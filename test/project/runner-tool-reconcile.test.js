import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import path from 'node:path';
import { runnerProject } from './fixtures/runner-project.js';
import { until, env, gate } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { runnerIdentity } from '../../src/core/runner-service.js';
import { hash, OPERATIONS, definitiveRunnerRejection } from '../../src/runner/protocol.js';
import { REMOTE_RUNNER_METHODS } from '../../src/agent/remote-contract.js';
import { startTestWeb, fetch } from '../web/auth-fixture.js';

test('every registered Bridge Runner mutation belongs to the journal evidence set', () => {
  expect(REMOTE_RUNNER_METHODS.filter(method => OPERATIONS[method].mutation).sort())
    .toEqual(Object.keys(OPERATIONS).filter(method => OPERATIONS[method].tool_effect).sort());
});

test('timeout, cancellation and unknown transport failures never prove a no-effect rejection', () => {
  for (const code of ['TIMEOUT', 'CANCELLED', 'UNKNOWN', 'UNAVAILABLE', 'INTERNAL', 'future-code'])
    expect(definitiveRunnerRejection({ code, runner_response: true })).toBe(false);
  expect(definitiveRunnerRejection({ code: 'CONFLICT' })).toBe(false);
  expect(definitiveRunnerRejection({ code: 'CONFLICT', runner_response: true })).toBe(true);
});

async function failedWrite({ beforeStart, dropAck = true } = {}) {
  let dropped, forbiddenWrites = 0, invocations = 0, sentWrites = 0;
  const f = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token), context = await bridge.call('context');
    if (++invocations === 1) {
      try { await bridge.call('tool', { name: 'write', args: { path: 'ack-lost.txt', content: 'accepted exactly once', context_ack: context.fingerprint } }); }
      catch (error) {
        await expect(bridge.call('tool', { name: 'write', args: { path: 'forbidden.txt', content: 'no', context_ack: context.fingerprint } })).rejects.toThrow();
        throw error;
      }
    } else {
      const read = await bridge.call('tool', { name: 'read', args: { path: 'ack-lost.txt' } });
      expect(read.content[0].text).toContain('accepted exactly once');
      await bridge.call('tool', { name: 'bash', args: { command: 'git add ack-lost.txt && git -c user.name=Fixture -c user.email=fixture@invalid commit -m recovered', context_ack: context.fingerprint } });
    }
    return 'completed';
  } }, { async intercept(frame, request) {
    if (frame.method === 'file.write') sentWrites++;
    if (frame.method === 'file.write' && frame.params.path === 'forbidden.txt') forbiddenWrites++;
    const response = await request();
    if (dropAck && !dropped && frame.method === 'file.write') {
      dropped = { request_id: frame.request_id, identity: frame.identity };
      throw Object.assign(new Error('fixture ACK lost'), { code: 'UNKNOWN' });
    }
    return response;
  } });
  try {
    beforeStart?.(f);
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'write ACK loss', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => !f.project.running.has(sent.task.id) && f.store.task(sent.task.id).calls === 1, 8000);
    expect(f.store.runnerBinding(sent.task.id).state).toBe('unknown');
    expect(forbiddenWrites).toBe(0);
    return { ...f, id: sent.task.id, dropped, sentWrites: () => sentWrites };
  } catch (error) { await f.close(); throw error; }
}
const params = f => ({ id: f.id, expected_revision: f.store.runnerBinding(f.id).revision });

