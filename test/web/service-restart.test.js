import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { setup, fetch } from './harness.js';
import { temp, env } from '../helpers.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';

const post = (url, body = {}, extra = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
});

test('restart routes require session and same Origin, reject tokens/paths and embedded hosts report unsupported', async () => {
  const password = 'long restart test password', f = await setup({ auth: { username: 'owner', password } });
  try {
    for (const route of ['/api/host/restart', '/api/service/restart']) {
      expect((await post(f.url + route)).status).toBe(401);
      expect((await post(f.url + route, {}, { Origin: 'https://evil.invalid' })).status).toBe(403);
    }
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=owner&password=${encodeURIComponent(password)}` });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const host = await fetch(f.url + '/api/host', { headers: { Cookie } }).then(r => r.json());
    expect(host).toMatchObject({ restart_supported: false, pid: process.pid });
    for (const route of ['/api/host/restart', '/api/service/restart']) {
      expect((await post(f.url + route, {}, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
      for (const body of [{ _token: 'agent' }, { project: '/tmp/other' }, null, []]) {
        expect((await post(f.url + route, body, { Cookie })).status).toBe(400);
      }
    }
    const unsupported = await post(f.url + '/api/host/restart', {}, { Cookie });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error).toContain('不支持');
    expect(f.project.stopping).toBe(false);
  } finally { await f.close(); }
});

test('host restart acknowledges before callback and refuses duplicate requests', async () => {
  const f = await setup(); let calls = 0;
  const web = startWeb(f.config, 0, { restartHost: () => { calls++; } });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    expect((await fetch(url + '/api/host').then(r => r.json())).restart_supported).toBe(true);
    const result = await post(url + '/api/host/restart');
    expect(await result.json()).toEqual({ restarting: true });
    expect(calls).toBe(0);
    expect((await post(url + '/api/host/restart')).status).toBe(400);
    await Bun.sleep(250);
    expect(calls).toBe(1);
  } finally { web.stop(true); await f.close(); }
});

test('project restart resolves only request project identity; missing and unknown identities never fall back', async () => {
  const a = await setup(), b = await setup(), global = temp(), launcherEnv = env({ XDG_CONFIG_HOME: global });
  writeLauncherState(a.root, launcherEnv); writeLauncherState(b.root, launcherEnv);
  const web = startWeb(null, 0, { env: launcherEnv, openProject: async project => {
    const f = project === a.root ? a : b;
    return { config: f.config, client: {} };
  } });
  const url = `http://127.0.0.1:${web.port}`;
  a.project.introRunning.set(1, {}); b.project.writing = 1;
  try {
    expect((await post(url + '/api/service/restart')).status).toBe(400);
    expect((await post(url + '/p/0000000000000000/api/service/restart')).status).toBe(400);
    const first = await post(url + `/p/${projectRouteId(a.root)}/api/service/restart`);
    expect(first.status).toBe(400); expect((await first.json()).error).toContain('活动 Agent');
    const second = await post(url + `/p/${projectRouteId(b.root)}/api/service/restart`);
    expect(second.status).toBe(400); expect((await second.json()).error).toContain('Git');
    expect(a.project.stopping).toBe(false); expect(b.project.stopping).toBe(false);
  } finally {
    a.project.introRunning.clear(); b.project.writing = 0;
    web.stop(true); await a.close(); await b.close(); fs.rmSync(global, { recursive: true, force: true });
  }
});
