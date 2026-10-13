import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';
import { isLocked } from '../../src/daemon/locking.js';
import { serviceRestartControls } from '../../src/ui/web/assets/service-restart.js';
import { installDom, deepText } from '../dom-stub.js';
import { temp, repo, env, until } from '../helpers.js';
import { cli, emittedTask, idle } from './harness.js';
import { bindMockPiSource } from './pi-runtime-fixture.js';
import { startTestWeb } from '../web/auth-fixture.js';
import { fetch } from '../web/harness.js';

// Actual guarded provider and tool processes. The test controls tool completion and then
// provider exit separately; a stop marker alone must never authorize a daemon restart.
const providerSource = `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.LUSH_HOME;
const context = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'task-' + process.env.LUSH_TASK_ID + '-input.md'), 'utf8'));
const mark = value => fs.writeFileSync(path.join(home, value), 'yes');
if (context.task.calls !== 1 || context.task.goal !== 'controlled active tool') {
  mark('resumed-' + context.task.id); console.log('controlled provider returned'); process.exit(0);
}
const tool = Bun.spawn([process.execPath, '-e', "const fs=require('node:fs'); const p=process.argv[1]; while(!fs.existsSync(p)) await Bun.sleep(10);", path.join(home, 'release-tool')], { stdout: 'ignore', stderr: 'inherit' });
mark('tool-started');
const request = path.join(home, 'preempt', 'task-' + context.task.id + '.request.json');
while (!fs.existsSync(request)) await Bun.sleep(10);
mark('interrupt-seen');
await tool.exited; mark('tool-finished');
const signal = JSON.parse(fs.readFileSync(request, 'utf8'));
fs.writeFileSync(path.join(home, 'preempt', 'task-' + context.task.id + '.stop.json'), JSON.stringify({ ...signal,
  task_id: context.task.id, run_id: context.invocation.run_id, safe_point: 'tool_end', stopped_at: new Date().toISOString() }));
mark('safe-point');
while (!fs.existsSync(path.join(home, 'release-provider'))) await Bun.sleep(10);
console.log('tool safely finished, provider now exits');
`;

