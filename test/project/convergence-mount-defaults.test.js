import { test, expect } from 'bun:test';
import { fixture, repo, git } from '../helpers.js';
import { historicalConvergencePolicy } from '../convergence-fixtures.js';
import { CONVERGENCE_POLICY_PREFIX } from '../../src/core/convergence-contract.js';

const policies = f => f.store.all('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key', CONVERGENCE_POLICY_PREFIX + '%');
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  await repo(f.root); f.main = await f.project.ensureMainTask(); return f;
}

test('main initialization/bootstrap and pure reads never install retired policies or initialization markers', async () => {
  const f = await setup();
  try {
    expect(await f.project.branchConvergence('main')).toMatchObject({ mounted: false, enabled: false, retired: true, editable: false });
    await f.project.bootstrapMain(); await f.project.ensureMainTask();
    f.project.hooksList(); f.project.taskHooks(f.main.id); await f.project.branchConvergenceList();
    expect(policies(f)).toEqual([]);
    expect(f.store.get("SELECT value FROM meta WHERE key='convergence_main_initialized:v1'")).toBeNull();
    expect(f.project.branchConvergenceDefaults()).toMatchObject({ mounted: false, scope: 'none', enabled: false, retired: true });
    expect(f.store.get("SELECT value FROM meta WHERE key='convergence_defaults:v1'")).toBeNull();
  } finally { await f.close(); }
});

for (const mounted of [undefined, true, false]) test(`bootstrap preserves historical policy verbatim, including mounted=${mounted}`, async () => {
  const f = await setup();
  try {
    const policy = historicalConvergencePolicy(f, f.main, { mounted, generation: 7,
      validation: { command_id: '00000000-0000-0000-0000-000000000001', command_version: 9 } });
    const before = policies(f), view = await f.project.branchConvergence('main');
    await f.project.bootstrapMain(); await f.project.ensureMainTask();
    expect(policies(f)).toEqual(before);
    expect(await f.project.branchConvergence('main')).toEqual(view);
    expect(view).toMatchObject({ mounted: mounted ?? true, enabled: mounted ?? true, retired: true, editable: false,
      validation: { ...policy.validation, name: null } });
    expect(f.project.taskHooks(f.main.id).convergence).toEqual(view);
  } finally { await f.close(); }
});

for (const scope of [undefined, 'main', 'all', 'user', 'none']) test(`historical enabled defaults (${scope}) never mount new order/child/owner`, async () => {
  const f = await setup();
  try {
    const saved = JSON.stringify({ version: 1, mounted: scope !== 'none', enabled: true, generation: 4, scope });
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'convergence_defaults:v1', saved);
    historicalConvergencePolicy(f, f.main);
    const before = policies(f);
    const order = (await f.project.order('order', 'main', [], null, false)).task;
    const child = await f.project.spawn(order.id, 'child');
    const nested = (await f.project.order('nested order', order.branch, [], null, false)).task;
    const grandchild = await f.project.spawn(child.id, 'grandchild');
    await git(f.root, 'branch', 'owner');
    const owner = await f.project.bindBranch('owner', await git(f.root, 'rev-parse', 'HEAD'));
    for (const task of [order, child, nested, grandchild, owner]) {
      expect(f.project.convergencePolicy(task.branch)).toMatchObject({ mounted: false, enabled: false });
      expect(f.project.taskHooks(task.id).mounted_features.convergence).toBe(false);
    }
    expect(JSON.parse(child.auto_merge)).toMatchObject({ enabled: true, locked: true });
    expect(f.project.taskHooks(child.id).completion.locked).toBe(true);
    expect(policies(f)).toEqual(before);
    expect(f.store.get("SELECT value FROM meta WHERE key='convergence_defaults:v1'").value).toBe(saved);
    expect(f.project.branchConvergenceDefaults()).toMatchObject({ mounted: scope !== 'none', enabled: true, scope: scope ?? 'all', retired: true, editable: false });
  } finally { await f.close(); }
});

test('retired setters reject even no-op/concurrent writes and preserve legacy defaults, policies, events and reservations', async () => {
  const f = await setup();
  try {
    historicalConvergencePolicy(f, f.main);
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'convergence_defaults:v1', JSON.stringify({ version: 1, mounted: true, enabled: true, generation: 9 }));
    const before = f.store.all('SELECT * FROM meta ORDER BY key'), events = f.store.all('SELECT * FROM events');
    const view = await f.project.branchConvergence('main'), defaults = f.project.branchConvergenceDefaults();
    const writes = await Promise.allSettled([
      f.project.setBranchConvergence('main', true, undefined, view.revision),
      f.project.setBranchConvergence('main', false, null, view.revision, false),
      f.project.setBranchConvergenceDefaults(true, true, defaults.revision),
      f.project.setBranchConvergenceDefaults(false, false, defaults.revision, 'none'),
    ]);
    expect(writes.every(r => r.status === 'rejected' && r.reason.message.includes('retired'))).toBe(true);
    expect(f.store.all('SELECT * FROM meta ORDER BY key')).toEqual(before);
    expect(f.store.all('SELECT * FROM events')).toEqual(events);
  } finally { await f.close(); }
});

test('deferred birth ignores historical defaults changed after reservation without migrating them', async () => {
  const f = await setup();
  try {
    const freeze = f.project.branchFreeze.bind(f.project); let frozen = true;
    f.project.branchFreeze = branch => frozen && branch === 'main' ? { reason: 'controlled freeze' } : freeze(branch);
    const queued = await f.project.order('deferred', 'main', [], null, false, undefined, null, true);
    expect(queued.deferred).toBe(true);
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'convergence_defaults:v1', JSON.stringify({ version: 1, mounted: true, enabled: true, scope: 'all', generation: 5 }));
    frozen = false; f.project.emitTaskHook(queued.parent_id, 'worker.parent_ready'); await f.project.hookQueue;
    const created = f.store.all("SELECT * FROM tasks WHERE task_kind='order'");
    expect(created).toHaveLength(1); expect(f.project.convergencePolicy(created[0].branch).mounted).toBe(false);
    expect(policies(f)).toEqual([]);
  } finally { await f.close(); }
});
