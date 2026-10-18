import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { normalizeMergeConditions, MERGE_CONDITION_LIMIT } from '../../src/core/merge-conditions.js';

const condition = (task, kind = 'worker_settled') => ({ kind, worker_id: task.id });
const reserve = (p, task, conditions) => p.mergeTaskAfter(task.id, conditions, p.taskMergeConditions(task.id).revision);
const booking = (f, task) => JSON.parse(f.store.task(task.id).reservation ?? 'null');
async function setup(provider = null) {
  const f = fixture(provider ?? { resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    fs.writeFileSync(path.join(cwd, `worker-${task.id}.txt`), `code ${task.id}\n`);
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `work ${task.id}`); return 'safe result';
  } });
  f.project.kick = () => {}; await repo(f.root); await f.project.bootstrapMain(); return f;
}
async function runQueued(f) {
  f.project.pump();
  await until(() => !f.project.running.size && !f.store.all("SELECT id FROM tasks WHERE status IN ('queued','running')").length, 12000);
}

test('single-source strict condition contract requires explicit kinds, integer IDs, unique pairs and 1..16 AND operands', () => {
  const max = Array.from({ length: MERGE_CONDITION_LIMIT }, (_, index) => ({ kind: 'worker_settled', worker_id: index + 1 }));
  expect(normalizeMergeConditions(max)).toEqual(max);
  for (const value of [[], [...max, { kind: 'worker_merged', worker_id: 1 }], [{ worker_id: 2 }],
    [{ kind: 'worker_settled', worker_id: '2' }], [max[0], max[0]], [{ ...max[0], script: 'true' }]])
    expect(() => normalizeMergeConditions(value)).toThrow();
});

test('AND: safe settled plus exact direct-parent merge (not main), wait without source freeze or parent slot; child auto Hook cannot bypass', async () => {
  const held = gate();
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    if (task.goal === 'hold') await held.promise;
    if (task.goal !== 'hold' && task.goal !== 'parent') {
      fs.writeFileSync(path.join(cwd, `worker-${task.id}.txt`), `code ${task.id}\n`);
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `work ${task.id}`);
    }
    return 'safe result';
  } });
  try {
    const p = f.project, parent = (await p.order('parent')).task;
    f.store.update(parent.id, { status: 'waiting' });
    const a = await p.spawn(parent.id, 'A'), b = (await p.order('B')).task, c = (await p.order('hold')).task;
    // B's real direct parent is a non-main development Worker, separate from A's parent.
    const bp = (await p.order('parent')).task;
    f.store.update(bp.id, { status: 'waiting' });
    const nested = await p.spawn(bp.id, 'B nested');
    reserve(p, a, [condition(c), condition(nested, 'worker_merged')]);
    p.pump();
    await until(() => f.store.task(nested.id).integration === 'merged' && f.store.task(a.id).status === 'waiting', 12000);
    expect(await git(f.root, 'show', `main:worker-${a.id}.txt`).catch(() => null)).toBeNull();
    expect(booking(f, a).status).toBe('pending');
    expect(p.inputFreezeReason(f.store.task(a.id))).toBeNull();
    expect(p.activeTaskMerge(parent.id)).toBeNull();
    expect(p.autoMergeView(f.store.task(a.id))).toMatchObject({ enabled: true, locked: true });
    expect(p.taskHooks(a.id).mounts.find(m => m.id === 'merge-conditions')).toMatchObject({ registry_id: 'system:merge-conditions', locked: true, editable: false });
    await p.requestTaskMerge(a.id);
    expect(booking(f, a).status).toBe('pending'); // manual cannot bypass either
    held.resolve();
    await until(() => f.store.task(a.id).integration === 'merged', 12000);
    expect(p.taskMergeConditions(a.id)).toMatchObject({ state: 'consumed' });
    const view = p.taskMergeConditions(a.id);
    expect(view.conditions.every(c => c.satisfied)).toBe(true);
    expect(view.conditions[1].evidence.parent_id).toBe(bp.id);
    expect(await git(bp.workspace, 'show', `HEAD:worker-${nested.id}.txt`)).toBe(`code ${nested.id}`);
    expect(await git(f.root, 'show', `main:worker-${nested.id}.txt`).catch(() => null)).toBeNull();
    expect(await git(parent.workspace, 'show', `HEAD:worker-${a.id}.txt`)).toBe(`code ${a.id}`);
    expect(f.store.task(b.id).integration).not.toBe('merged');
  } finally { held.resolve(); await f.close(); }
});

