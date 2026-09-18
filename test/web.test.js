import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse } from '../src/agent/provider.js';
import { LushError } from '../src/core/types.js';
import { RPCClient } from '../src/rpc/client.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { UIClient, taskDeleteRequest, taskListQuery, taskRequest } from '../src/ui/client.js';
import { WebUIServer } from '../src/ui/web.js';
import { cleanup, deferred, system, tmpdir } from './helpers.js';

function testTemplates() {
  const make = (name, childTemplates = []) => ({
    name,
    singleton: false,
    description: `${name} test template`,
    spawn_prompt: `create ${name}`,
    system_prompt: `you are ${name}`,
    child_templates: childTemplates,
    variables: {},
  });
  const templates = {
    'lush-root': { ...make('lush-root', ['generic-task', 'generic-service']), singleton: true },
    'generic-task': make('generic-task'),
    'generic-service': { ...make('generic-service'), singleton: true },
  };
  return {
    templates,
    get(name) {
      if (!Object.hasOwn(templates, name)) throw new Error(`missing test template: ${name}`);
      return structuredClone(templates[name]);
    },
    find(name) {
      return Object.hasOwn(templates, name) ? structuredClone(templates[name]) : null;
    },
  };
}

describe('shared UI application client', () => {
  test('all adapters can use one command gateway and typed workflows', async () => {
    const calls = [];
    const ui = new UIClient({
      request(method, params) {
        calls.push([method, params]);
        return Promise.resolve({ method, params });
      },
    });

    await ui.execute('service.list');
    await ui.status();
    await ui.shutdown();
    await ui.serviceTree();
    await ui.serviceView(7);
    await ui.createTask(7, 'work');
    await ui.taskResult(3);
    await ui.taskSession(3);
    await ui.taskList({ sid: 1, status: 'running', roots: 'roots', limit: 5 });
    await ui.taskTree(3);
    await ui.cancelTask(3);
    await ui.deleteTask(3, true);
    await ui.openInteractiveTask(7, 'pair');
    await ui.recordInteractivePid(3, 4, 99);
    await ui.settleInteractiveTask(3, 4, 'failed', { error: 'stopped' });

    expect(calls).toEqual([
      ['service.list', {}],
      ['system.status', {}],
      ['system.shutdown', {}],
      ['service.tree', {}],
      ['service.view', { sid: 7, sections: ['description', 'templates', 'prompt'] }],
      ['call', { sid: 7, goal: 'work', detach: true }],
      ['task.result', { task_id: 3 }],
      ['task.session', { task_id: 3 }],
      ['task.list', { sid: 1, status: 'running', roots: 'roots', limit: 5 }],
      ['task.tree', { task_id: 3 }],
      ['task.cancel', { task_id: 3 }],
      ['task.delete', { task_id: 3, recursive: true }],
      ['call', { sid: 7, goal: 'pair', interactive: true }],
      ['call.os_pid', { task_id: 3, call_id: 4, os_pid: 99 }],
      ['call.end', { task_id: 3, call_id: 4, status: 'failed', error: 'stopped' }],
    ]);

    // The view workflow only carries what it is given; Core still owns the section names.
    expect(() => ui.serviceView(-1)).toThrow(/sid/);
  });
});

class BlockingProvider {
  constructor(gate) {
    this.name = 'blocking';
    this.contextMode = 'tools';
    this.gate = gate;
  }

  async call() {
    await this.gate.promise;
    return new AgentResponse('finished in background');
  }
}

