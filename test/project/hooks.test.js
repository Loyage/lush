import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { retiredHook, interruptHookFinish } from '../hook-assertions.js';
import { normalizeHook, publicHookDefinition } from '../../src/core/hooks.js';
setDefaultTimeout(20000);
const notifyRule = (trigger = 'agent.returned', mode = 'once') => ({ name: '告知', trigger, mode, enabled: true, conditions: {},
  actions: [{ type: 'notify', title: 'hook-test', body: 'done' }] });
const attach = (f, task, hook) => f.project.attachTaskHook(task.id, hook, f.project.taskHooks(task.id).revision);
async function frozenFixture(extra = {}) {
  const f = fixture(undefined, extra); f.project.kick = () => {}; await repo(f.root);
  const order = await f.project.order('freeze source', 'main', [], null, false);
  f.store.update(order.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: order.task.base_commit }) });
  return { ...f, source: order.task, main: f.store.task(order.task.parent_id) };
}

test('Hook definitions reject scripts, unknown fields, invalid trigger/actions and recursive persistent messages', () => {
  expect(() => normalizeHook({ ...notifyRule(), script: 'danger' })).toThrow('invalid hook fields');
  expect(() => normalizeHook({ ...notifyRule(), trigger: 'bad' })).toThrow('unknown hook trigger');
  expect(() => normalizeHook({ ...notifyRule(), actions: [{ type: 'request_merge' }] })).toThrow('not allowed');
  expect(() => normalizeHook({ ...notifyRule(), mode: 'persistent', actions: [{ type: 'message', target_id: 1, body: 'again' }] })).toThrow('must be once');
  expect(() => normalizeHook({ ...notifyRule('worker.parent_ready','persistent'), actions: [{ type: 'create_worker', content: 'job' }] })).toThrow('must be once');
  expect(() => normalizeHook({ ...notifyRule(), conditions: { integrations: ['invented'] } })).toThrow('invalid hook integrations');
});

test('templates are revision checked and copied at mount, not mutable global rules', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const order = await f.project.order('job', 'main', [], null, false);
    const initial = f.project.hooksList();
    const saved = f.project.saveHookTemplate(notifyRule(), initial.revision), template = saved.templates[0];
    expect(() => f.project.saveHookTemplate(notifyRule(), initial.revision)).toThrow('revision changed');
    const view = attach(f, order.task, { template_id: template.id });
    expect(view.mounts.at(-1).name).toBe('告知');
    f.project.saveHookTemplate({ ...notifyRule(), id: template.id, name: 'changed' }, saved.revision);
    expect(f.project.taskHooks(order.task.id).mounts.at(-1).name).toBe('告知');
    expect(() => f.project.attachTaskHook(order.task.id, notifyRule(), 'stale')).toThrow('revision changed');
    expect(() => f.project.removeTaskHook(order.task.id, 'auto-merge', f.project.taskHooks(order.task.id).revision)).toThrow('cannot be removed');
  } finally { await f.close(); }
});

test('persistent notifications dedupe the same source event and evaluate conditions', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const order = await f.project.order('job', 'main', [], null, false);
    attach(f, order.task, { ...notifyRule('agent.returned', 'persistent'), conditions: { statuses: ['paused'] } });
    const source = f.store.event(order.task.id, 'test.returned', {});
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.store.update(order.task.id, { status: 'waiting' });
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.store.update(order.task.id, { status: 'paused' });
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(2);
  } finally { await f.close(); }
});

test('normal return is emitted after release and does not turn a child wait into delivery ready', async () => {
  const hold = gate(); let parentId;
  const f = fixture({ async run({ task, api }) {
    if (task.id === parentId) { await api.spawn(task.id, 'child'); return 'waiting for child'; }
    await hold.promise; return 'child result';
  } }); await repo(f.root);
  try {
    const order = await f.project.order('parent','main',[],null,false); parentId = order.task.id;
    attach(f, order.task, notifyRule('agent.returned'));
    attach(f, order.task, { ...notifyRule('worker.delivery_ready'), actions: [{ type: 'notify', title: 'ready', body: '' }] });
    f.project.resumeTask(parentId);
    await until(() => f.store.get("SELECT id FROM notices WHERE title='hook-test'"));
    expect(f.project.running.has(parentId)).toBe(false);
    expect(f.store.get("SELECT id FROM notices WHERE title='ready'")).toBeNull();
    hold.resolve();
    await until(() => f.store.children(parentId)[0]?.status === 'awaiting_acceptance');
  } finally { hold.resolve(); await f.close(); }
});
