import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerNode } from '../../src/runner/node.js';
import { createCommandService } from '../../src/runner/commands.js';
import { outputStorageUsed, OUTPUT_CHUNK_STORAGE_BYTES } from '../../src/runner/command-state.js';
import { hash, check, workspaceKey } from '../../src/runner/protocol.js';
import { fixtureProcessAdapter } from './fixtures/command-process-adapter.js';

const machine = hash('fixture-machine'), control = hash('fixture-control'), runToken = hash('fixture-run');
function fixture({ root: supplied, max_commands = 1, adapter = fixtureProcessAdapter(), output_storage_bytes, budgets } = {}) {
  const root = supplied ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lush-command-'));
  const config = { root, node_id: 'node', machine_token_hash: hash(machine), projects: { p: { control_token_hash: hash(control) } },
    cgroup_root: '/not-a-real-cgroup', max_commands, memory_reserve_bytes: 512 * 1024 * 1024, output_storage_bytes, budgets };
  const node = new RunnerNode(config);
  const command = createCommandService({ store: node.store, config: node.config, process_adapter: adapter });
  node.preflight = command.preflight;
  node.services = { ...command.services, check_context: (_, params) => check(params.context_ack === 'test-context', 'CONTEXT_REQUIRED', 'Context acknowledgement required') };
  const session = node.openSession(); let seq = 0;
  const identity = worker => ({ project_id: 'p', node_id: 'node', runner_id: node.runner_id, worker_id: worker, workspace_id: `workspace-${worker}`, generation: 1, operation_id: `control-${worker}` });
  const frame = (worker, method, params = {}, patch = {}) => ({ version: 1, request_id: `${session}-${++seq}`,
    identity: identity(worker), auth: { machine_token: machine, control_token: control }, method, params, ...patch });
  const dispatch = (worker, method, params, patch) => node.dispatch(frame(worker, method, params, patch), session);
  const call = async (...args) => {
    const response = await dispatch(...args);
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  };
  const start = (worker, params = {}, patch) => call(worker, 'command.start', { context_ack: 'test-context', script: 'printf hello', ...params }, patch);
  return { root, node, command, session, identity, frame, dispatch, call, start,
    register: worker => call(worker, 'workspace.register'),
    close: async () => { await node.close(); if (!supplied) fs.rmSync(root, { recursive: true, force: true }); } };
}
async function until(read, condition, timeout = 3500) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read(); if (condition(value)) return value;
    if (Date.now() >= deadline) throw new Error('condition did not complete: ' + JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const stopped = (f, worker, execution_id) => until(() => f.call(worker, 'command.status', { execution_id }), value => value.stop_confirmed);
const outputText = result => result.chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString('utf8')).join('');

test('real Runner authority → durable start → independent guard → output/stop receipt', async () => {
  const f = fixture();
  try {
    await f.register(1);
    const rejected = await f.dispatch(1, 'command.start', { script: 'touch forbidden' });
    expect(rejected.error.code).toBe('CONTEXT_REQUIRED');
    const started = await f.start(1, { script: 'printf "hello\n"; printf "diagnostic\n" >&2; exit 7' });
    expect(started.state).toBe('queued');
    const end = await stopped(f, 1, started.execution_id);
    expect(end.state).toBe('exited'); expect(end.exit_code).toBe(7); expect(end.reason).toBe('exit');
    expect(end.stop_confirmed).toBe(true);
    const output = await f.call(1, 'command.output', { execution_id: started.execution_id });
    expect(outputText(output)).toContain('hello'); expect(outputText(output)).toContain('diagnostic');
    expect(output.complete).toBe(true); expect(output.gap).toBe(false);
    expect((await f.call(1, 'workspace.barrier')).stopped).toBe(true);
  } finally { await f.close(); }
});

