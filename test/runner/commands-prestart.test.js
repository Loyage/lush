import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { RunnerClient, StdioTransport } from '../../src/runner/index.js';
import { hash } from '../../src/runner/protocol.js';
import { resourceRow, commandResourceCleanup } from '../../src/runner/command-resources.js';

async function until(read, accept) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = read(); if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Prestart condition timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function guardAlive(gate) {
  try {
    const pid = fs.readFileSync(gate + '.ready', 'utf8');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2)[0]);
  } catch { return false; }
}
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-prestart-stop-')), gate = path.join(root, 'release-guard');
  const nodeRoot = path.join(root, 'node'), file = path.join(root, 'config.json');
  const auth = { machine_token: hash('prestart-machine'), control_token: hash('prestart-control') };
  fs.writeFileSync(file, JSON.stringify({ version: 1, root: nodeRoot, node_id: 'node', cgroup_root: path.join(root, 'fixture-only'),
    machine_token_hash: hash(auth.machine_token), projects: { p: { control_token_hash: hash(auth.control_token) } }, memory_reserve_bytes: 0 }), { mode: 0o600 });
  const transport = new StdioTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/integration-node.js', import.meta.url)), file, 'abort-cancel', gate],
    env: { PATH: '/usr/bin:/bin', HOME: root } });
  const client = new RunnerClient({ transport, auth, identity: { project_id: 'p', node_id: 'node', worker_id: 1,
    workspace_id: 'workspace', generation: 1, operation_id: 'setup' } });
  await client.handshake();
  const workspace = await client.call('workspace.register');
  const run_token = hash('prestart-run'); await client.call('lease.grant', { run_id: 1, run_token });
  const run = client.forRun({ run_id: 1, run_token });
  const context = await run.call('file.context', { scope: 'workspace' });
  const started = await run.call('command.start', { script: 'printf LATE > must-not-exist', context_ack: context.fingerprint });
  await until(() => fs.existsSync(gate + '.ready'), Boolean);
  const db = new Database(path.join(nodeRoot, 'runner.db'));
  db.exec('PRAGMA busy_timeout=5000'); // Match RunnerStore's writer contention policy, not test timeout/retries.
  const row = () => db.query('SELECT * FROM executions WHERE execution_id=?').get(started.execution_id);
  expect(row().state).toBe('starting'); expect(row().started_at).toBeNull();
  return { root, gate, transport, client, run, db, row, workspace, id: started.execution_id,
    release: () => fs.writeFileSync(gate, 'release'),
    async close() {
      fs.writeFileSync(gate, 'release');
      await client.close();
      await until(() => guardAlive(gate), alive => !alive);
      db.close(); fs.rmSync(root, { recursive: true, force: true });
    } };
}

for (const method of ['command.cancel', 'lease.revoke', 'disconnect', 'abort', 'parent-death']) test(`independent Runner ${method} before guard readiness proves no launch and releases the barrier`, async () => {
  const f = await fixture();
  try {
    let stopping;
    if (method === 'command.cancel') stopping = f.run.call(method, { execution_id: f.id });
    else if (method === 'lease.revoke') stopping = f.client.call(method);
    else if (method === 'disconnect') stopping = f.client.close();
    else if (method === 'parent-death') {
      f.transport.child.kill('SIGKILL'); stopping = f.transport.exit;
      await until(() => fs.existsSync(f.gate + '.eof'), Boolean);
      expect(f.row().state).toBe('starting'); // No service remains alive to persist cancellation.
    } else {
      const abort = new AbortController();
      stopping = f.run.call('command.cancel', { execution_id: f.id }, { request_id: 'abort-cancel', signal: abort.signal })
        .then(() => { throw new Error('Dropped ACK unexpectedly delivered'); }, error => { expect(error.code).toBe('UNKNOWN'); });
      // Confirm the command request reached the independent node; its response is deliberately dropped.
      await until(f.row, row => row.state === 'stopping');
      abort.abort();
    }
    if (method !== 'parent-death') await until(f.row, row => row.state === 'stopping');
    expect(f.row().stop_confirmed).toBe(0); // Cancellation by itself is NOT stop proof.
    expect(fs.existsSync(f.gate + '.effects')).toBe(false);
    f.release(); await stopping;
    const row = await until(f.row, row => Boolean(row.stop_confirmed));
    expect(row.state).toBe('exited'); expect(row.started_at).toBeNull();
    expect(JSON.parse(row.spec_json)).toMatchObject({ bootstrap_state: 'not_started' });
    expect(JSON.parse(row.spec_json).guard_claim).toBeString();
    expect(JSON.parse(row.spec_json).containment).toBeUndefined();
    expect(row.output_complete).toBe(1);
    expect(f.db.query('SELECT busy_request FROM workspaces').get().busy_request).toBeNull();
    await until(() => guardAlive(f.gate), alive => !alive);
    expect(fs.existsSync(f.gate + '.effects')).toBe(false);
    expect(fs.existsSync(path.join(f.workspace.directory, 'must-not-exist'))).toBe(false);
    const resourceStore = { db: f.db, root: path.join(f.root, 'node'), runner_id: f.client.runner_id };
    expect(resourceRow(resourceStore, f.id)).toMatchObject({ runner_id: f.client.runner_id, workspace_key: row.workspace_key,
      phase: 'unallocated', home_state: 'absent', cgroup_state: 'absent', home: null, containment: null });
    // Reclaim only these proven-unallocated command resources; no fake cgroup stop/removal evidence.
    const unexpected = () => { throw new Error('Unallocated resources must not invoke containment cleanup'); };
    commandResourceCleanup(resourceStore, [row], {}, { controller: { verify: unexpected, remove: unexpected, absent: unexpected } })();
    expect(resourceRow(resourceStore, f.id).phase).toBe('removed');
  } finally { await f.close(); }
});

for (const prior of ['bootstrap', 'resources']) test(`late guard cannot use stopping alone to erase persisted ${prior} uncertainty`, async () => {
  const f = await fixture();
  try {
    const spec = JSON.parse(f.row().spec_json);
    // Simulate prior creation facts, not an actual unowned OS process or containment directory.
    if (prior === 'bootstrap') f.db.query('UPDATE executions SET spec_json=? WHERE execution_id=?')
      .run(JSON.stringify({ ...spec, bootstrap_state: 'pending' }), f.id);
    else f.db.query(`INSERT INTO command_resources(execution_id,workspace_key,runner_id,phase,home_state,cgroup_state)
      VALUES (?,?,?,'preparing','absent','creating')`).run(f.id, f.row().workspace_key, f.client.runner_id);
    const stopped = f.run.call('command.cancel', { execution_id: f.id });
    await until(f.row, row => row.state === 'stopping'); f.release();
    expect((await stopped).stop_confirmed).toBe(false);
    expect(f.row().state).toBe('unknown');
    if (prior === 'bootstrap') expect(JSON.parse(f.row().spec_json).bootstrap_state).toBe('pending');
    else expect(f.db.query('SELECT phase,cgroup_state FROM command_resources WHERE execution_id=?').get(f.id))
      .toEqual({ phase: 'preparing', cgroup_state: 'creating' });
    expect(f.db.query('SELECT busy_request FROM workspaces').get().busy_request).not.toBeNull();
    await until(() => guardAlive(f.gate), alive => !alive);
    expect(fs.existsSync(f.gate + '.effects')).toBe(false);
  } finally {
    // Only remove the synthetic teardown barrier after the fixture guard has exited.
    try { f.db.query('UPDATE executions SET stop_confirmed=1 WHERE execution_id=?').run(f.id); }
    finally { await f.close(); }
  }
});
