import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {};
  await repo(f.root);
  f.base = await git(f.root, 'rev-parse', 'HEAD');
  await git(f.root, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'feature\n');
  await git(f.root, 'commit', '-am', 'feature');
  f.commit = await git(f.root, 'rev-parse', 'HEAD');
  await git(f.root, 'checkout', 'main');
  f.store.recordBranch({ branch: 'feature', parent: 'main', created_from_commit: f.base });
  return f;
}

/** A non-terminal worker task on the branch keeps full showcase eligibility pending. */
function block(f) {
  const task = f.store.create({ role: 'worker', goal: 'feature work' });
  f.store.update(task.id, { branch: 'feature' });
  return task;
}
const rawReservation = f => f.store.branch('feature').showcase_reservation;
const reservation = f => { const raw = rawReservation(f); return raw ? JSON.parse(raw) : null; };
const showcaseIds = f => f.store.all("SELECT id FROM tasks WHERE role='showcase' ORDER BY id").map(row => row.id);
const eventCount = (f, type) => f.store.get('SELECT count(*) AS value FROM events WHERE type=?', type).value;
const event = (f, type) => f.store.get('SELECT * FROM events WHERE type=? ORDER BY id DESC LIMIT 2', type);

test('reserve rejects branches outside the static reservable set', async () => {
  const f = await setup();
  try {
    await expect(f.project.reserveShowcase('unregistered')).rejects.toThrow('已登记');
    await expect(f.project.reserveShowcase('main')).rejects.toThrow('已登记');
    // A recorded branch without a recorded parent / fork point is not reservable.
    await git(f.root, 'branch', 'inferred', f.commit);
    f.store.recordBranch({ branch: 'inferred', parent: 'main', relation: 'inferred', created_from_commit: f.base });
    await expect(f.project.reserveShowcase('inferred')).rejects.toThrow('明确父分支和基线');
    await git(f.root, 'branch', 'nofork', f.commit);
    f.store.recordBranch({ branch: 'nofork', parent: 'main' });
    await expect(f.project.reserveShowcase('nofork')).rejects.toThrow('明确父分支和基线');
    // Archived branches are out even if the rest of the record is intact.
    f.store.run("UPDATE branches SET status='archived' WHERE branch='feature'");
    await expect(f.project.reserveShowcase('feature')).rejects.toThrow('归档或删除');
    f.store.run("UPDATE branches SET status='active' WHERE branch='feature'");
    // An already active showcase blocks new reservations (manual start uses the same rule).
    const running = f.store.create({ role: 'showcase', goal: 'running', showcase: { branch: 'feature', commit: f.commit, baseline_commit: f.base } });
    expect(f.project.showcaseReservable('feature').allowed).toBe(false);
    expect(f.project.showcaseReservable('feature').reason).toContain('still active');
    await expect(f.project.reserveShowcase('feature')).rejects.toThrow('still active');
    f.store.update(running.id, { status: 'completed' });
    expect(rawReservation(f)).toBeNull();
    expect(showcaseIds(f)).toHaveLength(1);
  } finally { await f.close(); }
});

test('reservation is idempotent while pending and clears on unreserve', async () => {
  const f = await setup();
  try {
    block(f);
    const first = await f.project.reserveShowcase('feature');
    expect(first).toMatchObject({ branch: 'feature', reserved: true, task_id: null });
    expect(first.reason).toContain('尚未成功完成');
    expect(reservation(f)).toMatchObject({ version: 1, status: 'pending' });
    expect(typeof reservation(f).created_at).toBe('string');
    const second = await f.project.reserveShowcase('feature');
    expect(second).toMatchObject({ branch: 'feature', reserved: true, task_id: null });
    expect(eventCount(f, 'showcase.reserved')).toBe(1);
    expect(eventCount(f, 'showcase.reservation_started')).toBe(0);
    expect(showcaseIds(f)).toHaveLength(0);
    const cleared = f.project.unreserveShowcase('feature');
    expect(cleared).toEqual({ branch: 'feature', reserved: false });
    expect(rawReservation(f)).toBeNull();
    expect(eventCount(f, 'showcase.unreserved')).toBe(1);
    // Idempotent: nothing to clear means no extra event.
    f.project.unreserveShowcase('feature');
    expect(eventCount(f, 'showcase.unreserved')).toBe(1);
    // Reservations are user/registration metadata only; no new business entity rows.
    expect(f.store.all('SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE ?', 'table', 'sqlite_%')
      .map(row => row.name)).not.toContain('showcase_reservations');
  } finally { await f.close(); }
});

