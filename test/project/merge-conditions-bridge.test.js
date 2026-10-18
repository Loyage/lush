import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, env, git, until } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { MANAGEMENT_TOOL_NAMES } from '../../src/agent/pi-management.js';
import { Dispatcher, HANDLERS } from '../../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { MERGE_CONDITION_CAPABILITIES, MERGE_CONDITION_PARAMETERS } from '../../src/core/merge-conditions.js';
import { LUSHW_METHODS } from '../../src/cli/catalog.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');
const sorted = values => [...values].sort();
const call = (method, params, callId) => ({ name: 'manager_call', params: { method, params }, callId });
async function setup() {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    fs.writeFileSync(path.join(cwd, `worker-${task.id}.txt`), `code ${task.id}\n`);
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `work ${task.id}`); return 'safe result';
  } });
  f.project.kick = () => {}; await repo(f.root); await f.project.bootstrapMain();
  const a = (await f.project.order('A')).task, b = (await f.project.order('B')).task;
  f.project.pump(); await until(() => !f.project.running.size && f.store.task(a.id).status === 'waiting' && f.store.task(b.id).status === 'waiting', 12000);
  f.store.update(b.id, { status: 'paused' });
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
  async function cli(...args) {
    const proc = Bun.spawn([process.execPath, bin, '--project', f.root, '--json', ...args], { cwd: f.root,
      env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, err, value: out.trim() ? JSON.parse(out) : null };
  }
  return { ...f, a, b, dispatcher, cli, async close() { await rpc.close(); await f.close(); } };
}

test('real user CLI W-number lookup -> shared registry/schema -> configure AND intent -> actual parent queue landing', async () => {
  const f = await setup();
  try {
    const { a, b, project: p } = f;
    const before = await f.cli('worker', 'merge-conditions', a.worker_number);
    expect(before).toMatchObject({ code: 0, err: '', value: { worker_id: a.id, state: 'idle' } });
    const configured = await f.cli('worker', 'merge-after', a.worker_number, '--after-settled', b.worker_number, '--revision', before.value.revision);
    expect(configured).toMatchObject({ code: 0, err: '', value: { worker_id: a.id, state: 'waiting', conditions: [{ worker_id: b.id, kind: 'worker_settled' }] } });
    expect(p.hooksList().registry.items.find(item => item.id === 'system:merge-conditions')).toMatchObject({ readonly: true, mount_count: 1 });
    expect((await f.cli('worker', 'merge-after', a.worker_number, '--after-settled', b.worker_number, '--revision', before.value.revision)).code).toBe(0);
    const and = await f.cli('worker', 'merge-after', a.worker_number, '--after-settled', b.worker_number, '--after-merged', b.worker_number, '--revision', configured.value.revision);
    expect(and).toMatchObject({ code: 0, value: { conditions: [{ kind: 'worker_settled', worker_id: b.id }, { kind: 'worker_merged', worker_id: b.id }] } });
    expect((await f.cli('worker', 'merge-after', a.worker_number, '--after-settled', b.worker_number, '--revision', and.value.revision)).code).toBe(0);
    const malformed = await f.cli('worker', 'merge-after', a.worker_number, '--after-merged', '--revision', before.value.revision);
    expect(malformed.code).not.toBe(0);
    const directory = await f.dispatcher.dispatch('cli.catalog', {});
    for (const [method, parameters] of Object.entries(MERGE_CONDITION_PARAMETERS)) {
      expect(PARAMS[method]).toEqual(parameters); expect(typeof HANDLERS[method]).toBe('function'); expect(USER_ONLY.has(method)).toBe(true);
      expect(LUSHW_METHODS.has(method)).toBe(false); // user-only management surface, never ordinary Agent authority
      expect(directory.commands.flatMap(command => command.rpc).find(item => item.method === method)).toMatchObject({ parameters, schema: MERGE_CONDITION_CAPABILITIES[method].schema });
    }
    f.store.update(b.id, { status: 'waiting' }); p.scheduleTaskHooks();
    await until(() => f.store.task(a.id).integration === 'merged', 12000);
    expect((await f.cli('worker', 'merge-conditions', a.worker_number)).value.state).toBe('consumed');
    expect(await git(f.root, 'show', `main:worker-${a.id}.txt`)).toBe(`code ${a.id}`);
    expect(await git(f.root, 'show', `main:worker-${b.id}.txt`).catch(() => null)).toBeNull();
  } finally { await f.close(); }
});

