import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, gate, repo, until, env } from '../helpers.js';
import { setup, fetch } from '../web/harness.js';
import { managementState, saveManagement } from '../../src/core/project/management-data.js';
import { trackControlJob } from '../../src/core/project/management-control.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Project } from '../../src/core/project.js';
import { Dispatcher, HANDLERS } from '../../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';
import { cliCommands } from '../../src/cli/catalog.js';
import { run as runHooks } from '../../src/cli/commands/hooks.js';
import { createSignal } from '../../src/signal.js';

const methods = ['management.emergency_preview', 'management.emergency_stop'];
const apiPreview = async f => (await fetch(f.url + '/api/management/emergency-preview')).json();
const post = (f, params, options = {}) => fetch(f.url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'management.emergency_stop', params }), ...options });
const dispatcher = f => f.project.rpcDispatcher ?? new Dispatcher(f.project, createSignal(), {});
function legacy(f, change = {}) {
  const task = f.store.create({ role: 'manager', task_kind: 'management', goal: 'PRIVATE-INSTRUCTION', name: 'history' });
  const occurrence = f.store.event(task.id, 'management.input_submitted', {});
  saveManagement(f.project, task.id, { version: 1, config_revision: 1, mode: 'once', enabled: false, consumed: false,
    signal_id: null, state: 'unknown', pending_signal: { id: occurrence, phase: 'started', run_id: 999 },
    receipts: [{ receipt_id: occurrence, status: 'unknown', reason: 'PRIVATE-HISTORY' }], control_calls: [],
    last_execution: { id: occurrence, status: 'unknown', reason: 'PRIVATE-HISTORY' }, ...change });
  f.store.update(task.id, { status: 'failed' });
  return f.store.task(task.id);
}

