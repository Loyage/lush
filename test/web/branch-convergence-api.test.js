import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { setup, fetch } from './harness.js';
import { env, temp } from '../helpers.js';
import { startTestWeb as startWeb } from './auth-fixture.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';
import { UIClient } from '../../src/ui/client.js';
import { LushError } from '../../src/core/types.js';

const revision = 'branch-main:opaque-v1', commandId = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const validation = { command_id: commandId, command_version: 2 };
const policy = { version: 1, branch: 'main', owner_id: 1, owner_worker_number: null, enabled: false,
  validation: null, revision, editable: true, reason: null,
  counts: { preparing: 0, resolving: 0, awaiting: 0, validating: 0, ready: 0, landing: 0, failed: 0, blocked: 0 } };
const list = { version: 1, items: [policy], count: 1, truncated: false };
const run = { id: 9, revision, parent_id: 1, target_branch: 'main', state: 'failed', baseline: null, commit: null,
  member_count: 1, members: [{ id: 7, worker_number: 'W5', title: 'member', delivery_id: 8, source_commit: 'a'.repeat(40) }],
  members_truncated: false, validation: null, integration_worker: null, error: 'checks failed', created_at: '2026-10-11', updated_at: '2026-10-11' };
const runs = { version: 1, branch: 'main', items: [run], next_before: 9, has_more: false };
const mutation = { branch: 'main', enabled: true, validation, expected_revision: revision };
const post = (url, method, params, headers = {}, extra = {}) => fetch(url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params, ...extra }) });
function mocks(project) {
  const calls = [];
  for (const [name, result] of [['branchConvergenceList',list], ['branchConvergence',policy],
    ['branchConvergenceRuns',runs], ['setBranchConvergence',policy], ['retryBranchConvergence',run]]) {
    project[name] = (...args) => { calls.push({ name, args }); return result; };
  }
  return calls;
}

test('convergence HTTP reads are on-demand, no-store and forward exact typed defaults without writes', async () => {
  const f = await setup(), calls = mocks(f.project);
  const before = f.store.get('SELECT count(*) AS n FROM events').n;
  try {
    const response = await fetch(f.url + '/api/branch-convergence');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(list);
    expect(await (await fetch(f.url + '/api/branch-convergence?branch=main')).json()).toEqual(policy);
    expect(await (await fetch(f.url + '/api/branch-convergence/runs?branch=main')).json()).toEqual(runs);
    expect(await (await fetch(f.url + '/api/branch-convergence/runs?branch=main&before=15&limit=3')).json()).toEqual(runs);
    expect(calls).toEqual([{ name: 'branchConvergenceList', args: [] }, { name: 'branchConvergence', args: ['main'] },
      { name: 'branchConvergenceRuns', args: ['main', null, 20] }, { name: 'branchConvergenceRuns', args: ['main', 15, 3] }]);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
  } finally { await f.close(); }
});

test('convergence HTTP rejects unknown/duplicate queries, invalid cursors and read actions without runtime access', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const route of ['/api/branch-convergence?branch=main&branch=other', '/api/branch-convergence?_token=',
      '/api/branch-convergence?enabled=true', '/api/branch-convergence?before=1', '/api/branch-convergence?branch=',
      '/api/branch-convergence?branch=main%5E', '/api/branch-convergence/runs', '/api/branch-convergence/runs?branch=main&ref=HEAD',
      '/api/branch-convergence/runs?branch=main&limit=2&limit=3', '/api/branch-convergence/runs?branch=main&before=1&before=2',
      '/api/branch-convergence/runs?branch=main&limit=0', '/api/branch-convergence/runs?branch=main&limit=51',
      '/api/branch-convergence/runs?branch=main&limit=2.1', '/api/branch-convergence/runs?branch=main&before=1e2',
      '/api/branch-convergence/runs?branch=main&before=9007199254740992']) {
      expect((await fetch(f.url + route)).status).toBe(400);
    }
    for (const method of ['branch.convergence','branch.convergence_list','branch.convergence_runs']) {
      expect((await post(f.url, method, { branch: 'main' })).status).toBe(400);
    }
    for (const route of ['/api/branch-convergence/set', '/api/branch-convergence/retry', '/api/branch-convergence/runs/9']) {
      expect((await fetch(f.url + route)).status).toBe(404);
    }
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('convergence HTTP setters and retry preserve explicit command version and revisions', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    expect(await (await post(f.url, 'branch.convergence_set', mutation)).json()).toEqual(policy);
    expect(await (await post(f.url, 'branch.convergence_set', { ...mutation, enabled: false })).json()).toEqual(policy);
    expect(await (await post(f.url, 'branch.convergence_retry', { id: 9, expected_revision: revision })).json()).toEqual(run);
    expect(calls).toEqual([{ name: 'setBranchConvergence', args: ['main',true,validation,revision,true] },
      { name: 'setBranchConvergence', args: ['main',false,validation,revision,true] },
      { name: 'retryBranchConvergence', args: [9,revision] }]);
  } finally { await f.close(); }
});

