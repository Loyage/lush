import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerNode, RunnerClient, LocalTransport } from '../../src/runner/index.js';
import { createCommandService } from '../../src/runner/commands.js';
import { createFileService } from '../../src/runner/files.js';
import { hash } from '../../src/runner/protocol.js';
import { fixtureProcessAdapter } from './fixtures/command-process-adapter.js';

async function until(read, accept) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = await read(); if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Lease scope condition timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
const runToken = id => hash(`lease-scope-run-${id}`);
async function fixture(running = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-lease-scope-'));
  const auth = { machine_token: hash('lease-scope-machine'), control_token: hash('lease-scope-control') };
  const node = new RunnerNode({ root, node_id: 'node', machine_token_hash: hash(auth.machine_token),
    projects: { project: { control_token_hash: hash(auth.control_token) } }, memory_reserve_bytes: 1 });
  const commands = createCommandService({ store: node.store, config: node.config,
    process_adapter: fixtureProcessAdapter({ available_memory: running ? 1024 ** 3 : 0 }) });
  node.services = { ...commands.services, ...createFileService() }; node.preflight = commands.preflight;
  const identity = { project_id: 'project', node_id: 'node', runner_id: node.runner_id,
    worker_id: 1, workspace_id: 'workspace', generation: 1, operation_id: 'control' };
  const clients = [];
  const connect = async () => {
    const client = new RunnerClient({ transport: new LocalTransport(node), identity, auth });
    clients.push(client); await client.handshake(); return client;
  };
  const control = await connect(); await control.call('workspace.register');
  const row = id => node.store.db.query('SELECT * FROM executions WHERE execution_id=?').get(id);
  return { root, node, control, connect, row,
    resources: id => node.store.db.query('SELECT * FROM command_resources WHERE execution_id=?').get(id) ?? null,
    async grant(id, owner = control) {
      await owner.call('lease.grant', { run_id: id, run_token: runToken(id) });
      return owner.forRun({ run_id: id, run_token: runToken(id) });
    },
    async start(actor) {
      const context = await actor.call('file.context', { scope: 'workspace' });
      const execution = await actor.call('command.start', { script: 'printf READY; sleep 30', context_ack: context.fingerprint });
      if (running) await until(() => row(execution.execution_id), value => value.state === 'running' && value.output_seq > 0);
      else expect(row(execution.execution_id).state).toBe('queued');
      return execution.execution_id;
    },
    async close() { await Promise.all(clients.map(client => client.close())); await node.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

for (const running of [false, true]) for (const target of ['new-run', 'control'])
  test(`late released Run cannot stop ${target} ${running ? 'running' : 'queued'} command or alter its resource receipts`, async () => {
    const f = await fixture(running);
    try {
      const old = await f.grant(1);
      const original = await old.call('lease.release', {}, { request_id: 'original-release' });
      expect(original.stopped).toBe(true);
      const current = target === 'new-run' ? await f.grant(2) : f.control;
      const id = await f.start(current), before = f.row(id), resources = f.resources(id);
      const late = await old.call('lease.release', {}, { request_id: 'late-release' });
      expect(late).toMatchObject({ stopped: false, busy: true, total: 1, executions: [] });
      expect(f.row(id)).toMatchObject({ state: before.state, reason: null, stop_confirmed: 0, lease_id: before.lease_id });
      expect(f.resources(id)).toEqual(resources);
      if (target === 'new-run') expect(f.node.store.lease(current.identity).revoked).toBe(0);
      expect(await old.call('lease.release', {}, { request_id: 'late-release' })).toEqual(late);
      // Idempotent mutation receipts remain historical snapshots, not fresh idle observations.
      expect(await old.call('lease.release', {}, { request_id: 'original-release' })).toEqual(original);
      expect((await old.call('workspace.barrier')).stopped).toBe(false);
      await expect(old.call('command.cancel', { execution_id: id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(old.call('command.output', { execution_id: id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(old.call('lease.revoke')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(f.row(id).stop_confirmed).toBe(0);
      expect((await current.call('lease.release')).stopped).toBe(true);
      expect(f.row(id)).toMatchObject({ state: 'exited', stop_confirmed: 1 });
    } finally { await f.close(); }
  });

for (const running of [false, true]) for (const method of ['lease.release', 'lease.revoke'])
  test(`control ${method} retains workspace-wide authority for ${running ? 'running' : 'queued'} execution`, async () => {
    const f = await fixture(running);
    try {
      const run = await f.grant(1), id = await f.start(run);
      expect((await f.control.call(method)).stopped).toBe(true);
      expect(f.node.store.lease(run.identity).revoked).toBe(1);
      expect(f.row(id)).toMatchObject({ state: 'exited', stop_confirmed: 1 });
    } finally { await f.close(); }
  });

test('expired Run release and old connection disconnect cannot stop a newer Run on another session', async () => {
  const f = await fixture(true);
  try {
    const old = await f.grant(1), expired = f.node.store.lease(old.identity);
    // Advance just this isolated lease's clock deterministically; do not wait out the product TTL.
    f.node.store.db.query('UPDATE leases SET expires_at=? WHERE lease_id=?').run(Date.now() - 1, expired.lease_id);
    const second = await f.connect(), current = await f.grant(2, second), id = await f.start(current);
    expect((await old.call('lease.release')).stopped).toBe(false);
    const lateOnNewSession = second.forRun({ run_id: 1, run_token: runToken(1) });
    expect((await lateOnNewSession.call('lease.release')).stopped).toBe(false);
    await expect(lateOnNewSession.call('lease.renew')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(lateOnNewSession.call('file.write', { path: 'intruder', content: 'bad', expected_sha256: null })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await f.control.close();
    expect(f.row(id)).toMatchObject({ state: 'running', stop_confirmed: 0 });
    expect(f.node.store.lease(current.identity).revoked).toBe(0);
    expect((await current.call('lease.release')).stopped).toBe(true);
  } finally { await f.close(); }
});

test('Run release on a reconnected session preserves its unknown execution and the global barrier', async () => {
  const f = await fixture(false); let id;
  try {
    const run = await f.grant(1); id = await f.start(run);
    // Synthetic interrupted start: no OS process is launched with this fixture's zero memory gate.
    f.node.store.db.query("UPDATE executions SET state='unknown' WHERE execution_id=?").run(id);
    const second = await f.connect(), retained = second.forRun({ run_id: 1, run_token: runToken(1) });
    const barrier = await retained.call('lease.release');
    expect(f.node.store.lease(run.identity).revoked).toBe(1);
    expect(barrier).toMatchObject({ stopped: false, busy: true, total: 1 });
    expect(f.row(id)).toMatchObject({ state: 'unknown', stop_confirmed: 0 });
    await expect(f.grant(2, second)).rejects.toMatchObject({ code: 'BUSY' });
  } finally {
    // Remove only this synthetic no-process teardown barrier; never product reconciliation.
    if (id) f.node.store.db.query('UPDATE executions SET stop_confirmed=1 WHERE execution_id=?').run(id);
    await f.close();
  }
});
