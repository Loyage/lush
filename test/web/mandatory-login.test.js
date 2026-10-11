import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startWeb } from '../../src/ui/web/server.js';
import { temp, env } from '../helpers.js';
import { rawFetch as fetch } from './auth-fixture.js';

const password = 'mandatory-login-test-only-password';
function fixture(value = { version: 2 }, bound = false) {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: root });
  const config = bound ? { project: root, home: path.join(root, '.lush'), env: environment } : null;
  const home = config?.home || root, file = path.join(home, 'web.json');
  fs.mkdirSync(home, { recursive: true });
  if (value) fs.writeFileSync(file, JSON.stringify({ username: 'W测试用户', password, ...value }), { mode: 0o600 });
  let calls = 0, web;
  const projectHost = new Proxy({}, { get() { calls++; throw new Error('session must not touch projectHost'); } });
  return { root, file, environment, config, calls: () => calls,
    start(options = {}) { return web = startWeb(config, 0, { env: environment, projectHost, ...options }); },
    async close() { await web?.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
}
const login = url => fetch(url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: url },
  body: new URLSearchParams({ username: 'W测试用户', password }).toString() });

test('missing scoped configuration refuses startup without writing auth or touching a daemon', async () => {
  for (const bound of [false, true]) {
    const f = fixture(null, bound);
    try {
      expect(() => f.start()).toThrow('请手工创建');
      expect(fs.existsSync(f.file)).toBe(false); expect(f.calls()).toBe(0);
      expect(() => f.start({ authConfig: null })).toThrow('不可禁用');
      // A config from another scope must never silently supply a missing project's auth.
      if (bound) {
        fs.writeFileSync(path.join(f.root, 'web.json'), JSON.stringify({ version: 2, username: 'owner', password }), { mode: 0o600 });
        expect(() => f.start()).toThrow(f.file);
      }
    } finally { await f.close(); }
  }
});

test('loopback login protects pages, assets and session; only the account name is returned without project access', async () => {
  for (const bound of [false, true]) {
    const f = fixture({ version: 2 }, bound), web = f.start(), url = `http://127.0.0.1:${web.port}`;
    try {
      expect(web.hostname).toBe('127.0.0.1');
      for (const route of ['/', '/app.js', '/p/abcdef0123456789/']) expect((await fetch(url + route)).status).toBe(303);
      for (const route of ['/api/host/session', '/api/docs', '/p/abcdef0123456789/api/snapshot']) {
        const response = await fetch(url + route); expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      const signed = await login(url); expect(signed.status).toBe(303);
      const Cookie = signed.headers.get('set-cookie').split(';')[0];
      expect(signed.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
      const response = await fetch(url + '/api/host/session', { headers: { Cookie, Origin: url } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ username: 'W测试用户' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect((await fetch(url + '/api/host/session?_token=secret', { headers: { Cookie } })).status).toBe(400);
      expect((await fetch(url + '/api/host/session', { method: 'POST', headers: { Cookie } })).status).toBe(404);
      for (const headers of [{ Cookie, Origin: 'https://attacker.invalid', 'Sec-Fetch-Site': 'same-site' },
        { Cookie, 'Sec-Fetch-Site': 'cross-site' }, { Cookie, Host: 'attacker.invalid' }])
        expect((await fetch(url + '/api/host/session', { headers })).status).toBe(403);
      expect((await fetch(url + '/p/abcdef0123456789/api/host/session', { headers: { Cookie } })).status).toBe(404);
      expect((await fetch(url + '/logout', { method: 'POST', headers: { Cookie, Origin: 'https://attacker.invalid' } })).status).toBe(403);
      expect((await fetch(url + '/api/host/session', { headers: { Cookie } })).status).toBe(200);
      expect((await fetch(url + '/logout', { method: 'POST', headers: { Cookie, Origin: url } })).status).toBe(303);
      expect((await fetch(url + '/api/host/session', { headers: { Cookie } })).status).toBe(401);
      expect(f.calls()).toBe(0);
    } finally { await f.close(); }
  }
});

test('all login page states use a network-free favicon with narrowly scoped image CSP', async () => {
  const f = fixture(), web = f.start(), url = `http://127.0.0.1:${web.port}`;
  const wrong = headers => fetch(url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ username: 'W测试用户', password: 'wrong-password' }).toString() });
  const assertPage = async (response, status) => {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const html = await response.text(), icon = /<link rel="icon" href="([^"]+)">/.exec(html)?.[1];
    expect(icon).toStartWith('data:image/svg+xml,');
    expect(decodeURIComponent(icon.slice('data:image/svg+xml,'.length))).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(html).not.toContain('/favicon.ico');
  };
  try {
    await assertPage(await fetch(url + '/login'), 200);
    await assertPage(await wrong({ Origin: 'https://attacker.invalid' }), 403);
    for (let i = 0; i < 5; i++) await assertPage(await wrong({ Origin: url }), 401);
    await assertPage(await wrong({ Origin: url }), 429);
    expect(f.calls()).toBe(0);
  } finally { await f.close(); }
});

