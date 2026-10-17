import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, env, temp, until } from './helpers.js';
import { RPCClient } from '../src/rpc/client.js';
import { RPCServer } from '../src/rpc/server.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { createSignal } from '../src/signal.js';
import { tokenHash } from '../src/core/project/internal.js';
import { DeviceSettingsService, DEVICE_SETTINGS_READS, DEVICE_SETTINGS_ACTIONS } from '../src/host/device-settings.js';
import { managementCatalog, validateManagementCall } from '../src/rpc/management-policy.js';
import { managementToolCLI } from './agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../src/agent/provider.js';
import { setup, fetch } from './web/harness.js';
import { startTestWeb } from './web/auth-fixture.js';

// These are intentionally historical negative cases, not a new callable registry.
const retiredMethods = ['runner.nodes.get','runner.nodes.set','runner.nodes.check',
  'runner.credentials.get','runner.credentials.set','runner.credentials.remove',
  'runner.project.get','runner.project.set','runner.ssh.discover','runner.ssh.test',
  'runner.deployments.get','runner.deployments.plan','runner.deployments.apply',
  'runner.deployments.confirm','runner.deployments.reconcile','runner.deployments.recovery.plan',
  'runner.deployments.recovery.apply','runner.deployments.recovery.reconcile','runner.worker.reconcile',
  'runner.unknown'];
const node = '11111111-1111-4111-8111-111111111111';
const selectionMethods = ['order.submit','input.emit','draft.add','draft.update','worker.spawn'];
const bin = name => path.resolve(import.meta.dir, `../bin/${name}`);
async function cli(f, executable, args, token = null) {
  const proc = Bun.spawn([process.execPath, bin(executable), ...args, '--json'], { cwd: f.root,
    env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home,
      ...(token ? { LUSH_AGENT_TOKEN: token } : {}) }), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}
const post = (url, method, params) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method, params }) });

function legacyFiles(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const files = ['runners.json','runner-credentials.json','runner-deployments.json'];
  for (const file of files) fs.writeFileSync(path.join(home, file), `invalid old private ${file}`, { mode: 0o600 });
  return () => { for (const file of files) expect(fs.readFileSync(path.join(home, file), 'utf8')).toBe(`invalid old private ${file}`); };
}

test('real CLI and authenticated RPC reject retired nodes and all explicit selections before execution', async () => {
  const f = fixture(); f.project.kick = () => {};
  const actor = f.store.create({ role: 'agent', task_kind: 'order', goal: 'retirement probe' });
  const token = 'execution-retired-test-token';
  f.store.update(actor.id, { status: 'running' }); f.store.armAgent(actor.id, tokenHash(token));
  f.project.running.set(actor.id, { token, controller: new AbortController() });
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher);
  try {
    await rpc.start(); const client = new RPCClient(f.config.socket);
    for (const method of retiredMethods) {
      for (const auth of [{}, { _token: token }]) await expect(client.request(method, auth)).rejects.toThrow('retired');
      await expect(f.project.managementDispatch(method, {}, actor.id)).rejects.toThrow('retired');
      expect(() => validateManagementCall(method, {})).toThrow('unknown management capability');
    }
    expect(managementCatalog().methods.some(item => item.method.startsWith('runner.'))).toBe(false);
    for (const method of selectionMethods) for (const selection of ['local', node, null]) {
      await expect(client.request(method, { runner_node_id: selection })).rejects.toThrow('runner_node_id is retired');
      await expect(client.request(method, { runner_node_id: selection, _token: token })).rejects.toThrow('runner_node_id is retired');
    }
    for (const executable of ['lush','lushc']) for (const auth of [null, token]) {
      for (const args of [['runner','ssh','test','unreachable'], ['runner','deployments','apply','--file','/not-read','--scope','device'],
        ['order','goal','--runner-node','local'], ['worker','spawn','goal','--parent',String(actor.id),'--runner-node=' + node]]) {
        const result = await cli(f, executable, args, auth);
        expect(result.code).not.toBe(0); expect(result.err).toContain('retired'); expect(result.out).toBe('');
      }
    }
    expect(f.store.all('SELECT * FROM drafts')).toEqual([]);
    expect(f.store.all('SELECT * FROM inputs')).toEqual([]);
    expect(f.store.all('SELECT * FROM tasks')).toHaveLength(1);
  } finally { f.project.running.delete(actor.id); await rpc.close(); await f.close(); }
});

