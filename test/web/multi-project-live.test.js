import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { fixture, repo, temp, env as cleanEnv } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { UIClient } from '../../src/ui/client.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId, writeLauncherState } from '../../src/host/registry.js';
import { fetch } from './harness.js';

test('Host 只探测已登记项目的 lushd，读取列表不启动项目', async () => {
  const f = fixture();
  await repo(f.root);
  const global = temp();
  const env = cleanEnv({ LUSH_GLOBAL_CONFIG: global });
  writeLauncherState(f.config.project, env);
  const web = startWeb(null, 0, { env, openProject: async () => { throw new Error('列表不得启动 lushd'); } });
  const url = `http://127.0.0.1:${web.port}`;
  let rpc;
  try {
    const offline = await (await fetch(url + '/api/host/projects')).json();
    expect(offline.projects[0]).toMatchObject({ connected: false, running: false });
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
    await rpc.start();
    const online = await (await fetch(url + '/api/host/projects')).json();
    expect(online.projects[0]).toMatchObject({ connected: false, running: true });
    expect(online.projects[0].summary.project).toBe(f.config.project);
  } finally {
    web.stop(true);
    if (rpc) await rpc.close();
    fs.rmSync(f.config.socket, { force: true });
    await f.close();
    fs.rmSync(global, { recursive: true, force: true });
  }
});

// 真实 daemon（进程内 RPC server）：两个项目的写与读在同一个全局 Web 下仍各自归属。
test('两个真实项目的 daemon 同时连在一个全局 Web 下，A 的写不会落到 B', async () => {
  const a = fixture(), b = fixture();
  await repo(a.root); await repo(b.root);
  const rpcA = new RPCServer(a.config.socket, new Dispatcher(a.project, createSignal(), {})); await rpcA.start();
  const rpcB = new RPCServer(b.config.socket, new Dispatcher(b.project, createSignal(), {})); await rpcB.start();
  const global = temp();
  const env = cleanEnv({ LUSH_GLOBAL_CONFIG: global });
  const byPath = new Map([[a.config.project, a], [b.config.project, b]]);
  const web = startWeb(null, 0, { env, openProject: async project => {
    const f = byPath.get(project);
    if (!f) throw new Error(`unexpected project: ${project}`);
    return { config: f.config, client: new UIClient(f.config) };
  } });
  const url = `http://127.0.0.1:${web.port}`;
  const idA = projectRouteId(a.config.project), idB = projectRouteId(b.config.project);
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    expect((await post('/api/host/select', { project: a.root })).status).toBe(200);
    expect((await post('/api/host/select', { project: b.root })).status).toBe(200);
    expect((await post(`/p/${idA}/api/action`, { method: 'order.submit', params: { content: 'A only' } })).status).toBe(200);

    const snapA = await (await fetch(`${url}/p/${idA}/api/snapshot`)).json();
    const snapB = await (await fetch(`${url}/p/${idB}/api/snapshot`)).json();
    expect(snapA.status.project).toBe(a.config.project);
    expect(snapB.status.project).toBe(b.config.project);
    expect(snapA.tasks.some(task => task.goal === 'A only')).toBe(true);
    expect(snapB.tasks.some(task => task.goal === 'A only')).toBe(false);

    // 无前缀旧路由即使 daemon 都活着也不能替任何一个项目作答。
    expect((await fetch(`${url}/api/snapshot`)).status).toBe(400);

    const { projects } = await (await fetch(url + '/api/host/projects')).json();
    expect(projects.find(row => row.id === idA).summary.project).toBe(a.config.project);
    expect(projects.find(row => row.id === idB).summary.project).toBe(b.config.project);
  } finally {
    web.stop(true);
    await Promise.all([rpcA.close(), rpcB.close()]);
    fs.rmSync(a.config.socket, { force: true }); fs.rmSync(b.config.socket, { force: true });
    await a.close(); await b.close();
    fs.rmSync(global, { recursive: true, force: true });
  }
});