for (const access of ['automatic','confirmation']) test(`real controlled Provider/CLI -> manager bridge -> ${access} permission -> conditional intent -> parent queue landing`, async () => {
  const f = await setup();
  try {
    const { a, b, project: p } = f, cli = managementToolCLI(f.config.home, 'node');
    f.config.env.LUSH_PI_COMMAND = cli.command; p.provider = new AgentProvider(f.config, p.agentSettings);
    const policy = p.managementPermissionGet('worker.merge_after', 'device');
    p.managementPermissionSet('worker.merge_after', access, policy.revision, 'device');
    const conditions = [{ kind: 'worker_settled', worker_id: b.id }];
    async function invoke(plan) {
      cli.plan(plan);
      const manager = p.submitManagementInstruction({ instruction: '安排 A 在 B 本轮安全交付就绪后合并到 A 的直接父，只管理本轮条件，不改变子 Worker Hook', profile: { agent: 'pi', config_mode: 'pi' } }).task;
      p.pump(); await until(() => p.running.has(manager.id)); await p.running.get(manager.id).promise;
      const result = JSON.parse(f.store.task(manager.id).result);
      for (const key of ['registered','cliActive','sessionActive','modelActive']) expect(result[key]).toEqual([...MANAGEMENT_TOOL_NAMES]);
      expect(result.blocked.every(Boolean)).toBe(true);
      return { manager, result };
    }
    const first = await invoke([{ name: 'manager_catalog', params: {} },
      call('worker.merge_conditions', { id: a.id }, 'read-conditions'),
      call('worker.merge_after', { id: a.id, conditions, expected_revision: p.taskMergeConditions(a.id).revision }, 'configure-conditions')]);
    const catalog = first.result.replies[0].response.details;
    expect(sorted(catalog.methods.map(item => item.method))).toEqual(sorted(Object.keys(PARAMS)));
    expect(sorted(Object.keys(PARAMS))).toEqual(sorted(Object.keys(HANDLERS)));
    for (const [method, parameters] of Object.entries(MERGE_CONDITION_PARAMETERS)) {
      expect(catalog.methods.find(item => item.method === method)).toMatchObject({ parameters, schema: MERGE_CONDITION_CAPABILITIES[method].schema,
        access: method === 'worker.merge_conditions' ? 'read' : access });
    }
    expect(first.result.replies[1].response.details.result).toMatchObject({ state: 'idle', worker_id: a.id });
    const receipt = first.result.replies[2].response.details;
    expect(receipt).toMatchObject({ method: 'worker.merge_after', status: access === 'confirmation' ? 'pending_confirmation' : 'succeeded' });
    if (access === 'confirmation') {
      expect(p.taskMergeConditions(a.id).state).toBe('idle');
      expect(p.answer(receipt.notice_id, { answers: [{ selected: [1], custom: '' }] }).answer_source).toBe('user');
      await until(() => JSON.parse(f.store.task(first.manager.id).management).control_calls.find(c => c.receipt_id === receipt.receipt_id)?.status === 'succeeded');
      await Promise.all([...p.managementControlJobs]);
    }
    expect(p.taskMergeConditions(a.id)).toMatchObject({ state: 'waiting', conditions: [{ worker_id: b.id, kind: 'worker_settled', satisfied: false }] });
    expect(JSON.parse(f.store.task(a.id).reservation).status).toBe('pending');
    const latest = p.managementPermissionGet('worker.merge_after', 'device');
    p.managementPermissionSet('worker.merge_after', 'unavailable', latest.revision, 'device');
    const denied = await invoke([call('worker.merge_after', { id: a.id, conditions, expected_revision: p.taskMergeConditions(a.id).revision }, 'denied-config')]);
    expect(denied.result.replies[0].error).toContain('管理请求被拒绝或未确认完成');
    // The already-started successful configuration is an explicit persistent intent;
    // denying NEW config does not revoke it or change its locked source Hook.
    f.store.update(b.id, { status: 'waiting' }); p.scheduleTaskHooks();
    try { await until(() => f.store.task(a.id).integration === 'merged', 12000); }
    catch (error) {
      console.error('conditional bridge failure', JSON.stringify({ conditions: p.taskMergeConditions(a.id), reservation: f.store.task(a.id).reservation,
        status: f.store.task(a.id).status, error: f.store.task(a.id).integration_error,
        events: f.store.all("SELECT type,data FROM events WHERE task_id=? ORDER BY id DESC LIMIT 8", a.id) }));
      throw error;
    }
    expect(await git(f.root, 'show', `main:worker-${a.id}.txt`)).toBe(`code ${a.id}`);
    expect(p.taskMergeConditions(a.id).state).toBe('consumed');
  } finally { await f.close(); }
});

test('latest management permission revokes an unstarted exact confirmation, not merely its catalog projection', async () => {
  const f = await setup();
  try {
    const { a, b, project: p } = f, cli = managementToolCLI(f.config.home, 'node');
    f.config.env.LUSH_PI_COMMAND = cli.command; p.provider = new AgentProvider(f.config, p.agentSettings);
    const original = p.managementPermissionGet('worker.merge_after', 'device');
    p.managementPermissionSet('worker.merge_after', 'confirmation', original.revision, 'device');
    cli.plan([call('worker.merge_after', { id: a.id, conditions: [{ kind: 'worker_settled', worker_id: b.id }], expected_revision: p.taskMergeConditions(a.id).revision }, 'await-confirmation')]);
    const manager = p.submitManagementInstruction({ instruction: '设置本轮条件合并', profile: { agent: 'pi', config_mode: 'pi' } }).task;
    p.pump(); await until(() => p.running.has(manager.id)); await p.running.get(manager.id).promise;
    const receipt = JSON.parse(f.store.task(manager.id).result).replies[0].response.details;
    expect(receipt.status).toBe('pending_confirmation');
    const latest = p.managementPermissionGet('worker.merge_after', 'device');
    p.managementPermissionSet('worker.merge_after', 'unavailable', latest.revision, 'device');
    p.refreshManagementPermissions();
    expect(p.taskMergeConditions(a.id).state).toBe('idle');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', receipt.notice_id).status).toBe('dismissed');
    expect(JSON.parse(f.store.task(manager.id).management).control_calls.find(c => c.receipt_id === receipt.receipt_id).status).toBe('rejected');
    expect(f.store.task(a.id).reservation).toBeNull();
  } finally { await f.close(); }
});