test('一键真实双daemon：等工具收尾与provider退出→持久维护门重启→仅自动继续新暂停→最后界面', async () => {
  const roots = [temp(), temp(), temp(), temp()], device = temp(), dom = installDom();
  const fake = path.join(device, 'controlled-pi'); fs.writeFileSync(fake, providerSource, { mode: 0o755 });
  const extra = { LUSH_GLOBAL_CONFIG: device, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake }, environment = env(extra);
  const configs = roots.map(project => new Config({ project, env: environment }));
  const clients = configs.map(config => new UIClient(config));
  const ids = roots.map(projectRouteId), home = configs[0].home;
  const exists = name => fs.existsSync(path.join(home, name));
  const release = name => fs.writeFileSync(path.join(home, name), 'yes');
  let web, section, hostRestarts = 0;
  try {
    await Promise.all(roots.map(root => repo(root)));
    const before = await Promise.all([0, 1, 3].map(i => cli(roots[i], ['daemon', 'start'], extra)));
    await bindMockPiSource(roots[0], extra);
    for (const root of roots.slice(0, 3)) writeLauncherState(root, environment);
    const staged = await Promise.all(clients.slice(0, 2).map(client => client.request('order.submit', { content: 'original staged', start: false })));
    const originalPause = await clients[1].request('system.interrupt_all');
    const deadline = Date.now() + 4000;
    while ((await clients[1].request('system.summary')).maintenance.completion_state !== 'completed') {
      if (Date.now() >= deadline) throw new Error('original maintenance did not complete');
      await Bun.sleep(10);
    }
    const queuedB = await clients[1].request('order.submit', { content: 'keep queued in original maintenance' });
    const receipt = await clients[0].request('order.submit', { content: 'controlled active tool' });
    const active = await emittedTask(clients[0], receipt);
    await until(() => exists('tool-started'));
    web = startTestWeb(null, 0, { env: environment, restartHost: () => hostRestarts++ });
    const url = `http://127.0.0.1:${web.port}`, calls = [], writes = [], restarted = [];
    section = serviceRestartControls({ confirm: async options => {
      expect(options.agent).toBe(true); expect(options.message).toContain('2 个在线项目');
      expect(options.detail).toContain(roots[0]); expect(options.detail).toContain(roots[1]);
      expect(options.detail).not.toContain(roots[2]); expect(options.detail).not.toContain(roots[3]);
      expect(options.detail).toContain('原维护暂停'); return true;
    }, schedule: (fn, ms) => setTimeout(fn, ms === 2000 ? 20 : ms), recover: async () => true,
    reload: () => {}, request: async (route, options) => {
      calls.push(route);
      if (options?.method === 'POST') {
        writes.push([route, route.endsWith('/api/action') ? JSON.parse(options.body).method : 'restart']);
        if (route.endsWith('/api/service/restart')) {
          expect(exists('tool-finished')).toBe(true); expect(exists('safe-point')).toBe(true);
          const state = await clients[0].request('worker.inspect', { id: active.id });
          expect(state.agent.active).toBe(false); expect(state.calls).toBe(1);
          for (const client of clients.slice(0, 2)) expect((await client.request('system.summary')).maintenance).toMatchObject({ paused: true, ready_to_restart: true, completion_state: 'completed' });
        }
        if (route === '/api/host/restart') {
          expect(restarted).toHaveLength(2);
          expect((await clients[0].request('system.summary')).maintenance.paused).toBe(false);
          expect((await clients[1].request('system.summary')).maintenance).toMatchObject({ paused: true, batch_id: originalPause.batch_id });
        }
      }
      const response = await fetch(url + route, options), result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (route.endsWith('/api/service/restart')) {
        restarted.push(result);
        const index = ids.findIndex(id => route.includes(id));
        expect(result.pid).not.toBe(before[index].pid);
        expect((await clients[index].request('system.summary')).maintenance).toMatchObject({ paused: true, completion_state: 'completed', ready_to_restart: true });
      }
      return result;
    } });
    await section.ready;
    const operation = section.root.querySelector('[data-service-restart="safe"]').onclick();
    await until(() => exists('interrupt-seen'));
    expect((await clients[0].request('system.summary')).maintenance).toMatchObject({ paused: true, ready_to_restart: false, completion_state: 'pending' });
    expect(writes).toEqual([[`/p/${ids[0]}/api/action`, 'system.interrupt_all']]);
    expect((await clients[0].request('system.status')).pid).toBe(before[0].pid);
    release('release-tool'); await until(() => exists('safe-point'));
    expect(exists('tool-finished')).toBe(true);
    expect((await clients[0].request('worker.inspect', { id: active.id })).agent.active).toBe(true);
    expect((await clients[0].request('system.summary')).maintenance.ready_to_restart).toBe(false);
    expect(writes).toHaveLength(1);
    release('release-provider'); await operation;
    expect(section.root.querySelector('.settings-error')).toBeNull();
    expect(deepText(section.root)).toContain('一键安全重启已完成');
    expect(writes).toEqual([[`/p/${ids[0]}/api/action`, 'system.interrupt_all'],
      [`/p/${ids[0]}/api/service/restart`, 'restart'], [`/p/${ids[1]}/api/service/restart`, 'restart'],
      [`/p/${ids[0]}/api/action`, 'system.resume_all'], ['/api/host/restart', 'restart']]);
    await until(() => hostRestarts === 1);
    expect((await idle(clients[0], active.id, 2)).calls).toBe(2);
    expect(exists(`resumed-${active.id}`)).toBe(true);
    for (let i = 0; i < 2; i++) expect(await clients[i].request('worker.inspect', { id: staged[i].task.id })).toMatchObject({ status: 'paused', calls: 0 });
    expect(await clients[1].request('input.get', { kind: 'draft', id: queuedB.draft_id })).toMatchObject({ task_id: null, dispatch: { state: 'queued' } });
    expect(isLocked(configs[2].home)).toBe(false);
    expect((await clients[3].request('system.status')).pid).toBe(before[2].pid);
    expect((await clients[3].request('system.summary')).maintenance.paused).toBe(false);
    expect(calls.some(route => route.includes(ids[2]) || route.includes(ids[3]))).toBe(false);
  } finally {
    // Release only this test's controlled processes even if an assertion failed before cleanup.
    if (fs.existsSync(home)) { release('release-tool'); release('release-provider'); }
    section?.dispose(); dom.restore(); await web?.stop(true);
    await Promise.all(roots.map(root => cli(root, ['daemon', 'stop'], extra).catch(() => {})));
    for (const root of [...roots, device]) fs.rmSync(root, { recursive: true, force: true });
  }
});