test('ACK loss and duplicate request return one execution, mismatched parameters refuse', async () => {
  const f = fixture();
  try {
    const workspace = await f.register(1);
    const req = f.frame(1, 'command.start', { script: 'echo one >> count', context_ack: 'test-context' });
    const ack = await f.node.dispatch(req, f.session); // caller could lose this ACK
    expect(await f.node.dispatch(req, f.session)).toEqual(ack);
    await stopped(f, 1, ack.result.execution_id);
    expect(await f.node.dispatch(req, f.session)).toEqual(ack);
    expect((await f.node.dispatch({ ...req, params: { ...req.params, script: 'echo two >> count' } }, f.session)).error.code).toBe('CONFLICT');
    expect(fs.readFileSync(path.join(workspace.directory, 'count'), 'utf8')).toBe('one\n');
    expect((await f.call(1, 'request.status', { request_id: req.request_id })).result.execution_id).toBe(ack.result.execution_id);
  } finally { await f.close(); }
});

test('node-global slot is shared by independent service connections and queued cancel never starts', async () => {
  const f = fixture(), other = fixture({ root: f.root });
  try {
    await f.register(1); const workspace2 = await other.register(2);
    const a = await f.start(1, { script: 'printf ready; sleep 30' });
    await until(() => f.call(1, 'command.output', { execution_id: a.execution_id }), value => outputText(value).includes('ready'));
    const b = await other.start(2, { script: 'touch must-not-exist' });
    expect((await other.call(2, 'command.status', { execution_id: b.execution_id })).state).toBe('queued');
    expect((await other.call(2, 'command.cancel', { execution_id: b.execution_id })).stop_confirmed).toBe(true);
    const cancel = await f.call(1, 'command.cancel', { execution_id: a.execution_id });
    expect(cancel.reason).toBe('cancelled'); expect(cancel.stop_confirmed).toBe(true);
    const c = await other.start(2, { script: 'printf next' }); await stopped(other, 2, c.execution_id);
    expect(fs.existsSync(path.join(workspace2.directory, 'must-not-exist'))).toBe(false);
  } finally { await other.close(); await f.close(); }
});

test('watchdog distinguishes timeout and cleans same-group background writers', async () => {
  const f = fixture();
  try {
    const workspace = await f.register(1);
    const command = await f.start(1, { script: 'sleep 30 & echo $! > child.pid; wait', command_ms: 100 });
    const end = await stopped(f, 1, command.execution_id);
    expect(end.reason).toBe('timeout'); expect(end.stop_confirmed).toBe(true);
    const pid = Number(fs.readFileSync(path.join(workspace.directory, 'child.pid'), 'utf8'));
    let state = 'gone'; try { state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]; } catch {}
    expect(['gone', 'Z', 'X']).toContain(state);
  } finally { await f.close(); }
});

test('lease revocation and expired queue prevent new execution and reject old invocation writes', async () => {
  const f = fixture({ adapter: fixtureProcessAdapter({ available_memory: 0 }) });
  try {
    const workspace = await f.register(1);
    await f.call(1, 'lease.grant', { run_id: 1, run_token: runToken, ttl_ms: 200 });
    const { operation_id, ...base } = f.identity(1);
    const run = { identity: { ...base, run_id: 1 }, auth: { machine_token: machine, run_token: runToken } };
    const command = await f.start(1, { script: 'touch forbidden', queue_ms: 1000 }, run);
    const end = await stopped(f, 1, command.execution_id);
    expect(end.reason).toBe('revoked'); expect(end.started_at).toBeNull();
    expect(fs.existsSync(path.join(workspace.directory, 'forbidden'))).toBe(false);
    expect((await f.dispatch(1, 'command.start', { script: 'true', context_ack: 'test-context' }, run)).error.code).toBe('UNAUTHORIZED');
  } finally { await f.close(); }
});

