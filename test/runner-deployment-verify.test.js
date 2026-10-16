import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { StdioTransport } from '../src/runner/transport.js';
import { IMPLEMENTATION_VERSION, OPERATIONS, hash, stable } from '../src/runner/protocol.js';
import { DeploymentStore } from '../src/core/runner-deployment-store.js';
import { DeploymentOperations } from '../src/core/runner-deployment-operations.js';
import { verifyDeploymentRunner } from '../src/core/runner-deployment-verify.js';
import { RunnerStore } from '../src/runner/store.js';
import { Database } from 'bun:sqlite';

function fixture({ existing_installation = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-deployment-verify-')), node_id = randomUUID(), deployment_id = randomUUID();
  const machine = randomBytes(32).toString('hex'), control = randomBytes(32).toString('hex'), project_id = 'deployment-test';
  const configFile = path.join(root, 'node.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, root: path.join(root, 'runner'), node_id, machine_token_hash: hash(machine),
    projects: { [project_id]: { control_token_hash: hash(control) } }, memory_reserve_bytes: 0, cgroup_root: path.join(root, 'test-only-cgroup') }), { mode: 0o600 });
  const store = new DeploymentStore({ home: path.join(root, 'device') }), operations = new DeploymentOperations(store);
  const row = store.create({ id: deployment_id, status: 'planned', ssh_alias: 'fixture', name: 'Fixture', project_id, plan: { supported: true }, stages: [], private_data: {} });
  // SETUP ONLY, never production recovery observation: establish an existing persistent Runner ID.
  let original_runner_id = null;
  if (existing_installation) { const nodeStore = new RunnerStore(path.join(root, 'runner')); original_runner_id = nodeStore.runner_id; nodeStore.close(); }
  const transports = [], calls = [], errors = [], observations = [];
  const f = { root, machine, control, node_id, original_runner_id, store, operations, row, transports, calls, errors, observations, connections: 0, lastError: null,
    run({ transform = null, override = {}, async_checkpoint = false, close_failure = false } = {}) {
      return operations.run(row.id, row.revision, { stages: ['verify_runner'] }, async context => {
        await context.stage('verify_runner', async () => {
          const checkpoint = event => context.checkpoint(receipt => { receipt.private_data.verification ??= []; receipt.private_data.verification.push(event); });
          try { return await verifyDeploymentRunner({ deployment_id, node_id, project_id, runtime_path: process.execPath, runtime_version: Bun.version,
            implementation_version: IMPLEMENTATION_VERSION, arch: process.arch, auth: { machine_token: machine, control_token: control },
            checkpoint: async_checkpoint ? async event => checkpoint(event) : checkpoint,
            guard: context.guard, signal: context.signal, on_client: client => context.onClose(() => client.close()), timeout_ms: 8000,
            transport_factory() {
              f.connections++;
              const transport = new StdioTransport({ command: process.execPath,
                args: [path.resolve(import.meta.dir, 'runner/fixtures/integration-node.js'), configFile], env: { PATH: '/usr/bin:/bin', HOME: root }, request_ms: 2000 });
              transports.push(transport);
              return { async request(frame, options) {
                calls.push({ method: frame.method, request_id: frame.request_id, ...(frame.method === 'hello' ? { expected_runner_id: frame.params.expected_runner_id ?? null } : {}) });
                if (frame.method === 'hello' || OPERATIONS[frame.method]?.mutation) {
                  const event = store.read(row.id).private_data.verification.findLast(event => event.phase === 'intent' && event.request_id === frame.request_id);
                  expect(event?.method).toBe(frame.method);
                  expect(event?.fingerprint).toBe(hash(stable({ method: frame.method, identity: frame.identity, params: frame.params })));
                  expect(operations.pending).toBe(1); expect(store.isActive(row.id)).toBe(true);
                }
                const response = await transport.request(frame, options);
                if (response.error) errors.push({ method: frame.method, code: response.error.code });
                if (['command.start', 'command.status', 'command.cancel'].includes(frame.method) && response.result) {
                  const fields = ['state', 'reason', 'stop_confirmed', 'exit_code', 'output_complete', 'output_bytes', 'truncated'];
                  observations.push({ method: frame.method, ...Object.fromEntries(fields.filter(key => Object.hasOwn(response.result, key)).map(key => [key, response.result[key]])) });
                  if (observations.length > 32) observations.shift();
                }
                return transform ? transform(frame, response) : response;
              }, async close() { await transport.close(); if (close_failure) throw new Error('PRIVATE-CLOSE-ERROR'); } };
            }, ...override }); }
          catch (error) { f.lastError = error.message; throw error; }
        }, (receipt, proof) => { receipt.runner_id = proof.runner_id; receipt.node_id = node_id; receipt.private_data.proof = proof; });
      });
    },
    async close() { await operations.close(); await Promise.allSettled(transports.map(transport => transport.close())); fs.rmSync(root, { recursive: true, force: true }); },
  };
  return f;
}

