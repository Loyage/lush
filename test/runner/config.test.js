import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRunnerConfig } from '../../src/runner/config.js';
import { RunnerNode } from '../../src/runner/node.js';
import { hash, RunnerError, validToken } from '../../src/runner/protocol.js';
const machine = hash('fixture-machine'), control = hash('fixture-control'), run = hash('fixture-run');
const base = root => ({ version: 1, root, node_id: 'node-1', cgroup_root: '/sys/fs/cgroup/user-runner',
  machine_token_hash: hash(machine), projects: { project: { control_token_hash: hash(control) } } });
const identity = { project_id: 'project', node_id: 'node-1', worker_id: 1, workspace_id: 'space', generation: 1, operation_id: 'op' };
test('private Runner configuration rejects links, broad modes, secrets and unknown schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-config-'));
  const file = path.join(root, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify(base(path.join(root, 'data'))), { mode: 0o600 });
    expect(readRunnerConfig(file).node_id).toBe('node-1');
    fs.chmodSync(file, 0o644); expect(() => readRunnerConfig(file)).toThrow('owner-only');
    fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, path.join(root, 'link.json'));
    expect(() => readRunnerConfig(path.join(root, 'link.json'))).toThrow('safely');
    fs.writeFileSync(file, JSON.stringify({ ...base(root), machine_token: machine }));
    expect(() => readRunnerConfig(file)).toThrow('Unknown');
    fs.writeFileSync(file, '{"machine_token":"' + machine);
    expect(() => readRunnerConfig(file)).toThrow('valid JSON');
    expect(validToken('this token contains spaces')).toBe(false);
    expect(validToken(run)).toBe(true);
    expect(validToken(Buffer.alloc(32, 7).toString('base64url'))).toBe(true);
    for (const invalid of ['a'.repeat(31), 'a'.repeat(257), Buffer.alloc(31).toString('base64url'), Buffer.alloc(32).toString('base64'), 'a'.repeat(43) + '='])
      expect(validToken(invalid)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('credential revocation reload rejects fresh operations and requests stopping before further admission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-revoke-'));
  let config = base(root), stopped = [];
  const node = new RunnerNode(config, { preflight: async () => {}, refresh_config: () => config,
    services: { stop_workspace: key => { stopped.push(key); } } });
  const session = node.openSession(); let id = 0;
  const call = (method, params = {}, extra = {}) => node.dispatch({ version: 1, request_id: `request-${++id}`,
    identity: { ...identity, runner_id: node.runner_id }, auth: { machine_token: machine, control_token: control }, method, params, ...extra }, session);
  try {
    await call('workspace.register');
    expect((await call('lease.grant', { run_id: 1, run_token: run })).error).toBeUndefined();
    config = { ...config, projects: { project: { control_token_hash: hash(control), enabled: false } } };
    expect((await call('lease.grant', { run_id: 2, run_token: run })).error.code).toBe('UNAUTHORIZED');
    expect(stopped).toHaveLength(1);
    expect(node.store.db.query('SELECT revoked FROM leases').get().revoked).toBe(1);
    expect((await call('workspace.barrier')).result.stopped).toBe(true);
    expect((await call('lease.revoke')).error).toBeUndefined();
    config = { ...config, machine_token_hash: hash('rotated-machine-secret') };
    expect((await call('hello')).error.code).toBe('UNAUTHORIZED');
  } finally { await node.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('repeated revocation checks join one pending workspace stop instead of issuing concurrent stops', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-stop-join-'));
  let config = base(root), calls = 0;
  const done = Promise.withResolvers();
  const node = new RunnerNode(config, { preflight: async () => {}, refresh_config: () => config,
    services: { stop_workspace: async () => { calls++; await done.promise; } } });
  const session = node.openSession(), owner = { ...identity, runner_id: node.runner_id };
  try {
    await node.dispatch({ version: 1, request_id: 'register', identity: owner, auth: { machine_token: machine, control_token: control }, method: 'workspace.register', params: {} }, session);
    const workspace = node.store.workspace(owner);
    node.store.db.query('INSERT INTO executions (execution_id,workspace_key,request_id,identity_json,session_id,state,spec_json,created_at,expires_at,queue_deadline) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('active', workspace.workspace_key, 'start', JSON.stringify(owner), session, 'running', '{}', Date.now(), Date.now() + 30000, Date.now() + 30000);
    config = { ...config, projects: { project: { control_token_hash: hash(control), enabled: false } } };
    for (let i = 0; i < 30; i++) node.refreshAuthorization();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(node.stopping_workspaces.size).toBe(1);
  } finally { done.resolve(); await node.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('credentials are redacted before errors/results/receipts and are absent from durable rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-runner-redact-'));
  const node = new RunnerNode(base(root), { preflight: async () => {}, services: {
    check_context: () => {},
    'file.write': () => ({ value: machine + control }),
    'file.read': () => { throw new RunnerError('CONFLICT', 'diagnostic ' + control, { private: machine }); },
  } });
  const session = node.openSession(); let id = 0;
  const call = (method, params = {}) => node.dispatch({ version: 1, request_id: `request-${++id}`,
    identity: { ...identity, runner_id: node.runner_id }, auth: { machine_token: machine, control_token: control }, method, params }, session);
  try {
    await call('workspace.register');
    expect(JSON.stringify(await call('file.write'))).not.toContain(machine);
    expect(JSON.stringify(await call('file.read'))).not.toContain(control);
    expect((await call('file.write', { content: machine })).error.code).toBe('UNAUTHORIZED');
    await call('lease.grant', { run_id: 1, run_token: run });
    const persisted = JSON.stringify({ receipts: node.store.db.query('SELECT * FROM requests').all(), leases: node.store.db.query('SELECT * FROM leases').all() });
    for (const secret of [machine, control, run]) expect(persisted).not.toContain(secret);
  } finally { await node.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