// First real user ingress before the larger module regression: authenticated HTTP ->
// actual RPC registration/Dispatcher -> persisted isolation -> original submit.
test('user HTTP recovers zero-process unknown ownership, preserves history, enforces exact confirmation and retries only its original scope', async () => {
  const f = await setup();
  try {
    f.project.kick = () => {};
    const old = legacy(f), original = managementState(old), rpc = dispatcher(f);
    expect(() => f.project.submitManagementInstruction({ instruction: 'blocked' })).toThrow('已有管家');
    expect((await fetch(f.url + '/api/management/emergency-preview', { anonymous: true })).status).toBe(401);
    expect((await fetch(f.url + '/api/management/emergency-preview?unexpected=1')).status).toBe(400);
    const eventCount = f.store.all('SELECT id FROM events').length;
    const preview = await apiPreview(f);
    expect(preview).toMatchObject({ scope: 'current_project', total: 1, affected_total: 1,
      items_truncated: false, totals: { unknown_receipts: 1, live_workers: 0 }, history_preserved: true });
    expect(f.store.task(old.id).management).toBe(old.management);
    expect(f.store.all('SELECT id FROM events')).toHaveLength(eventCount);
    expect(JSON.stringify(preview)).not.toContain('PRIVATE-');
    expect((await post(f, { revision: preview.revision, confirm: true }, { anonymous: true })).status).toBe(401);
    expect((await post(f, { revision: preview.revision, confirm: true }, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' } })).status).toBe(403);
    for (const params of [{ revision: preview.revision }, { revision: preview.revision, confirm: false },
      { revision: preview.revision, confirm: true, _token: 'not-a-user' }, { revision: preview.revision, confirm: true, unknown: 1 }])
      expect((await post(f, params)).status).toBe(400);
    expect((await post(f, { revision: 'stale', confirm: true })).status).toBe(400);
    // Change an old receipt, not only a config revision: the exact full preview must invalidate.
    const changed = managementState(f.store.task(old.id)); changed.receipts[0].reason = 'new history fact';
    saveManagement(f.project, old.id, changed);
    expect((await post(f, { revision: preview.revision, confirm: true })).status).toBe(400);
    const fresh = await apiPreview(f), response = await post(f, { revision: fresh.revision, confirm: true });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    const stopped = await response.json();
    expect(stopped).toMatchObject({ status: 'isolated', affected_total: 1, isolated_total: 1, stopping_total: 0, blockers: [] });
    const isolated = managementState(f.store.task(old.id));
    expect(isolated).toMatchObject({ enabled: false, consumed: true, state: 'unknown', emergency: { status: 'isolated' } });
    expect(isolated.pending_signal).toEqual(original.pending_signal);
    expect(isolated.last_execution).toEqual(original.last_execution);
    expect(isolated.receipts).toEqual(changed.receipts);
    expect(f.project.inspect(old.id).management).toMatchObject({ can_append: false, can_enable: false, emergency: { status: 'isolated' } });
    expect(() => f.project.updateManagementBinding(old.id, true, f.project.managementView(old.id).revision)).toThrow();
    expect(() => f.project.message(old.id, 'do not replay')).toThrow();
    const created = await rpc.dispatch('management.submit', { instruction: 'new explicit authorization', client_request_id: 'new-input' });
    expect(created).toMatchObject({ management: true, task: { status: 'queued' } });
    const beforeRetry = f.store.task(created.task.id).management;
    expect(await (await post(f, { revision: fresh.revision, confirm: true })).json()).toEqual(stopped);
    expect(f.store.task(created.task.id).management).toBe(beforeRetry);
    f.project.recoverManagementWorkers();
    expect(managementState(f.store.task(old.id))).toEqual(isolated);
    expect(f.project.managementOccupant().id).toBe(created.task.id);
  } finally { await f.close(); }
});

test('registered user-only RPC/CLI/catalogue deny delegation and explicit CLI confirmation is mandatory', async () => {
  const f = await setup();
  try {
    f.project.kick = () => {};
    const rpc = dispatcher(f), calls = [];
    const client = { request: (method, params) => { calls.push(method); return rpc.dispatch(method, params); } };
    for (const method of methods) {
      expect(PARAMS[method]).toBeDefined(); expect(HANDLERS[method]).toBeFunction();
      expect(USER_ONLY.has(method)).toBe(true); expect(managementPolicy(method).access).toBe('unavailable');
      expect(cliCommands('lushw').some(entry => entry.rpc?.includes(method))).toBe(false);
      expect(cliCommands('lush').some(entry => entry.rpc?.includes(method))).toBe(true);
    }
    legacy(f);
    const preview = await runHooks('hooks', ['management', 'emergency-preview'], { client });
    await expect(runHooks('hooks', ['management', 'emergency-stop', '--revision', preview.revision], { client })).rejects.toThrow('--confirm');
    expect(calls).toEqual(['management.emergency_preview']);
    await expect(runHooks('hooks', ['management', 'emergency-preview'], { client: { ...client, token: 'agent' } })).rejects.toThrow('user only');
    const userCLI = async args => {
      const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../../bin/lush'), 'hooks', 'management', ...args, '--json'],
        { cwd: f.root, env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home }), stdout: 'pipe', stderr: 'pipe' });
      const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, error, value: code === 0 ? JSON.parse(out) : null };
    };
    expect((await userCLI(['emergency-preview'])).value).toEqual(preview);
    expect(await userCLI(['emergency-stop', '--revision', preview.revision])).toMatchObject({ code: 1 });
    expect((await userCLI(['emergency-stop', '--revision', preview.revision, '--confirm'])).value).toMatchObject({ status: 'isolated' });
  } finally { await f.close(); }
});

