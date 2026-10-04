import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { fetch } from './harness.js';
import { startWeb } from '../../src/ui/web/server.js';

const ID = '0123456789abcdef0123456789abcdef';
function manager(origin) {
  const state = { connected: false, inspections: [], connects: [], disconnects: [], disposals: 0 };
  return { state,
    list() { return state.inspections.length ? [{ id: ID, alias: 'allowed-host', connected: state.connected, url: origin + '/' }] : []; },
    async inspect(profile) { state.inspections.push(profile); return { profile: { id: ID, alias: profile.alias }, ready: true,
      requiresInstall: false, plan: { alias: profile.alias }, warnings: [] }; },
    async connect(profile, options) { state.connects.push({ profile, options }); state.connected = true; return { profile, url: origin + '/' }; },
    disconnect(value) { state.disconnects.push(value); state.connected = false; return true; },
    dispose() { state.disposals++; state.connected = false; },
  };
}
function post(url, body, Cookie, extra = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(Cookie ? { Cookie } : {}), ...extra }, body: JSON.stringify(body) });
}
async function login(url, password) {
  const response = await fetch(url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=owner&password=${encodeURIComponent(password)}` });
  return response.headers.get('set-cookie').split(';')[0];
}
function hostStub() {
  return { launcher: true, status: async () => ({ mode: 'host', projects: [] }), projects: async () => [], hasRoute: () => false,
    rememberCurrent() {} };
}

test('public SSH requires an explicit alias allowlist and inspection confirmation is session-bound and one-use', async () => {
  const home = temp(), project = temp(), password = 'environment password long enough';
  fs.writeFileSync(path.join(home, 'web.json'), JSON.stringify({ version: 1, username: 'owner', password }), { mode: 0o600 });
  const tunnel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ mode: 'host', pid: 42, projects: [] }) });
  const ssh = manager(`http://127.0.0.1:${tunnel.port}`);
  const config = { project, home, env: {} };
  const web = startWeb(config, 0, { env: { LUSH_SSH_HOSTS: '["allowed-host"]' }, sshManager: ssh, projectHost: hostStub() });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    expect((await fetch(url + '/api/environments')).status).toBe(401);
    const first = await login(url, password), second = await login(url, password);
    const status = await (await fetch(url + '/api/environments', { headers: { Cookie: first } })).json();
    expect(status.ssh).toMatchObject({ supported: true, hosts: [{ alias: 'allowed-host' }], connections: [] });
    expect(status.execution.scope).toBe('host');

    const denied = await post(url + '/api/environments/ssh/inspect', { alias: 'evil.example' }, first);
    expect(denied.status).toBe(400); expect(ssh.state.inspections).toEqual([]);
    const checked = await (await post(url + '/api/environments/ssh/inspect', { alias: 'allowed-host' }, first)).json();
    expect(checked.confirmation).toBeString();
    expect((await post(url + '/api/environments/ssh/connect', { confirmation: checked.confirmation, install: false }, second)).status).toBe(400);
    const connected = await post(url + '/api/environments/ssh/connect', { confirmation: checked.confirmation, install: false }, first);
    expect(await connected.json()).toEqual({ id: ID, href: `/e/${ID}/` });
    expect(ssh.state.connects).toHaveLength(1);
    expect((await post(url + '/api/environments/ssh/connect', { confirmation: checked.confirmation, install: false }, first)).status).toBe(400);
    expect(ssh.state.connects).toHaveLength(1);

    const next = await (await post(url + '/api/environments/ssh/inspect', { alias: 'allowed-host', id: ID }, first)).json();
    expect(next.confirmation).toBeString();
    expect((await post(url + '/api/environments/ssh/cancel', {}, first)).status).toBe(200);
    expect((await post(url + '/api/environments/ssh/connect', { confirmation: next.confirmation, install: false }, first)).status).toBe(400);
    expect(ssh.state.disconnects).toEqual([]); // abandoning a ready plan preserves the live tunnel
  } finally {
    web.stop(true); tunnel.stop(true);
    expect(ssh.state.disposals).toBe(1);
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true });
  }
});

test('public SSH is disabled without LUSH_SSH_HOSTS and malformed allowlists fail before listening', async () => {
  const home = temp(), project = temp(), password = 'environment password long enough';
  fs.writeFileSync(path.join(home, 'web.json'), JSON.stringify({ version: 1, username: 'owner', password }), { mode: 0o600 });
  const ssh = manager('http://127.0.0.1:9');
  const config = { project, home, env: {} };
  let web;
  try {
    web = startWeb(config, 0, { env: {}, sshManager: ssh, projectHost: hostStub() });
    const url = `http://127.0.0.1:${web.port}`, Cookie = await login(url, password);
    const status = await (await fetch(url + '/api/environments', { headers: { Cookie } })).json();
    expect(status.ssh.supported).toBe(false); expect(status.ssh.hosts).toEqual([]);
    expect((await post(url + '/api/environments/ssh/inspect', { alias: 'allowed-host' }, Cookie)).status).toBe(400);
    web.stop(true); web = null;
    for (const value of ['not json', '{}', '["ok", "ok"]', '["https://evil.invalid"]']) {
      expect(() => startWeb(config, 0, { env: { LUSH_SSH_HOSTS: value }, sshManager: ssh, projectHost: hostStub() })).toThrow('LUSH_SSH_HOSTS');
    }
  } finally { web?.stop(true); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); }
});