test('real Bridge write ACK loss -> reopened central Store -> user CLI verify -> preserved dirty file -> separate explicit retry', async () => {
  const f = await failedWrite();
  let store, project, rpc;
  try {
    const receipt = f.store.runnerReceipt(f.dropped.request_id);
    expect(receipt).toMatchObject({ kind: 'tool', state: 'unknown', data: { method: 'file.write', path_hash: hash('ack-lost.txt') } });
    expect(JSON.stringify(receipt)).not.toContain('accepted exactly once');
    await expect(f.dispatcher.dispatch('runner.worker.reconcile', { id: f.id, expected_revision: f.store.runnerBinding(f.id).revision - 1 })).rejects.toThrow('revision');
    await f.service.close();
    store = new Store(path.join(f.config.home, 'project.db'), f.root);
    project = new Project(f.config, store, f.project.provider, { runner: f.project.runnerOptions });
    const dispatcher = new Dispatcher(project, { isRequested: () => false });
    rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../../bin/lush'), '--project', f.root, '--json',
      'runner', 'worker', 'reconcile', String(f.id), '--expected-revision', String(store.runnerBinding(f.id).revision)],
    { cwd: f.root, env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(JSON.parse(out)).toMatchObject({ worker_id: f.id, reconciled: true, state: 'ready', pending: 0 });
    expect(out).not.toContain(f.dropped.request_id);
    expect(store.task(f.id)).toMatchObject({ status: 'failed', calls: 1 });
    expect(await dispatcher.dispatch('runner.worker.reconcile', { id: f.id, expected_revision: store.runnerBinding(f.id).revision }))
      .toMatchObject({ reconciled: true, pending: 0 }); // repeat observation, never replay a write or release twice
    const connection = await project.runners.connect(runnerIdentity(store.runnerBinding(f.id), { operation_id: 'test-read' }), { observation: true });
    try { expect((await connection.client.call('file.read', { path: 'ack-lost.txt' })).text).toBe('accepted exactly once'); }
    finally { await connection.close(); }
    await dispatcher.dispatch('worker.retry', { id: f.id });
    await until(() => !project.running.has(f.id) && store.runsForTask(f.id).length === 2, 8000);
    expect(store.task(f.id)).toMatchObject({ status: 'waiting', calls: 1, error: null }); // explicit retry starts a new call round
    expect(store.runnerBarriers(f.id)).toEqual({ bindings: [], runs: [], receipts: [] });
  } finally {
    await rpc?.close(); await project?.shutdown(); await project?._runners?.close(); store?.close(); await f.close();
  }
});

test('verification remains blocked when node receipt evidence is missing and does not replay the original write', async () => {
  const f = await failedWrite();
  try {
    const connect = f.service.connect.bind(f.service); let writes = 0;
    f.service.connect = async (...args) => {
      const connection = await connect(...args), call = connection.client.call.bind(connection.client);
      connection.client.call = async (method, ...rest) => {
        if (method === 'file.write') writes++;
        if (method === 'request.status') return { state: 'completed', result: { path: 'ack-lost.txt' } };
        return call(method, ...rest);
      };
      return connection;
    };
    expect(await f.dispatcher.dispatch('runner.worker.reconcile', params(f))).toMatchObject({ reconciled: false, state: 'unknown' });
    expect(writes).toBe(0); expect(f.store.task(f.id).calls).toBe(1);
    expect(f.store.runnerReceipt(f.dropped.request_id).terminal).toBe(0);
  } finally { await f.close(); }
});

for (const phase of ['prepare', 'ack']) test(`central ${phase} persistence failure never permits unjournaled writes or false success`, async () => {
  let restore;
  const f = await failedWrite({ dropAck: false, beforeStart(f) {
    const method = phase === 'prepare' ? 'createRunnerReceipt' : 'updateRunnerReceipt';
    const original = f.store[method].bind(f.store); let failed = false;
    f.store[method] = (...args) => {
      const tool = phase === 'prepare' ? args[0].kind === 'tool' : f.store.runnerReceipt(args[0].request_id)?.kind === 'tool' && args[1].state === 'completed';
      if (tool && !failed) { failed = true; throw new Error('fixture journal persistence failure'); }
      return original(...args);
    };
    restore = () => { f.store[method] = original; };
  } });
  try {
    restore();
    expect(f.sentWrites()).toBe(phase === 'prepare' ? 0 : 1);
    const result = await f.dispatcher.dispatch('runner.worker.reconcile', params(f));
    expect(result.reconciled).toBe(true); // zero issued tools is a durable new-journal fact, not legacy inference
    expect(f.store.get('SELECT tool_count FROM runner_runs WHERE worker_id=?', f.id).tool_count).toBe(phase === 'prepare' ? 0 : 1);
    expect(f.store.task(f.id).calls).toBe(1);
  } finally { restore?.(); await f.close(); }
});

