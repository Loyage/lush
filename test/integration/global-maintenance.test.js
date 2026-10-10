import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { writeLauncherState, projectRouteId } from '../../src/host/registry.js';
import { startWeb } from '../../src/ui/web/server.js';
import { serviceRestartControls } from '../../src/ui/web/assets/service-restart.js';
import { isLocked } from '../../src/daemon/locking.js';
import { installDom, deepText } from '../dom-stub.js';
import { temp, repo, env } from '../helpers.js';
import { cli, idle } from './harness.js';
import { fetch } from '../web/harness.js';

test('全局中断→项目后台重启→全部继续真实双daemon，保留维护门，不启动原待开始／离线／未登记项目', async () => {
  const roots = [temp(), temp(), temp(), temp()], device = temp(), dom = installDom();
  const extra = { LUSH_GLOBAL_CONFIG: device }, environment = env(extra);
  const configs = roots.map(project => new Config({ project, env: environment }));
  const clients = configs.map(config => new UIClient(config));
  let web;
  try {
    await Promise.all(roots.map(root => repo(root)));
    const before = await Promise.all([0, 1, 3].map(index => cli(roots[index], ['daemon', 'start'], extra)));
    for (const root of roots.slice(0, 3)) writeLauncherState(root, environment);
    web = startWeb(null, 0, { env: environment }); // No Host restart support is needed for maintenance.
    const url = `http://127.0.0.1:${web.port}`, calls = [];
    const request = async (route, options) => {
      calls.push([route, options]);
      const response = await fetch(url + route, options), result = await response.json();
      if (!response.ok) throw new Error(result.error); return result;
    };
    const section = serviceRestartControls({ request, confirm: async options => {
      if (options.title.startsWith('全部')) {
        expect(options.detail).toContain(roots[0]); expect(options.detail).toContain(roots[1]);
        expect(options.detail).not.toContain(roots[2]); expect(options.detail).not.toContain(roots[3]);
      }
      return true;
    }, changed: async () => section.updateProjects((await request('/api/host/projects')).projects) });
    await section.ready; section.updateProjects((await request('/api/host/projects')).projects);
    const button = kind => section.root.querySelector(`[data-service-restart="${kind}"]`);
    expect(button('all').disabled).toBe(true); expect(button('pause').disabled).toBe(false);
    await button('pause').onclick(); expect(deepText(section.root)).toContain('请求已接受');
    const queued = [], staged = [];
    for (const client of clients.slice(0, 2)) {
      expect((await client.request('system.summary')).maintenance).toMatchObject({ paused: true, ready_to_restart: true });
      queued.push((await client.request('order.submit', { content: 'queued during global maintenance' })).task);
      staged.push((await client.request('order.submit', { content: 'do not start staged', start: false })).task);
    }
    for (let i = 0; i < 2; i++) {
      const restart = section.projectControl({ id: projectRouteId(roots[i]), name: '项目', project: roots[i], running: true }).querySelector('button');
      await restart.onclick();
      const summary = await clients[i].request('system.summary');
      expect(summary.pid).not.toBe(before[i].pid); expect(summary.maintenance.paused).toBe(true);
      expect(await clients[i].request('worker.inspect', { id: queued[i].id })).toMatchObject({ status: 'queued', calls: 0 });
    }
    await button('resume').onclick(); expect(deepText(section.root)).toContain('请求已接受');
    for (let i = 0; i < 2; i++) {
      expect((await clients[i].request('system.summary')).maintenance.paused).toBe(false);
      expect((await idle(clients[i], queued[i].id)).calls).toBe(1);
      expect(await clients[i].request('worker.inspect', { id: staged[i].id })).toMatchObject({ status: 'paused', calls: 0 });
    }
    expect(isLocked(configs[2].home)).toBe(false);
    expect((await clients[3].request('system.summary')).maintenance.paused).toBe(false);
    expect((await clients[3].request('system.status')).pid).toBe(before[2].pid);
    const writes = calls.filter(([, options]) => options?.method === 'POST');
    expect(writes.filter(([route]) => route.endsWith('/api/action')).map(([route, options]) => [route, JSON.parse(options.body).method])).toEqual([
      [`/p/${projectRouteId(roots[0])}/api/action`, 'system.interrupt_all'],
      [`/p/${projectRouteId(roots[1])}/api/action`, 'system.interrupt_all'],
      [`/p/${projectRouteId(roots[0])}/api/action`, 'system.resume_all'],
      [`/p/${projectRouteId(roots[1])}/api/action`, 'system.resume_all'],
    ]);
    expect(writes.some(([route]) => route.startsWith('/api/host/'))).toBe(false);
  } finally {
    dom.restore(); await web?.stop(true);
    await Promise.all(roots.map(root => cli(root, ['daemon', 'stop'], extra).catch(() => {})));
    expect(configs.every(config => !isLocked(config.home))).toBe(true);
    for (const root of [...roots, device]) fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
