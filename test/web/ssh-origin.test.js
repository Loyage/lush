import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from '../helpers.js';
import { fetch } from './harness.js';
import { startWeb, sshLoopbackOrigin } from '../../src/ui/web/server.js';
import { launcherWebConfig } from '../../src/host/registry.js';
import { run } from '../../src/cli/commands/system.js';

const SSH_ORIGIN = 'http://127.0.0.1:14318';
const SSH_HOST = '127.0.0.1:14318';

function fixture(extra = {}) {
  const home = temp(), project = temp();
  const env = { LUSH_GLOBAL_CONFIG: home, ...extra };
  const calls = [];
  const options = { env, openProject: async selected => {
    calls.push(selected);
    return { config: { project: selected, home: path.join(selected, '.lush') },
      client: { snapshot: async () => ({ status: { project: selected } }) } };
  } };
  return { home, project, env, calls, options,
    close(web) { web?.stop(true); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); } };
}

function url(web) { return `http://127.0.0.1:${web.port}`; }
function post(project, headers = {}) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ project }) };
}

// All fixtures use real temporary HTTP listeners and controllable project openers, never user lushd.
test('default unauthenticated Host still rejects forwarded ports and malicious domains', async () => {
  const f = fixture();
  const web = startWeb(null, 0, f.options);
  try {
    expect(web.hostname).toBe('127.0.0.1');
    expect((await fetch(url(web))).status).toBe(200);
    for (const host of [SSH_HOST, 'evil.invalid', `evil.invalid:${web.port}`, `127.0.0.1.evil.invalid:${web.port}`]) {
      expect((await fetch(url(web), { headers: { Host: host } })).status).toBe(403);
    }
    expect(f.calls).toEqual([]);
  } finally { f.close(web); }
});