test('previews cover every legacy Valet beyond the bounded page; all queued actions, confirmations, questions and future bindings are revoked without replay', async () => {
  const f = fixture();
  try {
    f.project.kick = () => {};
    const tasks = [];
    for (let i = 0; i < 105; i++) tasks.push(legacy(f, { enabled: true, mode: 'persistent', state: 'queued',
      pending_signal: { id: i + 1, phase: i === 0 ? 'question' : 'pending' },
      receipts: [{ receipt_id: i + 1, status: 'waiting' }], control_calls: [
        { receipt_id: i + 201, status: 'approved' }, { receipt_id: i + 401, status: 'pending_confirmation' },
        { receipt_id: i + 601, status: 'succeeded', result: { id: 123 } }] }));
    const question = Number(f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,'question')", tasks[0].id, 'own question', 'PRIVATE-DECISION').lastInsertRowid);
    const state = managementState(f.store.task(tasks[0].id)); state.pending_signal.question_notice_id = question;
    saveManagement(f.project, tasks[0].id, state);
    const preview = f.project.managementEmergencyPreview();
    expect(preview).toMatchObject({ total: 105, affected_total: 105, items_truncated: true,
      totals: { enabled: 105, pending_occurrences: 105, unstarted_actions: 105, unstarted_calls: 210, open_decisions: 1 } });
    expect(preview.items).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(100000);
    expect(JSON.stringify(preview)).not.toContain('PRIVATE-');
    const last = managementState(f.store.task(tasks.at(-1).id)); last.config_revision++;
    saveManagement(f.project, tasks.at(-1).id, last);
    expect(() => f.project.managementEmergencyStop(preview.revision, true)).toThrow('revision changed');
    const result = f.project.managementEmergencyStop(f.project.managementEmergencyPreview().revision, true);
    expect(result).toMatchObject({ affected_total: 105, isolated_total: 105, status: 'isolated' });
    for (const task of tasks) {
      const current = managementState(f.store.task(task.id));
      expect(current).toMatchObject({ enabled: false, consumed: true, emergency: { status: 'isolated' },
        receipts: [{ status: 'skipped' }], control_calls: [{ status: 'rejected' }, { status: 'rejected' }, { status: 'succeeded', result: { id: 123 } }] });
      f.project.submitManagementSignal(task.id, { id: 99999 });
      expect(f.project.managementReady(f.store.task(task.id))).toBe(false);
    }
    expect(f.store.get('SELECT status FROM notices WHERE id=?', question).status).toBe('dismissed');
    expect(f.project.resumeManagementQuestion(tasks[0].id, question)).toBe(false);
    f.project.recoverManagementWorkers(); f.project.drainManagementActions();
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.store.all('SELECT id FROM agent_runs')).toEqual([]);
    expect(f.project.submitManagementInstruction({ instruction: 'new' }).task.status).toBe('queued');
  } finally { await f.close(); }
});

test('actual Provider/tools/bridge reject manager and developer emergency access; abort kills only the Valet process group and releases at real cleanup', async () => {
  const f = await setup(); const devExit = gate(); let providerRun, processIds;
  try {
    f.project.kick = () => {}; await repo(f.root);
    const rpc = dispatcher(f), devEntered = gate();
    const cli = managementToolCLI(f.root, 'node'), ready = path.join(f.root, 'ready.json');
    cli.plan(methods.map(method => ({ name: 'manager_call', params: { method, params: method.endsWith('_stop') ? { revision: 'not-authorized', confirm: true } : {} } })));
    const source = fs.readFileSync(cli.command, 'utf8');
    fs.writeFileSync(cli.command, source.replace('console.log(JSON.stringify({ runtime:', `
const child = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, child: child.pid, replies }));
await new Promise(() => {});
console.log(JSON.stringify({ runtime:`));
    f.config.env.LUSH_PI_COMMAND = cli.command;
    const real = new AgentProvider(f.config, f.project.agentSettings);
    f.project.provider = { async run(options) {
      if (options.task.task_kind === 'management') {
        for (const method of methods) await expect(rpc.dispatch(method, { _token: options.token })).rejects.toThrow('requires user approval');
        return real.run(options);
      }
      for (const method of methods) await expect(rpc.dispatch(method, { _token: options.token })).rejects.toThrow('requires user approval');
      devEntered.resolve(options); await devExit.promise; return 'development unaffected';
    } };
    const dev = (await f.project.order('development unaffected', 'main')).task;
    const manager = (await rpc.dispatch('management.submit', { instruction: 'hold in real process', profile: { agent: 'pi', config_mode: 'pi' } })).task;
    f.project.pump(); const developer = await devEntered.promise;
    providerRun = f.project.running.get(manager.id);
    await until(() => fs.existsSync(ready)); processIds = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(processIds.replies).toHaveLength(2);
    for (const reply of processIds.replies) expect(reply.error).toContain('管理请求被拒绝');
    const before = f.store.task(dev.id), preview = await apiPreview(f);
    expect(preview.totals.live_workers).toBe(1);
    const stopped = await (await post(f, { revision: preview.revision, confirm: true })).json();
    expect(stopped).toMatchObject({ status: 'stopping', blockers: [{ id: manager.id, kinds: ['provider_cleanup'] }] });
    expect(providerRun.controller.signal.aborted).toBe(true);
    expect(developer.signal.aborted).toBe(false); expect(f.project.running.has(dev.id)).toBe(true);
    expect(f.store.task(dev.id).status).toBe(before.status);
    await providerRun.promise;
    const alive = pid => { try { return !/State:\s+Z/.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; } };
    await until(() => !alive(processIds.pid) && !alive(processIds.child));
    expect(f.project.running.has(manager.id)).toBe(false);
    expect(managementState(f.store.task(manager.id))).toMatchObject({ emergency: { status: 'isolated' }, enabled: false });
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.project.submitManagementInstruction({ instruction: 'fresh after actual process exit' }).task.status).toBe('queued');
  } finally { devExit.resolve(); await f.close(); }
});

