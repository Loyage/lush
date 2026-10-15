import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { setup, fetch } from './harness.js';
import { env, temp } from '../helpers.js';
import { startTestWeb as startWeb } from './auth-fixture.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';
import { UIClient } from '../../src/ui/client.js';
import { LushError } from '../../src/core/types.js';

const revision = 'integration:opaque-v1';
const members = Array.from({ length: 12 }, (_, i) => ({ id: i + 20, worker_number: `W5-${i + 1}`, title: 'member',
  source_commit: 'a'.repeat(40), base_commit: 'b'.repeat(40) }));
const operation = { id: 9, revision, target_branch: 'main', state: 'resolving',
  worker: { id: 7, worker_number: 'W5-13', status: 'running' }, member_count: 12, members, members_truncated: false,
  baseline: 'c'.repeat(40), commit: null, error: null };
const plan = { version: 1, branch: 'main', target: { id: 1, worker_number: null, branch: 'main' }, revision, members,
  excluded: [{ id: 40, worker_number: 'W6', reason: 'source still running' }], count: 12, active: null, ready: true, reason: null };
const writes = [
  ['branch.integrate_start', { branch: 'main', expected_revision: revision }, 'branchIntegrateStart', ['main',revision]],
  ['branch.integrate_cancel', { id: 9, expected_revision: revision }, 'branchIntegrateCancel', [9,revision]],
  ['branch.integrate_retry', { id: 9, expected_revision: revision }, 'branchIntegrateRetry', [9,revision]],
];
const post = (url, method, params, headers = {}, extra = {}) => fetch(url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params, ...extra }) });
function mocks(project) {
  const calls = [];
  for (const [name, result] of [['branchIntegratePlan',plan], ['branchIntegration',operation],
    ...writes.map(([, , name]) => [name, operation])]) {
    project[name] = (...args) => { calls.push({ name, args }); return result; };
  }
  return calls;
}

test('integration HTTP -> real RPC dispatcher -> mock interface -> result preserves complete members and no-store', async () => {
  const f = await setup(), calls = mocks(f.project);
  const before = f.store.get('SELECT count(*) AS n FROM events').n;
  try {
    for (const [path, result] of [['/api/branch-integrate-plan?branch=main',plan], ['/api/branch-integration?id=9',operation]]) {
      const response = await fetch(f.url + path);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(result);
    }
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
    for (const [method, params] of writes) {
      const response = await post(f.url, method, params);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(operation);
    }
    expect(calls).toEqual([{ name: 'branchIntegratePlan', args: ['main'] }, { name: 'branchIntegration', args: [9] },
      ...writes.map(([, , name, args]) => ({ name, args }))]);
  } finally { await f.close(); }
});

test('integration HTTP rejects missing/unknown/duplicate query fields, invalid types and read actions', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const path of ['/api/branch-integrate-plan', '/api/branch-integrate-plan?branch=', '/api/branch-integrate-plan?branch=main%5E',
      '/api/branch-integrate-plan?branch=main&branch=other', '/api/branch-integrate-plan?branch=main&ref=HEAD',
      '/api/branch-integrate-plan?branch=main&_token=', '/api/branch-integrate-plan?id=9', '/api/branch-integration',
      ...['','0','01','-1','1.1','1e2','W9','9007199254740992'].map(id => `/api/branch-integration?id=${id}`),
      '/api/branch-integration?id=9&id=10', '/api/branch-integration?id=9&branch=main', '/api/branch-integration?id=9&_token=']) {
      expect((await fetch(f.url + path)).status).toBe(400);
    }
    for (const method of ['branch.integrate_plan','branch.integration']) expect((await post(f.url, method, { branch: 'main' })).status).toBe(400);
    for (const path of ['/api/branch-integrate-start', '/api/branch-integrate-cancel', '/api/branch-integrate-retry', '/api/branch-integration/9']) {
      expect((await fetch(f.url + path)).status).toBe(404);
    }
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('integration HTTP mutations reject every token value, extra envelope/params/query fields and invalid types before execution', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const [method, valid] of writes) {
      for (const _token of [null,'',false,0,'agent',{}]) expect((await post(f.url, method, { ...valid, _token })).status).toBe(400);
      for (const params of [null,[],true,'text',{}, { ...valid, force: true }, { ...valid, cwd: '/tmp' },
        ...[null,'',0,' padded ','bad\nrevision'].map(expected_revision => ({ ...valid, expected_revision })),
        method.endsWith('start') ? { ...valid, branch: 'refs/heads/main' } : { ...valid, id: '9' }]) {
        expect((await post(f.url, method, params)).status).toBe(400);
      }
      for (const extra of [{ project: '/tmp' }, { _token: '' }, { force: true }]) expect((await post(f.url, method, valid, {}, extra)).status).toBe(400);
      expect((await fetch(f.url + '/api/action?branch=main', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params: valid }) })).status).toBe(400);
      expect((await fetch(f.url + '/api/action', { method: 'POST', body: JSON.stringify({ method, params: valid }) })).status).toBe(400);
    }
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('integration HTTP propagates revision/unknown-landing errors once without implicit retry or fallback', async () => {
  const f = await setup(), calls = mocks(f.project);
  for (const [, , name] of writes) f.project[name] = (...args) => { calls.push({ name, args }); throw new LushError('revision changed; unknown landing'); };
  try {
    for (const [method, params] of writes) {
      const response = await post(f.url, method, params);
      expect(response.status).toBe(400); expect((await response.json()).error).toContain('revision changed; unknown landing');
    }
    expect(calls).toEqual(writes.map(([, , name, args]) => ({ name, args })));
  } finally { await f.close(); }
});

