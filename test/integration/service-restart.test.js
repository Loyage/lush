import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../src/identity.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { temp, repo, env, until } from '../helpers.js';
import { cli, freePort, waitForWeb } from './harness.js';
import { fetch } from '../web/harness.js';

const post = (url, body = {}, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function hostChanged(url, oldPid) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const response = await fetch(url + '/api/host').catch(() => null);
    if (response?.status === 200) { const host = await response.json(); if (host.pid !== oldPid) return host; }
    await Bun.sleep(25);
  }
  throw new Error('Host did not restart with a new serving pid');
}

test('project restart changes daemon only, single-flights clicks and keeps paused work unchanged', async () => {
  const root = temp(), other = temp(), port = freePort();
  try {
    await Promise.all([repo(root), repo(other)]);
    const [before, untouched] = await Promise.all([cli(root, ['daemon', 'start']), cli(other, ['daemon', 'start'])]);
    const client = new UIClient(new Config({ project: root, env: env() }));
    const task = await client.request('order.submit', { content: 'keep paused', start: false });
    const web = await cli(root, ['host', String(port)]), url = `http://127.0.0.1:${port}`;
    const [a, b] = await Promise.all([post(url + '/api/service/restart'), post(url + '/api/service/restart')]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const result = await (a.status === 200 ? a : b).json();
    expect(result).toMatchObject({ restarted: true, project: root });
    expect(result.pid).not.toBe(before.pid);
    expect((await fetch(url + '/api/host').then(r => r.json())).pid).toBe(web.pid);
    expect((await cli(other, ['daemon', 'status'])).pid).toBe(untouched.pid);
    expect((await client.request('worker.inspect', { id: task.task.id })).status).toBe('paused');
    expect((await client.request('worker.inspect', { id: task.task.id })).calls).toBe(0);
  } finally {
    await cli(root, ['host-stop', String(port)]).catch(() => {});
    await Promise.all([cli(root, ['daemon', 'stop']).catch(() => {}), cli(other, ['daemon', 'stop']).catch(() => {})]);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true });
  }
}, 30000);

test('Host restart flushes acceptance, changes worker on same port, leaves project daemon untouched', async () => {
  const root = temp(), port = freePort();
  try {
    await repo(root);
    const daemon = await cli(root, ['daemon', 'start']);
    const web = await cli(root, ['host', String(port)]), url = `http://127.0.0.1:${port}`;
    const before = await fetch(url + '/api/host').then(r => r.json());
    expect(before).toMatchObject({ pid: web.pid, restart_supported: true });
    const stateBefore = JSON.parse(fs.readFileSync(path.join(root, '.lush/host.state.json'), 'utf8'));
    const reply = await post(url + '/api/host/restart');
    expect(reply.status).toBe(200); expect(await reply.json()).toEqual({ restarting: true });
    expect((await post(url + '/api/host/restart')).status).toBe(400);
    const after = await hostChanged(url, before.pid);
    expect(after.restart_supported).toBe(true);
    expect(alive(before.pid)).toBe(false);
    const stateAfter = JSON.parse(fs.readFileSync(path.join(root, '.lush/host.state.json'), 'utf8'));
    expect(stateAfter.supervisor_pid).toBe(stateBefore.supervisor_pid);
    expect(stateAfter.port).toBe(port);
    expect((await cli(root, ['daemon', 'status'])).pid).toBe(daemon.pid);
  } finally {
    await cli(root, ['host-stop', String(port)]).catch(() => {});
    await cli(root, ['daemon', 'stop']).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('desktop ephemeral supervisor keeps random port through restart and owns the replacement lifetime', async () => {
  const root = temp();
  const host = Bun.spawn([process.execPath, path.join(ROOT, 'bin/lush-host'), '0'], {
    cwd: ROOT, env: env({ LUSH_WEB_LAUNCHER: '1', LUSH_WEB_EPHEMERAL: '1', XDG_CONFIG_HOME: root }),
    stdout: 'pipe', stderr: 'pipe',
  });
  let ready;
  const firstReady = new Promise(resolve => { ready = resolve; });
  const output = (async () => {
    const reader = host.stdout.getReader(), decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
      const line = text.split('\n').find(line => line.startsWith('LUSH_HOST_READY ') && line.endsWith('}'));
      if (line) ready(JSON.parse(line.slice(16)));
    }
  })();
  const errors = new Response(host.stderr).text();
  let first = null, replacement = null;
  try {
    let timer;
    const readyState = await Promise.race([firstReady, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ephemeral Host readiness timed out')), 10000);
    })]).finally(() => clearTimeout(timer));
    const url = readyState.url;
    first = { ...await fetch(url + '/api/host').then(r => r.json()), port: readyState.port };
    expect((await post(url + '/api/host/restart')).status).toBe(200);
    replacement = await hostChanged(url, first.pid);
    host.kill('SIGKILL'); await host.exited; // lost owner must close IPC and stop replacement too
    await waitForWeb(first.port, false);
    await until(() => !alive(replacement.pid));
    expect(alive(first.pid)).toBe(false);
    expect(alive(replacement.pid)).toBe(false);
    const ready = (await output).split('\n').filter(line => line.startsWith('LUSH_HOST_READY '));
    expect(ready.length).toBe(2);
    expect(ready.map(line => JSON.parse(line.slice(16)).port)).toEqual([first.port, first.port]);
  } finally {
    host.kill('SIGTERM'); await host.exited; await output; await errors;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('real authenticated Host restart invalidates old session and still accepts a fresh login', async () => {
  const root = temp(), port = freePort(), password = 'host restart auth password';
  try {
    fs.mkdirSync(path.join(root, '.lush'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lush/web.json'), JSON.stringify({ version: 1, username: 'owner', password }), { mode: 0o600 });
    const web = await cli(root, ['host', String(port)]), url = `http://127.0.0.1:${port}`;
    const login = () => fetch(url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=owner&password=${encodeURIComponent(password)}` });
    const oldLogin = await login(), Cookie = oldLogin.headers.get('set-cookie').split(';')[0];
    expect((await post(url + '/api/host/restart', {}, { Cookie })).status).toBe(200);
    const deadline = Date.now() + 10000;
    let expired = false;
    while (Date.now() < deadline) {
      const response = await fetch(url + '/api/host', { headers: { Cookie } }).catch(() => null);
      if (response?.status === 401) { expired = true; break; }
      await Bun.sleep(25);
    }
    expect(expired).toBe(true);
    const fresh = await login(); expect(fresh.status).toBe(303);
    const next = await fetch(url + '/api/host', { headers: { Cookie: fresh.headers.get('set-cookie').split(';')[0] } }).then(r => r.json());
    expect(next.pid).not.toBe(web.pid);
    expect(next.restart_supported).toBe(true);
  } finally {
    await cli(root, ['host-stop', String(port)]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);