test('no-change delivery is settled but not a real merge; dirty or unclosed descendants do not provide safe settled evidence', async () => {
  const f = await setup({ resolve() { return { agent: 'mock' }; }, async run() { return 'no-code result'; } });
  try {
    const p = f.project, a = (await p.order('A')).task, parent = (await p.order('parent')).task;
    f.store.update(parent.id, { status: 'waiting' });
    const b = await p.spawn(parent.id, 'no changes');
    p.pump();
    await until(() => f.store.task(b.id).status === 'awaiting_acceptance' && !p.running.size, 12000);
    p.scheduleMergeConditions = () => {};
    reserve(p, a, [condition(b, 'worker_merged')]);
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
    expect(p.taskMergeConditions(a.id).conditions[0].satisfied).toBe(false);
    reserve(p, a, [condition(b)]);
    expect(await p.refreshMergeConditions(a.id)).toBe(true);
    fs.writeFileSync(path.join(b.workspace, 'dirty'), 'not delivered');
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
    fs.unlinkSync(path.join(b.workspace, 'dirty'));
    f.store.update(b.id, { status: 'waiting' });
    const child = await p.spawn(b.id, 'unclosed descendant');
    f.store.update(child.id, { status: 'failed' });
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
  } finally { await f.close(); }
});

test('already satisfied evidence, exact lost-ACK duplicate, concurrent CAS, and consumed conditions do not authorize next input round', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task, c = (await p.order('C')).task;
    await runQueued(f);
    const revision = p.taskMergeConditions(a.id).revision;
    const first = p.mergeTaskAfter(a.id, [condition(b)], revision);
    expect(p.mergeTaskAfter(a.id, [condition(b)], revision).revision).toBe(first.revision);
    expect(() => p.mergeTaskAfter(a.id, [condition(c)], revision)).toThrow('different conditions');
    await until(() => f.store.task(a.id).integration === 'merged', 12000);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='merge.conditions_configured'", a.id).n).toBe(1);
    expect(p.taskMergeConditions(a.id).state).toBe('consumed');
    p.message(a.id, 'next round');
    expect(p.taskMergeConditions(a.id).state).toBe('consumed');
    expect(booking(f, a)).toBeNull();
    expect(p.mergeReadiness(f.store.task(a.id)).ready).toBe(false);
  } finally { await f.close(); }
});

test('settled proof must name the exact current source commit, not merely an earlier successful Run in the same input round', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    await runQueued(f); p.scheduleMergeConditions = () => {}; reserve(p, a, [condition(b)]);
    expect(await p.refreshMergeConditions(a.id)).toBe(true);
    fs.writeFileSync(path.join(b.workspace, 'new-code.txt'), 'new unreviewed code\n');
    await git(b.workspace, 'add', '.'); await git(b.workspace, 'commit', '-m', 'new source without new success receipt');
    await p.workspaces.finish(f.store.task(b.id));
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
    expect(p.taskMergeConditions(a.id).conditions[0].satisfied).toBe(false);
  } finally { await f.close(); }
});

test('reject self, explicit cycles and implicit ancestor closure deadlocks; parent may wait for descendant', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    expect(() => reserve(p, a, [condition(a)])).toThrow('self');
    reserve(p, a, [condition(b, 'worker_merged')]);
    expect(() => reserve(p, b, [condition(a)])).toThrow('cycle');
    f.store.update(a.id, { status: 'waiting' });
    const child = await p.spawn(a.id, 'child');
    expect(() => reserve(p, child, [condition(a)])).toThrow('deadlock');
    expect(() => reserve(p, a, [condition(child)])).not.toThrow();
  } finally { await f.close(); }
});

test('new A/B input invalidates waiting round, invocation return is insufficient, failure/cancellation never satisfy', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    reserve(p, a, [condition(b)]);
    f.store.update(a.id, { status: 'waiting' }); f.store.update(b.id, { status: 'waiting' });
    // Fabricated idle without a completed Run cannot be treated as delivery.
    f.store.event(b.id, 'task.idle', { run_id: 999999 });
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
    p.message(b.id, 'new B work');
    expect(p.taskMergeConditions(a.id).state).toBe('stale');
    reserve(p, a, [condition(b)]);
    p.message(a.id, 'new A work');
    expect(p.taskMergeConditions(a.id).state).toBe('stale');
    reserve(p, a, [condition(b)]);
    f.store.update(b.id, { status: 'failed' });
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
    f.store.update(b.id, { status: 'cancelled' });
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
    expect(booking(f, a).status).toBe('pending');
    expect(() => reserve(p, a, [condition(b)])).toThrow('non-failed');
  } finally { await f.close(); }
});

