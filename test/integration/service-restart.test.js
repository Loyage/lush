import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { temp, repo, env, until } from '../helpers.js';
import { cli, freePort } from './harness.js';
import { fetch } from '../web/harness.js';
import { installDom, deepText } from '../dom-stub.js';
import { serviceRestartControls, waitForHostRestart } from '../../src/ui/web/assets/service-restart.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';
import { startWeb } from '../../src/ui/web/server.js';
import { isLocked } from '../../src/daemon/locking.js';

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
    const web = await cli(root, ['host', 'start', String(port)]), url = `http://127.0.0.1:${port}`;
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
    await cli(root, ['host', 'stop', String(port)]).catch(() => {});
    await Promise.all([cli(root, ['daemon', 'stop']).catch(() => {}), cli(other, ['daemon', 'stop']).catch(() => {})]);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true });
  }
}, 30000);

test('Host restart flushes acceptance, changes worker on same port, leaves project daemon untouched', async () => {
  const root = temp(), port = freePort();
  try {
    await repo(root);
    const daemon = await cli(root, ['daemon', 'start']);
    const web = await cli(root, ['host', 'start', String(port)]), url = `http://127.0.0.1:${port}`;
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
    await cli(root, ['host', 'stop', String(port)]).catch(() => {});
    await cli(root, ['daemon', 'stop']).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('全部重启按钮更换后台与Host进程，保留静息Worker且不动其他项目', async () => {
  const root = temp(), other = temp(), port = freePort(), dom = installDom();
  try {
    await Promise.all([repo(root), repo(other)]);
    const [daemon, untouched] = await Promise.all([cli(root, ['daemon', 'start']), cli(other, ['daemon', 'start'])]);
    const client = new UIClient(new Config({ project: root, env: env() }));
    const task = await client.request('order.submit', { content: 'keep paused through all restart', start: false });
    const web = await cli(root, ['host', 'start', String(port)]), url = `http://127.0.0.1:${port}`;
    const calls = []; let reloads = 0, confirmations = 0;
    const section = serviceRestartControls({ confirm: async () => { confirmations++; return true; }, reload: () => reloads++,
      recover: pid => waitForHostRestart(pid, { fetchHost: () => fetch(url + '/api/host') }),
      request: async (route, options) => {
        calls.push(route);
        const response = await fetch(url + route, options), value = await response.json();
        if (!response.ok) throw new Error(value.error);
        return value;
      } });
    const button = section.root.querySelector('[data-service-restart="all"]');
    await until(() => !button.disabled);
    await button.onclick();
    expect(deepText(section.root)).not.toContain('失败');
    expect(confirmations).toBe(1); expect(reloads).toBe(1);
    expect(calls).toEqual(['/api/host', '/api/host/projects', '/api/host', `/p/${projectRouteId(root)}/api/service/restart`, '/api/host/restart']);
    expect((await fetch(url + '/api/host').then(r => r.json())).pid).not.toBe(web.pid);
    expect((await cli(root, ['daemon', 'status'])).pid).not.toBe(daemon.pid);
    expect((await cli(other, ['daemon', 'status'])).pid).toBe(untouched.pid);
    expect(await client.request('worker.inspect', { id: task.task.id })).toMatchObject({ status: 'paused', calls: 0 });
  } finally {
    dom.restore();
    await cli(root, ['host', 'stop', String(port)]).catch(() => {});
    await Promise.all([cli(root, ['daemon', 'stop']).catch(() => {}), cli(other, ['daemon', 'stop']).catch(() => {})]);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true });
  }
}, 30000);

test('全局全部重启真实双daemon：只处理已登记在线项目，离线与未登记项目不启动／不重启', async () => {
  const roots = [temp(), temp(), temp(), temp()], device = temp(), dom = installDom();
  const extra = { LUSH_GLOBAL_CONFIG: device }, environment = env(extra);
  const configs = roots.map(project => new Config({ project, env: environment }));
  const ids = roots.map(projectRouteId);
  let web, hostRestarts = 0;
  try {
    await Promise.all(roots.map(root => repo(root)));
    const [beforeA, beforeB, untouched] = await Promise.all([0, 1, 3].map(index => cli(roots[index], ['daemon', 'start'], extra)));
    for (const root of roots.slice(0, 3)) writeLauncherState(root, environment);
    const clients = configs.slice(0, 2).map(config => new UIClient(config));
    const tasks = await Promise.all(clients.map(client => client.request('order.submit', { content: 'keep paused', start: false })));
    // Daemons and routing are real; the isolated embedded Host's exit is controlled.
    web = startWeb(null, 0, { env: environment, restartHost: () => hostRestarts++ });
    const url = `http://127.0.0.1:${web.port}`, calls = []; let reloads = 0;
    const section = serviceRestartControls({ confirm: async options => {
      expect(options.message).toContain('2 个在线项目');
      expect(options.detail).toContain(roots[0]); expect(options.detail).toContain(roots[1]);
      expect(options.detail).not.toContain(roots[2]); expect(options.detail).not.toContain(roots[3]); return true;
    }, reload: () => reloads++, recover: async () => true, request: async (route, options) => {
      calls.push(route); const response = await fetch(url + route, options), value = await response.json();
      if (!response.ok) throw new Error(value.error); return value;
    } });
    await section.ready; await section.root.querySelector('[data-service-restart="all"]').onclick();
    expect(calls).toEqual(['/api/host', '/api/host/projects', '/api/host', `/p/${ids[0]}/api/service/restart`, `/p/${ids[1]}/api/service/restart`, '/api/host/restart']);
    expect(reloads).toBe(1); await until(() => hostRestarts === 1);
    expect((await clients[0].request('system.status')).pid).not.toBe(beforeA.pid);
    expect((await clients[1].request('system.status')).pid).not.toBe(beforeB.pid);
    expect(isLocked(configs[2].home)).toBe(false);
    expect((await cli(roots[3], ['daemon', 'status'], extra)).pid).toBe(untouched.pid);
    for (let i = 0; i < 2; i++) expect(await clients[i].request('worker.inspect', { id: tasks[i].task.id })).toMatchObject({ status: 'paused', calls: 0 });
  } finally {
    dom.restore(); await web?.stop(true);
    await Promise.all(roots.map(root => cli(root, ['daemon', 'stop'], extra)));
    expect(configs.every(config => !isLocked(config.home))).toBe(true);
    for (const root of [...roots, device]) fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('real authenticated Host restart invalidates old session and still accepts a fresh login', async () => {
  const root = temp(), port = freePort(), password = 'host restart auth password';
  try {
    fs.mkdirSync(path.join(root, '.lush'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lush/web.json'), JSON.stringify({ version: 1, username: 'owner', password }), { mode: 0o600 });
    const web = await cli(root, ['host', 'start', String(port)]), url = `http://127.0.0.1:${port}`;
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
    await cli(root, ['host', 'stop', String(port)]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);