test('session expiry rejects the old cookie', async () => {
  const f = fixture(), web = f.start(), url = `http://127.0.0.1:${web.port}`;
  const response = await login(url), Cookie = response.headers.get('set-cookie').split(';')[0];
  const now = Date.now(), clock = spyOn(Date, 'now').mockReturnValue(now + 12 * 60 * 60 * 1000 + 1);
  try { expect((await fetch(url + '/api/host/session', { headers: { Cookie } })).status).toBe(401); }
  finally { clock.mockRestore(); await f.close(); }
});

test('v2 listening is explicit, v1 public compatibility is retained and hash configs are not rewritten', async () => {
  for (const [value, hostname] of [[{ version: 2 }, '127.0.0.1'], [{ version: 2, listen: 'loopback' }, '127.0.0.1'],
    [{ version: 2, listen: 'public' }, '0.0.0.0'], [{ version: 1 }, '0.0.0.0']]) {
    const f = fixture(value, true);
    try {
      const web = f.start(); expect(web.hostname).toBe(hostname);
      const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      expect(saved).toMatchObject(value); expect(saved.password).toBeUndefined(); expect(saved.password_hash).toStartWith('scrypt$');
      const before = fs.readFileSync(f.file, 'utf8'); await web.stop(true);
      f.start(); expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    } finally { await f.close(); }
  }
  for (const value of [{ version: 3 }, { version: 2, listen: '0.0.0.0' }, { version: 1, listen: 'loopback' },
    { version: 2, listen: 'public' }, { version: 1 }, { version: 2, projects: [] }]) {
    const f = fixture(value);
    try { expect(() => f.start()).toThrow(); expect(f.calls()).toBe(0); }
    finally { await f.close(); }
  }
});

test('v2 global projects whitelist is enforced in both loopback and explicit public modes', async () => {
  for (const listen of ['loopback', 'public']) {
    const allowed = temp(), denied = temp(), f = fixture({ version: 2, listen, projects: [allowed] });
    const calls = [], web = f.start({ projectHost: undefined, openProject: async project => {
      calls.push(project); return { config: { project, home: path.join(project, '.lush') }, client: {} };
    } }), url = `http://127.0.0.1:${web.port}`;
    try {
      expect(web.hostname).toBe(listen === 'public' ? '0.0.0.0' : '127.0.0.1');
      const signed = await login(url), Cookie = signed.headers.get('set-cookie').split(';')[0];
      const select = project => fetch(url + '/api/host/select', { method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }) });
      expect((await select(denied)).status).toBe(400); expect(calls).toEqual([]);
      expect((await select(allowed)).status).toBe(200); expect(calls).toEqual([allowed]);
      expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).projects).toEqual([allowed]);
    } finally { await f.close(); for (const dir of [allowed, denied]) fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('v2 loopback accepts explicit proxy Host and Origin without enabling public listening', async () => {
  const f = fixture({ version: 2, origin: 'https://lush.example.com' }), web = f.start(), url = `http://127.0.0.1:${web.port}`;
  try {
    expect(web.hostname).toBe('127.0.0.1');
    const signed = await fetch(url + '/login', { method: 'POST', headers: { Host: 'lush.example.com', Origin: 'https://lush.example.com',
      'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'W测试用户', password }).toString() });
    expect(signed.status).toBe(303);
    expect((await fetch(url + '/api/host/session', { headers: { Host: 'lush.example.com', Origin: 'https://lush.example.com',
      Cookie: signed.headers.get('set-cookie').split(';')[0] } })).status).toBe(200);
    expect(f.calls()).toBe(0);
  } finally { await f.close(); }
});