for (const outcome of ['succeeded', 'unknown']) test(`in-flight control owner/busy retain the lane; late ${outcome} preserves effects and isolates without a second request`, async () => {
  const providerExit = gate(), effectExit = gate(), entered = gate(); let job;
  const f = fixture({ async run(options) { entered.resolve(options); await providerExit.promise; return 'late result must not revive'; } });
  try {
    f.project.kick = () => {}; await repo(f.root); const rpc = dispatcher(f);
    const manager = f.project.submitManagementInstruction({ instruction: 'write one draft' }).task;
    f.project.pump(); const options = await entered.promise, run = f.project.running.get(manager.id);
    const dispatch = f.project.managementDispatch;
    f.project.managementDispatch = async (...args) => {
      const result = await dispatch(...args); await effectExit.promise;
      if (outcome === 'unknown') throw Error('PRIVATE-LATE-ERROR');
      return result;
    };
    job = rpc.dispatch('manager.call', { _token: options.token, method: 'draft.add', params: { content: 'real completed effect', branch: 'main' } });
    await until(() => f.store.draftCount() === 1);
    expect(f.project.managementControlOwners.has(manager.id)).toBe(true);
    const preview = f.project.managementEmergencyPreview();
    const result = f.project.managementEmergencyStop(preview.revision, true);
    expect(result).toMatchObject({ status: 'stopping', blockers: [{ id: manager.id, kinds: ['provider_cleanup', 'control_owner', 'control_busy'] }] });
    // A newly confirmed preview while stopping must still report existing owners,
    // never an empty/isolated request just because authorization is already revoked.
    const again = f.project.managementEmergencyPreview();
    expect(again).toMatchObject({ affected_total: 1, stopping_total: 1 });
    expect(f.project.managementEmergencyStop(again.revision, true)).toMatchObject({ status: 'stopping', affected_total: 1 });
    expect(() => f.project.submitManagementInstruction({ instruction: 'blocked' })).toThrow('已有管家');
    providerExit.resolve(); await run.promise;
    expect(managementState(f.store.task(manager.id)).emergency.status).toBe('stopping');
    expect(f.project.managementOccupant().id).toBe(manager.id);
    expect(f.store.task(manager.id).status).toBe('cancelled');
    effectExit.resolve(); await job;
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
    const state = managementState(f.store.task(manager.id));
    expect(state).toMatchObject({ enabled: false, emergency: { status: 'isolated' }, control_calls: [{ status: outcome }] });
    expect(JSON.stringify(state)).not.toContain('PRIVATE-LATE-ERROR');
    expect(f.store.draftCount()).toBe(1); expect(f.project.managementOccupant()).toBeNull();
    f.project.completeManagementInvocation(manager.id, run.recordId);
    f.project.failManagementOccurrence(manager.id, 'failed');
    expect(managementState(f.store.task(manager.id))).toEqual(state);
    expect(f.project.submitManagementInstruction({ instruction: 'new after control cleanup' }).task.status).toBe('queued');
  } finally { providerExit.resolve(); effectExit.resolve(); await job?.catch(() => {}); await f.close(); }
});

