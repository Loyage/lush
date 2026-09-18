import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse } from '../src/agent/provider.js';
import { LushError } from '../src/core/types.js';
import { RPCClient } from '../src/rpc/client.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { UIClient, taskRequest } from '../src/ui/client.js';
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
    'lush-root': { ...make('lush-root', ['generic-task']), singleton: true },
    'generic-task': make('generic-task'),
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
    await ui.createTask(7, 'work');
    await ui.taskResult(3);
    await ui.taskSession(3);
    await ui.openInteractiveTask(7, 'pair');
    await ui.recordInteractivePid(3, 4, 99);
    await ui.settleInteractiveTask(3, 4, 'failed', { error: 'stopped' });

    expect(calls).toEqual([
      ['service.list', {}],
      ['system.status', {}],
      ['system.shutdown', {}],
      ['service.tree', {}],
      ['call', { sid: 7, goal: 'work', detach: true }],
      ['task.result', { task_id: 3 }],
      ['task.session', { task_id: 3 }],
      ['call', { sid: 7, goal: 'pair', interactive: true }],
      ['call.os_pid', { task_id: 3, call_id: 4, os_pid: 99 }],
      ['call.end', { task_id: 3, call_id: 4, status: 'failed', error: 'stopped' }],
    ]);
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
    expect(await page.text()).toContain('Service Tree');

    const tree = await request('/api/tree');
    expect(tree.status).toBe(200);
    expect((await tree.json()).services).toEqual([
      expect.objectContaining({ sid: 0, name: 'lush', status: 'active' }),
    ]);
    expect((await request('/app.js')).headers.get('content-type')).toContain('text/javascript');
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

    const wrongType = await request('/api/tasks', { method: 'POST', body: '{}' });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).error.message).toContain('Content-Type');

    const crossOrigin = await request('/api/tree', { headers: { Origin: 'https://example.com' } });
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()).error.message).toContain('cross-origin');
  });

  test('only binds loopback addresses', () => {
    const ui = new UIClient({ request() {} });
    expect(() => new WebUIServer(ui, { hostname: '0.0.0.0' })).toThrow(/loopback/);
  });
});
