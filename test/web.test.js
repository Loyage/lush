import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse } from '../src/agent/provider.js';
import { LushError } from '../src/core/types.js';
import { RPCClient } from '../src/rpc/client.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import {
  UIClient, intensionListQuery, intensionRequest, taskDeleteRequest, taskListQuery, taskTraceQuery,
} from '../src/ui/client.js';
import { uiRevision } from '../src/identity.js';
import { WebUIServer } from '../src/ui/web.js';
import { cleanup, deferred, system, tmpdir } from './helpers.js';

function testTemplates() {
  const make = (name, childTemplates = []) => ({
    name,
    singleton: false,
    description: `${name} test template`,
    construct_prompt: `create ${name}`,
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
    await ui.submitIntension('work', 7);
    await ui.taskResult(3);
    await ui.taskSession(3);
    await ui.taskList({ sid: 1, status: 'running', roots: 'roots', limit: 5 });
    await ui.taskTree(3);
    await ui.taskTrace(3, { limit: 40 });
    await ui.cancelTask(3);
    await ui.deleteTask(3, true);
    await ui.submitInteractiveIntension('pair', 7);
    await ui.intensionList({ open: true });
    await ui.intensionInspect(11);
    await ui.intensionContext(11);
    await ui.withdrawIntension(11, 'changed my mind');
    await ui.recordInteractivePid(3, 4, 99);
    await ui.settleInteractiveTask(3, 4, 'failed', { error: 'stopped' });

    expect(calls).toEqual([
      ['service.list', {}],
      ['system.status', {}],
      ['system.shutdown', {}],
      ['service.tree', {}],
      ['service.view', { sid: 7, sections: ['description', 'templates', 'prompt'] }],
      ['intent.submit', { content: 'work', sid: 7, source: 'web' }],
      ['task.result', { task_id: 3 }],
      ['task.session', { task_id: 3 }],
      ['task.list', { sid: 1, status: 'running', roots: 'roots', limit: 5 }],
      ['task.tree', { task_id: 3 }],
      ['task.trace', { task_id: 3, limit: 40 }],
      ['task.cancel', { task_id: 3 }],
      ['task.delete', { task_id: 3, recursive: true }],
      ['intent.submit', { content: 'pair', sid: 7, source: 'cli', interactive: true }],
      ['intent.list', { status: null, sid: undefined, open: true, limit: 200 }],
      ['intent.inspect', { intension_id: 11 }],
      ['intent.context', { intension_id: 11 }],
      ['intent.withdraw', { intension_id: 11, reason: 'changed my mind' }],
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
          construct_prompt: 'create generic-task',
        },
        {
          name: 'generic-service',
          singleton: true,
          description: 'generic-service test template',
          construct_prompt: 'create generic-service',
        },
      ],
    });

    // A singleton disappears once its slot under SID 0 is taken; a leaf node has none.
    const taken = manager.construct(0, 'generic-service', 'keeper');
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

  test('submits an intension and exposes what came of it', async () => {
    const created = await request('/api/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'do this later' }),
    });
    expect(created.status).toBe(202);
    const row = (await created.json()).intension;
    expect(row).toMatchObject({ content: 'do this later', sid: null, source: 'web', status: 'parsing' });
    expect(row.parse_task_id).not.toBeNull();

    // The queue view and the detail read the same row, one from the list, one
    // with the parse task that is working on it.
    const queue = await request('/api/intents?open=1');
    expect((await queue.json()).intensions.map((item) => item.id)).toEqual([row.id]);
    const pending = await request(`/api/intents/${row.id}`);
    expect(await pending.json()).toMatchObject({
      intension: { id: row.id, status: 'parsing', parse_task_status: 'running' },
    });

    gate.resolve();
    await manager.intensionWait(row.id);
    const settled = await request(`/api/intents/${row.id}`);
    expect(await settled.json()).toMatchObject({
      intension: { id: row.id, status: 'settled', response: 'finished in background' },
    });
  });

  test('serves one frozen UI version and refuses a page from another', async () => {
    const revision = uiRevision();
    const app = await (await request('/app.js')).text();
    // The page is stamped with the revision of the routes that will answer it,
    // and no longer carries the token the stamp replaced.
    expect(app).toContain(revision);
    expect(app).not.toContain('__LUSH_UI_REVISION__');
    expect(await (await request('/app.js')).text()).toBe(app);
    expect(await (await request('/')).text()).not.toContain('__LUSH_UI_REVISION__');
    expect((await request('/app.js', { method: 'HEAD' })).status).toBe(200);

    // A page that names its own revision is answered only when it matches; one
    // from another build is told to reload rather than left to fail route by
    // route. Silence (curl, tests) keeps working, which every other case here
    // relies on.
    const mine = await request('/api/tree', { headers: { 'X-Lush-UI-Revision': revision } });
    expect(mine.status).toBe(200);
    const theirs = await request('/api/tree', { headers: { 'X-Lush-UI-Revision': 'older-build' } });
    expect(theirs.status).toBe(409);
    const error = (await theirs.json()).error;
    expect(error.data).toEqual({ reason: 'ui_revision_mismatch', page: 'older-build', server: revision });
    expect(error.message).toContain(revision);
    expect(error.message).toContain('reload');
    const staleWrite = await request('/api/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lush-UI-Revision': 'older-build' },
      body: JSON.stringify({ content: 'never parsed' }),
    });
    expect(staleWrite.status).toBe(409);

    // A route that moved in between is still a 404, but one that says what to do.
    const moved = await request('/api/tasks', { method: 'POST' });
    expect(moved.status).toBe(404);
    expect((await moved.json()).error.message).toContain('reload');
  });

  test('validates writes and blocks cross-origin API requests', async () => {
    expect(() => intensionRequest({ content: 'x', extra: true })).toThrow(/unexpected field/);
    expect(() => intensionRequest({ sid: 0 })).toThrow(/missing 'content'/);
    expect(intensionRequest({ content: 'x' })).toEqual({ content: 'x', sid: null });
    expect(intensionListQuery(new URLSearchParams('open=1&sid=none&limit=5')))
      .toEqual({ status: null, sid: null, open: true, limit: 5 });
    expect(intensionListQuery(new URLSearchParams('status=awaiting')))
      .toEqual({ status: 'awaiting', sid: undefined, open: false, limit: 200 });
    expect(() => intensionListQuery(new URLSearchParams('sid=abc'))).toThrow(/sid/);
    expect(() => taskListQuery(new URLSearchParams('roots=sideways'))).toThrow(/roots/);
    expect(() => taskListQuery(new URLSearchParams('limit=1&limit=2'))).toThrow(/duplicate/);
    expect(() => taskListQuery(new URLSearchParams('nope=1'))).toThrow(/unknown query parameter/);
    expect(() => taskDeleteRequest({ recursive: 'yes' })).toThrow(/boolean/);
    expect(() => taskTraceQuery(new URLSearchParams('limit=1&limit=2'))).toThrow(/duplicate/);
    expect(() => taskTraceQuery(new URLSearchParams('nope=1'))).toThrow(/unknown query parameter/);
    expect(taskTraceQuery(new URLSearchParams(''))).toEqual({ limit: 200 });
    expect(taskTraceQuery(new URLSearchParams('limit=7'))).toEqual({ limit: 7 });
    expect(taskListQuery(new URLSearchParams('sid=2&status=running&limit=9')))
      .toEqual({ sid: 2, status: 'running', roots: null, limit: 9 });
    expect(taskListQuery(new URLSearchParams(''))).toEqual({ sid: null, status: null, roots: null, limit: 200 });
    expect(taskDeleteRequest({})).toEqual({ recursive: false });

    const wrongType = await request('/api/intents', { method: 'POST', body: '{}' });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).error.message).toContain('Content-Type');

    const crossOrigin = await request('/api/tree', { headers: { Origin: 'https://example.com' } });
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()).error.message).toContain('cross-origin');
  });

  test('lists tasks, exposes one task tree and applies filters', async () => {
    const worker = manager.construct(0, 'generic-task', 'worker');
    const root = manager.constructRootTask(0, 'root goal');
    const child = manager.constructTask(root.id, worker.sid, 'child goal');

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

    // The collaboration timeline of the same subtree: the delegation it made.
    const trace = await request(`/api/tasks/${root.id}/trace?limit=50`);
    expect(trace.status).toBe(200);
    expect(await trace.json()).toEqual({
      trace: expect.objectContaining({
        task_id: root.id,
        total: 1,
        truncated: false,
        entries: [expect.objectContaining({
          kind: 'delegated',
          from_task_id: root.id,
          to_task_id: child.id,
          to_service: 'worker',
          goal: 'child goal',
        })],
      }),
    });
    expect((await request(`/api/tasks/${root.id}/trace?nope=1`)).status).toBe(400);
    expect((await request('/api/tasks/9999/trace')).status).toBe(404);

    gate.resolve();
  });

  test('cancels and deletes a task subtree through the API', async () => {
    const worker = manager.construct(0, 'generic-task', 'worker');
    const root = manager.constructRootTask(0, 'root goal');
    const child = manager.constructTask(root.id, worker.sid, 'child goal');

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