describe('web ui', () => {
  let dir;
  let database;
  let manager;
  let runtime;
  let rpcServer;
  let web;
  let gate;

  beforeEach(async () => {
    dir = tmpdir('lush-web-');
    gate = deferred();
    ({ database, manager, runtime } = system(dir, new BlockingProvider(gate), { templates: testTemplates() }));
    const socket = path.join(dir, 'lush.sock');
    rpcServer = new RPCServer(socket, new Dispatcher(manager, createSignal()));
    await rpcServer.start();
    const ui = new UIClient(new RPCClient(socket, 2));
    web = new WebUIServer(ui, { port: 0 });
    await web.start();
  });

  afterEach(async () => {
    gate?.resolve();
    if (web) await web.stop();
    if (rpcServer) await rpcServer.close();
    if (runtime) await runtime.shutdown();
    if (database) database.close();
    if (dir) cleanup(dir);
  });

  function request(route, options = {}) {
    return web.fetch(new Request(new URL(route, web.url), options));
  }

  test('serves the app and service tree', async () => {
    const page = await request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    const html = await page.text();
    expect(html).toContain('服务与任务');
    expect(html).toContain('Service 能力');

    const tree = await request('/api/tree');
    expect(tree.status).toBe(200);
    expect((await tree.json()).services).toEqual([
      expect.objectContaining({ sid: 0, name: 'lush', status: 'active' }),
    ]);
    expect((await request('/app.js')).headers.get('content-type')).toContain('text/javascript');
  });

  test('serves one service view: description, child templates and call prompt', async () => {
    const response = await request('/api/services/0/view');
    expect(response.status).toBe(200);
    expect((await response.json()).service).toEqual({
      sid: 0,
      description: 'lush-root test template',
      call_prompt: 'you are lush-root',
      available_child_templates: [
        {
          name: 'generic-task',
          singleton: false,
          description: 'generic-task test template',
          spawn_prompt: 'create generic-task',
        },
        {
          name: 'generic-service',
          singleton: true,
          description: 'generic-service test template',
          spawn_prompt: 'create generic-service',
        },
      ],
    });

    // A singleton disappears once its slot under SID 0 is taken; a leaf node has none.
    const taken = manager.spawn(0, 'generic-service', 'keeper');
    const names = async () => (await (await request('/api/services/0/view')).json())
      .service.available_child_templates.map((item) => item.name);
    expect(await names()).toEqual(['generic-task']);
    expect((await (await request(`/api/services/${taken.sid}/view`)).json())
      .service.available_child_templates).toEqual([]);
    expect((await request('/api/services/999/view')).status).toBe(404);
  });

  test('keeps serving the UI shell while the daemon is offline', async () => {
    web.ui = {
      serviceTree() {
        throw new LushError("cannot connect to lushd at /tmp/missing/lush.sock; run 'lush daemon start'", -32004);
      },
    };
    expect((await request('/')).status).toBe(200);
    const tree = await request('/api/tree');
    expect(tree.status).toBe(503);
    expect((await tree.json()).error.message).toContain('cannot connect to lushd');
  });

  test('creates a detached root task and exposes its result', async () => {
    const child = manager.spawn(0, 'generic-task', 'worker');
    const created = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: child.sid, goal: 'do this later' }),
    });
    expect(created.status).toBe(202);
    const task = (await created.json()).task;
    expect(task).toMatchObject({ sid: child.sid, goal: 'do this later', parent_task_id: null });
    expect(['created', 'running']).toContain(task.status);

    const pending = await request(`/api/tasks/${task.id}`);
    expect(await pending.json()).toMatchObject({
      task: { id: task.id, sid: child.sid, finished: false },
    });

    gate.resolve();
    await manager.waitForTask(task.id);
    const finished = await request(`/api/tasks/${task.id}`);
    expect(await finished.json()).toEqual({
      task: {
        id: task.id,
        sid: child.sid,
        status: 'completed',
        finished: true,
        result: 'finished in background',
        error: null,
      },
    });
  });

  test('validates writes and blocks cross-origin API requests', async () => {
    expect(() => taskRequest({ sid: 0, goal: 'x', extra: true })).toThrow(/unexpected field/);
    expect(() => taskListQuery(new URLSearchParams('roots=sideways'))).toThrow(/roots/);
    expect(() => taskListQuery(new URLSearchParams('limit=1&limit=2'))).toThrow(/duplicate/);
    expect(() => taskListQuery(new URLSearchParams('nope=1'))).toThrow(/unknown query parameter/);
    expect(() => taskDeleteRequest({ recursive: 'yes' })).toThrow(/boolean/);
    expect(taskListQuery(new URLSearchParams('sid=2&status=running&limit=9')))
      .toEqual({ sid: 2, status: 'running', roots: null, limit: 9 });
    expect(taskListQuery(new URLSearchParams(''))).toEqual({ sid: null, status: null, roots: null, limit: 200 });
    expect(taskDeleteRequest({})).toEqual({ recursive: false });

    const wrongType = await request('/api/tasks', { method: 'POST', body: '{}' });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).error.message).toContain('Content-Type');

    const crossOrigin = await request('/api/tree', { headers: { Origin: 'https://example.com' } });
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()).error.message).toContain('cross-origin');
  });

  test('lists tasks, exposes one task tree and applies filters', async () => {
    const worker = manager.spawn(0, 'generic-task', 'worker');
    const root = manager.spawnTask(null, 0, 'root goal');
    const child = manager.spawnTask(root.id, worker.sid, 'child goal');

    const list = await request('/api/tasks');
    expect(list.status).toBe(200);
    expect((await list.json()).tasks.map((task) => task.id)).toEqual([child.id, root.id]);

    const filtered = await request(`/api/tasks?sid=${worker.sid}&status=running`);
    expect((await filtered.json()).tasks.map((task) => task.id)).toEqual([child.id]);

    const roots = await request('/api/tasks?roots=roots');
    expect((await roots.json()).tasks.map((task) => task.id)).toEqual([root.id]);

    const tree = await request(`/api/tasks/${root.id}/tree`);
    expect(tree.status).toBe(200);
    expect(await tree.json()).toEqual({
      task: expect.objectContaining({
        id: root.id,
        sid: 0,
        service_name: 'lush',
        status: 'running',
        children: [expect.objectContaining({
          id: child.id,
          sid: worker.sid,
          service_name: 'worker',
          goal: 'child goal',
          children: [],
        })],
      }),
    });

    gate.resolve();
  });

  test('cancels and deletes a task subtree through the API', async () => {
    const worker = manager.spawn(0, 'generic-task', 'worker');
    const root = manager.spawnTask(null, 0, 'root goal');
    const child = manager.spawnTask(root.id, worker.sid, 'child goal');

    const cancelled = await request(`/api/tasks/${root.id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      task: expect.objectContaining({
        id: root.id,
        status: 'cancelled',
        children: [expect.objectContaining({ id: child.id, status: 'cancelled' })],
      }),
    });

    const remove = (body) => request(`/api/tasks/${root.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await remove({ nope: true })).status).toBe(400);

    const deleted = await remove({ recursive: true });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).deleted).toEqual([root.id, child.id]);
    expect((await request(`/api/tasks/${root.id}/tree`)).status).toBe(404);
  });

  test('only binds loopback addresses', () => {
    const ui = new UIClient({ request() {} });
    expect(() => new WebUIServer(ui, { hostname: '0.0.0.0' })).toThrow(/loopback/);
  });
});