test('RPC edits old selected drafts without replacing retained selection and creates ordinary local work', async () => {
  const f = fixture(); f.project.kick = () => {};
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  try {
    await repo(f.root); await rpc.start(); const client = new RPCClient(f.config.socket);
    const created = await client.request('order.submit', { content: 'local order', start: false });
    expect(created.task.workspace).toBeTruthy(); expect(fs.existsSync(created.task.workspace)).toBe(true);
    const child = await client.request('worker.spawn', { parent: created.task.id, goal: 'local child' });
    expect(child.workspace).toBeTruthy(); expect(child.execution_retired).not.toBe(true);
    const draft = await client.request('draft.add', { content: 'local draft', branch: 'main' });
    const stored = f.store.draft(draft.id), options = JSON.parse(stored.input_options);
    expect(Object.hasOwn(options, 'runner_node_id')).toBe(false);
    const changed = await client.request('draft.update', { id: draft.id, content: 'edited local', expected_revision: stored.revision });
    expect(changed.content).toBe('edited local');
    for (const selection of [node, 'local']) {
      f.store.run('UPDATE drafts SET input_options=? WHERE id=?', JSON.stringify({ ...options, runner_node_id: selection }), draft.id);
      const before = f.store.draft(draft.id);
      const content = `edited legacy ${selection}`;
      await client.request('draft.update', { id: draft.id, content, expected_revision: before.revision });
      expect(f.store.draft(draft.id).input_options).toBe(before.input_options);
      expect((await client.request('input.get', { kind: 'draft', id: draft.id })).content).toBe(content);
    }
    const result = await cli(f, 'lush', ['order','CLI local','--buffer']);
    expect(result.code, result.err).toBe(0);
    const local = JSON.parse(result.out); expect(Object.hasOwn(local, 'runner_node_id')).toBe(false);
  } finally { await rpc.close(); await f.close(); }
});

test('real RPC emits legacy local and remote-UUID drafts into local Workers through both submission paths and create-only', async () => {
  const f = fixture({ async run() { return 'saved draft executed locally'; } }); f.project.stopping = true;
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  try {
    await repo(f.root); await rpc.start(); const client = new RPCClient(f.config.socket), drafts = [];
    for (const selection of ['local', node]) for (const method of ['input.emit', 'order.submit']) {
      const draft = await client.request('draft.add', { content: `legacy ${selection} ${method}`, branch: 'main' });
      const row = f.store.draft(draft.id);
      const retained = JSON.stringify({ ...JSON.parse(row.input_options), runner_node_id: selection });
      f.store.run('UPDATE drafts SET input_options=? WHERE id=?', retained, draft.id);
      const receipt = await client.request(method, { draft_id: draft.id, expected_revision: row.revision });
      expect(receipt.emitted).toBe(true); expect(receipt.draft_id).toBe(draft.id);
      expect(f.store.draft(draft.id).input_options).toBe(retained);
      drafts.push({ id: draft.id, retained });
    }
    const createOnly = await client.request('draft.add', { content: 'legacy UUID create only', branch: 'main' });
    const saved = JSON.stringify({ ...JSON.parse(f.store.draft(createOnly.id).input_options), runner_node_id: node });
    f.store.run('UPDATE drafts SET input_options=? WHERE id=?', saved, createOnly.id);
    const created = await client.request('order.submit', { draft_id: createOnly.id, expected_revision: createOnly.revision, start: false });
    expect(created.task.status).toBe('paused'); expect(fs.existsSync(created.task.workspace)).toBe(true);
    expect(created.task.execution_retired).not.toBe(true);
    expect(f.store.draft(createOnly.id).input_options).toBe(saved);
    f.project.stopping = false; f.project.kick();
    for (const draft of drafts) {
      await until(() => f.project.inputEmissionResult(draft.id).dispatch.state === 'succeeded');
      const dispatch = f.project.inputEmissionResult(draft.id).dispatch;
      await until(() => f.store.task(dispatch.worker_id).result && !f.project.running.has(dispatch.worker_id));
      const worker = await client.request('worker.inspect', { id: dispatch.worker_id });
      expect(worker.workspace).toBeTruthy(); expect(fs.existsSync(worker.workspace)).toBe(true);
      expect(worker.execution_retired).not.toBe(true);
      expect(worker.result).toBe('saved draft executed locally');
      expect(f.store.draft(draft.id).input_options).toBe(draft.retained);
    }
  } finally { await rpc.close(); await f.close(); }
});

test('model-free Provider uses real management tool bridge and cannot proxy retired nodes or selections', async () => {
  const f = fixture(); f.project.kick = () => {}; let rpc;
  try {
    const toolCLI = managementToolCLI(f.root, 'node');
    f.config.env.LUSH_PI_COMMAND = toolCLI.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const manager = f.project.submitManagementInstruction({ instruction: 'probe retired execution entry points',
      profile: { agent: 'pi', config_mode: 'pi' } }).task;
    toolCLI.plan([
      { name: 'manager_catalog', params: {} },
      { name: 'manager_call', params: { method: 'runner.ssh.test', params: { ssh_alias: 'never-connect' } } },
      { name: 'manager_call', params: { method: 'draft.add', params: { content: 'must not persist', runner_node_id: 'local' } } },
    ]);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const task = f.store.task(manager.id); expect(task.status).toBe('completed');
    const result = JSON.parse(task.result);
    expect(result.replies).toHaveLength(3);
    expect(result.replies[0].response.details.methods.some(item => item.method.startsWith('runner.'))).toBe(false);
    for (const reply of result.replies.slice(1)) { expect(reply.response).toBeUndefined(); expect(reply.error).toBeTruthy(); }
    expect(f.store.all('SELECT * FROM drafts')).toEqual([]);
  } finally { await rpc?.close(); await f.close(); }
});

