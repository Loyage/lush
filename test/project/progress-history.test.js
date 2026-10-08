import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';
import { Dispatcher, encode } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { receivedProgressInput } from '../../src/core/project/progress.js';
import path from 'node:path';

const steps = (...keys) => keys.map(key => ({ key, label: key }));
const at = ms => new Date(ms).toISOString();
const worker = f => f.store.create({ role: 'agent', goal: 'progress history', task_kind: 'order' });
// Direct API tests suppress scheduling, but use the real public ordinary-message path.
const offline = f => { f.project.kick = () => {}; };
const history = (f, id, options) => f.project.progressHistory(id, options);

function controlled() {
  const calls = [];
  return { reportsInputDelivery: true, calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    if (ctx.signal.aborted) done.resolve('aborted');
    else ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

test('actual shape/label/order changes archive full old states, duplicate plans do not; keys preserve clocks and missed reports', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f);
    f.project.reportProgressPlan(task.id, steps('inspect', 'implement', 'test'));
    f.project.completeProgressStep(task.id, 'implement');
    const before = f.project.progressView(f.store.task(task.id)).progress;
    const duplicate = f.project.reportProgressPlan(task.id, steps('inspect', 'implement', 'test'));
    expect(duplicate.unchanged).toBe(true);
    expect(history(f, task.id).items).toEqual([]);
    const fresh = f.project.reportProgressPlan(task.id, [
      { key: 'implement', label: 'renamed' }, ...steps('test', 'inspect', 'commit'),
    ]).progress;
    expect(fresh.items[0]).toMatchObject({ status: 'completed', timing_unknown: true });
    expect(fresh.items.find(row => row.key === 'inspect')).toMatchObject({ unconfirmed: true, timing_unknown: true });
    expect(fresh.items.find(row => row.key === 'test').started_at).toBe(before.items[2].started_at);
    const archived = history(f, task.id).items[0];
    expect(archived.reason).toBe('replan');
    expect(archived.progress).toMatchObject({ frozen: true, updated_at: before.updated_at, frozen_at: archived.archived_at });
    expect(archived.progress.items.map(row => [row.key, row.label, row.status]))
      .toEqual(before.items.map(row => [row.key, row.label, row.status]));
    expect(archived.progress.items[0]).toMatchObject({ unconfirmed: true, timing_unknown: true, work_ms: null, duration_ms: null });
    expect(archived.progress.items[1]).toMatchObject({ completed_at: before.items[1].completed_at, work_ms: null });
    f.project.reportProgressPlan(task.id, steps('test', 'implement'));
    expect(history(f, task.id).items).toHaveLength(2);
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='progress.plan'", task.id)).toHaveLength(3);
  } finally { await f.close(); }
});

test('direct callers reset same keys once per ordinary user input; notice answers, child messages and signals do not reset', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f), child = f.store.create({ parent_id: task.id, role: 'agent', goal: 'child', task_kind: 'child' });
    f.project.reportProgressPlan(task.id, steps('inspect', 'test'));
    f.project.completeProgressStep(task.id, 'inspect');
    const question = f.project.notice(task.id, 'pick');
    f.project.answer(question.id, 'answer');
    f.project.message(task.id, 'child says', child.id);
    f.project.sendTaskSignal(child.id, task.id, 'child.completed', 'done', {});
    f.project.reportProgressPlan(task.id, steps('inspect', 'test'));
    expect(history(f, task.id).items).toEqual([]);
    expect(f.project.inspect(task.id).progress.items[0].status).toBe('completed');
    // JSON-looking user text is still ordinary input: provenance comes from the Event, not body heuristics.
    f.project.message(task.id, JSON.stringify({ notice_id: question.id, answer: 'user work' }));
    const fresh = f.project.reportProgressPlan(task.id, steps('inspect', 'test')).progress;
    expect(fresh.items).toMatchObject([{ status: 'pending', completed_at: null }, { status: 'pending', started_at: null }]);
    expect(history(f, task.id).items[0].reason).toBe('new_input');
    expect(history(f, task.id).items[0].progress.items[0].status).toBe('completed');
    f.project.completeProgressStep(task.id, 'inspect');
    f.project.reportProgressPlan(task.id, steps('inspect', 'test'));
    expect(history(f, task.id).items).toHaveLength(1);
    expect(f.project.inspect(task.id).progress.items[0].status).toBe('completed');
    f.project.message(task.id, 'more work');
    f.project.reportProgressPlan(task.id, steps('inspect', 'test'));
    expect(history(f, task.id).items.map(row => row.reason)).toEqual(['new_input', 'new_input']);
  } finally { await f.close(); }
});