test('emergency revokes real future bindings and queued submit without a Provider, even with a full historical state', async () => {
  const f = fixture({ async run() { throw Error('must never start'); } });
  try {
    f.project.kick = () => {};
    const hook = f.project.hooksList();
    const signal = f.project.saveHookSignal({ name: 'future', enabled: true,
      schedule: { kind: 'once', at: new Date(Date.now() + 60000).toISOString(), timezone: 'UTC' } }, hook.signals.revision).signals.items[0];
    const bound = f.project.createManagementWorker({ name: 'future bound', instruction: 'only future', signal_id: signal.id, mode: 'persistent' });
    const queued = f.project.submitManagementInstruction({ instruction: 'unstarted input', client_request_id: 'original-key' }).task;
    const full = managementState(f.store.task(queued.id));
    full.receipts = Array.from({ length: 32 }, (_, i) => ({ receipt_id: i + 100000, status: 'waiting' }));
    full.last_execution = { status: 'unknown', reason: '' };
    full.last_execution.reason = 'x'.repeat(128 * 1024 - Buffer.byteLength(JSON.stringify(full)));
    saveManagement(f.project, queued.id, full);
    expect(Buffer.byteLength(f.store.task(queued.id).management)).toBe(128 * 1024);
    const preview = f.project.managementEmergencyPreview();
    expect(preview).toMatchObject({ affected_total: 2, totals: { enabled: 2, pending_occurrences: 1, unstarted_actions: 32, live_workers: 0 } });
    expect(f.project.managementEmergencyStop(preview.revision, true)).toMatchObject({ status: 'isolated', affected_total: 2 });
    expect(managementState(f.store.task(queued.id)).last_execution).toEqual(full.last_execution);
    expect(managementState(f.store.task(bound.id))).toMatchObject({ enabled: false, emergency: { status: 'isolated' } });
    f.project.submitManagementSignal(bound.id, { id: 999999, signal_id: signal.id });
    f.project.pump();
    expect(f.store.all('SELECT id FROM agent_runs')).toEqual([]);
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.project.hookSignals().items[0]).toEqual(signal); // Signal itself and other consumers are not deleted.
    expect(f.project.submitManagementInstruction({ instruction: 'unstarted input', client_request_id: 'original-key' }).task).toMatchObject({ id: queued.id, status: 'cancelled' });
    expect(f.project.managementOccupant()).toBeNull();
  } finally { await f.close(); }
});

test('bounded blocker lists retain complete counts and every real owner finalizes its own durable isolation', async () => {
  const f = fixture(), exit = gate(), jobs = [];
  try {
    f.project.kick = () => {};
    const tasks = Array.from({ length: 101 }, () => legacy(f, { pending_signal: null }));
    for (const task of tasks) jobs.push(trackControlJob(f.project, task.id, exit.promise));
    const result = f.project.managementEmergencyStop(f.project.managementEmergencyPreview().revision, true);
    expect(result).toMatchObject({ status: 'stopping', affected_total: 101, stopping_total: 101, blockers_total: 101, blockers_truncated: true });
    expect(result.blockers).toHaveLength(100);
    expect(result.blockers.every(item => item.kinds.join() === 'control_owner')).toBe(true);
    expect(f.project.managementOccupant()).not.toBeNull();
    exit.resolve(); await Promise.all(jobs);
    expect(f.project.managementOccupant()).toBeNull();
    expect(tasks.every(task => managementState(f.store.task(task.id)).emergency.status === 'isolated')).toBe(true);
  } finally { exit.resolve(); await Promise.all(jobs); await f.close(); }
});