test('new user force-acceptance RPC paths cannot preview or reclaim retired roots or descendants', async () => {
  for (const target of ['root', 'descendant']) {
    const f = fixture(); f.project.kick = () => {};
    const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
    try {
      await repo(f.root); await rpc.start(); const client = new RPCClient(f.config.socket);
      const root = (await client.request('order.submit', { content: 'acceptance root', start: false })).task;
      const child = await client.request('worker.spawn', { parent: root.id, goal: 'retained child' });
      f.store.update(root.id, { status: 'waiting', head_commit: root.base_commit });
      f.store.update(child.id, { status: 'failed', head_commit: child.base_commit });
      f.store.run('CREATE TABLE runner_bindings(worker_id INTEGER PRIMARY KEY)');
      f.store.run('INSERT INTO runner_bindings VALUES (?)', target === 'root' ? root.id : child.id);
      const retained = ['tasks', 'messages', 'events', 'runner_bindings'].map(table => f.store.all(`SELECT * FROM ${table} ORDER BY rowid`));
      await expect(client.request('worker.accept_preview', { id: root.id })).rejects.toThrow('retired');
      await expect(client.request('worker.accept_force', { id: root.id, revision: '0'.repeat(64), confirm: true })).rejects.toThrow('retired');
      expect(['tasks', 'messages', 'events', 'runner_bindings'].map(table => f.store.all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(retained);
      expect(fs.existsSync(root.workspace)).toBe(true); expect(fs.existsSync(child.workspace)).toBe(true);
    } finally { await rpc.close(); await f.close(); }
  }
});

test('Host service ignores and preserves invalid retired private files while ordinary shared settings work', async () => {
  const root = temp(), service = new DeviceSettingsService(env({ LUSH_GLOBAL_CONFIG: root }));
  const preserved = legacyFiles(service.config.home);
  try {
    expect([...DEVICE_SETTINGS_READS.keys()].some(key => key.startsWith('runner/'))).toBe(false);
    expect([...DEVICE_SETTINGS_ACTIONS].some(key => key.startsWith('runner.'))).toBe(false);
    for (const method of retiredMethods) await expect(service.request(method)).rejects.toThrow('not allowed');
    expect((await service.request('system.settings')).call_timeout.value).toBeGreaterThan(0);
    expect((await service.request('system.configure', { settings: { call_timeout: 17 } })).call_timeout.value).toBe(17);
    expect((await service.request('system.settings')).call_timeout.value).toBe(17);
    expect(service.runners).toBeUndefined(); preserved();
  } finally { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('authenticated project and Host HTTP reject retired routes/actions/selections and preserve private legacy files', async () => {
  const f = await setup(); f.project.kick = () => {};
  const root = temp(), host = startTestWeb(null, 0, { env: env({ LUSH_GLOBAL_CONFIG: root }) });
  const url = `http://127.0.0.1:${host.port}`, preserved = legacyFiles(path.join(root, 'shared'));
  try {
    for (const suffix of ['nodes','credentials','deployments','project','ssh/aliases']) {
      expect((await fetch(f.url + '/api/runner/' + suffix)).status).toBe(404);
      expect((await fetch(url + '/api/host/settings/runner/' + suffix)).status).toBe(404);
    }
    for (const method of retiredMethods) {
      expect((await post(f.url + '/api/action', method, {})).status).toBe(400);
      expect((await post(url + '/api/host/settings/action', method, {})).status).toBe(400);
    }
    for (const method of selectionMethods) {
      const response = await post(f.url + '/api/action', method, { runner_node_id: 'local' });
      expect(response.status).toBe(400); expect((await response.json()).error).toContain('retired');
    }
    const saved = await post(url + '/api/host/settings/action', 'system.configure', { settings: { call_timeout: 19 } });
    expect(saved.status).toBe(200); expect((await saved.json()).call_timeout.value).toBe(19);
    expect((await (await fetch(url + '/api/host/settings/runtime')).json()).call_timeout.value).toBe(19);
    expect(f.store.all('SELECT * FROM drafts')).toEqual([]); preserved();
  } finally { await host.stop(true); await f.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
