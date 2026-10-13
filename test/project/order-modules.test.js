import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import orderMethods, { composeOrderMethods } from '../../src/core/project/order.js';
import ownerMethods from '../../src/core/project/order-owner.js';
import creationMethods from '../../src/core/project/order-create.js';
import reservationMethods from '../../src/core/project/order-reservation.js';
import legacyMergeMethods from '../../src/core/project/order-legacy-merge.js';
import divergenceMethods from '../../src/core/project/order-divergence.js';
import { storedReservation, parentMovedReason } from '../../src/core/project/order-state.js';

const responsibilities = [
  [ownerMethods, ['bootstrapMain', 'ensureMainTask', 'bindBranch', 'analyze']],
  [creationMethods, ['order', 'submitOrder', 'sendOrder']],
  [reservationMethods, ['resolveTask', 'reserveTask', 'reserveMergeAll', 'noteReservationBlocked',
    'clearReservationBlocked', 'recheckRequestedMerge', 'noteBranchAdvance', 'mergeReadiness',
    'reservationWaitReason', 'unreserveTask']],
  [legacyMergeMethods, ['settleReservedMerge', 'requestCompletedMergeUnsafe', 'pinSettledMergeRequest',
    'approveReservedMerge', 'integrateChild']],
  [divergenceMethods, ['resolveOrderDivergence', 'finalizeTerminalDivergence',
    'scheduleTerminalDivergenceFinalize', 'noteTerminalDivergenceFailure', 'resolveChildDivergence']],
];

test('order facade preserves all 27 Project methods, identities and enumerable descriptors', () => {
  const expected = responsibilities.flatMap(([, names]) => names);
  expect(new Set(expected).size).toBe(27);
  expect(Object.keys(orderMethods).sort()).toEqual([...expected].sort());
  for (const [methods, names] of responsibilities) {
    expect(Object.keys(methods).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(orderMethods[name]).toBe(methods[name]);
      expect(Object.getOwnPropertyDescriptor(Project.prototype, name)).toEqual({
        value: methods[name], enumerable: true, configurable: true, writable: true,
      });
    }
  }
  expect(Project.prototype.storedReservation).toBeUndefined();
  expect(Project.prototype.composeOrderMethods).toBeUndefined();
});

test('order facade refuses duplicate methods rather than silently replacing the first responsibility', () => {
  const first = { submitOrder() {} }, second = { submitOrder() {} };
  expect(() => composeOrderMethods([['first', first], ['second', second]]))
    .toThrow('duplicate order method(s) submitOrder from project/second.js');
  expect(composeOrderMethods([['first', first]]).submitOrder).toBe(first.submitOrder);
});

test('extracted entry methods keep the caller this and cross-responsibility dispatch', async () => {
  const calls = [];
  const context = {
    write(action, operation) { calls.push(action); return operation(); },
    sendOrder(...args) { calls.push(args); return this; },
    store: { task(taskId) { return { id: taskId, task_kind: 'order' }; } },
    acceptTask(taskId) { calls.push(taskId); return this; },
    reservationWaitReason(task) { calls.push(task); return null; },
  };
  expect(orderMethods.order.call(context, 'input', 'branch', [], null, false, 3, null, true)).toBe(context);
  expect(calls.pop()).toEqual(['input', 'branch', [], null, false, 3, null, true]);
  expect(orderMethods.submitOrder.call(context, 'input', 'branch', [], { agent: 'mock' }, false)).toBe(context);
  expect(calls.pop()).toEqual(['input', 'branch', [], null, false, undefined, { agent: 'mock' }]);
  expect(await orderMethods.resolveTask.call(context, 7)).toBe(context);
  expect(calls.pop()).toBe(7);
  const task = { task_kind: 'order', integration: 'pending', branch: 'work', head_commit: 'new', base_commit: 'old' };
  expect(orderMethods.mergeReadiness.call(context, task)).toEqual({ ready: true, reason: null });
  expect(calls.pop()).toBe(task);
});

