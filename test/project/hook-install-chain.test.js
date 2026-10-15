import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { setup as httpSetup, fetch } from '../web/harness.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';

const approve = { answers: [{ selected: [1], custom: '' }] };
const options = (f, key = 'chain-install') => ({ id: f.main.id,
  command: { name: 'restart application', kind: 'shell', command: 'bun run restart' },
  hook: { name: 'main merge restart', trigger: 'worker.merge_received', mode: 'persistent', enabled: true },
  expected_revisions: { commands: f.project.shortcutCommands().revision, worker_hooks: f.project.taskHooks(f.main.id).revision },
  client_request_id: key });
async function prepare(f) {
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ scripts: {
    restart: `bun -e 'require("node:fs").appendFileSync(".lush/restart-proof", "x")'`,
  } }));
  await git(f.root, 'add', 'package.json'); await git(f.root, 'commit', '-m', 'controlled restart script');
  f.main = await f.project.bootstrapMain();
  f.project.observeTaskHooks();
}
async function deliver(f, name) {
  const { task } = await f.project.order(name, 'main', [], null, false);
  fs.writeFileSync(path.join(task.workspace, name + '.txt'), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
  f.store.update(task.id, { status: 'waiting', result: 'done' });
  await f.project.workspaces.finish(f.store.task(task.id));
  await f.project.reserveTask(task.id, 'merge'); await f.project.driveTaskMerge(f.main.id);
  await f.project.hookQueue;
  expect(f.store.task(task.id).integration).toBe('merged');
}
const proof = f => path.join(f.config.home, 'restart-proof');
async function runManager(f, input) {
  const cli = managementToolCLI(f.config.home, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
  const provider = new AgentProvider(f.config, f.project.agentSettings);
  f.invocations = 0;
  const run = provider.run.bind(provider);
  provider.run = args => { f.invocations++; return run(args); }; f.project.provider = provider;
  cli.plan([{ name: 'manager_catalog', params: {} },
    { name: 'manager_call', params: { method: 'hooks.list', params: {} } },
    { name: 'manager_call', params: { method: 'worker.hooks', params: { id: f.main.id } } },
    { name: 'manager_call', callId: 'install-through-bridge', params: { method: 'hooks.install', params: input } }]);
  const manager = f.project.submitManagementInstruction({ instruction: 'main 每次合并后运行 bun run restart',
    profile: { agent: 'pi', config_mode: 'pi' } }).task;
  f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
  const output = JSON.parse(f.store.task(manager.id).result);
  expect(output.blocked).toEqual([true, true, true, true, true]);
  const capability = output.replies[0].response.details.methods.find(item => item.method === 'hooks.install');
  expect(capability).toMatchObject({ access: 'confirmation', schema: { required: ['id','command','hook','expected_revisions','client_request_id'] } });
  return { manager, output, reply: output.replies[3] };
}

test('real Provider -> registered manager_call -> Bun bridge -> exact single confirmation -> atomic install -> two real main merges restart twice', async () => {
  const f = fixture(); let rpc;
  try {
    await prepare(f);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const input = options(f), before = { commands: f.project.shortcutCommands().items.length, hooks: f.project.taskHooks(f.main.id).mounts.length };
    const { manager, reply } = await runManager(f, input);
    expect(reply.response.details).toMatchObject({ method: 'hooks.install', status: 'pending_confirmation' });
    expect(f.project.shortcutCommands().items).toHaveLength(before.commands);
    expect(f.project.taskHooks(f.main.id).mounts).toHaveLength(before.hooks);
    expect(fs.existsSync(proof(f))).toBe(false);
    f.project.answer(reply.response.details.notice_id, approve);
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
    const state = JSON.parse(f.store.task(manager.id).management);
    const receipt = state.last_execution.control_calls[0];
    expect(receipt).toMatchObject({ status: 'succeeded', result: { submitted: true, installed: true, worker_id: f.main.id } });
    expect(receipt.result.command_id).toBeString(); expect(receipt.result.hook_id).toBeString();
    expect(f.store.task(manager.id).status).toBe('completed'); expect(f.invocations).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE task_id=?", manager.id).n).toBe(1);
    expect(fs.existsSync(proof(f))).toBe(false);
    await deliver(f, 'first'); await deliver(f, 'second');
    expect(fs.readFileSync(proof(f), 'utf8')).toBe('xx');
    const events = f.store.all("SELECT id FROM events WHERE task_id=? AND type='worker.merge_received' ORDER BY id", f.main.id);
    expect(events).toHaveLength(2);
    for (const event of [...events, ...events]) f.project.emitTaskHook(f.main.id, 'worker.merge_received', event.id);
    await f.project.hookQueue;
    expect(fs.readFileSync(proof(f), 'utf8')).toBe('xx');
    expect(f.project.installCommandHook(input)).toMatchObject({ command_id: receipt.result.command_id, hook_id: receipt.result.hook_id });
    expect(JSON.stringify(receipt.result)).not.toContain('bun run');
    expect(f.project.shortcutCommandHistory().items).toHaveLength(2);
    expect(f.invocations).toBe(1);
  } finally { await rpc?.close(); await f.close(); }
});

test('real user CLI and HTTP install the same registered capability; response-loss replay does not duplicate or execute it', async () => {
  const f = await httpSetup();
  try {
    await prepare(f);
    const input = options(f, 'cli-install'), { id, ...definition } = input;
    const file = path.join(f.config.home, 'automation.json'); fs.writeFileSync(file, JSON.stringify(definition), { mode: 0o600 });
    const child = Bun.spawn([Bun.which('bun'), path.resolve(import.meta.dir, '../../bin/lush'), '--json', 'hooks', 'install', String(id), '--file', file],
      { cwd: f.root, env: f.config.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(err).toBe(''); const result = JSON.parse(out);
    expect(result).toMatchObject({ installed: true, worker_id: id });
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'hooks.install', params: input }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='hook.installed'").n).toBe(1);
    expect(fs.existsSync(proof(f))).toBe(false);
    await deliver(f, 'cli-land'); expect(fs.readFileSync(proof(f), 'utf8')).toBe('x');
  } finally { await f.close(); }
});

for (const outcome of ['unavailable', 'reject', 'stale_revision', 'target_changed'])
  test(`real bridge install ${outcome} never leaves partial automation`, async () => {
    const f = fixture(); let rpc;
    try {
      await prepare(f);
      rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
      const input = options(f), count = f.project.shortcutCommands().items.length;
      const { manager, reply } = await runManager(f, input);
      expect(reply.response.details.status).toBe('pending_confirmation');
      if (outcome === 'unavailable') {
        const current = f.project.managementPermissions();
        f.project.setManagementPermissions({ ...current.permissions, 'hooks.install': 'unavailable' }, current.revision);
      } else {
        if (outcome === 'stale_revision') f.project.saveShortcutCommand({ name: 'unrelated edit', command: 'true' }, f.project.shortcutCommands().revision);
        if (outcome === 'target_changed') f.store.update(f.main.id, { head_commit: 'a'.repeat(40) });
        f.project.answer(reply.response.details.notice_id, outcome === 'reject' ? { answers: [{ selected: [0], custom: '' }] } : approve);
      }
      await Promise.all([...(f.project.managementControlJobs ?? [])]);
      expect(f.project.shortcutCommands().items).toHaveLength(count + (outcome === 'stale_revision' ? 1 : 0));
      expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='hook.installed'").n).toBe(0);
      expect(f.project.taskHooks(f.main.id).mounts.some(item => item.name === input.hook.name)).toBe(false);
      expect(fs.existsSync(proof(f))).toBe(false); expect(f.invocations).toBe(1);
      const state = JSON.parse(f.store.task(manager.id).management);
      const call = (state.last_execution ?? state.pending_signal).control_calls?.[0] ?? state.control_calls[0];
      expect(call.status).toBe(outcome === 'unavailable' || outcome === 'reject' ? 'rejected' : 'failed');
    } finally { await rpc?.close(); await f.close(); }
  });