test('real invocation gates reset on backend receipt, ignores in-flight arrivals, and retains state when continuing on child signals', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.order('original')).task;
    await until(() => provider.calls.length === 1);
    provider.calls[0].onInputDelivered();
    f.project.reportProgressPlan(task.id, steps('inspect', 'test'));
    f.project.completeProgressStep(task.id, 'inspect');
    f.project.message(task.id, 'arrived during reporting');
    f.project.reportProgressPlan(task.id, steps('inspect', 'test', 'commit'));
    expect(history(f, task.id).items.map(row => row.reason)).toEqual(['replan']);
    expect(f.project.inspect(task.id).progress.items.find(row => row.key === 'inspect').status).toBe('completed');
    provider.calls[0].done.resolve('first');
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].messages).toHaveLength(1);
    // A prepared but not delivered batch cannot end the old work boundary.
    f.project.reportProgressPlan(task.id, steps('inspect', 'test', 'commit'));
    expect(history(f, task.id).items).toHaveLength(1);
    provider.calls[1].onInputDelivered();
    f.project.reportProgressPlan(task.id, steps('inspect', 'test', 'commit'));
    expect(history(f, task.id).items[0].reason).toBe('new_input');
    f.project.completeProgressStep(task.id, 'inspect');
    f.project.reportProgressPlan(task.id, steps('inspect', 'test', 'commit'));
    expect(history(f, task.id).items).toHaveLength(2);
    const child = f.store.create({ parent_id: task.id, role: 'agent', goal: 'signal', task_kind: 'child' });
    f.store.update(child.id, { status: 'completed' });
    f.project.sendTaskSignal(child.id, task.id, 'child.completed', 'done', {});
    provider.calls[1].done.resolve('second');
    await until(() => provider.calls.length === 3);
    provider.calls[2].onInputDelivered();
    f.project.reportProgressPlan(task.id, steps('inspect', 'test', 'commit'));
    expect(history(f, task.id).items).toHaveLength(2);
    expect(f.project.inspect(task.id).progress.items.find(row => row.key === 'inspect').status).toBe('completed');
    expect(provider.calls.every(call => !('progress_history' in call.task))).toBe(true);
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const read = await rpc.dispatch('worker.progress_history', { id: task.id, _token: provider.calls[2].token });
    expect(read.items).toHaveLength(2);
    expect((await f.project.taskGraph()).nodes.every(row => !('progress_history' in row))).toBe(true);
    expect((await f.project.graph()).nodes.every(row => !('progress_history' in row))).toBe(true);
  } finally { await f.close(); }
});

test('only received batch IDs count, deferred input waits for later batch; redelivery of same message never resets twice', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f);
    f.project.reportProgressPlan(task.id, steps('work'));
    f.project.completeProgressStep(task.id, 'work');
    f.project.message(task.id, 'one'); f.project.message(task.id, 'two');
    const [one, two] = f.store.unread(task.id);
    const run = { progressInputMessageId: 0 };
    f.project.running.set(task.id, run);
    run.progressInputMessageId = receivedProgressInput(f.store, task.id, { messages: [one] });
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: [one.id] });
    f.project.reportProgressPlan(task.id, steps('work'));
    f.project.completeProgressStep(task.id, 'work');
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: [one.id] });
    run.progressInputMessageId = receivedProgressInput(f.store, task.id);
    f.project.reportProgressPlan(task.id, steps('work'));
    expect(history(f, task.id).items).toHaveLength(1);
    run.progressInputMessageId = receivedProgressInput(f.store, task.id, { messages: [two] });
    f.project.reportProgressPlan(task.id, steps('work'));
    expect(history(f, task.id).items).toHaveLength(2);
    f.project.running.delete(task.id);
  } finally { f.project.running.clear(); await f.close(); }
});

test('frozen snapshots include all current work/wait, survive restart, and never reproject against later Runs', async () => {
  const f = fixture(); offline(f);
  let reopened;
  try {
    const task = worker(f), now = Date.now();
    f.store.setProgressPlan(task.id, { version: 1, updated_at: at(now - 20000), items: [
      { key: 'done', label: 'done', status: 'completed', started_at: at(now - 20000), completed_at: at(now - 15000), duration_ms: 5000 },
      { key: 'active', label: 'active', status: 'pending', started_at: at(now - 15000), completed_at: null, duration_ms: null },
    ] });
    const first = f.store.startRun(task), second = f.store.startRun(task);
    f.store.run('UPDATE agent_runs SET started_at=?,ended_at=? WHERE id=?', at(now - 20000), at(now - 14000), first.id);
    f.store.run('UPDATE agent_runs SET started_at=? WHERE id=?', at(now - 4000), second.id);
    f.store.update(task.id, { status: 'running' });
    f.project.reportProgressPlan(task.id, steps('done', 'active', 'new'));
    const frozen = history(f, task.id).items[0], instant = Date.parse(frozen.archived_at);
    expect(frozen.progress.items.find(row => row.key === 'active')).toMatchObject({ work_ms: 1000 + instant - (now - 4000), active_since: null, wait_ms: 10000 });
    expect(frozen.progress.items.find(row => row.kind === 'wait')).toMatchObject({ wait_ms: 10000, waiting_since: null });
    expect(frozen.progress.items.find(row => row.key === 'done')).toMatchObject({ work_ms: 5000, duration_ms: 5000 });
    f.store.run('UPDATE agent_runs SET ended_at=? WHERE id=?', at(now + 900000), second.id);
    f.store.startRun(task);
    expect(history(f, task.id).items[0]).toEqual(frozen);
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    const project = new Project(f.config, reopened);
    expect(project.progressHistory(task.id).items[0]).toEqual(frozen);
  } finally { reopened?.close(); await f.close(); }
});