function assertReached(f, result, starts, status = result.status, injected = true) {
  const count = f.calls.filter(call => call.method === 'command.start').length;
  if (count !== starts || result.status !== status || !injected) console.error(JSON.stringify({ deployment_fixture_diagnostic: { count, status: result.status, injected,
    errors: f.errors, phases: result.private_data.verification?.map(({ phase, method, kind }) => ({ phase, method, kind })), observations: f.observations } }));
  expect(count).toBe(starts); expect(injected).toBe(true);
}

test('durable deployment journal -> real client -> independent Runner/guard -> Bun FFI command and live stop proof', async () => {
  const f = fixture();
  try {
    const result = await f.run(); assertReached(f, result, 2, 'ready');
    expect({ status: result.status, errors: f.errors }).toEqual({ status: 'ready', errors: [] }); expect(f.lastError).toBe(null); expect(f.connections).toBe(1);
    expect(result.private_data.proof).toMatchObject({ runner_id: result.runner_id, node_id: f.node_id, runtime_version: Bun.version,
      runtime_verified: true, ffi_verified: true, stop_confirmed: true, barrier_confirmed: true });
    expect(result.private_data.proof.command_execution_id).not.toBe(result.private_data.proof.stop_execution_id);
    expect(result.private_data.proof.command_execution_id).toBe('cmd-' + hash(`deployment-test:${result.private_data.proof.command_request_id}`));
    expect(result.private_data.proof.stop_execution_id).toBe('cmd-' + hash(`deployment-test:${result.private_data.proof.stop_request_id}`));
    expect(f.calls.some(call => call.method === 'command.cancel' && call.request_id === result.private_data.proof.cancel_request_id)).toBe(true);
    expect(f.calls.filter(call => call.method === 'command.start')).toHaveLength(2);
    expect(f.calls.filter(call => call.method === 'command.cancel')).toHaveLength(1);
    const events = result.private_data.verification;
    expect(events[0].phase).toBe('connection'); expect(events.at(-1).phase).toBe('verified');
    expect(events.filter(event => event.phase === 'execution').map(event => event.kind)).toEqual(['runtime_ffi', 'stop']);
    expect(events.every(event => !Object.hasOwn(event, 'auth') && !Object.hasOwn(event, 'params'))).toBe(true);
    const storage = fs.readFileSync(path.join(f.root, 'device', 'runner-deployments.json'), 'utf8');
    expect(storage).not.toContain(f.machine); expect(storage).not.toContain(f.control); expect(storage).not.toContain('setInterval');
    expect(f.operations.pending).toBe(0); expect(f.store.isActive(f.row.id)).toBe(false);
  } finally { await f.close(); }
});

function existingFacts(f) {
  const db = new Database(path.join(f.root, 'runner', 'runner.db'), { readonly: true });
  try { return { runner_id: db.query("SELECT value FROM node_metadata WHERE key='runner_id'").get().value,
    workspaces: db.query('SELECT count(*) n FROM workspaces').get().n, commands: db.query('SELECT count(*) n FROM executions').get().n }; }
  finally { db.close(); }
}

