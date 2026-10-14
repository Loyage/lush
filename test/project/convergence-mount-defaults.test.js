import { test, expect } from 'bun:test';
import { fixture, repo, git } from '../helpers.js';
import { CONVERGENCE_POLICY_PREFIX } from '../../src/core/convergence-contract.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  await repo(f.root); f.main = await f.project.ensureMainTask(); return f;
}
const saved = (f, branch) => JSON.parse(f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + branch).value);
const set = async (f, branch, mounted, enabled, validation = undefined) => f.project.setBranchConvergence(branch, enabled, validation, (await f.project.branchConvergence(branch)).revision, mounted);
const defaults = async (f, mounted, enabled) => f.project.setBranchConvergenceDefaults(mounted, enabled, f.project.branchConvergenceDefaults().revision);

test('main is mounted off once on real initialization; reads never install and removal survives bootstrap', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const main = f.store.create({ role: 'agent', task_kind: 'main', goal: 'historical main' });
    f.store.update(main.id, { branch: 'main', status: 'waiting' });
    expect((await f.project.branchConvergence('main')).mounted).toBe(false);
    expect(f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + 'main')).toBeNull();
    await f.project.ensureMainTask();
    expect((await f.project.branchConvergence('main'))).toMatchObject({ mounted: true, enabled: false });
    await set(f, 'main', false, false);
    const before = saved(f, 'main');
    await f.project.bootstrapMain(); await f.project.ensureMainTask();
    expect(saved(f, 'main')).toEqual(before);
    expect((await f.project.branchConvergence('main')).mounted).toBe(false);
  } finally { await f.close(); }
});

test('old saved policies are actual mounts, retain enabled and obsolete references, and are not overwritten at bootstrap', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const main = f.store.create({ role: 'agent', task_kind: 'main', goal: 'historical main' });
    f.store.update(main.id, { branch: 'main', status: 'waiting' });
    const value = { version: 1, owner_id: main.id, enabled: true, validation: { command_id: '00000000-0000-0000-0000-000000000001', command_version: 7 }, generation: 4 };
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', CONVERGENCE_POLICY_PREFIX + 'main', JSON.stringify(value));
    const before = await f.project.branchConvergence('main');
    expect(before).toMatchObject({ mounted: true, enabled: true, validation: { ...value.validation, name: null } });
    await f.project.bootstrapMain();
    expect(saved(f, 'main')).toEqual(value); expect((await f.project.branchConvergence('main')).revision).toBe(before.revision);
    const removed = await set(f, 'main', false, false);
    expect(removed).toMatchObject({ mounted: false, enabled: false, validation: { ...value.validation } });
    const remounted = await set(f, 'main', true, true);
    expect(remounted).toMatchObject({ mounted: true, enabled: true, validation: { ...value.validation } });
    expect(f.project.taskHooks(main.id).convergence).toEqual(await f.project.branchConvergence('main'));
  } finally { await f.close(); }
});

test('mount and enabled are independent, stale revisions fail, tombstones preserve history and internal unmounted policy is off', async () => {
  const f = await setup();
  try {
    const view = await f.project.branchConvergence('main');
    await expect(f.project.setBranchConvergence('main', true, undefined, view.revision, false)).rejects.toThrow('must be mounted');
    await expect(f.project.setBranchConvergence('main', false, undefined, view.revision, 'false')).rejects.toThrow('boolean');
    const enabled = await set(f, 'main', true, true);
    expect(enabled).toMatchObject({ mounted: true, enabled: true, validation: null });
    await expect(f.project.setBranchConvergence('main', false, undefined, view.revision, false)).rejects.toThrow('revision changed');
    const off = await set(f, 'main', true, false); expect(off.mounted).toBe(true);
    const removed = await set(f, 'main', false, false); expect(removed.enabled).toBe(false);
    const raw = saved(f, 'main');
    f.store.run('UPDATE meta SET value=? WHERE key=?', JSON.stringify({ ...raw, enabled: true }), CONVERGENCE_POLICY_PREFIX + 'main');
    expect(f.project.convergencePolicy('main')).toMatchObject({ mounted: false, enabled: false });
    expect(f.store.all("SELECT * FROM events WHERE type='branch.convergence_configured'")).toHaveLength(3);
    const hooks = f.project.taskHooks(f.main.id);
    expect(hooks.convergence).toEqual(await f.project.branchConvergence('main'));
    expect(hooks.mounts.some(m => /convergence/.test(m.id))).toBe(false);
  } finally { await f.close(); }
});