test('host publishes explicit project control and forwards only registered project ids to lifecycle methods', async () => {
  const home = temp(), calls = [];
  const projectHost = { ...hostStub(), async start(id) { calls.push(['start', id]); return { id, running: true }; },
    async stop(id) { calls.push(['stop', id]); return { id, running: false }; } };
  const environmentManager = { status: () => ({ execution: {}, ssh: { supported: false, hosts: [], warnings: [], connections: [] } }), dispose() {}, cancel() {} };
  const web = startWeb(null, 0, { env: { LUSH_GLOBAL_CONFIG: home }, projectHost, environmentManager });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    expect(await (await fetch(url + '/api/host')).json()).toMatchObject({ project_control: true });
    expect(await (await post(url + '/api/host/projects/start', { id: 'aaaaaaaaaaaaaaaa' })).json()).toEqual({ id: 'aaaaaaaaaaaaaaaa', running: true });
    expect(await (await post(url + '/api/host/projects/stop', { id: 'aaaaaaaaaaaaaaaa' })).json()).toEqual({ id: 'aaaaaaaaaaaaaaaa', running: false });
    expect(calls).toEqual([['start', 'aaaaaaaaaaaaaaaa'], ['stop', 'aaaaaaaaaaaaaaaa']]);
    expect((await post(url + '/api/host/projects/start', { id: 'aaaaaaaaaaaaaaaa', project: '/tmp/evil' })).status).toBe(400);
  } finally { web.stop(true); fs.rmSync(home, { recursive: true, force: true }); }
});

test('environment UI is local and gateway proxies only registered JSON APIs without browser secrets', async () => {
  const home = temp(), project = temp(), seen = [];
  let remoteMode = 'host', tunnelStopped = false;
  const tunnel = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url); seen.push({ path: url.pathname, cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization') });
    if (url.pathname === '/api/host') return Response.json({ mode: remoteMode, pid: 77, projects: [{ id: 'aaaaaaaaaaaaaaaa' }] }, { headers: { 'Set-Cookie': 'remote=secret' } });
    if (url.pathname === '/api/host/projects') return Response.json({ projects: [{ id: 'aaaaaaaaaaaaaaaa', running: false }] }, { headers: { 'Set-Cookie': 'remote=secret' } });
    if (url.pathname === '/p/aaaaaaaaaaaaaaaa/api/snapshot') return Response.json({ status: { project: '/remote/project' } });
    return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid/' } });
  } });
  const ssh = manager(`http://127.0.0.1:${tunnel.port}`);
  ssh.state.inspections.push({ alias: 'allowed-host' }); ssh.state.connected = true;
  const web = startWeb(null, 0, { env: { LUSH_GLOBAL_CONFIG: home }, sshManager: ssh, projectHost: hostStub(),
    readSSHConfig: () => ({ hosts: [{ alias: 'allowed-host' }], warnings: [] }) });
  const url = `http://127.0.0.1:${web.port}`;
  try {
    const page = await fetch(`${url}/e/${ID}/`, { headers: { Cookie: 'lush_session=must-not-forward', Authorization: 'Bearer browser-secret' } });
    expect(page.status).toBe(200); expect(await page.text()).toContain('id="project-app"');
    const host = await fetch(`${url}/e/${ID}/api/host`, { headers: { Cookie: 'lush_session=must-not-forward', Authorization: 'Bearer browser-secret' } });
    expect(host.status).toBe(200); expect(host.headers.get('set-cookie')).toBeNull();
    const projects = await fetch(`${url}/e/${ID}/api/host/projects`, { headers: { Cookie: 'lush_session=must-not-forward' } });
    expect(projects.status).toBe(200); expect(projects.headers.get('set-cookie')).toBeNull();
    const snapshot = await fetch(`${url}/e/${ID}/p/aaaaaaaaaaaaaaaa/api/snapshot`);
    expect(snapshot.status).toBe(200); expect((await snapshot.json()).status.project).toBe('/remote/project');
    expect((await fetch(`${url}/e/${ID}/p/bbbbbbbbbbbbbbbb/api/snapshot`)).status).toBe(400);
    expect((await fetch(`${url}/e/${ID}/assets/app.js`)).status).toBe(400);
    expect((await fetch(`${url}/e/${ID}/api/environments`)).status).toBe(400);
    const gateway = `${url}/e/${ID}/p/aaaaaaaaaaaaaaaa/api/action`;
    for (const body of [{ method: 'system.stop', params: {} }, { method: 'worker.cancel', params: { id: 1, _token: 'escaped' } }]) {
      expect((await post(gateway, body)).status).toBe(400);
    }
    expect(seen.some(call => call.path.endsWith('/api/action'))).toBe(false);
    expect((await fetch(`${url}/e/${'f'.repeat(32)}/api/host`)).status).toBe(400); // missing environment identity
    ssh.state.connected = false;
    expect((await fetch(`${url}/e/${ID}/`)).status).toBe(200);
    expect((await fetch(`${url}/e/${ID}/p/aaaaaaaaaaaaaaaa/`)).status).toBe(200);
    expect((await fetch(`${url}/e/${ID}/api/docs`)).status).toBe(200);
    expect((await fetch(`${url}/e/${ID}/api/host`)).status).toBe(400); // disconnected identity never falls back locally
    ssh.state.connected = true; remoteMode = 'bound';
    expect((await fetch(`${url}/e/${ID}/api/host`)).status).toBe(400); // wrong Host identity
    remoteMode = 'host';
    const docs = await fetch(`${url}/e/${ID}/api/docs`);
    expect(docs.status).toBe(200); expect((await docs.json()).docs.length).toBeGreaterThan(0);
    expect(seen.every(call => call.cookie === null && call.authorization === null)).toBe(true);
    tunnel.stop(true); tunnelStopped = true;
    expect((await fetch(`${url}/e/${ID}/api/host`)).status).toBe(400); // offline tunnel
  } finally { web.stop(true); if (!tunnelStopped) tunnel.stop(true); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); }
});