test('shared reservation helpers preserve protocol validation and drift diagnostics', () => {
  expect(storedReservation(null)).toBeNull();
  for (const version of [1, 2, 3]) {
    const booking = { version, kind: 'merge', status: 'pending', unknown_field: 'preserved' };
    expect(storedReservation(JSON.stringify(booking))).toEqual(booking);
  }
  for (const raw of ['bad JSON', 'null', '[]', '{"version":4,"kind":"merge","status":"pending"}'])
    expect(() => storedReservation(raw)).toThrow('reservation state is invalid');
  expect(parentMovedReason('main', 'a'.repeat(40), 'b'.repeat(40)))
    .toContain('父分支 main 在本请求发出后被推进到 aaaaaaaaaaaa，固定提交 bbbbbbbbbbbb 已不能快进');
});

async function commitFile(cwd, file) {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  await git(cwd, 'add', file);
  await git(cwd, 'commit', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

function legacyPending(f, taskId) {
  f.store.update(taskId, { status: 'waiting', reservation: JSON.stringify({
    version: 1, kind: 'merge', status: 'pending', created_at: '2020-01-01T00:00:00.000Z',
  }) });
}

for (const branch of ['main', 'external']) {
  test(`legacy request / explicit approval still crosses reservation and landing modules for ${branch}`, async () => {
    const f = fixture(); f.project.stopping = true; await repo(f.root);
    try {
      const baseline = await git(f.root, 'rev-parse', 'main');
      if (branch !== 'main') {
        await git(f.root, 'branch', branch);
        await f.project.bindBranch(branch, baseline);
      }
      const sent = await f.project.order('historical fixed-tip order', branch);
      const commit = await commitFile(sent.task.workspace, 'source.txt');
      await f.project.workspaces.finish(f.store.task(sent.task.id));
      legacyPending(f, sent.task.id);
      const booked = await f.project.reserveTask(sent.task.id, 'merge');
      expect(booked.reservation).toMatchObject({ version: 1, status: 'requested', commit, baseline });
      expect(f.store.task(sent.task.id).status).toBe('completed');
      expect(await git(f.root, 'rev-parse', branch)).toBe(baseline);
      expect(await f.project.recheckRequestedMerge(sent.task.id)).toBe('landable');
      expect(f.store.all("SELECT id FROM messages WHERE task_id=? AND signal_type='merge.requested'", sent.task.parent_id)).toHaveLength(1);
      await expect(f.project.approveReservedMerge(sent.task.id, baseline, baseline)).rejects.toThrow('does not match');
      const result = await f.project.approveReservedMerge(sent.task.id, commit, baseline);
      expect(result.task.integration).toBe('merged');
      expect(JSON.parse(result.task.reservation).status).toBe('integrated');
      expect(await git(f.root, 'rev-parse', branch)).toBe(commit);
      expect((await f.project.approveReservedMerge(sent.task.id, commit, baseline)).already_integrated).toBe(true);
      expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.merge_integrated'", sent.task.id)).toHaveLength(1);
    } finally { await f.close(); }
  });
}

test('legacy parent drift shares deduplicated diagnostics across recheck, branch advance and approval', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const sent = await f.project.order('historical requested order');
    const source = await commitFile(sent.task.workspace, 'source.txt');
    await f.project.workspaces.finish(f.store.task(sent.task.id));
    legacyPending(f, sent.task.id);
    const { reservation } = await f.project.reserveTask(sent.task.id, 'merge');
    const parent = await commitFile(f.root, 'parent.txt');
    f.store.update(sent.task.parent_id, { head_commit: parent });
    expect(await f.project.recheckRequestedMerge(sent.task.id)).toBe('parent_moved');
    expect(await f.project.noteBranchAdvance(sent.task.parent_id)).toBe(sent.task.id);
    await expect(f.project.approveReservedMerge(sent.task.id, source, reservation.baseline))
      .rejects.toThrow('parent branch moved');
    const booking = JSON.parse(f.store.task(sent.task.id).reservation);
    expect(booking.blocked_reason).toBe(parentMovedReason('main', parent, source));
    expect(booking.blocked_code).toBe('parent_moved');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.reservation_blocked'", sent.task.id)).toHaveLength(1);
    f.project.clearReservationBlocked(sent.task.id);
    const { blocked_reason, blocked_code, ...fixed } = booking;
    expect(JSON.parse(f.store.task(sent.task.id).reservation)).toEqual(fixed);
    expect(f.project.unreserveTask(sent.task.id)).toMatchObject({ changed: true, withdrawn: fixed });
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.request_withdrawn'", sent.task.id)).toHaveLength(1);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
    expect(await git(f.root, 'rev-parse', sent.task.branch)).toBe(source);
  } finally { await f.close(); }
});

