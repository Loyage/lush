import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { setup, fetch } from './harness.js';
import { env, temp } from '../helpers.js';
import { UIClient } from '../../src/ui/client.js';
import { LushError } from '../../src/core/types.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';

const methods = ['system.interrupt_all', 'system.resume_all'];
const post = (url, body, extra = {}) => fetch(url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
function maintenanceFixture(f, affected = 2) {
  const calls = [];
  let view = { version: 1, paused: false, phase: 'running', ready_to_restart: false,
    active_calls: 1, pending_operations: 1, affected_count: 0, blockers: ['等待当前调用安全退出'] };
  f.project.interruptAll = (...args) => {
    calls.push(['system.interrupt_all', args]);
    view = { ...view, paused: true, phase: 'pausing', affected_count: affected };
    return view;
  };
  f.project.resumeAll = (...args) => {
    calls.push(['system.resume_all', args]);
    view = { ...view, paused: false, phase: 'running', affected_count: 0 };
    return view;
  };
  return { calls, view: () => view };
}

// These tests run real HTTP -> UIClient -> Unix RPC -> Dispatcher with controlled
// Project methods. They prove interface boundaries, not the runtime's pause logic.
test('bound maintenance actions return the safe runtime view, never imply shutdown or alter Workers', async () => {
  const f = await setup(), m = maintenanceFixture(f);
  const before = f.store.tasks();
  try {
    for (const method of methods) {
      expect((await post(f.url, { method, params: {} }, { Host: 'evil.invalid' })).status).toBe(403);
      const response = await post(f.url, { method, params: {} });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(m.view());
      expect(m.calls.at(-1)).toEqual([method, []]);
      expect(f.project.stopping).toBe(false);
      expect(f.store.tasks()).toEqual(before);
    }
    // The conventional omitted params envelope has the same no-argument semantics.
    expect((await post(f.url, { method: methods[0] })).status).toBe(200);
    expect(m.calls).toEqual([[methods[0], []], [methods[1], []], [methods[0], []]]);
    // Bound project routes retain their own fixed identity too.
    const response = await post(`${f.url}/p/${projectRouteId(f.root)}`, { method: methods[1], params: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(m.view());
  } finally { await f.close(); }
});

test('maintenance actions require login, same Origin and JSON before project effects', async () => {
  const password = 'maintenance authentication password', f = await setup({ auth: { username: 'owner', password } });
  const m = maintenanceFixture(f);
  try {
    for (const method of methods) {
      expect((await post(f.url, { method, params: {} })).status).toBe(401);
      expect((await post(f.url, { method, params: {} }, { Origin: 'https://evil.invalid' })).status).toBe(403);
    }
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=owner&password=${encodeURIComponent(password)}` });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    for (const method of methods) {
      const body = { method, params: {} };
      expect((await post(f.url, body, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await post(f.url, body, { Cookie, 'Content-Type': 'text/plain' })).status).toBe(400);
      expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { Cookie }, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(m.calls).toEqual([]);
    for (const method of methods) {
      const response = await post(f.url, { method, params: {} }, { Cookie, Origin: f.url });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(m.view());
    }
    expect(m.calls).toEqual(methods.map(method => [method, []]));
  } finally { await f.close(); }
});

test('maintenance actions strictly reject fields, tokens even if empty, malformed params and query overrides', async () => {
  const f = await setup(), m = maintenanceFixture(f);
  try {
    for (const method of methods) {
      for (const params of [null, [], false, 1, 'all', { id: 1 }, { force: true }, { profile: {} },
        { project: '/another-project' }, { scope: 'device' }, { _token: 'live' }, { _token: '' }, { _token: null }, { _token: false }]) {
        expect((await post(f.url, { method, params })).status).toBe(400);
      }
      for (const extra of [{ project: '/another-project' }, { _token: 'live' }, { _token: '' }, { _token: null }, { scope: 'device' }, { confirm: true }]) {
        expect((await post(f.url, { method, params: {}, ...extra })).status).toBe(400);
      }
      for (const query of ['?project=/elsewhere', '?_token=live', '?scope=device', '?force=true']) {
        const response = await fetch(f.url + '/api/action' + query, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: {} }) });
        expect(response.status).toBe(400);
      }
    }
    for (const body of [null, [], true, 1, 'all', { params: {} }, { method: 'system.stop', params: {} }])
      expect((await post(f.url, body)).status).toBe(400);
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status).toBe(400);
    expect((await fetch(f.url + '/api/action?method=system.interrupt_all')).status).toBe(404);
    expect(m.calls).toEqual([]);
    expect(f.project.stopping).toBe(false);
  } finally { await f.close(); }
});

test('maintenance runtime rejection is reported once without a follow-up continue or restart', async () => {
  const f = await setup(), m = maintenanceFixture(f);
  let effects = 0;
  try {
    f.project.interruptAll = () => { effects++; throw new LushError('maintenance guard rejected'); };
    const response = await post(f.url, { method: methods[0], params: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'maintenance guard rejected' });
    expect(effects).toBe(1);
    expect(m.calls).toEqual([]);
    expect(f.project.stopping).toBe(false);
  } finally { await f.close(); }
});

test('Host routes maintenance only to the URL project; missing or forged identities never fall back', async () => {
  const a = await setup(), b = await setup(), global = temp(), launcherEnv = env({ LUSH_GLOBAL_CONFIG: global });
  const ma = maintenanceFixture(a, 2), mb = maintenanceFixture(b, 9);
  writeLauncherState(a.root, launcherEnv); writeLauncherState(b.root, launcherEnv);
  let starts = 0;
  const web = startWeb(null, 0, { env: launcherEnv,
    openProject: async () => { starts++; throw new Error('maintenance must not start daemon'); },
    attachProject: async project => {
      const f = project === a.root ? a : b;
      return { config: f.config, client: new UIClient(f.config) };
    } });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    for (const method of methods) {
      for (const base of [url, `${url}/p/${'0'.repeat(16)}`, `${url}/p/${'z'.repeat(16)}`]) {
        expect((await post(base, { method, params: {} })).status).toBe(400);
      }
    }
    expect(ma.calls).toEqual([]); expect(mb.calls).toEqual([]);
    const urlA = `${url}/p/${projectRouteId(a.root)}`, urlB = `${url}/p/${projectRouteId(b.root)}`;
    let response = await post(urlA, { method: methods[0], params: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paused: true, phase: 'pausing', affected_count: 2 });
    expect(mb.view().paused).toBe(false);
    response = await post(urlB, { method: methods[0], params: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paused: true, phase: 'pausing', affected_count: 9 });
    response = await post(urlA, { method: methods[1], params: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paused: false });
    expect(mb.view().paused).toBe(true);
    expect(ma.calls).toEqual([[methods[0], []], [methods[1], []]]);
    expect(mb.calls).toEqual([[methods[0], []]]);
    expect(starts).toBe(0);
    expect(a.project.stopping).toBe(false); expect(b.project.stopping).toBe(false);
  } finally {
    await web.stop(true); await a.close(); await b.close();
    fs.rmSync(global, { recursive: true, force: true });
  }
});