test('pinned original installation verification authenticates its existing persistent Runner ID before real Bun/FFI/live cancel/full barrier', async () => {
  const f = fixture({ existing_installation: true });
  try {
    expect(existingFacts(f)).toEqual({ runner_id: f.original_runner_id, workspaces: 0, commands: 0 });
    const result = await f.run({ override: { expected_runner_id: f.original_runner_id } });
    assertReached(f, result, 2, 'ready'); expect(result.status).toBe('ready'); expect(result.runner_id).toBe(f.original_runner_id);
    expect(result.private_data.proof).toMatchObject({ expected_runner_id: f.original_runner_id, runner_id: f.original_runner_id, runtime_verified: true, ffi_verified: true, stop_confirmed: true, barrier_confirmed: true });
    expect(f.calls[0]).toMatchObject({ method: 'hello', expected_runner_id: f.original_runner_id }); expect(f.calls.filter(call => call.method === 'command.cancel')).toHaveLength(1);
    expect(result.private_data.verification[0]).toMatchObject({ phase: 'connection', expected_runner_id: f.original_runner_id });
    expect(existingFacts(f)).toEqual({ runner_id: f.original_runner_id, workspaces: 1, commands: 2 });
  } finally { await f.close(); }
});

test('a different actual persistent Runner ID rejects the pinned hello before registering a workspace or starting any command', async () => {
  const f = fixture({ existing_installation: true }), wrong = randomUUID();
  try {
    const before = existingFacts(f), result = await f.run({ override: { expected_runner_id: wrong } });
    expect(wrong).not.toBe(f.original_runner_id); expect(result.status).toBe('unknown'); expect(f.connections).toBe(1);
    expect(f.calls.map(call => call.method)).toEqual(['hello']); expect(f.calls[0].expected_runner_id).toBe(wrong); expect(f.errors).toEqual([{ method: 'hello', code: 'STALE' }]);
    expect(existingFacts(f)).toEqual(before); expect(result.private_data.proof).toBeUndefined(); expect(result.runner_id).toBeUndefined();
    expect(result.private_data.verification.some(event => event.phase === 'hello' || event.phase === 'execution')).toBe(false);
    expect(f.operations.pending).toBe(0); expect(f.store.isActive(f.row.id)).toBe(false);
  } finally { await f.close(); }
});

test('an inconsistent successful hello response still cannot mutate the original workspace or substitute a new verification identity', async () => {
  const f = fixture({ existing_installation: true }); let injected = false;
  try {
    const before = existingFacts(f), result = await f.run({ override: { expected_runner_id: f.original_runner_id }, transform(frame, response) {
      if (frame.method === 'hello' && response.result) { response.result.runner_id = randomUUID(); injected = true; } return response;
    } });
    expect(injected).toBe(true); expect(result.status).toBe('unknown'); expect(f.calls.map(call => call.method)).toEqual(['hello']); expect(f.connections).toBe(1);
    expect(existingFacts(f)).toEqual(before); expect(result.private_data.proof).toBeUndefined(); expect(result.runner_id).toBeUndefined();
  } finally { await f.close(); }
});

for (const expected_runner_id of ['', 'legacy-node', false, []]) test(`invalid pinned identity ${JSON.stringify(expected_runner_id)} fails before connection/hello intent, without a fallback to fresh-install discovery`, async () => {
  const f = fixture();
  try {
    const result = await f.run({ override: { expected_runner_id } });
    expect(result.status).toBe('unknown'); expect(f.connections).toBe(0); expect(f.calls).toEqual([]); expect(result.private_data.verification).toBeUndefined();
    expect(fs.existsSync(path.join(f.root, 'runner'))).toBe(false); expect(result.private_data.proof).toBeUndefined();
  } finally { await f.close(); }
});

test('missing production capability is rejected before any command, with no fallback or reconnect', async () => {
  const f = fixture(); let injected = false;
  try {
    const result = await f.run({ transform(frame, response) {
      if (frame.method === 'hello') { response.result.capabilities = response.result.capabilities.filter(method => method !== 'command.cancel'); injected = true; }
      return response;
    } });
    expect(result.status).toBe('unknown'); expect(f.connections).toBe(1);
    expect(injected).toBe(true); expect(f.calls.map(call => call.method)).toEqual(['hello']); expect(result.runner_id).toBeUndefined();
    expect(result.private_data.proof).toBeUndefined(); expect(f.lastError).toContain('not confirmed');
  } finally { await f.close(); }
});