test('legacy no-Run clocks freeze, pending waits freeze, and old plans have no backfilled archives', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f), now = Date.now();
    f.store.setProgressPlan(task.id, { version: 1, updated_at: at(now - 20000), items: [
      { key: 'active', label: 'active', status: 'pending', started_at: at(now - 20000) },
    ] });
    expect(history(f, task.id).items).toEqual([]);
    f.project.reportProgressPlan(task.id, steps('active'));
    expect(history(f, task.id).items).toEqual([]);
    f.project.reportProgressPlan(task.id, steps('active', 'new'));
    const legacy = history(f, task.id).items[0];
    expect(legacy.progress.items[0].work_ms).toBe(Date.parse(legacy.archived_at) - (now - 20000));
    const record = f.store.startRun(task);
    f.store.run('UPDATE agent_runs SET started_at=?,ended_at=? WHERE id=?', at(now - 20000), at(now - 10000), record.id);
    f.store.update(task.id, { status: 'waiting' });
    f.project.reportProgressPlan(task.id, steps('active', 'new', 'last'));
    const waiting = history(f, task.id).items[0];
    expect(waiting.progress.items.find(row => row.kind === 'wait')).toMatchObject({ status: 'pending', waiting_since: null,
      wait_ms: Date.parse(waiting.archived_at) - (now - 10000) });
    expect(waiting.progress.items.every(row => !row.active_since && !row.waiting_since)).toBe(true);
  } finally { await f.close(); }
});

test('delivered new input without a plan remains a boundary after restart; same marker survives complete and repeat plans', async () => {
  const f = fixture(); offline(f); let reopened;
  try {
    const task = worker(f);
    f.project.reportProgressPlan(task.id, steps('work'));
    f.project.completeProgressStep(task.id, 'work');
    f.project.message(task.id, 'received in a round without replanning');
    const message = f.store.unread(task.id)[0];
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: [message.id] });
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    const project = new Project(f.config, reopened);
    const progress = project.reportProgressPlan(task.id, steps('work')).progress;
    expect(progress.items[0].status).toBe('pending');
    project.completeProgressStep(task.id, 'work');
    project.reportProgressPlan(task.id, steps('work'));
    expect(project.progressHistory(task.id).items).toHaveLength(1);
    expect(project.progressView(reopened.task(task.id)).progress.items[0].status).toBe('completed');
    expect(progress.input_message_id).toBeUndefined();
  } finally { reopened?.close(); await f.close(); }
});

test('legacy markerless plans retain pre-plan delivery baseline and reset only on subsequent delivered work', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f);
    f.project.message(task.id, 'prior work');
    const first = f.store.unread(task.id)[0];
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: [first.id] });
    f.project.reportProgressPlan(task.id, steps('work'));
    f.project.completeProgressStep(task.id, 'work');
    const raw = JSON.parse(f.store.task(task.id).progress_plan); delete raw.input_message_id;
    f.store.setProgressPlan(task.id, raw);
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', first.id);
    f.project.reportProgressPlan(task.id, steps('work'));
    expect(history(f, task.id).items).toEqual([]);
    expect(f.project.inspect(task.id).progress.items[0].status).toBe('completed');
    f.project.message(task.id, 'subsequent work');
    const next = f.store.unread(task.id)[0];
    f.store.event(task.id, 'invocation.inputs_delivered', { message_ids: [next.id] });
    f.store.run('UPDATE messages SET consumed=1 WHERE id=?', next.id);
    f.project.reportProgressPlan(task.id, steps('work'));
    expect(history(f, task.id).items[0].reason).toBe('new_input');
    expect(f.project.inspect(task.id).progress.items[0].status).toBe('pending');
  } finally { await f.close(); }
});