test('explicit SSH origin accepts only its exact forwarded Host without changing the listener', async () => {
  const f = fixture({ LUSH_WEB_SSH_ORIGIN: SSH_ORIGIN });
  const web = startWeb(null, 0, f.options);
  try {
    expect(web.hostname).toBe('127.0.0.1');
    expect(web.port).not.toBe(14318);
    expect((await fetch(url(web), { headers: { Host: SSH_HOST } })).status).toBe(200);
    expect((await fetch(url(web) + '/api/host', { headers: { Host: SSH_HOST, Origin: SSH_ORIGIN, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
    const rejected = ['localhost:14318', '127.0.0.1:14319', '[::1]:14318', 'evil.invalid:14318', '127.0.0.1.evil.invalid:14318', '127.1:14318'];
    for (const host of rejected) {
      expect((await fetch(url(web), { headers: { Host: host } })).status).toBe(403);
    }
    // The normal remote loopback entrance remains useful for readiness diagnostics.
    expect((await fetch(url(web))).status).toBe(200);
    expect(f.calls).toEqual([]);
  } finally { f.close(web); }
});

test('SSH forwarding does not allow cross-origin or cross-site mutations', async () => {
  const f = fixture({ LUSH_WEB_SSH_ORIGIN: SSH_ORIGIN });
  const web = startWeb(null, 0, f.options);
  try {
    for (const origin of ['http://127.0.0.1:14319', 'http://localhost:14318', 'https://127.0.0.1:14318', 'https://evil.invalid', url(web)]) {
      for (const site of ['same-origin', 'same-site', 'none']) {
        const denied = await fetch(url(web) + '/api/host/select', post(f.project, { Host: SSH_HOST, Origin: origin, 'Sec-Fetch-Site': site }));
        expect(denied.status).toBe(403);
      }
    }
    const crossSite = await fetch(url(web) + '/api/host/select', post(f.project, { Host: SSH_HOST, Origin: SSH_ORIGIN, 'Sec-Fetch-Site': 'cross-site' }));
    expect(crossSite.status).toBe(403);
    expect(f.calls).toEqual([]);

    const accepted = await fetch(url(web) + '/api/host/select', post(f.project, { Host: SSH_HOST, Origin: SSH_ORIGIN, 'Sec-Fetch-Site': 'same-origin' }));
    expect(accepted.status).toBe(200);
    expect(f.calls).toEqual([fs.realpathSync(f.project)]);
    // Declaring a forwarding origin must not add it as a general proxy-origin exception.
    expect((await fetch(url(web) + '/api/host', { headers: { Origin: SSH_ORIGIN } })).status).toBe(403);
  } finally { f.close(web); }
});

test('SSH origin validation rejects non-canonical origins before creating state or listeners', () => {
  const invalid = [null, 14318, '', ' ', SSH_ORIGIN + '\n', ' ' + SSH_ORIGIN,
    'http://localhost:14318', 'http://[::1]:14318', 'http://127.1:14318', 'http://2130706433:14318',
    'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:014318',
    'https://127.0.0.1:14318', 'HTTP://127.0.0.1:14318', 'http://evil.invalid:14318',
    'http://owner@127.0.0.1:14318', 'http://127.0.0.1:14318/', 'http://127.0.0.1:14318/path',
    'http://127.0.0.1:14318?query', 'http://127.0.0.1:14318#fragment', 'http://127.0.0.1:14318\\path'];
  for (const value of invalid) {
    const f = fixture({ LUSH_WEB_SSH_ORIGIN: value });
    try {
      expect(() => startWeb(null, 0, f.options)).toThrow('LUSH_WEB_SSH_ORIGIN must be');
      expect(fs.readdirSync(f.home)).toEqual([]);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    expect(sshLoopbackOrigin(f.env)).toBeNull();
    for (const port of [1, 80, 14318, 65535]) {
      const value = `http://127.0.0.1:${port}`;
      expect(sshLoopbackOrigin({ ...f.env, LUSH_WEB_SSH_ORIGIN: value })).toBe(new URL(value).origin);
    }
  } finally { f.close(); }
});

test('SSH accepts canonical browser Host and Origin for explicitly declared default HTTP port', async () => {
  const f = fixture({ LUSH_WEB_SSH_ORIGIN: 'http://127.0.0.1:80' });
  const web = startWeb(null, 0, f.options);
  try {
    expect((await fetch(url(web), { headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1' } })).status).toBe(200);
    expect((await fetch(url(web), { headers: { Host: 'localhost', Origin: 'http://localhost' } })).status).toBe(403);
  } finally { f.close(web); }
});

test('project config env is honored, and explicit options env takes precedence', async () => {
  const f = fixture({ LUSH_WEB_SSH_ORIGIN: SSH_ORIGIN });
  const config = { project: f.project, home: f.home, env: f.env };
  let web;
  try {
    web = startWeb(config, 0, { openProject: f.options.openProject });
    expect((await fetch(url(web), { headers: { Host: SSH_HOST } })).status).toBe(200);
    web.stop(true);
    web = startWeb(config, 0, { ...f.options, env: { LUSH_GLOBAL_CONFIG: f.home } });
    expect((await fetch(url(web), { headers: { Host: SSH_HOST } })).status).toBe(403);
  } finally { f.close(web); }
});

test('SSH refuses existing auth scopes even when ephemeral mode or authConfig:null would suppress auth', () => {
  const f = fixture({ LUSH_WEB_SSH_ORIGIN: SSH_ORIGIN, LUSH_WEB_EPHEMERAL: '1' });
  const auth = JSON.stringify({ version: 1, username: 'owner', password: 'never rewrite this test password', projects: [f.project] });
  const file = path.join(f.home, 'web.json');
  fs.writeFileSync(file, auth, { mode: 0o600 });
  try {
    for (const config of [null, { project: f.project, home: f.home, env: f.env }]) {
      for (const authConfig of [undefined, null]) {
        expect(() => startWeb(config, 0, { ...f.options, authConfig })).toThrow('conflicts with web.json');
        expect(fs.readFileSync(file, 'utf8')).toBe(auth);
      }
    }
  } finally { f.close(); }
});

test('SSH refuses a supplied alternate auth configuration before password hashing', () => {
  const f = fixture({ LUSH_WEB_SSH_ORIGIN: SSH_ORIGIN });
  const alternate = temp();
  const file = path.join(alternate, 'web.json');
  const auth = JSON.stringify({ version: 1, username: 'owner', password: 'never rewrite this test password', projects: [f.project] });
  fs.writeFileSync(file, auth, { mode: 0o600 });
  try {
    expect(() => startWeb(null, 0, { ...f.options, authConfig: { home: alternate, env: f.env } })).toThrow('supplied Web auth configuration');
    expect(fs.readFileSync(file, 'utf8')).toBe(auth);
  } finally { fs.rmSync(alternate, { recursive: true, force: true }); f.close(); }
});

test('CLI validates SSH scope before host startup or restart side effects', async () => {
  for (const command of ['host:start', 'host:restart']) {
    const f = fixture({ LUSH_WEB_SSH_ORIGIN: 'https://evil.invalid:14318' });
    try {
      const config = launcherWebConfig(f.env);
      await expect(run(command, ['0'], { client: { config, token: null }, json: true })).rejects.toThrow('LUSH_WEB_SSH_ORIGIN must be');
      expect(fs.readdirSync(f.home)).toEqual([]);
      config.env.LUSH_WEB_SSH_ORIGIN = SSH_ORIGIN;
      const auth = 'existing authentication configuration must not be changed';
      fs.writeFileSync(path.join(f.home, 'web.json'), auth, { mode: 0o600 });
      await expect(run(command, ['0'], { client: { config, token: null }, json: true })).rejects.toThrow('conflicts with web.json');
      expect(fs.readFileSync(path.join(f.home, 'web.json'), 'utf8')).toBe(auth);
      expect(fs.readdirSync(f.home)).toEqual(['web.json']);
    } finally { f.close(); }
  }
});