test('integration routes retain login and Origin guards', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } }), calls = mocks(f.project);
  try {
    for (const path of ['/api/branch-integrate-plan?branch=main','/api/branch-integration?id=9']) expect((await fetch(f.url + path)).status).toBe(401);
    for (const [method, params] of writes) expect((await post(f.url, method, params)).status).toBe(401);
    expect(calls).toEqual([]);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + '/api/branch-integrate-plan?branch=main', { headers: { Cookie } })).status).toBe(200);
    expect((await post(f.url, writes[0][0], writes[0][1], { Cookie, Origin: f.url })).status).toBe(200);
    for (const path of ['/api/branch-integrate-plan?branch=main','/api/branch-integration?id=9']) {
      expect((await fetch(f.url + path, { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    }
    for (const [method, params] of writes) {
      expect((await post(f.url, method, params, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await post(f.url, method, params, { Cookie, Host: 'evil.invalid', Origin: f.url })).status).toBe(403);
    }
    expect(calls).toHaveLength(2);
  } finally { await f.close(); }
});

test('integration routes retain loopback Host restrictions', async () => {
  const f = await setup(), calls = mocks(f.project);
  try {
    for (const path of ['/api/branch-integrate-plan?branch=main','/api/branch-integration?id=9']) {
      expect((await fetch(f.url + path, { headers: { Host: 'evil.invalid' } })).status).toBe(403);
    }
    for (const [method, params] of writes) expect((await post(f.url, method, params, { Host: 'evil.invalid' })).status).toBe(403);
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('integration Host routes stay bound to explicit project identity and never start stopped daemons', async () => {
  const a = await setup(), b = await setup(), global = temp(), launcherEnv = env({ LUSH_GLOBAL_CONFIG: global });
  const ca = mocks(a.project), cb = mocks(b.project);
  writeLauncherState(a.root, launcherEnv); writeLauncherState(b.root, launcherEnv);
  let starts = 0;
  const web = startWeb(null, 0, { env: launcherEnv,
    openProject: async () => { starts++; throw new Error('integration must not start daemon'); },
    attachProject: async project => { const f = project === a.root ? a : b; return { config: f.config, client: new UIClient(f.config) }; },
  });
  const url = `http://127.0.0.1:${web.port}`, ua = `${url}/p/${projectRouteId(a.root)}`, ub = `${url}/p/${projectRouteId(b.root)}`;
  try {
    expect((await fetch(ua + '/api/branch-integrate-plan?branch=main')).status).toBe(200);
    expect((await fetch(ub + '/api/branch-integration?id=9')).status).toBe(200);
    expect((await post(ua, writes[0][0], writes[0][1])).status).toBe(200);
    expect((await post(ub, writes[1][0], writes[1][1])).status).toBe(200);
    expect(ca).toEqual([{ name: 'branchIntegratePlan', args: ['main'] }, { name: 'branchIntegrateStart', args: ['main',revision] }]);
    expect(cb).toEqual([{ name: 'branchIntegration', args: [9] }, { name: 'branchIntegrateCancel', args: [9,revision] }]);
    for (const base of [url, `${url}/p/${'0'.repeat(16)}`]) {
      expect((await fetch(base + '/api/branch-integrate-plan?branch=main')).status).toBe(400);
      expect((await post(base, writes[0][0], writes[0][1])).status).toBe(400);
    }
    await b.rpc.close();
    expect((await fetch(ub + '/api/branch-integration?id=9')).status).toBe(400);
    expect(starts).toBe(0); expect(ca).toHaveLength(2); expect(cb).toHaveLength(2);
  } finally {
    await web.stop(true); await a.close(); await b.close(); fs.rmSync(global, { recursive: true, force: true });
  }
});