test('async pre-start control admission cannot overwrite revocation or execute after emergency', async () => {
  const entered = gate(), providerExit = gate(), admission = gate(), waiting = gate(); let job;
  const f = fixture({ async run(options) { entered.resolve(options); await providerExit.promise; return 'late'; } });
  try {
    f.project.kick = () => {}; await repo(f.root); const rpc = dispatcher(f);
    const manager = f.project.submitManagementInstruction({ instruction: 'write if still authorized' }).task;
    f.project.pump(); const options = await entered.promise, run = f.project.running.get(manager.id);
    const write = f.project.write.bind(f.project);
    f.project.write = async (action, fn) => {
      if (action === 'execute confirmed management capability') { waiting.resolve(); await admission.promise; }
      return write(action, fn);
    };
    job = rpc.dispatch('manager.call', { _token: options.token, method: 'draft.add', params: { content: 'must not execute', branch: 'main' } });
    await waiting.promise;
    expect(f.project.managementEmergencyStop(f.project.managementEmergencyPreview().revision, true).status).toBe('stopping');
    expect(managementState(f.store.task(manager.id)).control_calls[0].status).toBe('rejected');
    providerExit.resolve(); await run.promise;
    expect(f.project.managementOccupant().id).toBe(manager.id);
    admission.resolve(); await job; await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.store.draftCount()).toBe(0);
    expect(managementState(f.store.task(manager.id))).toMatchObject({ enabled: false, emergency: { status: 'isolated' }, control_calls: [{ status: 'rejected' }] });
    expect(f.project.managementOccupant()).toBeNull();
  } finally { providerExit.resolve(); admission.resolve(); await job?.catch(() => {}); await f.close(); }
});

test('real pending confirmation is closed without approval or effect; recovery finalizes a durable stopping request and never revives old authorization', async () => {
  const entered = gate(), exit = gate();
  const f = fixture({ async run(options) { entered.resolve(options); await exit.promise; return 'normal'; } });
  let recovered;
  try {
    f.project.kick = () => {}; const rpc = dispatcher(f);
    const permissions = f.project.managementPermissionGet('draft.add', 'device');
    f.project.managementPermissionSet('draft.add', 'confirmation', permissions.revision, 'device');
    const manager = f.project.submitManagementInstruction({ instruction: 'ask for a draft' }).task;
    f.project.pump(); const options = await entered.promise, run = f.project.running.get(manager.id);
    const call = await rpc.dispatch('manager.call', { _token: options.token, method: 'draft.add', params: { content: 'not approved', branch: 'main' } });
    expect(call.status).toBe('pending_confirmation'); exit.resolve(); await run.promise;
    const stopped = f.project.managementEmergencyStop(f.project.managementEmergencyPreview().revision, true);
    expect(stopped.status).toBe('isolated');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', call.notice_id).status).toBe('dismissed');
    f.project.resolveManagementConfirmation(call.notice_id);
    expect(f.project.managementControlOwners?.has(manager.id) ?? false).toBe(false);
    const late = f.project.executeManagementCapability(manager.id, call.receipt_id);
    expect(f.project.managementControlOwners?.has(manager.id) ?? false).toBe(false);
    await late; await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.store.draftCount()).toBe(0);
    const old = legacy(f, { pending_signal: null, control_calls: [{ receipt_id: 88888, status: 'running' }] });
    // Simulate a crash after the durable revocation but before owner cleanup, with
    // a fresh runtime and no surviving process (the real Provider EOF guard kills it).
    f.project.managementControlOwners = new Map([[old.id, 1]]);
    const revision = f.project.managementEmergencyPreview().revision;
    expect(f.project.managementEmergencyStop(revision, true).status).toBe('stopping');
    f.project.managementControlOwners.delete(old.id);
    recovered = new Project(f.config, f.store); recovered.kick = () => {};
    recovered.recoverManagementWorkers();
    const state = managementState(f.store.task(old.id));
    expect(state).toMatchObject({ enabled: false, emergency: { status: 'isolated' }, control_calls: [{ status: 'unknown' }] });
    expect(recovered.managementOccupant()).toBeNull();
    expect(recovered.managementEmergencyStop(revision, true)).toMatchObject({ status: 'isolated', affected_total: 1 });
    expect(recovered.submitManagementInstruction({ instruction: 'fresh after restart' }).task.status).toBe('queued');
  } finally { exit.resolve(); await recovered?.shutdown(); await f.close(); }
});
