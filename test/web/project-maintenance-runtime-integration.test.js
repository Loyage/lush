import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, gate, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { Project } from '../../src/core/project.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { AgentPreempted } from '../../src/agent/provider.js';
import { projectRouteId } from '../../src/host/registry.js';
import { installDom, deepText, answerDialog } from '../dom-stub.js';
import { renderProjectMaintenance, resetProjectMaintenance } from '../../src/ui/web/assets/project-maintenance.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { clear } from '../../src/ui/web/assets/messages.js';
setDefaultTimeout(30000);

function controlled() {
  const calls = [];
  return { calls, resolve: () => ({ agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }),
    run(options) {
      const done = gate(); calls.push({ ...options, done });
      return new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason ?? new Error('aborted'));
        if (options.signal.aborted) return abort();
        options.signal.addEventListener('abort', abort, { once: true });
        done.promise.then(value => { options.signal.removeEventListener('abort', abort); value instanceof Error ? reject(value) : resolve(value ?? 'delivered'); });
      });
    } };
}
async function post(f, method, params = {}, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status).toBe(status); return value;
}
const snapshot = async f => (await fetch(f.url + '/api/snapshot')).json();
const call = (p, id) => p.calls.findLast(row => row.task.id === id);
async function exitAtBoundary(f, p, id) {
  const dir = path.join(f.config.home, 'preempt');
  fs.renameSync(path.join(dir, `task-${id}.request.json`), path.join(dir, `task-${id}.stop.json`));
  call(p, id).done.resolve(new AgentPreempted({ safe_point: 'turn_end', reason: 'project maintenance' }));
  await until(() => !f.project.running.has(id));
}

// Real DOM -> HTTP -> Unix RPC -> SQLite/Git -> controlled provider, not stub Project methods.
test('maintenance buttons preserve a multi-level child wait and only resume the affected work', async () => {
  const f = await setup(), provider = controlled(); f.project.provider = provider; f.project.stopping = true;
  let dom, navigation;
  try {
    await repo(f.root);
    const parent = (await post(f, 'order.submit', { content: 'parent waits for children' })).task;
    const child = await f.project.spawn(parent.id, 'child waits for grandchild');
    const leaf = await f.project.spawn(child.id, 'grandchild working');
    const staged = (await post(f, 'order.submit', { content: 'not started', start: false })).task;
    const personal = (await post(f, 'order.submit', { content: 'personally paused' })).task;
    await post(f, 'worker.interrupt', { id: personal.id });
    f.store.update(parent.id, { status: 'waiting' }); f.store.update(child.id, { status: 'waiting' });
    f.project.stopping = false; f.project.kick(); await until(() => provider.calls.length === 1);
    expect(provider.calls[0].task.id).toBe(leaf.id);
    dom = installDom({ fetch: (url, options) => fetch(f.url + url, options) });
    dom.location.pathname = `/p/${projectRouteId(f.root)}/`;
    resetProjectMaintenance();
    const paint = async () => renderProjectMaintenance((await snapshot(f)).status.maintenance);
    navigation = registerNavigation({ refresh: paint, detail: async () => {}, overview: async () => {} });
    await paint();
    const host = dom.node('project-maintenance');
    const button = label => host.querySelectorAll('button').find(node => node.textContent === label);
    const pause = button('全部中断').onclick(); await answerDialog(dom, '全部中断'); await pause;
    expect(f.project.maintenancePaused()).toBe(true);
    expect(deepText(host)).toContain('等待安全退出');
    const busy = await fetch(f.url + '/api/service/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(busy.status).toBe(400); expect(f.project.stopping).toBe(false);
    const queued = (await post(f, 'order.submit', { content: 'new during maintenance' })).task;
    f.project.pump(); expect(provider.calls).toHaveLength(1);
    await exitAtBoundary(f, provider, leaf.id); await paint();
    expect((await snapshot(f)).status.maintenance).toMatchObject({ phase: 'paused', ready_to_restart: true });
    expect(deepText(host)).toContain('当前可重启');
    await button('全部继续').onclick();
    await until(() => provider.calls.length === 3);
    expect(provider.calls.map(row => row.task.id).sort((a, b) => a - b)).toEqual([leaf.id, leaf.id, queued.id].sort((a, b) => a - b));
    for (const row of [staged, personal]) expect(f.store.task(row.id).status).toBe('paused');
    for (const row of [parent, child]) expect(f.store.task(row.id).status).toBe('waiting');
    call(provider, leaf.id).done.resolve('grandchild delivered');
    await until(() => provider.calls.some(row => row.task.id === child.id));
    expect(f.store.task(leaf.id).status).toBe('awaiting_acceptance');
    expect(f.store.task(parent.id).status).toBe('waiting');
  } finally { navigation?.(); clear(); dom?.restore(); await f.close(); }
});

test('safe daemon reconstruction retains maintenance over real RPC and restores saved profile and unread input exactly once', async () => {
  const f = await setup(), provider = controlled(); f.project.provider = provider; f.project.stopping = true;
  let reopened, rpc;
  try {
    await repo(f.root);
    const task = (await post(f, 'order.submit', { content: 'restart maintenance' })).task;
    const staged = (await post(f, 'order.submit', { content: 'remain staged', start: false })).task;
    f.project.stopping = false; f.project.kick(); await until(() => provider.calls.length === 1);
    expect(await post(f, 'system.interrupt_all')).toMatchObject({ paused: true, phase: 'pausing', affected_count: 1 });
    await post(f, 'worker.message', { id: task.id, body: 'preserved across maintenance restart' });
    await exitAtBoundary(f, provider, task.id);
    await post(f, 'worker.configure', { id: task.id, profile: { agent: 'pi', model: 'kept-profile', thinking: 'high' } });
    const signal = createSignal(), stopping = new Dispatcher(f.project, signal, {});
    expect(await stopping.dispatch('system.stop_if_idle')).toEqual({ stopping: true });
    expect(signal.isRequested()).toBe(true);
    await f.rpc.close(); await f.project.shutdown();
    reopened = new Project(f.config, f.store, provider); reopened.recover();
    rpc = new RPCServer(f.config.socket, new Dispatcher(reopened, createSignal(), {})); await rpc.start();
    const resumed = { ...f, project: reopened };
    expect((await snapshot(resumed)).status.maintenance).toMatchObject({ paused: true, phase: 'paused', ready_to_restart: true, affected_count: 1 });
    reopened.pump(); expect(provider.calls).toHaveLength(1);
    expect(f.store.task(staged.id).status).toBe('paused');
    await post(resumed, 'system.resume_all'); await post(resumed, 'system.resume_all');
    await until(() => provider.calls.length === 2);
    expect(call(provider, task.id).agent.model).toBe('kept-profile');
    expect(call(provider, task.id).messages.map(row => row.body)).toEqual(['preserved across maintenance restart']);
    expect(call(provider, task.id).cwd).toBe(task.workspace);
    call(provider, task.id).done.resolve('resumed work delivered'); await until(() => !reopened.running.has(task.id));
    expect(f.store.unread(task.id)).toHaveLength(0);
    expect(f.store.task(task.id)).toMatchObject({ calls: 2, error: null });
    expect(f.store.task(staged.id).status).toBe('paused');
  } finally { if (rpc) await rpc.close(); if (reopened) await reopened.shutdown(); await f.close(); }
});
