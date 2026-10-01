import { test, expect } from 'bun:test';
import iteration, { iterationViews } from '../../src/core/project/iteration.js';
import { fixture, repo } from '../helpers.js';

async function setup() {
  const f = fixture(); Object.assign(f.project, iteration); f.project.stopping = true;
  await repo(f.root);
  const { task } = await f.project.say('read model');
  f.store.update(task.id, { status: 'waiting', result: 'answer' });
  return { ...f, task };
}
async function views(f) {
  return [f.project.inspect(f.task.id), f.project.decorate([f.store.task(f.task.id)])[0],
    (await f.project.taskGraph()).nodes.find(row => row.id === f.task.id)];
}
function expectState(rows, accepted, conflict) {
  for (const row of rows) {
    expect(row.accepted).toBe(accepted);
    expect(row.parent_sync_conflict).toEqual(conflict);
  }
}

test('inspect, decorate and Task graph distinguish explicit acceptance from historical completion and clear it on reopen', async () => {
  const f = await setup();
  try {
    expectState(await views(f), false, null);
    // Historical completed rows are retained, never silently declared accepted.
    f.store.update(f.task.id, { status: 'completed' });
    expectState(await views(f), false, null);
    f.store.update(f.task.id, { status: 'waiting' });
    await f.project.acceptTask(f.task.id);
    expectState(await views(f), true, null);
    await expect(f.project.reopenTask(f.task.id)).rejects.toThrow('accepted Tasks cannot be reopened');
    // Older persisted reopen records are read faithfully, but the new API cannot revive acceptance.
    f.store.event(f.task.id, 'task.reopened', { head_commit: f.store.task(f.task.id).head_commit });
    f.store.update(f.task.id, { status: 'awaiting_acceptance' });
    expectState(await views(f), false, null);
    // Reopened historical completion cannot revive the previous acceptance marker.
    f.store.update(f.task.id, { status: 'completed' });
    expectState(await views(f), false, null);
    f.store.update(f.task.id, { status: 'waiting' });
    await f.project.acceptTask(f.task.id);
    expectState(await views(f), true, null);
  } finally { await f.close(); }
});

test('read surfaces retain a fixed unresolved sync conflict while resolving and clear it only after newer success', async () => {
  const f = await setup();
  try {
    const diagnostic = { source_commit: 'a'.repeat(40), parent_commit: 'b'.repeat(40), reason: 'fixed conflict' };
    f.store.event(f.task.id, 'task.parent_sync_conflict', { ...diagnostic, parent_id: f.task.parent_id });
    expectState(await views(f), false, diagnostic);
    f.store.event(f.task.id, 'task.sync_resolution_requested', { ...diagnostic, message_id: 19 });
    f.store.update(f.task.id, { status: 'queued' });
    expectState(await views(f), false, diagnostic);
    f.store.event(f.task.id, 'task.parent_synced', { ...diagnostic, resolved: true });
    expectState(await views(f), false, null);
    const second = { ...diagnostic, source_commit: 'c'.repeat(40), reason: 'second conflict' };
    f.store.event(f.task.id, 'task.parent_sync_conflict', second);
    expectState(await views(f), false, second);
    expect(f.project.activity().tasks.find(row => row.id === f.task.id).parent_sync_conflict).toEqual(second);
  } finally { await f.close(); }
});

test('batched iteration projection uses bounded indexed latest-event reads and does not load task history', async () => {
  const f = await setup();
  try {
    const tasks = f.store.transaction(() => Array.from({ length: 405 }, (_, index) => {
      const task = f.store.create({ role: 'agent', task_kind: 'child', goal: `task ${index}` });
      f.store.update(task.id, { status: 'completed' });
      f.store.event(task.id, 'task.accepted', {});
      return f.store.task(task.id);
    }));
    const unrelated = f.store.create({ role: 'agent', task_kind: 'say', goal: 'not selected' });
    f.store.event(unrelated.id, 'task.parent_sync_conflict', { source_commit: 'x', parent_commit: 'y', reason: 'must not leak' });
    f.store.transaction(() => {
      for (let index = 0; index < 2500; index++) f.store.event(tasks[0].id, 'invocation.started', { index });
    });
    const all = f.store.all.bind(f.store);
    const queries = [];
    f.store.all = (sql, ...args) => {
      if (sql.startsWith('WITH targets(task_id)')) queries.push({ sql, args });
      return all(sql, ...args);
    };
    const projected = iterationViews(f.store, tasks);
    expect(queries).toHaveLength(3);
    expect(queries.map(query => query.args.length)).toEqual([200, 200, 5]);
    expect(projected.size).toBe(405);
    expect([...projected.values()].every(view => view.accepted && view.parent_sync_conflict === null)).toBe(true);
    expect(projected.has(unrelated.id)).toBe(false);
    const plans = all(`EXPLAIN QUERY PLAN ${queries[0].sql}`, ...queries[0].args);
    expect(plans.some(row => /USING COVERING INDEX events_task_type_id.*task_id=.*type=/.test(row.detail))).toBe(true);
    iterationViews(f.store, []);
    expect(queries).toHaveLength(3);
    // decorate a normal bounded list performs one read-model query, not one per Task.
    queries.length = 0; f.project.decorate(tasks.slice(0, 50));
    expect(queries).toHaveLength(1);
    expect(queries[0].args).toHaveLength(50);
  } finally { await f.close(); }
});

test('invalid or oversized persisted conflict diagnostics are bounded and remain visible', async () => {
  const f = await setup();
  try {
    f.store.event(f.task.id, 'task.parent_sync_conflict', { source_commit: 's'.repeat(200), parent_commit: 'p'.repeat(200), reason: 'r'.repeat(10000) });
    const state = iterationViews(f.store, [f.store.task(f.task.id)]).get(f.task.id);
    expect(state.parent_sync_conflict.source_commit).toHaveLength(128);
    expect(state.parent_sync_conflict.parent_commit).toHaveLength(128);
    expect(state.parent_sync_conflict.reason).toHaveLength(4000);
    f.store.run("INSERT INTO events(task_id,type,data) VALUES (?,'task.parent_sync_conflict','invalid')", f.task.id);
    expectState(await views(f), false, { source_commit: null, parent_commit: null, reason: '父分支同步冲突诊断需检查' });
  } finally { await f.close(); }
});