test('large complete snapshots page by byte budget within RPC frame and never lose versions between cursors', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f);
    for (let revision = 0; revision < 92; revision++) {
      f.project.reportProgressPlan(task.id, Array.from({ length: 32 }, (_, index) => ({
        key: `step_${index}`, label: '规'.repeat(157) + String(revision).padStart(3, '0'),
      })));
    }
    const first = history(f, task.id, { limit: 100 });
    expect(first.items.length).toBeGreaterThan(0); expect(first.items.length).toBeLessThan(91);
    expect(first.has_more).toBe(true);
    expect(encode({ jsonrpc: '2.0', id: 1, result: first }).length).toBeLessThan(1024 * 1024);
    const initial = f.project.inspect(task.id).progress_history;
    expect(initial.items.length).toBeLessThan(10); expect(initial.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThan(201000);
    const ids = []; let page = first;
    for (;;) {
      ids.push(...page.items.map(row => row.id));
      expect(page.items.every(row => row.progress.items.length === 32)).toBe(true);
      if (!page.has_more) break;
      page = history(f, task.id, { before: page.cursor, limit: 100 });
      expect(encode({ jsonrpc: '2.0', id: 1, result: page }).length).toBeLessThan(1024 * 1024);
    }
    expect(ids).toHaveLength(91); expect(new Set(ids).size).toBe(91);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  } finally { await f.close(); }
});

test('archive, active replacement and input marker are one rollback-safe transaction', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f);
    f.project.reportProgressPlan(task.id, steps('work'));
    const before = f.store.task(task.id).progress_plan;
    const original = f.store.setProgressPlan;
    f.store.setProgressPlan = () => { throw new Error('write failed'); };
    try { expect(() => f.project.reportProgressPlan(task.id, steps('work', 'next'))).toThrow('write failed'); }
    finally { f.store.setProgressPlan = original; }
    expect(f.store.task(task.id).progress_plan).toBe(before);
    expect(history(f, task.id).items).toEqual([]);
    f.project.reportProgressPlan(task.id, steps('work', 'next'));
    expect(history(f, task.id).items).toHaveLength(1);
  } finally { await f.close(); }
});

test('bounded newest-first pagination/inspect, isolation, permissions and reporting switch retain stored Events', async () => {
  const f = fixture(); offline(f);
  try {
    const task = worker(f), other = worker(f);
    for (let i = 0; i < 14; i++) f.project.reportProgressPlan(task.id, [{ key: 'work', label: `v${i}` }]);
    f.project.reportProgressPlan(other.id, steps('other')); f.project.reportProgressPlan(other.id, steps('other', 'next'));
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const first = await rpc.dispatch('worker.progress_history', { id: task.id, limit: 3 });
    expect(first).toMatchObject({ has_more: true, limit: 3, cursor: first.items[2].id });
    expect(first.items.map(row => row.progress.items[0].label)).toEqual(['v12', 'v11', 'v10']);
    const next = await rpc.dispatch('worker.progress_history', { id: task.id, before: first.cursor, limit: 100 });
    expect(next.items).toHaveLength(10); expect(next.has_more).toBe(false);
    expect(next.items.every(row => row.id < first.cursor)).toBe(true);
    expect(f.project.inspect(task.id).progress_history).toMatchObject({ limit: 10, has_more: true });
    expect(f.project.inspect(task.id).progress_history.items).toHaveLength(10);
    expect(f.project.decorate(f.store.summaries('work')).every(row => !('progress_history' in row))).toBe(true);
    expect(history(f, other.id).items).toHaveLength(1);
    for (const params of [{ before: 0 }, { before: -1 }, { before: 1.2 }, { limit: 0 }, { limit: 101 }, { limit: 1.2 }]) {
      await expect(rpc.dispatch('worker.progress_history', { id: task.id, ...params })).rejects.toThrow();
    }
    await expect(rpc.dispatch('worker.progress_history', { id: 999999 })).rejects.toThrow();
    await expect(rpc.dispatch('worker.progress_history', { id: task.id, after: 1 })).rejects.toThrow('unknown parameter');
    await expect(rpc.dispatch('worker.progress_history', { id: task.id, _token: 'expired' })).rejects.toThrow();
    const storage = f.store.all("SELECT * FROM events WHERE type='progress.archived'");
    f.config.progressReporting = false;
    expect(history(f, task.id)).toEqual({ items: [], cursor: null, has_more: false, limit: 10 });
    expect(f.project.inspect(task.id).progress_history.items).toEqual([]);
    expect(f.store.all("SELECT * FROM events WHERE type='progress.archived'")).toEqual(storage);
    f.config.progressReporting = true;
    expect(history(f, task.id, { limit: 100 }).items).toHaveLength(13);
  } finally { await f.close(); }
});
