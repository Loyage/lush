import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RunnerStore } from '../../src/runner/store.js';
import { hash } from '../../src/runner/protocol.js';

function host(root) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/command-fixture-host.js', import.meta.url)), root], {
    env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  const input = createInterface({ input: child.stdout });
  input.on('line', line => {
    const response = JSON.parse(line), waiter = pending.get(response.request_id);
    if (!waiter) return; pending.delete(response.request_id);
    if (response.error) waiter.reject(new Error(JSON.stringify(response.error))); else waiter.resolve(response.result);
  });
  const exit = new Promise(resolve => child.once('close', (code, signal) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`fixture host exited ${code ?? signal}`));
    pending.clear(); resolve(code);
  }));
  child.stdin.on('error', () => {});
  return { child, exit, call(worker, method, params = {}) {
    const request_id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(request_id, { resolve, reject });
      child.stdin.write(JSON.stringify({ version: 1, request_id, method, params,
        identity: { project_id: 'p', node_id: 'node', worker_id: worker, workspace_id: `workspace-${worker}`, generation: 1, operation_id: `op-${worker}` },
        auth: { machine_token: hash('fixture-machine'), control_token: hash('fixture-control') } }) + '\n');
    });
  }, async close() { if (child.exitCode === null && child.signalCode === null) child.stdin.end(); await exit; input.close(); } };
}
async function until(read, predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fixture timed out');
}
const command = (h, worker, script) => h.call(worker, 'command.start', { script, context_ack: 'test-context' });

test('two independent node processes share one SQLite admission slot; queued cancellation survives first exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-command-cross-process-'));
  // Admission test uses a provisioned Store. Concurrent cold bootstrap is a separate
  // shared Store defect reported to W298-3, not hidden as command admission coverage.
  new RunnerStore(root).close();
  const a = host(root), b = host(root);
  try {
    await a.call(1, 'workspace.register'); const secondWorkspace = await b.call(2, 'workspace.register');
    const first = await command(a, 1, 'printf ready; sleep 30');
    await until(() => a.call(1, 'command.status', { execution_id: first.execution_id }), value => value.state === 'running');
    const second = await command(b, 2, 'touch must-not-start');
    expect((await b.call(2, 'command.status', { execution_id: second.execution_id })).state).toBe('queued');
    expect((await b.call(2, 'command.cancel', { execution_id: second.execution_id })).stop_confirmed).toBe(true);
    await a.call(1, 'command.cancel', { execution_id: first.execution_id });
    const next = await command(b, 2, 'printf okay');
    expect((await until(() => b.call(2, 'command.status', { execution_id: next.execution_id }), value => value.stop_confirmed)).exit_code).toBe(0);
    expect(fs.existsSync(path.join(secondWorkspace.directory, 'must-not-start'))).toBe(false);
  } finally { await a.close(); await b.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('SIGKILL of node process closes guard pipe, independently stops descendants and persists receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-command-parent-death-'));
  const h = host(root); let store;
  try {
    const workspace = await h.call(1, 'workspace.register');
    const started = await command(h, 1, 'sleep 30 & echo $! > child.pid; echo READY; wait');
    await until(() => h.call(1, 'command.output', { execution_id: started.execution_id }), value => value.chunks.some(chunk => Buffer.from(chunk.data, 'base64').toString().includes('READY')));
    const descendant = Number(fs.readFileSync(path.join(workspace.directory, 'child.pid'), 'utf8'));
    h.child.kill('SIGKILL'); await h.exit;
    store = new RunnerStore(root);
    const end = await until(() => store.db.query('SELECT * FROM executions WHERE execution_id=?').get(started.execution_id), value => value.stop_confirmed);
    expect(end.reason).toBe('disconnected'); expect(end.output_complete).toBe(1);
    let state = 'gone'; try { state = fs.readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1][0]; } catch {}
    expect(['gone', 'Z', 'X']).toContain(state);
    expect(store.db.query('SELECT busy_request FROM workspaces').get().busy_request).toBeNull();
  } finally { await h.close(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
