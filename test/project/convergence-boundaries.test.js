import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import queue from '../../src/core/project/convergence-queue.js';
import prepare from '../../src/core/project/convergence-prepare.js';
import land from '../../src/core/project/convergence-land.js';

async function source(f) {
  f.project.stopping = true; await repo(f.root);
  const { task } = await f.project.order('fixed convergence source');
  fs.writeFileSync(path.join(task.workspace, 'fixed.txt'), 'fixed\n');
  await git(task.workspace, 'add', 'fixed.txt'); await git(task.workspace, 'commit', '-m', 'fixed');
  await f.project.workspaces.finish(f.store.task(task.id));
  f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 3, kind: 'merge', status: 'requested',
    parent_id: task.parent_id, commit: f.store.task(task.id).head_commit, delivery_id: 101, enqueue_seq: 101,
    run_id: 10, generation: 1 }) });
  return f.store.task(task.id);
}

test('v3 preparation/validation/repair/failure freezes only sources; landing/unknown effects freeze the real parent', async () => {
  const f = fixture();
  try {
    const task = await source(f);
    let run = { id: 10, generation: 1, state: 'preparing', landing_receipt: null };
    f.store.deliveryRun = () => run;
    const parentHead = await git(f.root, 'rev-parse', 'main');
    for (const state of ['preparing', 'validating', 'resolving', 'awaiting', 'ready', 'failed']) {
      run.state = state;
      expect(f.project.branchFreeze(task.branch)).toMatchObject({ kind: 'convergence', run_id: 10 });
      expect(f.project.branchFreeze('main')).toBeNull();
    }
    run.state = 'landing';
    expect(f.project.branchFreeze('main')).toMatchObject({ kind: 'convergence', run_id: 10 });
    run = { ...run, state: 'blocked', landing_receipt: '{"commit":"exact"}' };
    expect(f.project.branchFreeze('main')).toMatchObject({ kind: 'convergence', run_id: 10 });
    run.landing_receipt = null;
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parentHead);
  } finally { await f.close(); }
});

test('buffered input cannot invalidate a fixed v3 source but still blocks acceptance', async () => {
  const f = fixture();
  try {
    const task = await source(f);
    f.store.deliveryRun = () => ({ id: 10, generation: 1, state: 'preparing', landing_receipt: null });
    const before = f.store.task(task.id).reservation;
    const result = f.project.message(task.id, 'additional work after this delivery');
    expect(result).toBeDefined();
    expect(f.store.task(task.id).reservation).toBe(before);
    expect(f.project.taskInputQueue(f.store.task(task.id))).toMatchObject({ buffered: 1 });
    expect(f.project.reservationWaitReason(f.store.task(task.id))).toBeNull();
    expect(f.project.releaseTaskInputs(task.id)).toBe(false);
    await expect(f.project.acceptTask(task.id)).rejects.toThrow();
    expect(f.store.unread(task.id)).toHaveLength(1);
    expect(f.project.autoMergeView(f.store.task(task.id))).not.toBeNull();
  } finally { await f.close(); }
});

test('integration identity buffers ordinary additions and cannot issue development messages', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'agent', task_kind: 'order', goal: 'parent' });
    const helper = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'integration', goal: 'private repair' });
    f.project.message(helper.id, 'ordinary input');
    expect(f.project.taskInputQueue(f.store.task(helper.id))).toMatchObject({ buffered: 1 });
    expect(f.project.releaseTaskInputs(helper.id)).toBe(false);
    expect(() => f.project.message(parent.id, 'ordinary message', helper.id)).toThrow('internal integration');
    expect(f.store.unread(parent.id)).toHaveLength(0);
    expect(f.store.unread(helper.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('command claim follows latest definitions and ignores legacy authorization stamps; an active claim rejects edits', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    Object.assign(f.project, queue);
    f.project.saveShortcutCommand({ name: 'final', command: 'echo private-command-body' }, f.project.shortcutCommands().revision);
    const command = f.project.shortcutCommands().items[0];
    const reference = { command_id: command.id, command_version: 1 };
    const run = { validation: JSON.stringify(reference), data: JSON.stringify({ authorization_id: -1 }) };
    expect(f.project.assertConvergenceCommand(run).name).toBe('final');
    f.project.saveShortcutCommand({ id: command.id, name: 'latest', command: 'true' }, f.project.shortcutCommands().revision);
    expect(f.project.assertConvergenceCommand(run)).toMatchObject({ version: 2, name: 'latest' });
    run.data = JSON.stringify({ validation_execution: { command_id: command.id, command_version: 2 } });
    f.project.saveShortcutCommand({ id: command.id, name: 'next', command: 'true' }, f.project.shortcutCommands().revision);
    expect(() => f.project.assertConvergenceCommand(run)).toThrow('definition changed');
  } finally { await f.close(); }
});

test('preparation and publication mixins have disjoint explicit methods; stalled ready work never starts a polling job', () => {
  const names = [...Object.keys(queue), ...Object.keys(prepare), ...Object.keys(land)];
  expect(new Set(names).size).toBe(names.length);
  const host = { convergenceJobs: new Map(), store: { deliveryRun: () => ({ id: 1, state: 'ready' }) },
    running: new Map(), convergenceCanPublish: () => false, write: () => { throw new Error('must not run'); } };
  expect(queue.startConvergenceJob.call(host, 1)).toBe(false);
  expect(host.convergenceJobs.size).toBe(0);
});
