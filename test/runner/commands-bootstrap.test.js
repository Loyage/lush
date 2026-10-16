import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RunnerNode } from '../../src/runner/node.js';
import { createCommandService } from '../../src/runner/commands.js';
import { observeBootstrap } from '../../src/runner/command-bootstrap.js';
import { hash } from '../../src/runner/protocol.js';
import { fixtureProcessAdapter } from './fixtures/command-process-adapter.js';

async function until(read, predicate) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read(); if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error('bootstrap fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function running(pid) {
  try { return !['Z', 'X'].includes(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]); }
  catch { return false; }
}
async function fixture(mode, params = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-bootstrap-barrier-'));
  const machine_token = hash('bootstrap-machine'), control_token = hash('bootstrap-control');
  const node = new RunnerNode({ root, node_id: 'node', machine_token_hash: hash(machine_token),
    projects: { p: { control_token_hash: hash(control_token) } }, memory_reserve_bytes: 0 });
  const adapter = fixtureProcessAdapter({ guard_mode: mode });
  const launch = adapter.launch; let guard;
  adapter.launch = options => { guard = launch(options); return guard; };
  const command = createCommandService({ store: node.store, config: node.config, process_adapter: adapter });
  node.services = { ...command.services, check_context() {} }; node.preflight = command.preflight;
  const session = node.openSession(); let seq = 0;
  const identity = { project_id: 'p', node_id: 'node', runner_id: node.runner_id, worker_id: 1, workspace_id: 'w', generation: 1, operation_id: 'op' };
  const call = async (method, params = {}) => {
    const response = await node.dispatch({ version: 1, request_id: `request-${++seq}`, method, params, identity,
      auth: { machine_token, control_token } }, session);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  };
  const workspace = await call('workspace.register');
  const started = await call('command.start', { script: 'ignored by fixture', ...params });
  const row = () => node.store.db.query('SELECT * FROM executions WHERE execution_id=?').get(started.execution_id);
  return { node, session, call, workspace, id: started.execution_id, row, cutGuardInput: () => guard.stdin.end(),
    async close() { await node.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const stopping of ['cancel', 'eof', 'timeout']) test(`delayed real bootstrap cannot attach or execute after early ${stopping} stop receipt`, async () => {
  const f = await fixture('delayed-attach', stopping === 'timeout' ? { command_ms: 1000 } : {});
  try {
    const ready = path.join(f.workspace.directory, 'bootstrap-ready');
    await until(() => fs.existsSync(ready), Boolean);
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    expect(running(pid)).toBe(true);
    if (stopping === 'cancel') expect((await f.call('command.cancel', { execution_id: f.id })).stop_confirmed).toBe(true);
    else {
      if (stopping === 'eof') f.cutGuardInput(); // Pipe EOF only: node session/DB authorization remain active.
      await until(f.row, row => Boolean(row.stop_confirmed));
      expect(f.row().reason).toBe(stopping === 'eof' ? 'disconnected' : 'timeout');
    }
    expect(f.row().stop_confirmed).toBe(1);
    expect(JSON.parse(f.row().spec_json).bootstrap_state).toBe('exited');
    expect(running(pid)).toBe(false);
    fs.writeFileSync(path.join(f.workspace.directory, 'release-bootstrap'), 'release after stop');
    expect(fs.existsSync(path.join(f.workspace.directory, 'late-execution'))).toBe(false);
  } finally { await f.close(); }
});

test('repeated stop requests do not rewrite the stopping row or starve watchdog exit confirmation', async () => {
  const f = await fixture('delayed-attach');
  try {
    await until(() => fs.existsSync(path.join(f.workspace.directory, 'bootstrap-ready')), Boolean);
    f.node.store.db.exec(`CREATE TABLE test_stop_updates (count INTEGER);
      INSERT INTO test_stop_updates VALUES (0);
      CREATE TRIGGER test_stop_update AFTER UPDATE OF state ON executions WHEN NEW.state='stopping'
      BEGIN UPDATE test_stop_updates SET count=count+1; END;`);
    const key = f.row().workspace_key;
    await Promise.all(Array.from({ length: 16 }, () => f.node.services.stop_workspace(key)));
    expect(f.node.store.db.query('SELECT count FROM test_stop_updates').get().count).toBe(1);
    expect(f.row().stop_confirmed).toBe(1);
  } finally { await f.close(); }
});

test('launch initialization failure still terminates the captured live bootstrap before confirming empty containment', async () => {
  const f = await fixture('throw-after-spawn');
  try {
    const row = await until(f.row, value => value.state === 'unknown');
    expect(row.stop_confirmed).toBe(1);
    expect(row.reason).toBe('guard_error');
    const spec = JSON.parse(row.spec_json);
    expect(spec.bootstrap_state).toBe('exited');
    expect(running(spec.containment.pid)).toBe(false);
    expect(f.node.store.workspace(JSON.parse(row.identity_json)).busy_request).not.toBeNull();
  } finally { await f.close(); }
});

test('empty containment never changes an unconfirmed bootstrap exit into stop_confirmed in catch handling', async () => {
  const f = await fixture('unconfirmed-bootstrap');
  try {
    await until(f.row, row => row.state === 'running');
    const result = await f.call('command.cancel', { execution_id: f.id });
    expect(result.stop_confirmed).toBe(false); expect(result.state).toBe('unknown');
    expect(JSON.parse(f.row().spec_json).bootstrap_state).toBe('pending');
    expect(f.node.store.workspace(JSON.parse(f.row().identity_json)).busy_request).not.toBeNull();
  } finally {
    // Synthetic ChildProcess has no OS process; remove only this test's pending teardown barrier.
    f.node.store.db.query('UPDATE executions SET stop_confirmed=1 WHERE execution_id=?').run(f.id);
    await f.close();
  }
});

test('bootstrap output listeners are detached after bounded drain before Store teardown', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { this.signalCode = 'SIGKILL'; this.emit('exit', null, 'SIGKILL'); return true; } });
  let calls = 0;
  const observer = observeBootstrap(child, () => { calls++; });
  child.stdout.emit('data', Buffer.from('before'));
  await observer.terminate(30);
  expect(await observer.drain(10)).toBe(false);
  observer.detachOutput();
  expect(child.stdout.listenerCount('data')).toBe(0); expect(child.stderr.listenerCount('data')).toBe(0);
  child.stdout.emit('data', Buffer.from('after closed store')); child.stderr.emit('data', Buffer.from('after'));
  expect(calls).toBe(1);
  child.stdout.destroy(); child.stderr.destroy();
});
