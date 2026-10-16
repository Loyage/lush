import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerNode } from '../../src/runner/node.js';
import { CAPABILITIES, hash, PROTOCOL_VERSION, validateRequest } from '../../src/runner/protocol.js';
const machine = hash('fixture-machine'), control = hash('fixture-control'), token = hash('fixture-run');
const identity = { project_id: 'p1', node_id: 'n1', worker_id: 1, workspace_id: 'w1', generation: 1, operation_id: 'control-op' };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-test-'));
  const node = new RunnerNode({ root, node_id: 'n1', machine_token_hash: hash(machine), projects: { p1: { control_token_hash: hash(control) } } }, { preflight: async () => {} });
  const session = node.openSession(); let seq = 0;
  const request = (method, params = {}, patch = {}) => ({ version: PROTOCOL_VERSION, request_id: `r${++seq}`,
    auth: { machine_token: machine, control_token: control }, method, params, ...patch,
    identity: { ...identity, runner_id: node.runner_id, ...patch.identity } });
  return { root, node, session, request, call: (method, params, patch) => node.dispatch(request(method, params, patch), session),
    close: async () => { await node.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test('Runner registry, protocol and machine/control authorities fail closed', async () => {
  const f = fixture();
  try {
    expect(() => validateRequest(f.request('hello', {}, { version: 2 }))).toThrow('protocol');
    expect((await f.call('hello', {}, { auth: {} })).error.code).toBe('UNAUTHORIZED');
    const hello = await f.call('hello');
    expect(hello.result.capabilities.every(name => CAPABILITIES.includes(name))).toBe(true);
    expect(hello.result.node_id).toBe('n1');
    expect(hello.result.runner_id).toBe(f.node.runner_id);
    expect((await f.call('hello', { expected_runner_id: 'old-installation' })).error.code).toBe('STALE');
    expect((await f.call('workspace.register', {}, { identity: { runner_id: 'old-installation' } })).error.code).toBe('STALE');
    expect((await f.call('workspace.register', {}, { identity: { ...identity, project_id: 'p2' } })).error.code).toBe('UNAUTHORIZED');
    expect((await f.call('workspace.register')).result.directory.startsWith(f.root)).toBe(true);
    expect((await f.call('workspace.register', {}, { identity: { workspace_id: 'competing-copy' } })).error.code).toBe('CONFLICT');
  } finally { await f.close(); }
});
test('durable request identity prevents replay and survives node reopening', async () => {
  const f = fixture();
  try {
    const req = f.request('workspace.register');
    const first = await f.node.dispatch(req, f.session);
    expect(first.error).toBeUndefined();
    expect(await f.node.dispatch(req, f.session)).toEqual(first);
    expect((await f.node.dispatch({ ...req, params: { different: true } }, f.session)).error.code).toBe('CONFLICT');
    const second = new RunnerNode(f.node.config, { preflight: async () => {} });
    try { expect(await second.dispatch(req, second.openSession())).toEqual(first); }
    finally { await second.close(); }
  } finally { await f.close(); }
});
test('invocation lease is connection-bound and revoked on disconnect', async () => {
  const f = fixture();
  try {
    await f.call('workspace.register');
    const granted = await f.call('lease.grant', { run_id: 1, run_token: token });
    expect(granted.result.run_id).toBe(1);
    const { operation_id, ...base } = identity;
    const run = { identity: { ...base, operation_id: undefined, run_id: 1 }, auth: { machine_token: machine, run_token: token } };
    expect((await f.call('lease.renew', {}, run)).result.lease_id).toBe(granted.result.lease_id);
    const other = f.node.openSession();
    expect((await f.node.dispatch(f.request('lease.renew', {}, run), other)).error.code).toBe('UNAUTHORIZED');
    await f.node.disconnect(f.session);
    expect((await f.node.dispatch(f.request('lease.renew', {}, run), other)).error.code).toBe('UNAUTHORIZED');
    expect((await f.node.dispatch(f.request('workspace.barrier', {}, run), other)).result.stopped).toBe(true);
  } finally { await f.close(); }
});
test('renewal verifies its CAS and barriers expose only a bounded execution summary', async () => {
  const f = fixture();
  try {
    await f.call('workspace.register');
    await f.call('lease.grant', { run_id: 1, run_token: token });
    const lease = f.node.store.db.query('SELECT * FROM leases').get();
    f.node.store.db.query('UPDATE leases SET revoked=1 WHERE lease_id=?').run(lease.lease_id);
    expect(() => f.node.builtins['lease.renew']({ lease }, {})).toThrow('changed before renewal');
    const workspace = f.node.store.workspace({ ...identity, runner_id: f.node.runner_id });
    const insert = f.node.store.db.query('INSERT INTO executions (execution_id,workspace_key,request_id,identity_json,session_id,state,spec_json,created_at,expires_at,queue_deadline) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 40; i++) insert.run(`exec-${i}`, workspace.workspace_key, `start-${i}`, JSON.stringify(identity), f.session, 'unknown', '{}', i, 0, 0);
    const barrier = await f.call('workspace.barrier');
    expect(barrier.result.stopped).toBe(false);
    expect(barrier.result.executions).toHaveLength(32);
    expect(barrier.result.total).toBe(40);
    expect(barrier.result.truncated).toBe(true);
  } finally { await f.close(); }
});
test('incomplete receipts remain unknown instead of replaying and production preflight refuses missing containment', async () => {
  const f = fixture();
  try {
    const req = f.request('workspace.register');
    f.node.store.beginRequest(req, f.session);
    expect((await f.node.dispatch(req, f.session)).error.code).toBe('UNKNOWN');
    expect(f.node.store.workspace({ ...identity, runner_id: f.node.runner_id })).toBeNull();
    const production = new RunnerNode({ ...f.node.config, root: path.join(f.root, 'other') });
    try { expect((await production.dispatch(f.request('hello', {}, { identity: { runner_id: production.runner_id } }), production.openSession())).error.code).toBe('UNSUPPORTED'); }
    finally { await production.close(); }
  } finally { await f.close(); }
});
