import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerNode } from '../../src/runner/node.js';
import { hash, PROTOCOL_VERSION, workspaceKey } from '../../src/runner/protocol.js';

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-preparation-')));
  const machine = hash('machine'), control = hash('control');
  const node = new RunnerNode({ root, node_id: 'node', machine_token_hash: hash(machine),
    projects: { project: { control_token_hash: hash(control) } } }, { preflight: async () => {} });
  const identity = { project_id: 'project', node_id: 'node', runner_id: node.runner_id,
    worker_id: 1, workspace_id: 'workspace', generation: 1, operation_id: 'inspect' };
  const session = node.openSession(); let sequence = 0;
  const request = (method, params = {}, patch = {}) => ({ version: PROTOCOL_VERSION, request_id: `request-${++sequence}`,
    identity, auth: { machine_token: machine, control_token: control }, method, params, ...patch });
  const call = (method = 'workspace.preparation.inspect', params, patch) => node.dispatch(request(method, params, patch), session);
  return { root, node, identity, session, request, call, key: workspaceKey(identity),
    async close() { await node.close(); fs.rmSync(root, { force: true, recursive: true }); } };
}

test('preparation absence is authenticated, control-only, positive and entirely read-only', async () => {
  const f = fixture();
  try {
    const before = fs.readdirSync(f.root);
    const { operation_id, ...identity } = f.identity;
    expect((await f.call()).result).toEqual({ identity, absent: true });
    expect((await f.call()).result.absent).toBe(true);
    expect(fs.readdirSync(f.root)).toEqual(before);
    expect(f.node.store.db.query('SELECT count(*) AS n FROM requests').get().n).toBe(0);
    expect((await f.call(undefined, {}, { auth: {} })).error.code).toBe('UNAUTHORIZED');
    expect((await f.call(undefined, {}, { identity: { ...identity, run_id: 1 } })).error.code).toBe('UNAUTHORIZED');
    expect((await f.call(undefined, {}, { identity: { ...f.identity, runner_id: 'other' } })).error.code).toBe('STALE');
    expect((await f.call(undefined, { path: '/arbitrary' })).error.code).toBe('INVALID_REQUEST');
    f.node.config.projects.project.enabled = false;
    expect((await f.call()).result.absent).toBe(true); // observation does not reauthorize execution
  } finally { await f.close(); }
});

test('registration, competing identity and recorded but unfinished preparation forbid absence proof', async () => {
  const f = fixture();
  try {
    const request = f.request('workspace.register');
    f.node.store.beginRequest(request, f.session);
    expect((await f.call()).error.code).toBe('CONFLICT');
    f.node.store.finishRequest(request, undefined, { code: 'CONFLICT', message: 'rejected' });
    expect((await f.call()).error.code).toBe('CONFLICT'); // even terminal history is not never-started
    f.node.store.db.query('DELETE FROM requests').run();
    await f.call('workspace.register', {}, { identity: { ...f.identity, workspace_id: 'other' } });
    expect((await f.call()).error.code).toBe('CONFLICT');
    expect((await f.call(undefined, {}, { identity: { ...f.identity, worker_id: 2 } })).result.absent).toBe(true);
  } finally { await f.close(); }
});

test('orphan resources and unregistered directories or dangling links never count as absent', async () => {
  const f = fixture();
  try {
    f.node.store.db.query('INSERT INTO artifacts VALUES (?,?,?,?,?,?)').run('artifact', f.key, 'orphan', hash('orphan'), 1, 0);
    expect((await f.call()).error.code).toBe('CONFLICT');
    f.node.store.db.query('DELETE FROM artifacts').run();
    const container = path.join(f.root, 'workspaces'), directory = path.join(container, f.key);
    fs.mkdirSync(container); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'keep'), 'untouched');
    expect((await f.call()).error.code).toBe('CONFLICT');
    expect(fs.readFileSync(path.join(directory, 'keep'), 'utf8')).toBe('untouched');
    fs.rmSync(directory, { recursive: true }); fs.symlinkSync(path.join(f.root, 'missing'), directory);
    expect((await f.call()).error.code).toBe('CONFLICT');
    fs.unlinkSync(directory);
    expect((await f.call()).result.absent).toBe(true);
  } finally { await f.close(); }
});

test('confirmed absence closure fences late registration, is idempotent and survives node restart', async () => {
  const f = fixture();
  try {
    const request = f.request('workspace.preparation.close');
    const closed = await f.node.dispatch(request, f.session);
    expect(closed.result).toMatchObject({ absent: true, closed: true, request_id: request.request_id });
    expect(await f.node.dispatch(request, f.session)).toEqual(closed);
    expect((await f.call()).result).toEqual(closed.result);
    expect((await f.call('workspace.register')).error.code).toBe('STALE');
    // The store rechecks the fence in its request transaction, not just pre-record authorization.
    expect(() => f.node.store.beginRequest(f.request('workspace.register'), f.session)).toThrow('permanently closed');
    expect(fs.existsSync(path.join(f.root, 'workspaces'))).toBe(false);
    const reopened = new RunnerNode(f.node.config, { preflight: async () => {} });
    try {
      const session = reopened.openSession();
      expect((await reopened.dispatch(f.request('workspace.preparation.inspect'), session)).result).toEqual(closed.result);
      expect((await reopened.dispatch(f.request('workspace.register'), session)).error.code).toBe('STALE');
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('an earlier accepted register prevents sealing even when it has not created a directory', async () => {
  const f = fixture();
  try {
    f.node.store.beginRequest(f.request('workspace.register'), f.session);
    expect((await f.call('workspace.preparation.close')).error.code).toBe('CONFLICT');
    expect(f.node.store.preparationClosure(f.identity)).toBeNull();
  } finally { await f.close(); }
});

test('linked containers and replaced Runner roots cannot prove resource absence', async () => {
  const f = fixture();
  try {
    const target = path.join(f.root, 'target'), container = path.join(f.root, 'workspaces');
    fs.mkdirSync(target); fs.symlinkSync(target, container);
    expect((await f.call()).error.code).toBe('STALE');
    fs.unlinkSync(container);
    fs.renameSync(f.root, f.root + '-original'); fs.mkdirSync(f.root);
    try { expect((await f.call()).error.code).toBe('STALE'); }
    finally { fs.rmdirSync(f.root); fs.renameSync(f.root + '-original', f.root); }
  } finally { await f.close(); }
});