test('a satisfied reservation starts one showcase automatically; later sweeps do not duplicate it', async () => {
  const f = await setup();
  try {
    const blocker = block(f);
    await f.project.reserveShowcase('feature');
    expect(reservation(f).status).toBe('pending');
    // Settling the only blocker re-kicks the sweep from within finish().
    f.project.finish(blocker.id, 'completed');
    await until(() => showcaseIds(f).length === 1);
    expect(rawReservation(f)).toBeNull();
    const task = f.store.task(showcaseIds(f)[0]);
    expect(JSON.parse(task.showcase).branch).toBe('feature');
    expect(eventCount(f, 'showcase.reserved')).toBe(1);
    expect(eventCount(f, 'showcase.reservation_started')).toBe(1);
    const started = event(f, 'showcase.reservation_started');
    expect(started.task_id).toBe(task.id);
    expect(typeof JSON.parse(started.data).created_at).toBe('string');
    expect(JSON.parse(started.data).branch).toBe('feature');
    // Extra triggers are harmless while the showcase exists and after it settles.
    await f.project.sweepShowcaseReservations();
    f.project.finish(task.id, 'completed');
    f.store.update(task.id, { status: 'completed' });
    await f.project.sweepShowcaseReservations();
    expect(showcaseIds(f)).toHaveLength(1);
  } finally { await f.close(); }
});

test('a reservation that never passes admission stays pending and creates nothing', async () => {
  const f = await setup();
  try {
    const blocker = block(f);
    const result = await f.project.reserveShowcase('feature');
    expect(result.reserved).toBe(true);
    expect(result.task_id).toBeNull();
    expect(result.reason).toContain('尚未成功完成');
    f.project.finish(blocker.id, 'failed');
    await until(() => f.project.showcaseSweeping === false);
    await f.project.sweepShowcaseReservations();
    expect(showcaseIds(f)).toHaveLength(0);
    expect(reservation(f).status).toBe('pending');
    f.project.unreserveShowcase('feature');
    expect(rawReservation(f)).toBeNull();
  } finally { await f.close(); }
});

test('manual showcase.start consumes a pending reservation without bypassing admission', async () => {
  const f = await setup();
  try {
    const blocker = block(f);
    await f.project.reserveShowcase('feature');
    // Freeze the static gate without triggering a sweep, then start by hand.
    f.store.update(blocker.id, { status: 'completed' });
    const task = await f.project.startShowcase('feature');
    expect(task.role).toBe('showcase');
    expect(rawReservation(f)).toBeNull();
    expect(eventCount(f, 'showcase.reservation_started')).toBe(1);
    // Manually starting again cannot duplicate the still-running showcase.
    await expect(f.project.startShowcase('feature')).rejects.toThrow('still active');
  } finally { await f.close(); }
});

test('recover rescans reservations that became eligible while the daemon was down', async () => {
  const f = await setup();
  try {
    const blocker = block(f);
    await f.project.reserveShowcase('feature');
    // Simulate a completed settlement that happened without re-running the sweep.
    f.store.update(blocker.id, { status: 'completed' });
    expect(showcaseIds(f)).toHaveLength(0);
    f.project.recover();
    await until(() => showcaseIds(f).length === 1);
    expect(rawReservation(f)).toBeNull();
    expect(eventCount(f, 'showcase.reservation_started')).toBe(1);
  } finally { await f.close(); }
});

test('archiving and deleting a branch cancel its reservation', async () => {
  const f = await setup();
  try {
    const blocker = block(f);
    f.store.update(blocker.id, { status: 'failed' });
    await f.project.reserveShowcase('feature');
    expect(reservation(f).status).toBe('pending');
    const outcome = await f.project.archiveBranch('feature');
    expect(outcome.archived).toBe(true);
    expect(rawReservation(f)).toBeNull();
    expect(eventCount(f, 'showcase.unreserved')).toBe(1);
    expect(f.store.branch('feature').status).toBe('archived');
  } finally { await f.close(); }
});

test('markBranchDeleted clears a reservation in place (task cleanup path)', async () => {
  const f = await setup();
  try {
    block(f);
    await f.project.reserveShowcase('feature');
    expect(reservation(f).status).toBe('pending');
    f.store.markBranchDeleted('feature');
    expect(rawReservation(f)).toBeNull();
    expect(f.store.branch('feature').status).toBe('deleted');
    expect(eventCount(f, 'showcase.unreserved')).toBe(1);
  } finally { await f.close(); }
});

test('graph branch nodes carry the reservation increment with unchanged fields', async () => {
  const f = await setup();
  try {
    block(f);
    expect((await f.project.graph()).nodes.find(node => node.name === 'feature').showcase).toMatchObject({
      allowed: false, reserve_allowed: true, reserve_reason: null, reserved: false, reserved_at: null });
    await f.project.reserveShowcase('feature');
    const before = event(f, 'showcase.reserved');
    const node = (await f.project.graph()).nodes.find(row => row.name === 'feature');
    expect(node.showcase.allowed).toBe(false);
    expect(node.showcase.reserve_allowed).toBe(true);
    expect(node.showcase.reserve_reason).toBeNull();
    expect(node.showcase.reserved).toBe(true);
    expect(node.showcase.reserved_at).toBe(reservation(f).created_at);
    expect(node.showcase.latest_task_id).toBeNull();
    expect(typeof node.showcase.reason).toBe('string');
    expect(before.task_id).toBeNull();
  } finally { await f.close(); }
});

test('reserve/unreserve are registered as user-only RPC methods', () => {
  expect(PARAMS['showcase.reserve']).toEqual(['branch']);
  expect(PARAMS['showcase.unreserve']).toEqual(['branch']);
  expect(USER_ONLY.has('showcase.reserve')).toBe(true);
  expect(USER_ONLY.has('showcase.unreserve')).toBe(true);
});