test('project defaults copy only on new order/child birth, not from parent or to existing Workers or owners', async () => {
  const f = await setup();
  try {
    const initial = f.project.branchConvergenceDefaults();
    expect(initial).toMatchObject({ version: 1, mounted: true, scope: 'user', enabled: false, editable: true, reason: null });
    expect((await f.project.branchConvergenceList()).defaults).toEqual(initial);
    expect(f.store.get('SELECT value FROM meta WHERE key=?', 'convergence_defaults:v1')).toBeNull();
    const first = (await f.project.order('first', 'main', [], null, false)).task;
    expect(f.project.convergencePolicy(first.branch)).toMatchObject({ mounted: true, enabled: false });
    await set(f, first.branch, true, true);
    await defaults(f, true, false);
    const child = await f.project.spawn(first.id, 'child');
    expect(f.project.convergencePolicy(child.branch)).toMatchObject({ mounted: true, enabled: false });
    expect(JSON.parse(child.auto_merge)).toMatchObject({ enabled: true, locked: true });
    expect(f.project.taskHooks(child.id).completion.locked).toBe(true);
    await defaults(f, true, true);
    expect(f.project.convergencePolicy(child.branch).enabled).toBe(false);
    const second = (await f.project.order('second', 'main', [], null, false)).task;
    const grandchild = await f.project.spawn(child.id, 'grandchild');
    for (const task of [second, grandchild]) {
      expect(f.project.convergencePolicy(task.branch)).toMatchObject({ mounted: true, enabled: true, validation: null });
      expect(f.project.taskHooks(task.id).convergence).toEqual(await f.project.branchConvergence(task.branch));
    }
    await defaults(f, false, true);
    expect(f.project.branchConvergenceDefaults()).toMatchObject({ mounted: false, enabled: true });
    const latest = (await f.project.order('not mounted', 'main', [], null, false)).task;
    const childLatest = await f.project.spawn(latest.id, 'not mounted child');
    for (const task of [latest, childLatest])
      expect(f.project.convergencePolicy(task.branch)).toMatchObject({ mounted: false, enabled: false });
    expect(f.project.convergencePolicy(second.branch).enabled).toBe(true);
    await git(f.root, 'branch', 'owner');
    const owner = await f.project.bindBranch('owner', await git(f.root, 'rev-parse', 'HEAD'));
    expect(f.project.convergencePolicy(owner.branch)).toMatchObject({ mounted: false, enabled: false });
    expect(f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + owner.branch)).toBeNull();
    const analysis = f.store.create({ role: 'agent', task_kind: 'analysis', goal: 'read only' });
    expect(f.project.taskHooks(analysis.id).convergence).toBeNull();
  } finally { await f.close(); }
});

