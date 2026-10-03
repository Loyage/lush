import { test, expect, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(15000);
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate, until } from '../helpers.js';

const booking = (f, task) => JSON.parse(f.store.task(task.id).reservation);
async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  return f;
}
async function source(f, name) {
  const { task } = await f.project.order(name);
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
  f.store.update(task.id, { status: 'waiting', result: 'tested' });
  await f.project.reserveTask(task.id, 'merge');
  return task;
}

test('an unauthorized sender cannot suspend a resolving delivery or consume its repair signal', async () => {
  const f = await setup();
  try {
    const target = await source(f, 'target');
    const intruder = f.store.create({ parent_id: target.parent_id, role: 'agent', task_kind: 'order', goal: 'unrelated sender' });
    fs.writeFileSync(path.join(f.root, 'parent.txt'), 'parent changed');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'parent diverged');
    f.project.kick = () => {}; f.project.stopping = false;
    await f.project.driveTaskMerge(target.parent_id);
    expect(booking(f, target).status).toBe('resolving');
    const before = {
      task: f.store.task(target.id), parent: f.store.task(target.parent_id),
      messages: f.store.all('SELECT * FROM messages ORDER BY id'), events: f.store.all('SELECT * FROM events ORDER BY id'),
      owner: f.project.activeTaskMerge(target.parent_id), freeze: f.project.branchFreeze('main'),
      pending: [...(f.project.taskMergeWakePending ?? [])],
    };
    for (const sender of [intruder.id, 999999]) {
      expect(() => f.project.message(target.id, 'invalid work', sender)).toThrow();
      expect({
        task: f.store.task(target.id), parent: f.store.task(target.parent_id),
        messages: f.store.all('SELECT * FROM messages ORDER BY id'), events: f.store.all('SELECT * FROM events ORDER BY id'),
        owner: f.project.activeTaskMerge(target.parent_id), freeze: f.project.branchFreeze('main'),
        pending: [...(f.project.taskMergeWakePending ?? [])],
      }).toEqual(before);
    }
    expect(f.store.unread(target.id).some(message => message.signal_type === 'merge.repair')).toBe(true);
  } finally { await f.close(); }
});

test('automatic scheduling advances the next requested sibling after a pre-landing inspection fails', async () => {
  const f = await setup();
  try {
    const first = await source(f, 'first'), second = await source(f, 'second');
    const original = f.project.workspaces.branchState.bind(f.project.workspaces);
    f.project.workspaces.branchState = branch => branch === first.branch
      ? Promise.reject(new Error('pre-landing source inspection failed')) : original(branch);
    f.project.stopping = false;
    // No direct driver or explicit recheck: exercise the actual runtime wake/queue edge.
    f.project.scheduleTaskMerge(first.parent_id);
    await until(() => f.store.task(second.id).integration === 'merged', 10000);
    expect(booking(f, first).status).toBe('suspended');
    expect(f.store.task(second.id).status).toBe('awaiting_acceptance');
    expect(f.project.activeTaskMerge(first.parent_id)).toBeNull();
    expect(await git(f.root, 'show', 'main:second.txt')).toBe('second');
    expect(f.store.history(first.id).some(event => event.type === 'merge.landing_prepared')).toBe(false);
  } finally { await f.close(); }
});

for (const release of ['suspend', 'cancel', 'questionnaire']) {
  test(`automatic scheduling retains a busy-time ${release} wake and advances the next requested sibling`, async () => {
    const f = await setup(), entered = gate(), leave = gate();
    try {
      const first = await source(f, 'first'), second = await source(f, 'second');
      const original = f.project.workspaces.branchState.bind(f.project.workspaces);
      f.project.workspaces.branchState = async branch => {
        const state = await original(branch);
        if (branch === first.branch) { entered.resolve(); await leave.promise; }
        return state;
      };
      f.project.stopping = false;
      f.project.scheduleTaskMerge(first.parent_id);
      await entered.promise;
      expect(f.project.taskMergeBusy.has(first.parent_id)).toBe(true);
      expect(booking(f, first).status).toBe('executing');
      if (release === 'cancel') f.project.cancel(first.id);
      else if (release === 'questionnaire') f.project.parkForQuestion(first.id, 999);
      else f.project.suspendTaskMerge(first.id, 'deliberate release during async inspection');
      // Let the scheduled microtask hit the still-busy driver; this used to lose the wake.
      await Promise.resolve(); await Promise.resolve();
      expect(f.project.taskMergeBusy.has(first.parent_id)).toBe(true);
      expect(f.project.taskMergeWakePending.has(first.parent_id)).toBe(true);
      expect(f.store.task(second.id).integration).not.toBe('merged');
      leave.resolve();
      await until(() => f.store.task(second.id).integration === 'merged', 10000);
      expect(booking(f, first).status).toBe(release === 'cancel' ? 'withdrawn' : 'suspended');
      expect(f.project.activeTaskMerge(first.parent_id)).toBeNull();
      expect(await git(f.root, 'show', 'main:second.txt')).toBe('second');
    } finally { leave.resolve(); await f.close(); }
  });
}

test('exact landing recovery records the current parent tip without changing the historical landed credential', async () => {
  const f = await setup();
  try {
    const task = await source(f, 'recover');
    f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
    const finalize = f.project.finalizeTaskMerge.bind(f.project);
    f.project.finalizeTaskMerge = () => { throw new Error('DB write interrupted after Git success'); };
    f.project.stopping = false; await f.project.driveTaskMerge(task.parent_id);
    const receipt = booking(f, task).landing_receipt;
    expect(booking(f, task).status).toBe('blocked');
    fs.writeFileSync(path.join(f.root, 'external.txt'), 'external parent work');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'external parent advance');
    const current = await git(f.root, 'rev-parse', 'main');
    expect(current).not.toBe(receipt.commit);
    expect(await f.project.workspaces.verifyTaskSquashUnsafe(receipt)).toBe(true);
    f.project.finalizeTaskMerge = finalize;
    f.project.workspaces.applyTaskSquashUnsafe = () => { throw new Error('must never replay the landing'); };
    await f.project.driveTaskMerge(task.parent_id);
    expect(f.store.task(task.id).integration).toBe('merged');
    expect(booking(f, task).landing_receipt).toEqual(receipt);
    expect(booking(f, task).landed_commit).toBe(receipt.commit);
    expect(f.store.task(task.parent_id).head_commit).toBe(current);
    const event = f.store.history(task.id).find(row => row.type === 'task.merge_integrated');
    expect(event.data).toMatchObject({ commit: receipt.commit, parent_head: current });
    const message = f.store.unread(task.parent_id).find(row => row.signal_type === 'merge.completed');
    expect(JSON.parse(message.body).payload).toMatchObject({ commit: receipt.commit, parent_head: current });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(current);
  } finally { await f.close(); }
});