test('explicit revocation stops an already running invocation before the workspace can be leased again', async () => {
  const f = fixture();
  try {
    await f.register(1);
    await f.call(1, 'lease.grant', { run_id: 1, run_token: runToken });
    const { operation_id, ...base } = f.identity(1);
    const run = { identity: { ...base, run_id: 1 }, auth: { machine_token: machine, run_token: runToken } };
    const started = await f.start(1, { script: 'printf READY; sleep 30' }, run);
    await until(() => f.call(1, 'command.output', { execution_id: started.execution_id }), value => outputText(value).includes('READY'));
    const barrier = await f.call(1, 'lease.revoke');
    expect(barrier.stopped).toBe(true);
    const end = await f.call(1, 'command.status', { execution_id: started.execution_id });
    expect(end.reason).toBe('revoked'); expect(end.stop_confirmed).toBe(true);
    expect((await f.dispatch(1, 'command.start', { script: 'true', context_ack: 'test-context' }, run)).error.code).toBe('UNAUTHORIZED');
    expect((await f.call(1, 'lease.grant', { run_id: 2, run_token: hash('fixture-new-run') })).run_id).toBe(2);
  } finally { await f.close(); }
});

test('memory reserve admission and queue budget are distinct from execution timeout', async () => {
  const f = fixture({ adapter: fixtureProcessAdapter({ available_memory: 1 }) });
  try {
    await f.register(1);
    const command = await f.start(1, { queue_ms: 40 });
    const end = await stopped(f, 1, command.execution_id);
    expect(end.reason).toBe('queue_timeout'); expect(end.started_at).toBeNull(); expect(end.exit_code).toBeNull();
  } finally { await f.close(); }
});

test('output is bounded, cursor-based, loss-aware, and cannot cross workspace or invocation', async () => {
  const f = fixture();
  try {
    await f.register(1); await f.register(2);
    const command = await f.start(1, { script: 'head -c 100000 /dev/zero', output_bytes: 1000 });
    const end = await stopped(f, 1, command.execution_id);
    expect(end.output_bytes).toBe(1000); expect(end.output_seen).toBe(100000); expect(end.truncated).toBe(true);
    const page = await f.call(1, 'command.output', { execution_id: command.execution_id, limit: 1 });
    expect(page.chunks.reduce((sum, chunk) => sum + Buffer.from(chunk.data, 'base64').length, 0)).toBeLessThanOrEqual(1000);
    expect(page.truncated).toBe(true);
    expect((await f.dispatch(2, 'command.output', { execution_id: command.execution_id })).error.code).toBe('NOT_FOUND');
    f.node.store.db.query('DELETE FROM output_chunks WHERE execution_id=?').run(command.execution_id);
    expect((await f.call(1, 'command.output', { execution_id: command.execution_id })).gap).toBe(true);
    await f.call(1, 'lease.grant', { run_id: 2, run_token: runToken });
    const { operation_id, ...base } = f.identity(1);
    const run = { identity: { ...base, run_id: 2 }, auth: { machine_token: machine, run_token: runToken } };
    expect((await f.dispatch(1, 'command.output', { execution_id: command.execution_id }, run)).error.code).toBe('UNAUTHORIZED');
  } finally { await f.close(); }
});

test('node-wide output capacity is atomically shared, truncates without deleting logs, and blocks new admission', async () => {
  const capacity = 16384;
  const f = fixture({ max_commands: 2, output_storage_bytes: capacity });
  const other = fixture({ root: f.root, max_commands: 2, output_storage_bytes: capacity });
  try {
    await f.register(1); await other.register(2);
    const first = await f.start(1, { script: 'head -c 100000 /dev/zero' });
    const second = await other.start(2, { script: 'head -c 100000 /dev/zero' });
    const completed = await Promise.all([stopped(f, 1, first.execution_id), stopped(other, 2, second.execution_id)]);
    expect(completed.every(row => row.exit_code === 0 && row.stop_confirmed)).toBe(true);
    expect(completed.some(row => row.output_error?.details.scope === 'node_output_storage')).toBe(true);
    expect(outputStorageUsed(f.node.store)).toBeLessThanOrEqual(capacity);
    expect(completed.reduce((sum, row) => sum + row.output_seen, 0)).toBe(200000);
    const retained = f.node.store.db.query('SELECT execution_id,seq,length(data) AS length FROM output_chunks ORDER BY execution_id,seq').all();
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThanOrEqual(Math.floor(capacity / OUTPUT_CHUNK_STORAGE_BYTES));
    expect((await f.dispatch(1, 'command.start', { script: 'echo extra', context_ack: 'test-context' })).error.code).toBe('LIMIT_EXCEEDED');
    expect(f.node.store.db.query('SELECT execution_id,seq,length(data) AS length FROM output_chunks ORDER BY execution_id,seq').all()).toEqual(retained);
  } finally { await other.close(); await f.close(); }
});