test('default settings persist, compare-and-swap atomically, and obey project write gates', async () => {
  const f = await setup();
  try {
    const initial = f.project.branchConvergenceDefaults();
    for (const [mounted, enabled] of [[null,false], [true,'true']])
      await expect(f.project.setBranchConvergenceDefaults(mounted, enabled, initial.revision)).rejects.toThrow();
    const results = await Promise.allSettled([
      f.project.setBranchConvergenceDefaults(true, true, initial.revision),
      f.project.setBranchConvergenceDefaults(true, false, initial.revision),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.project.branchConvergenceDefaults()).toMatchObject({ mounted: true, enabled: true });
    const raw = f.store.get('SELECT value FROM meta WHERE key=?', 'convergence_defaults:v1').value;
    const { Project } = await import('../../src/core/project.js');
    const reloaded = new Project(f.config, f.store); reloaded.kick = () => {};
    expect(reloaded.branchConvergenceDefaults()).toEqual(f.project.branchConvergenceDefaults());
    await reloaded.shutdown();
    for (const key of ['clearing','settingsMigrationApplying','workerDeleteIds']) {
      f.project[key] = key === 'workerDeleteIds' ? new Set([999]) : true;
      expect(f.project.branchConvergenceDefaults().editable).toBe(false);
      await expect(defaults(f, false, false)).rejects.toThrow('in progress');
      f.project[key] = key === 'workerDeleteIds' ? new Set() : false;
    }
    expect(f.store.get('SELECT value FROM meta WHERE key=?', 'convergence_defaults:v1').value).toBe(raw);
  } finally { await f.close(); }
});

test('terminal and archived Workers do not expose editable automation; branch reads and writes require a real usable target', async () => {
  const f = await setup();
  try {
    const task = (await f.project.order('target availability', 'main', [], null, false)).task;
    const current = await set(f, task.branch, true, true), before = saved(f, task.branch);
    for (const status of ['completed','failed','cancelled']) {
      f.store.update(task.id, { status });
      expect(f.project.taskHooks(task.id).convergence).toBeNull();
      await expect(f.project.branchConvergence(task.branch)).rejects.toThrow('active branch owner');
      await expect(f.project.setBranchConvergence(task.branch, false, undefined, current.revision)).rejects.toThrow('active branch owner');
    }
    f.store.update(task.id, { status: 'paused' });
    for (const status of ['archived','deleted']) {
      f.store.run('UPDATE branches SET status=? WHERE branch=?', status, task.branch);
      expect(f.project.taskHooks(task.id).convergence).toBeNull();
      await expect(f.project.branchConvergence(task.branch)).rejects.toThrow('active branch owner');
      await expect(f.project.setBranchConvergence(task.branch, false, undefined, current.revision)).rejects.toThrow('active branch owner');
    }
    f.store.run('UPDATE branches SET status=? WHERE branch=?', 'active', task.branch);
    await git(f.root, 'worktree', 'remove', task.workspace);
    await git(f.root, 'branch', '-D', task.branch);
    await expect(f.project.branchConvergence(task.branch)).rejects.toThrow('real local branch');
    await expect(f.project.setBranchConvergence(task.branch, false, undefined, current.revision)).rejects.toThrow('real local branch');
    expect((await f.project.branchConvergenceList()).items.some(item => item.branch === task.branch)).toBe(false);
    expect(saved(f, task.branch)).toEqual(before);
  } finally { await f.close(); }
});

test('birth transaction rollback leaves no default policy rows when Worker creation fails', async () => {
  const f = await setup();
  try {
    await defaults(f, true, true);
    const before = f.store.all('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key', CONVERGENCE_POLICY_PREFIX + '%');
    const original = f.project.initializeNewWorkerConvergence.bind(f.project);
    f.project.initializeNewWorkerConvergence = (...args) => { original(...args); throw new Error('controlled birth failure'); };
    await expect(f.project.order('failed birth', 'main', [], null, false)).rejects.toThrow('controlled birth failure');
    expect(f.store.all('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key', CONVERGENCE_POLICY_PREFIX + '%')).toEqual(before);
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='order'")).toHaveLength(0);
    f.project.initializeNewWorkerConvergence = original;
    const parent = (await f.project.order('parent', 'main', [], null, false)).task;
    const after = f.store.all('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key', CONVERGENCE_POLICY_PREFIX + '%');
    f.project.initializeNewWorkerConvergence = (...args) => { original(...args); throw new Error('controlled child failure'); };
    await expect(f.project.spawn(parent.id, 'failed child')).rejects.toThrow('controlled child failure');
    expect(f.store.all('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key', CONVERGENCE_POLICY_PREFIX + '%')).toEqual(after);
    expect(f.store.children(parent.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test('branch setter rechecks project safety after waiting for asynchronous Git admission', async () => {
  const f = await setup();
  try {
    const current = await f.project.branchConvergence('main'), before = saved(f, 'main');
    const git = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = async (...args) => {
      const value = await git(...args);
      if (args.includes('for-each-ref')) f.project.settingsMigrationApplying = true;
      return value;
    };
    await expect(f.project.setBranchConvergence('main', true, undefined, current.revision)).rejects.toThrow('migration');
    expect(saved(f, 'main')).toEqual(before);
    f.project.settingsMigrationApplying = false;
  } finally { await f.close(); }
});

test('deferred creation uses defaults at actual emission, not at reservation', async () => {
  const f = await setup();
  try {
    const freeze = f.project.branchFreeze.bind(f.project); let frozen = true;
    f.project.branchFreeze = branch => frozen && branch === 'main' ? { reason: 'controlled freeze' } : freeze(branch);
    const reserved = await f.project.order('deferred', 'main', [], null, false, undefined, null, true);
    expect(reserved.deferred).toBe(true);
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='order'")).toHaveLength(0);
    await defaults(f, true, true); frozen = false;
    f.project.emitTaskHook(reserved.parent_id, 'worker.parent_ready');
    await f.project.hookQueue;
    const created = f.store.all("SELECT * FROM tasks WHERE task_kind='order'");
    expect(created).toHaveLength(1);
    expect(f.project.convergencePolicy(created[0].branch)).toMatchObject({ mounted: true, enabled: true });
  } finally { await f.close(); }
});
