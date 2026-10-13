import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb, rememberWebProject } from '../../src/ui/web/server.js';
import { temp, env } from '../helpers.js';
import { rawFetch } from './auth-fixture.js';

const username = 'assembly-owner', password = 'synthetic-assembly-password';
const projectId = 'abcdef0123456789';
function fixture(options = {}) {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: root });
  fs.writeFileSync(path.join(root, 'web.json'), JSON.stringify({ version: 2, username, password }), { mode: 0o600 });
  const servers = [];
  const start = () => {
    const web = startWeb(null, 0, { env: environment, ...options });
    servers.push(web);
    return { web, url: `http://127.0.0.1:${web.port}` };
  };
  return { start, async close() {
    for (const web of servers) await web.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  } };
}
async function login(url) {
  const response = await rawFetch(url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString() });
  expect(response.status).toBe(303);
  return response.headers.get('set-cookie').split(';')[0];
}
const post = (url, Cookie, body) => rawFetch(url, { method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('assembly guards run before every adapter; documents and assets never attach a project', async () => {
  const calls = [];
  const projectHost = new Proxy({ launcher: true }, { get(target, key) {
    if (key === 'launcher') return target.launcher;
    calls.push(key); throw new Error('unexpected project access');
  } });
  const f = fixture({ projectHost }), { url } = f.start();
  try {
    for (const route of ['/api/host/settings/runtime', `/p/${projectId}/api/worker/3`, '/api/docs', '/app.js']) {
      const response = await rawFetch(url + route);
      expect(response.status).toBe(route === '/app.js' ? 303 : 401);
    }
    const Cookie = await login(url);
    for (const route of ['/api/host/settings/runtime', `/p/${projectId}/api/worker/3`, '/api/docs', '/app.js']) {
      expect((await rawFetch(url + route, { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    }
    for (const route of ['/api/docs', `/p/${projectId}/api/docs`, '/app.js', '/styles.css', '/favicon.ico']) {
      const response = await rawFetch(url + route, { headers: { Cookie } });
      expect(response.status).toBe(route === '/favicon.ico' ? 204 : 200);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    }
    for (const route of [`/p/${projectId}/api/host/session`, `/p/${projectId}/api/quick-chat/history`, '/api/host/quick-explain/config']) {
      expect((await rawFetch(url + route, { headers: { Cookie } })).status).toBe(404);
    }
    expect(calls).toEqual([]);
  } finally { await f.close(); }
});

test('assembly preserves fixed route identity, whitelist ordering and HTTP validation errors', async () => {
  const opened = [], requests = [];
  const projectHost = {
    launcher: true,
    async openRoute(id) {
      opened.push(id);
      return { client: { async request(method, params) { requests.push({ method, params }); return { method, params }; } } };
    },
  };
  const f = fixture({ projectHost }), { url } = f.start();
  try {
    const Cookie = await login(url), base = `${url}/p/${projectId}`;
    expect((await rawFetch(url + '/api/worker/3', { headers: { Cookie } })).status).toBe(400);
    expect(opened).toEqual([]);
    expect(await (await rawFetch(base + '/api/worker/3/reading-record?kind=event&record_id=7&offset=0', { headers: { Cookie } })).json())
      .toEqual({ method: 'worker.reading_record', params: { id: 3, kind: 'event', record_id: 7, offset: 0 } });
    expect(opened).toEqual([projectId]);
    requests.length = 0;
    for (const route of ['/api/worker/3/reading-record?kind=event&kind=message', '/api/worker/3/run-settings?_token=x',
      '/api/settings/runtime?scope=device&scope=device', '/api/settings/runtime?scope=project']) {
      const response = await rawFetch(base + route, { headers: { Cookie } });
      expect(response.status).toBe(400); expect(typeof (await response.json()).error).toBe('string');
    }
    // A stale daemon must not make retired read branches reachable after extraction.
    for (const route of ['/api/sleep', '/api/worker/3/intros', '/api/task/3']) {
      expect((await rawFetch(base + route, { headers: { Cookie } })).status).toBe(404);
    }
    for (const body of [{ method: 'worker.auto_title', params: {} }, { method: 'worker.rename', params: { _token: 'forged' } },
      { method: 'system.interrupt_all', params: {}, project: '/tmp/elsewhere' },
      { method: 'branch.convergence_retry', params: { _token: '' } }]) {
      expect((await post(base + '/api/action', Cookie, body)).status).toBe(400);
    }
    expect((await post(base + '/api/service/restart', Cookie, { _token: '' })).status).toBe(400);
    expect((await post(base + '/api/action', Cookie, { method: 'worker.rename', params: { id: 3, title: 'new title' } })).status).toBe(200);
    expect(requests).toEqual([{ method: 'worker.rename', params: { id: 3, title: 'new title' } }]);
    expect((await rawFetch(base + '/api/action', { method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.rename', params: { title: 'x'.repeat(129 * 1024) } }) })).status).toBe(413);
  } finally { await f.close(); }
});

test('sessions are listener-local; lazy services close only after use and remember remains best-effort', async () => {
  let stopped = 0, closed = 0, remembered = 0;
  const projectHost = { rememberCurrent() { remembered++; throw new Error('cache failure'); } };
  const f = fixture({ projectHost,
    deviceSettingsService: { async request() { return { runtime: true }; }, async stop() { stopped++; } },
    userServiceOptions: { preferencesService: { get() { return { values: {} }; }, close() { closed++; } } },
  });
  const first = f.start(), second = f.start();
  try {
    const Cookie = await login(first.url);
    expect((await rawFetch(second.url + '/api/host/session', { headers: { Cookie } })).status).toBe(401);
    expect((await rawFetch(first.url + '/api/host/settings/runtime', { headers: { Cookie } })).status).toBe(200);
    expect((await rawFetch(first.url + '/api/host/preferences', { headers: { Cookie } })).status).toBe(200);
    expect(() => rememberWebProject(first.web)).not.toThrow();
    expect(remembered).toBe(1);
    await second.web.stop(true); expect(stopped).toBe(0); expect(closed).toBe(0);
    await first.web.stop(true); expect(stopped).toBe(1); expect(closed).toBe(1);
  } finally { await f.close(); }
});