test('node budgets cap command defaults and cannot be enlarged by a request', async () => {
  const f = fixture({ budgets: { timeout_ms: 50, output_bytes: 100 } });
  try {
    await f.register(1);
    for (const params of [{ command_ms: 51 }, { output_bytes: 101 }]) {
      expect((await f.dispatch(1, 'command.start', { script: 'true', context_ack: 'test-context', ...params })).error.code).toBe('INVALID_REQUEST');
    }
    const timed = await f.start(1, { script: 'sleep 30' });
    expect((await stopped(f, 1, timed.execution_id)).reason).toBe('timeout');
    const noisy = await f.start(1, { script: 'head -c 1000 /dev/zero' });
    const finished = await stopped(f, 1, noisy.execution_id);
    expect(finished.output_bytes).toBe(100);
    expect(finished.output_error.details.scope).toBe('command_output');
  } finally { await f.close(); }
});

test('shell/argv and environment/cwd validation prevents implicit local authority or credential inheritance', async () => {
  const f = fixture();
  try {
    const workspace = await f.register(1);
    for (const params of [{ script: 'true', argv: ['true'] }, { argv: [] }, { script: 'true', cwd: '../' },
      { script: 'true', env: { OPENAI_API_KEY: 'secret' } }, { script: 'true', env: { PATH: '/tmp' } }]) {
      expect((await f.dispatch(1, 'command.start', { context_ack: 'test-context', ...params })).error).toBeDefined();
    }
    fs.symlinkSync('/tmp', path.join(workspace.directory, 'escape'));
    expect((await f.dispatch(1, 'command.start', { script: 'true', cwd: 'escape', context_ack: 'test-context' })).error.code).toBe('UNAUTHORIZED');
    const cmd = await f.call(1, 'command.start', { argv: ['/bin/sh', '-c', 'test -z "$LUSH_AGENT_TOKEN$OPENAI_API_KEY"; printf "CI=%s" "$CI"'], env: { CI: 'yes' }, context_ack: 'test-context' });
    expect((await stopped(f, 1, cmd.execution_id)).exit_code).toBe(0);
    expect(outputText(await f.call(1, 'command.output', { execution_id: cmd.execution_id }))).toBe('CI=yes');
  } finally { await f.close(); }
});

test('unknown execution retains workspace and node slot after failed ownership reconciliation', async () => {
  const f = fixture({ adapter: fixtureProcessAdapter({ available_memory: 0 }) });
  try {
    await f.register(1); await f.register(2);
    const a = await f.start(1);
    f.node.store.db.query("UPDATE executions SET state='unknown' WHERE execution_id=?").run(a.execution_id);
    const other = fixture({ root: f.root });
    try {
      const b = await other.start(2, { queue_ms: 60 });
      expect((await stopped(other, 2, b.execution_id)).reason).toBe('queue_timeout');
      expect((await other.call(1, 'workspace.barrier')).stopped).toBe(false);
      expect(f.node.store.workspace(f.identity(1)).busy_request).not.toBeNull();
    } finally { await other.close(); }
    // Isolated fixture has never launched; remove the synthetic unknown so teardown does not await a nonexistent guard.
    f.node.store.db.query('UPDATE executions SET stop_confirmed=1 WHERE execution_id=?').run(a.execution_id);
    f.node.store.unlock(workspaceKey(f.identity(1)), f.node.store.workspace(f.identity(1)).busy_request);
  } finally { await f.close(); }
});
