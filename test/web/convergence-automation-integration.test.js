import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { setup, fetch } from './harness.js';

// Exercise the same project and Worker controls over authenticated HTTP, RPC and SQLite.
// All resources belong to the temporary project and scheduling cannot invoke a model.
async function get(f, suffix) {
  const response = await fetch(f.url + suffix);
  const value = await response.json();
  if (response.status !== 200) throw new Error(`${suffix}: ${response.status}: ${value.error}`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return value;
}
async function action(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const value = await response.json();
  if (response.status !== status) throw new Error(`${method}: ${response.status}: ${value.error}`);
  return value;
}
const policy = (f, branch) => get(f, `/api/branch-convergence?branch=${encodeURIComponent(branch)}`);
const defaults = f => get(f, '/api/branch-convergence/defaults');
const hooks = (f, id) => get(f, `/api/worker/${id}/hooks`);
async function order(f, content) {
  return (await action(f, 'order.submit', { content, branch: 'main', start: false })).task;
}
async function fixture() {
  const f = await setup();
  f.project.kick = () => {};
  f.project.scheduleTaskMerge = () => {};
  f.project.scheduleConvergence = () => {};
  f.project.provider = { run() { throw new Error('automation integration must not call a model'); } };
  try {
    await repo(f.root);
    const main = await f.project.bootstrapMain();
    return { ...f, main };
  } catch (error) { await f.close(); throw error; }
}

test('project and main automation controls share one mount; removal survives initialization and reads do not install it', async () => {
  const f = await fixture();
  try {
    const initial = await policy(f, 'main');
    expect(initial).toMatchObject({ mounted: true, enabled: false, validation: null });
    expect((await hooks(f, f.main.id)).convergence).toEqual(initial);
    const enabled = await action(f, 'branch.convergence_set', { branch: 'main', mounted: true,
      enabled: true, expected_revision: initial.revision });
    expect(enabled).toMatchObject({ mounted: true, enabled: true, validation: null });
    const detail = await get(f, `/api/worker/${f.main.id}`);
    expect(detail.hooks.convergence).toEqual(enabled);
    const list = await get(f, '/api/branch-convergence');
    expect(list.items.find(item => item.branch === 'main')).toEqual(enabled);
    expect(list.defaults).toEqual(await defaults(f));
    await action(f, 'branch.convergence_set', { branch: 'main', mounted: true, enabled: false,
      expected_revision: initial.revision }, 400);
    const removed = await action(f, 'branch.convergence_set', { branch: 'main', mounted: false,
      enabled: false, expected_revision: enabled.revision });
    expect(removed).toMatchObject({ mounted: false, enabled: false });
    await action(f, 'branch.convergence_set', { branch: 'main', mounted: false, enabled: true,
      expected_revision: removed.revision }, 400);
    const events = f.store.get('SELECT count(*) AS n FROM events').n;
    expect((await hooks(f, f.main.id)).convergence).toEqual(removed);
    expect(await policy(f, 'main')).toEqual(removed);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    await f.project.bootstrapMain();
    expect(await policy(f, 'main')).toEqual(removed);
    const remounted = await action(f, 'branch.convergence_set', { branch: 'main', mounted: true,
      enabled: false, expected_revision: removed.revision });
    expect((await hooks(f, f.main.id)).convergence).toEqual(remounted);
  } finally { await f.close(); }
});

test('project defaults snapshot only future order and child target mounts, independently of their own completion authorization', async () => {
  const f = await fixture();
  try {
    const original = await defaults(f);
    expect(original).toMatchObject({ mounted: false, enabled: false });
    const old = await order(f, 'before automation defaults');
    const oldPolicy = await policy(f, old.branch);
    expect(oldPolicy).toMatchObject({ mounted: false, enabled: false });
    const enabledDefaults = await action(f, 'branch.convergence_defaults_set', { mounted: true,
      enabled: true, expected_revision: original.revision });
    expect(enabledDefaults).toMatchObject({ mounted: true, enabled: true });
    await action(f, 'branch.convergence_defaults_set', { mounted: false,
      enabled: false, expected_revision: original.revision }, 400);
    const parent = await order(f, 'after automation defaults');
    expect(await policy(f, parent.branch)).toMatchObject({ mounted: true, enabled: true, validation: null });
    expect((await hooks(f, parent.id)).completion.level).toBe('off');
    const child = await f.project.spawn(parent.id, 'child target defaults', undefined, [], 'target-defaults');
    expect((await hooks(f, child.id)).convergence).toMatchObject({ branch: child.branch, mounted: true, enabled: true });
    expect((await hooks(f, child.id)).completion).toMatchObject({ level: 'merge', locked: true, editable: false });
    expect(await policy(f, old.branch)).toEqual(oldPolicy);
    expect(await policy(f, 'main')).toMatchObject({ mounted: true, enabled: false });
    const disabledDefaults = await action(f, 'branch.convergence_defaults_set', { mounted: false,
      enabled: true, expected_revision: enabledDefaults.revision });
    expect(disabledDefaults).toMatchObject({ mounted: false, enabled: true });
    const latest = await order(f, 'after disabling default attachment');
    expect(await policy(f, latest.branch)).toMatchObject({ mounted: false, enabled: false });
    expect(await policy(f, parent.branch)).toMatchObject({ mounted: true, enabled: true });
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='integration'").n).toBe(0);
  } finally { await f.close(); }
});