test('fixed requested/executing/resolving/blocked/suspended attempts reject later configuration without changing delivery', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    for (const status of ['requested','executing','resolving','blocked','suspended']) {
      const original = JSON.stringify({ version: 2, kind: 'merge', status, delivery_id: 90, parent_id: a.parent_id });
      f.store.update(a.id, { reservation: original });
      expect(() => reserve(p, a, [condition(b)])).toThrow('fixed');
      expect(f.store.task(a.id).reservation).toBe(original);
      expect(p.taskMergeConditions(a.id).state).toBe('idle');
    }
    f.store.update(a.id, { reservation: null });
    f.store.update(b.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested', parent_id: b.parent_id }) });
    p.message(b.id, 'buffered future round');
    expect(p.taskInputQueue(f.store.task(b.id)).buffered).toBe(1);
    expect(() => reserve(p, a, [condition(b)])).toThrow('buffered future input');
  } finally { await f.close(); }
});

test('pending conditions survive real Store/Project restart, no implicit replay or busy self-scheduling', async () => {
  const f = await setup(); let reopened, project;
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    reserve(p, a, [condition(b)]);
    // Persist a paused dependency, so restart must keep waiting instead of launching unknown work.
    f.store.update(a.id, { status: 'waiting' }); f.store.update(b.id, { status: 'paused' });
    const before = p.taskMergeConditions(a.id);
    await p.shutdown();
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    project = new Project(f.config, reopened, p.provider); project.kick = () => {}; project.recover();
    await project.drainMergeConditions();
    expect(project.taskMergeConditions(a.id).revision).toBe(before.revision);
    expect(JSON.parse(reopened.task(a.id).reservation).status).toBe('pending');
    expect(project.activeTaskMerge(a.parent_id)).toBeNull();
    expect(reopened.get("SELECT count(*) AS n FROM events WHERE type='merge.attempt_started'").n).toBe(0);
    const eventCount = reopened.get('SELECT count(*) AS n FROM events').n;
    for (let i = 0; i < 5; i++) await project.drainMergeConditions();
    expect(reopened.get('SELECT count(*) AS n FROM events').n).toBe(eventCount);
    project.scheduleTaskHooks();
    await until(() => project.runtimeCoordinator.pendingCount === 0 && project.runtimeCoordinator.runningCount === 0);
    expect(JSON.parse(reopened.task(a.id).reservation).status).toBe('pending');
  } finally { await project?.shutdown(); reopened?.close(); await f.close(); }
});

test('batch/manual/one-shot integration and automatic configuration share conditional source admission', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    f.store.update(b.id, { status: 'paused' });
    reserve(p, a, [condition(b)]); await runQueued(f);
    expect(p.oneShotAdmission(f.store.task(a.id))).toContain('条件');
    const plan = await p.branchIntegratePlan('main');
    expect(plan.members.some(m => m.id === a.id)).toBe(false);
    expect(plan.excluded.find(m => m.id === a.id).reason).toContain('条件');
    await p.reserveMergeAll('main');
    expect(booking(f, a).status).toBe('pending');
    await p.setTaskAutoMerge(a.id, true);
    expect(booking(f, a).status).toBe('pending');
    // Cancelling an explicit pending intent does not remove the protected condition.
    p.unreserveTask(a.id);
    p.armTaskAutoMerge(a.id); await p.settleQueuedMerge(a.id);
    expect(booking(f, a).status).toBe('pending');
    expect(p.taskMergeConditions(a.id).state).toBe('waiting');
  } finally { await f.close(); }
});

test('Git-wait races recheck all AND operands and the final apply guard blocks a newly changed input round', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task, c = (await p.order('C')).task;
    await runQueued(f);
    // Do not let the coordinator execute while inserting deterministic races.
    p.scheduleMergeConditions = () => {};
    reserve(p, a, [condition(b), condition(c)]);
    const clean = p.inputWorkspaceClean.bind(p); let changed = false;
    p.inputWorkspaceClean = async task => {
      const result = await clean(task);
      if (task.id === c.id && !changed) { changed = true; p.message(b.id, 'changed during AND check'); }
      return result;
    };
    expect(await p.refreshMergeConditions(a.id)).toBe(false);
    expect(p.taskMergeConditions(a.id).state).toBe('stale');
    p.inputWorkspaceClean = clean;
    // Use C only for the next exact configuration. Invalidate after receipt preparation,
    // immediately before Workspaces executes its real guarded apply.
    reserve(p, a, [condition(c)]);
    const apply = p.workspaces.applyTaskSquashUnsafe.bind(p.workspaces);
    p.workspaces.applyTaskSquashUnsafe = async (receipt, guard) => {
      p.message(c.id, 'changed at final Git gate');
      return apply(receipt, guard);
    };
    await p.settleQueuedMerge(a.id);
    await until(() => booking(f, a)?.status === 'blocked', 12000);
    expect(await git(f.root, 'show', `main:worker-${a.id}.txt`).catch(() => null)).toBeNull();
    expect(booking(f, a).landing_receipt).toBeTruthy(); // uncertain apply retains exact receipt, no retry
    expect(p.taskMergeConditions(a.id).state).toBe('stale');
  } finally { await f.close(); }
});