test('convergence mutations reject malformed authorization, envelope/query fields and every token value before writes', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const token of [null,'',false,0,'agent',{}]) {
      expect((await post(f.url, 'branch.convergence_set', { ...mutation, _token: token })).status).toBe(400);
      expect((await post(f.url, 'branch.convergence_retry', { id: 9, expected_revision: revision, _token: token })).status).toBe(400);
    }
    for (const params of [{ ...mutation, enabled: 'true' }, { ...mutation, mounted: false },
      { ...mutation, validation: { ...validation, command: 'unsafe' } }, { ...mutation, validation: { ...validation, authorized: true } },
      { ...mutation, validation: { ...validation, command_version: '2' } }, { ...mutation, expected_revision: '' },
      { ...mutation, expected_revision: null }, { ...mutation, cwd: '/tmp' }]) {
      expect((await post(f.url, 'branch.convergence_set', params)).status).toBe(400);
    }
    for (const params of [null,[],true,'text']) {
      expect((await post(f.url, 'branch.convergence_set', params)).status).toBe(400);
    }
    expect((await post(f.url, 'branch.convergence_set', mutation, {}, { project: '/tmp' })).status).toBe(400);
    expect((await post(f.url, 'branch.convergence_retry', { id: 9, expected_revision: revision }, {}, { _token: '' })).status).toBe(400);
    expect((await fetch(f.url + '/api/action?branch=main', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'branch.convergence_set', params: mutation }) })).status).toBe(400);
    expect((await fetch(f.url + '/api/action', { method: 'POST', body: JSON.stringify({ method: 'branch.convergence_set', params: mutation }) })).status).toBe(400);
    expect((await post(f.url, 'branch.convergence_retry', { id: '9', expected_revision: revision })).status).toBe(400);
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('convergence HTTP preserves runtime rejection once without implicit requeue or fallback', async () => {
  const f = await setup(), calls = mocks(f.project);
  f.project.setBranchConvergence = (...args) => { calls.push({ name: 'stale', args }); throw new LushError('branch convergence revision changed'); };
  f.project.retryBranchConvergence = (...args) => { calls.push({ name: 'blocked', args }); throw new LushError('unknown landing must be inspected'); };
  try {
    const stale = await post(f.url, 'branch.convergence_set', mutation);
    expect(stale.status).toBe(400); expect((await stale.json()).error).toContain('revision changed');
    const blocked = await post(f.url, 'branch.convergence_retry', { id: 9, expected_revision: revision });
    expect(blocked.status).toBe(400); expect((await blocked.json()).error).toContain('unknown landing');
    expect(calls).toHaveLength(2);
  } finally { await f.close(); }
});

test('convergence reads and writes require session authentication, normal Origin and Host guards', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }), calls = mocks(f.project);
  try {
    expect((await fetch(f.url + '/api/branch-convergence')).status).toBe(401);
    expect((await fetch(f.url + '/api/branch-convergence/runs?branch=main')).status).toBe(401);
    expect((await post(f.url, 'branch.convergence_set', mutation)).status).toBe(401);
    expect((await post(f.url, 'branch.convergence_retry', { id: 9, expected_revision: revision })).status).toBe(401);
    expect(calls).toEqual([]);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/branch-convergence', { headers: { Cookie } })).status).toBe(200);
    expect((await post(f.url, 'branch.convergence_set', mutation, { Cookie, Origin: f.url })).status).toBe(200);
    expect((await post(f.url, 'branch.convergence_set', mutation, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(f.url + '/api/branch-convergence', { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await post(f.url, 'branch.convergence_retry', { id: 9, expected_revision: revision }, { Cookie, Host: 'evil.invalid', Origin: f.url })).status).toBe(403);
    expect(calls).toHaveLength(2);
  } finally { await f.close(); }
});

test('convergence routes retain loopback Host restrictions', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    expect((await fetch(f.url + '/api/branch-convergence', { headers: { Host: 'evil.invalid' } })).status).toBe(403);
    expect((await post(f.url, 'branch.convergence_set', mutation, { Host: 'evil.invalid' })).status).toBe(403);
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('Host convergence APIs stay on explicit projects and never start a daemon through reads or mutations', async () => {
  const a = await setup(), b = await setup(), global = temp(), launcherEnv = env({ LUSH_GLOBAL_CONFIG: global });
  const ca = mocks(a.project), cb = mocks(b.project);
  writeLauncherState(a.root, launcherEnv); writeLauncherState(b.root, launcherEnv);
  let starts = 0;
  const web = startWeb(null, 0, { env: launcherEnv,
    openProject: async () => { starts++; throw new Error('convergence must not start daemon'); },
    attachProject: async project => { const f = project === a.root ? a : b; return { config: f.config, client: new UIClient(f.config) }; },
  });
  const url = `http://127.0.0.1:${web.port}`, ua = `${url}/p/${projectRouteId(a.root)}`, ub = `${url}/p/${projectRouteId(b.root)}`;
  try {
    expect((await fetch(ua + '/api/branch-convergence')).status).toBe(200);
    expect((await fetch(ub + '/api/branch-convergence/runs?branch=main&limit=1')).status).toBe(200);
    expect((await post(ua, 'branch.convergence_set', mutation)).status).toBe(200);
    expect((await post(ub, 'branch.convergence_retry', { id: 9, expected_revision: revision })).status).toBe(200);
    expect(ca).toEqual([{ name: 'branchConvergenceList', args: [] }, { name: 'setBranchConvergence', args: ['main',true,validation,revision,true] }]);
    expect(cb).toEqual([{ name: 'branchConvergenceRuns', args: ['main',null,1] }, { name: 'retryBranchConvergence', args: [9,revision] }]);
    for (const base of [url, `${url}/p/${'0'.repeat(16)}`]) {
      expect((await fetch(base + '/api/branch-convergence')).status).toBe(400);
      expect((await post(base, 'branch.convergence_set', mutation)).status).toBe(400);
    }
    await b.rpc.close();
    expect((await fetch(ub + '/api/branch-convergence')).status).toBe(400);
    expect(starts).toBe(0); expect(cb).toHaveLength(2); expect(ca).toHaveLength(2);
  } finally {
    await web.stop(true); await a.close(); await b.close(); fs.rmSync(global, { recursive: true, force: true });
  }
});