for (const mode of ['missing_stop_proof', 'lost_stop_ack']) test(`deployment refuses ${mode} after actual live command; original cancel intent is retained, never replayed`, async () => {
  const f = fixture(); let injected = false;
  try {
    const result = await f.run({ transform(frame, response) {
      if (frame.method === 'command.cancel') {
        injected = true;
        if (mode === 'lost_stop_ack') throw new Error('PRIVATE-TRANSPORT-STDERR');
        response.result.stop_confirmed = false;
      }
      return response;
    } });
    expect(result.status).toBe('unknown'); expect(result.runner_id).toBeUndefined(); expect(result.private_data.proof).toBeUndefined();
    assertReached(f, result, 2, 'unknown', injected);
    expect(f.calls.filter(call => call.method === 'command.cancel')).toHaveLength(1);
    expect(result.private_data.verification.some(event => event.phase === 'intent' && event.method === 'command.cancel')).toBe(true);
    expect(result.private_data.verification.some(event => event.phase === 'runtime_verified')).toBe(true);
    expect(result.private_data.verification.some(event => event.phase === 'verified')).toBe(false);
    const count = f.calls.length;
    expect(f.operations.view(f.store.read(f.row.id)).status).toBe('unknown'); expect(f.calls.length).toBe(count);
    expect(f.lastError).not.toContain('PRIVATE-TRANSPORT-STDERR'); expect(f.connections).toBe(1);
  } finally { await f.close(); }
});

for (const mode of ['output_gap', 'cancel_reason', 'truncated_barrier']) test(`deployment verification rejects ${mode} rather than guessing readiness`, async () => {
  const f = fixture(); let injected = false;
  try {
    const result = await f.run({ transform(frame, response) {
      if (mode === 'output_gap' && frame.method === 'command.output') { response.result.gap = true; injected = true; }
      if (mode === 'cancel_reason' && frame.method === 'command.cancel') { response.result.reason = 'timeout'; injected = true; }
      if (mode === 'truncated_barrier' && frame.method === 'workspace.barrier') { response.result.truncated = true; injected = true; }
      return response;
    } });
    expect(result.status).toBe('unknown'); expect(result.private_data.proof).toBeUndefined();
    expect(f.connections).toBe(1); assertReached(f, result, mode === 'output_gap' ? 1 : 2, 'unknown', injected);
  } finally { await f.close(); }
});

test('service shutdown closes an actual live independent Runner connection and preserves unknown rather than inventing stop proof', async () => {
  const f = fixture(); let announce, release, saved;
  const live = new Promise(resolve => { announce = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    const pending = f.run({ transform(frame, response) {
      if (frame.method === 'command.output' && response.result.chunks.some(chunk => Buffer.from(chunk.data, 'base64').toString().includes('lush-deployment-stop-live'))) {
        saved = response; announce(); return gate;
      }
      return response;
    } });
    await Promise.race([live, pending.then(() => { throw new Error('Verification ended before the live payload'); })]);
    expect(f.operations.pending).toBe(1);
    const closing = f.operations.close();
    expect(f.store.read(f.row.id).status).toBe('unknown');
    release(saved); await closing;
    const result = await pending;
    expect(result.status).toBe('unknown'); expect(result.private_data.proof).toBeUndefined();
    assertReached(f, result, 2);
    expect(f.calls.filter(call => call.method === 'command.cancel')).toHaveLength(0);
    expect(f.connections).toBe(1); expect(f.operations.pending).toBe(0);
    expect(f.transports[0].pending.size).toBe(0); expect(f.store.isActive(f.row.id)).toBe(false);
  } finally { release(saved); await f.close(); }
});

test('an asynchronous checkpoint cannot start a process or send a handshake', async () => {
  const f = fixture();
  try {
    const result = await f.run({ async_checkpoint: true });
    expect(result.status).toBe('unknown'); expect(f.connections).toBe(0); expect(f.calls).toEqual([]);
    expect(result.private_data.proof).toBeUndefined();
  } finally { await f.close(); }
});

test('cleanup failure is sanitized and cannot turn verified commands into a ready deployment', async () => {
  const f = fixture();
  try {
    const result = await f.run({ close_failure: true });
    expect(result.status).toBe('unknown'); expect(result.private_data.proof).toBeUndefined();
    expect(result.private_data.verification.at(-1).phase).toBe('verified');
    expect(f.lastError).toContain('close was not confirmed'); expect(f.lastError).not.toContain('PRIVATE-CLOSE-ERROR');
  } finally { await f.close(); }
});