test('dependency invalidation suspends an unwritten source-repair attempt and releases the parent execution slot without a scheduling loop', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task, c = (await p.order('C')).task;
    await runQueued(f);
    await p.requestTaskMerge(b.id);
    await until(() => f.store.task(b.id).integration === 'merged', 12000);
    p.scheduleMergeConditions = () => {};
    reserve(p, a, [condition(c)]);
    await p.settleQueuedMerge(a.id);
    await until(() => booking(f, a)?.status === 'resolving', 12000);
    expect(p.activeTaskMerge(a.parent_id)?.id).toBe(a.id);
    p.message(c.id, 'dependency starts a different input round');
    await p.drainMergeConditions();
    await until(() => booking(f, a)?.status === 'suspended', 12000);
    expect(p.activeTaskMerge(a.parent_id)).toBeNull();
    expect(f.store.task(a.id)).toMatchObject({ status: 'waiting', calls: 1 });
    expect(booking(f, a).landing_receipt).toBeUndefined();
    await until(() => !p.taskMergeBusy?.size);
    const count = f.store.get("SELECT count(*) AS n FROM events WHERE type='merge.attempt_suspended'").n;
    await p.drainMergeConditions();
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='merge.attempt_suspended'").n).toBe(count);
  } finally { await f.close(); }
});

test('restart reconciles an exact already-written receipt with pinned original conditions, never replaying apply after new dependency input', async () => {
  const f = await setup(); let reopened, project;
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    await runQueued(f); p.scheduleMergeConditions = () => {};
    reserve(p, a, [condition(b)]);
    const apply = p.workspaces.applyTaskSquashUnsafe.bind(p.workspaces); let applies = 0;
    p.workspaces.applyTaskSquashUnsafe = async (receipt, guard) => {
      applies++; await apply(receipt, guard);
      p.message(b.id, 'next round after actual Git landing');
      throw new Error('controlled crash after Git, before DB');
    };
    await p.settleQueuedMerge(a.id);
    await until(() => booking(f, a)?.status === 'blocked', 12000);
    expect(await git(f.root, 'show', `main:worker-${a.id}.txt`)).toBe(`code ${a.id}`);
    expect(applies).toBe(1); expect(p.taskMergeConditions(a.id).state).toBe('stale');
    await p.shutdown();
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    project = new Project(f.config, reopened, p.provider); project.kick = () => {};
    project.workspaces.applyTaskSquashUnsafe = () => { throw new Error('must never replay written apply'); };
    project.recover();
    await until(() => reopened.task(a.id).integration === 'merged', 12000);
    expect(project.taskMergeConditions(a.id).state).toBe('consumed');
    expect(project.taskMergeConditions(a.id).conditions[0].evidence.event_id).toBeTruthy();
    expect(reopened.task(a.id).calls).toBe(1);
    expect(reopened.task(b.id).calls).toBe(1);
    expect(reopened.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.merge_integrated'", a.id).n).toBe(1);
  } finally { await project?.shutdown(); reopened?.close(); await f.close(); }
});

test('public registration is user-only for ordinary Agents; strict nested fields and protected registry cannot be bypassed', async () => {
  const f = await setup();
  try {
    const p = f.project, a = (await p.order('A')).task, b = (await p.order('B')).task;
    const d = new Dispatcher(p, createSignal(), {});
    p.actor = token => token ? a.id : null;
    for (const method of ['worker.merge_conditions','worker.merge_after']) {
      await expect(d.dispatch(method, { id: a.id, ...(method.endsWith('after') ? { conditions: [condition(b)], expected_revision: p.taskMergeConditions(a.id).revision } : {}), _token: 'ordinary' })).rejects.toThrow('user approval');
    }
    await expect(d.dispatch('worker.merge_after', { id: a.id, conditions: [{ ...condition(b), shell: 'false' }], expected_revision: p.taskMergeConditions(a.id).revision })).rejects.toThrow('invalid merge condition');
    await expect(d.dispatch('worker.merge_after', { id: a.id, conditions: [condition(b)], expected_revision: p.taskMergeConditions(a.id).revision, bypass: true })).rejects.toThrow('unknown parameter');
    expect(() => p.attachTaskHook(a.id, { template_id: 'system:merge-conditions', template_version: 1 }, p.taskHooks(a.id).revision)).toThrow('system automation');
    expect(p.taskMergeConditions(a.id).state).toBe('idle');
  } finally { await f.close(); }
});