test('owner analysis still creates a detached private checkout at the exact owner tip without invoking Agent', async () => {
  const f = fixture({ async run() { throw new Error('unexpected Agent invocation'); } });
  f.project.stopping = true; await repo(f.root);
  try {
    const owner = await f.project.ensureMainTask();
    const result = await f.project.analyze(owner.id, '只读解释当前分支');
    const task = f.store.task(result.task.id);
    expect(task).toMatchObject({ task_kind: 'analysis', parent_id: owner.id, branch: null,
      target_branch: 'main', base_commit: owner.head_commit, status: 'queued', calls: 0 });
    expect(await git(task.baseline_workspace, 'rev-parse', 'HEAD')).toBe(owner.head_commit);
    await expect(git(task.baseline_workspace, 'symbolic-ref', '--short', 'HEAD')).rejects.toThrow('not a symbolic ref');
    expect(f.store.task(owner.id)).toMatchObject({ status: 'waiting', calls: 0 });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(owner.head_commit);
  } finally { await f.close(); }
});

test('legacy terminal order repair retains both fixed tips and reissues one request without parent Git writes', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const sent = await f.project.order('historical diverged order');
    const source = await commitFile(sent.task.workspace, 'source.txt');
    await f.project.workspaces.finish(f.store.task(sent.task.id));
    legacyPending(f, sent.task.id);
    const parent = await commitFile(f.root, 'parent.txt');
    expect((await f.project.reserveTask(sent.task.id, 'merge')).reservation.blocked_code).toBe('diverged');
    // Existing terminal records remain eligible for the historical independent repair path.
    f.store.update(sent.task.id, { status: 'completed' });
    const requested = await f.project.resolveOrderDivergence(sent.task.id);
    expect(requested).toMatchObject({ status: 'queued', source_commit: source, parent_commit: parent });
    const repair = f.store.task(requested.task.id);
    expect(repair).toMatchObject({ parent_id: sent.task.parent_id, resolves_task_id: sent.task.id,
      base_commit: source, target_branch: sent.task.branch });
    expect((await f.project.resolveOrderDivergence(sent.task.id)).task.id).toBe(repair.id);
    const cwd = await f.project.workspaces.ensure(repair);
    await f.project.workspaces.finish(f.store.task(repair.id));
    f.store.update(repair.id, { status: 'completed' });
    await expect(f.project.finalizeTerminalDivergence(repair.id)).rejects.toThrow('must contain both frozen commits');
    expect(await git(f.root, 'rev-parse', sent.task.branch)).toBe(source);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
    await git(cwd, 'merge', '--no-ff', '--no-edit', parent);
    await f.project.workspaces.finish(f.store.task(repair.id));
    const resolved = f.store.task(repair.id).head_commit;
    const landed = await f.project.finalizeTerminalDivergence(repair.id);
    expect(landed.reservation).toMatchObject({ version: 1, status: 'requested', commit: resolved, baseline: parent });
    expect(await git(f.root, 'rev-parse', sent.task.branch)).toBe(resolved);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(parent);
    expect(f.store.task(repair.id).integration).toBe('merged');
    expect(await f.project.finalizeTerminalDivergence(repair.id)).toBeNull();
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='task.merge_requested'", sent.task.id)).toHaveLength(1);
    await f.project.approveReservedMerge(sent.task.id, resolved, parent);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(resolved);
  } finally { await f.close(); }
});