for (const fault of ['identity', 'epoch', 'digest', 'incomplete_history', 'unjournaled', 'missing', 'no_central', 'offline', 'legacy', 'independent_sync']) {
  test(`explicit verification preserves barriers for ${fault}, without replay or model admission`, async () => {
    const f = await failedWrite();
    try {
      const connect = f.service.connect.bind(f.service);
      if (fault === 'legacy') f.store.run('UPDATE runner_runs SET tool_journal=NULL WHERE worker_id=?', f.id);
      if (fault === 'missing') {
        const node = new Database(path.join(f.config.home, 'node-A', 'runner.db'));
        try { node.query('DELETE FROM requests WHERE request_id=?').run(f.dropped.request_id); } finally { node.close(); }
      }
      if (fault === 'no_central') f.store.run('DELETE FROM runner_receipts WHERE request_id=?', f.dropped.request_id);
      if (fault === 'independent_sync') f.store.event(f.id, 'task.runner_parent_sync_prepared', { request_id: 'independent-sync' });
      f.service.connect = async (...args) => {
        if (fault === 'offline') throw new Error('fixture offline');
        const connection = await connect(...args), call = connection.client.call.bind(connection.client);
        let inspections = 0;
        connection.client.call = async (method, ...values) => {
          const result = await call(method, ...values);
          if (fault === 'epoch' && method === 'workspace.inspect' && ++inspections > 1) result.last_run_id++;
          if (method === 'request.status') {
            if (fault === 'identity') result.identity = { ...result.identity, generation: result.identity.generation + 1 };
            if (fault === 'digest') result.fingerprint = '0'.repeat(64);
            if (fault === 'incomplete_history') result.history.truncated = true;
            if (fault === 'unjournaled') { result.history.requests.push({ request_id: 'unowned-request', method: 'file.write', fingerprint: '1'.repeat(64) }); result.history.total++; }
          }
          return result;
        };
        return connection;
      };
      expect(await f.dispatcher.dispatch('runner.worker.reconcile', params(f))).toMatchObject({ reconciled: false, state: 'unknown' });
      if (fault === 'no_central') expect(f.store.runnerReceipt(f.dropped.request_id)).toBeNull();
      else expect(f.store.runnerReceipt(f.dropped.request_id).terminal).toBe(0);
      expect(f.sentWrites()).toBe(1); expect(f.store.task(f.id).calls).toBe(1);
    } finally { await f.close(); }
  });
}

test('verification gate excludes concurrent verification/retry/acceptance and rejects generation drift before publication', async () => {
  const f = await failedWrite(), reached = gate(), release = gate();
  let operation;
  try {
    const connect = f.service.connect.bind(f.service);
    f.service.connect = async (...args) => {
      const connection = await connect(...args), call = connection.client.call.bind(connection.client);
      connection.client.call = async (method, ...values) => {
        if (method === 'request.status') { reached.resolve(); await release.promise; }
        return call(method, ...values);
      };
      return connection;
    };
    operation = f.dispatcher.dispatch('runner.worker.reconcile', params(f));
    await reached.promise;
    expect(f.project.workspaces.pending).toBe(0); expect(f.store.db.inTransaction).toBe(false);
    await expect(f.dispatcher.dispatch('runner.worker.reconcile', params(f))).rejects.toThrow('in flight');
    await expect(f.dispatcher.dispatch('worker.retry', { id: f.id })).rejects.toThrow('in flight');
    await expect(f.dispatcher.dispatch('worker.accept', { id: f.id })).rejects.toThrow('in flight');
    f.store.run('UPDATE runner_bindings SET generation=generation+1,revision=revision+1 WHERE worker_id=?', f.id);
    release.resolve();
    expect(await operation).toMatchObject({ reconciled: false, state: 'unknown' });
    expect(f.store.runnerReceipt(f.dropped.request_id).terminal).toBe(0);
    expect(f.project.taskSyncBusy.has(f.id)).toBe(false);
  } finally { release.resolve(); await operation?.catch(() => {}); await f.close(); }
});

test('revoked project authorization permits fixed evidence verification but not a new retry invocation', async () => {
  const f = await failedWrite();
  try {
    const policy = f.service.readPolicy();
    await f.service.savePolicy({ allowed_node_ids: [], default_node_id: 'local' }, policy.revision);
    expect(await f.dispatcher.dispatch('runner.worker.reconcile', params(f))).toMatchObject({ reconciled: true, state: 'ready' });
    await expect(f.dispatcher.dispatch('worker.retry', { id: f.id })).rejects.toThrow();
    expect(f.store.task(f.id)).toMatchObject({ status: 'failed', calls: 1 });
  } finally { await f.close(); }
});

test('authenticated project HTTP exposes verification, while anonymous/foreign Origin and device Host cannot execute it', async () => {
  const f = await failedWrite(), rpc = new RPCServer(f.config.socket, f.dispatcher);
  await rpc.start();
  const web = startTestWeb(f.config), host = startTestWeb(null, 0, { env: f.config.env });
  const body = JSON.stringify({ method: 'runner.worker.reconcile', params: params(f) });
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  try {
    const url = `http://127.0.0.1:${web.port}/api/action`;
    expect((await fetch(url, { ...options, anonymous: true })).status).toBe(401);
    expect((await fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://evil.invalid' } })).status).toBe(403);
    const result = await fetch(url, options);
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ reconciled: true, state: 'ready' });
    expect((await fetch(`http://127.0.0.1:${host.port}/api/host/settings/action`, options)).status).toBe(400);
    expect(f.store.task(f.id)).toMatchObject({ calls: 1, status: 'failed' });
  } finally { await web.stop(true); await host.stop(true); await rpc.close(); await f.close(); }
});
