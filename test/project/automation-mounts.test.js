import { test, expect } from 'bun:test';
import { fixture, repo, gate, git } from '../helpers.js';
import { CONVERGENCE_POLICY_PREFIX } from '../../src/core/convergence-contract.js';
import { Project } from '../../src/core/project.js';

const patch = (f, value) => f.project.setAutomationSettings(value, f.project.automationSettings().revision);
const hooks = (f, task) => f.project.taskHooks(task.id);
const defaults = (f, scope, enabled = false) => f.project.setBranchConvergenceDefaults(scope !== 'none', enabled, f.project.branchConvergenceDefaults().revision, scope);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root); return f;
}

for (const scope of ['main','all','user','none']) test(`birth freezes real ${scope} mounts; child completion is always locked and defaults never inherit`, async () => {
  const f = await setup();
  try {
    patch(f, { completion_defaults: { enabled: true, level: 'accept' }, mount_scopes: { completion: scope, acceptance_notice: scope } });
    await defaults(f, scope);
    const order = (await f.project.order('order', null, [], null, false)).task;
    const child = await f.project.spawn(order.id, 'child');
    const orderMounted = ['all','user'].includes(scope), childMounted = scope === 'all';
    expect(hooks(f, order).mounted_features).toEqual({ completion: orderMounted, acceptance_notice: orderMounted, convergence: orderMounted, push: false });
    expect(hooks(f, order).completion.level).toBe(orderMounted ? 'accept' : 'off');
    expect(hooks(f, order).acceptance_notice.enabled).toBe(orderMounted);
    expect(hooks(f, child).mounted_features).toEqual({ completion: true, acceptance_notice: childMounted, convergence: childMounted, push: false });
    expect(hooks(f, child).completion).toMatchObject({ level: 'merge', locked: true, editable: false });
    expect(hooks(f, child).acceptance_notice.enabled).toBe(false);
    for (const enabled of [false,true]) await expect(f.project.setTaskAutoMerge(child.id, enabled)).rejects.toThrow('锁定');
    for (const level of ['off','merge','accept']) await expect(f.project.setTaskCompletion(child.id, level, hooks(f, child).revision)).rejects.toThrow('锁定');
    const rows = [order, child].map(t => f.store.task(t.id)), revisions = [order, child].map(t => hooks(f, t).revision);
    patch(f, { mount_scopes: { completion: 'none', acceptance_notice: 'none' }, display_principles: { completion: 'main', convergence: 'main' } });
    await defaults(f, 'none');
    expect([order, child].map(t => f.store.task(t.id))).toEqual(rows);
    expect([order, child].map(t => hooks(f, t).revision)).toEqual(revisions);
    const nestedOrder = (await f.project.order('independent order', order.branch, [], null, false)).task;
    expect(hooks(f, nestedOrder).mounted_features).toMatchObject({ completion: false, acceptance_notice: false, convergence: false });
    expect(hooks(f, nestedOrder).mounts.some(m => ['auto-merge','auto-accept'].includes(m.id))).toBe(false);
    expect(hooks(f, nestedOrder).mounts.find(m => m.id === 'delivery-handler').actions[0].strategy).toBe('serial');
  } finally { await f.close(); }
});

test('unmounted features become actual mounts only through existing safe explicit enabling; stale/frozen writes stay rejected', async () => {
  const f = await setup();
  try {
    patch(f, { mount_scopes: { completion: 'none', acceptance_notice: 'none' } });
    const one = (await f.project.order('completion', null, [], null, false)).task;
    const before = hooks(f, one);
    const enabled = await f.project.setTaskCompletion(one.id, 'merge', before.revision);
    expect(enabled.mounted_features.completion).toBe(true); expect(enabled.completion.level).toBe('merge');
    expect(enabled.revision).not.toBe(before.revision);
    expect(enabled.mounts.find(m => m.id === 'auto-merge').enabled).toBe(true);
    await expect(f.project.setTaskCompletion(one.id, 'accept', before.revision)).rejects.toThrow('revision');
    const off = await f.project.setTaskCompletion(one.id, 'off', enabled.revision);
    expect(off.mounted_features.completion).toBe(true);
    const two = (await f.project.order('legacy auto_merge switch', null, [], null, false)).task;
    await f.project.setTaskAutoMerge(two.id, true);
    expect(hooks(f, two).mounted_features.completion).toBe(true);
    expect(hooks(f, two).completion.level).toBe('merge');
    const child = await f.project.spawn(two.id, 'unmounted child notice');
    const noticeBefore = hooks(f, child);
    const noticeOn = f.project.setTaskAcceptanceNotice(child.id, true, noticeBefore.revision);
    expect(noticeOn.mounted_features.acceptance_notice).toBe(true); expect(noticeOn.acceptance_notice.enabled).toBe(true);
    expect(noticeOn.revision).not.toBe(noticeBefore.revision);
    expect(() => f.project.setTaskAcceptanceNotice(child.id, false, noticeBefore.revision)).toThrow('revision');
    f.store.update(child.id, { reservation: JSON.stringify({ version: 2, status: 'requested', kind: 'merge' }) });
    const frozen = hooks(f, child), raw = f.store.task(child.id).auto_merge;
    expect(() => f.project.setTaskAcceptanceNotice(child.id, false, frozen.revision)).toThrow('冻结');
    expect(f.store.task(child.id).auto_merge).toBe(raw);
  } finally { await f.close(); }
});

test('legacy missing birth metadata and defaults are read without rewriting enabled authorization, receipts or revisions', async () => {
  const f = await setup(); let restarted;
  try {
    const order = (await f.project.order('old enabled', null, [], null, false)).task;
    await f.project.setTaskCompletion(order.id, 'accept', hooks(f, order).revision);
    const config = JSON.parse(f.store.task(order.id).auto_merge); delete config.mounted_features;
    f.store.update(order.id, { auto_merge: JSON.stringify(config) });
    const saved = { version: 1, mounted: true, enabled: true, generation: 7 };
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'convergence_defaults:v1', JSON.stringify(saved));
    const initial = f.project.automationSettings();
    const legacySettings = { ...initial }; delete legacySettings.revision; delete legacySettings.mount_scopes;
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'project_automation_settings', JSON.stringify(legacySettings));
    const facts = ['tasks','events','meta'].map(table => f.store.all(`SELECT * FROM ${table}`));
    const oldRevision = hooks(f, order).revision;
    expect(hooks(f, order)).toMatchObject({ mounted_features: { completion: true, acceptance_notice: true }, completion: { level: 'accept' } });
    expect(f.project.automationSettings().mount_scopes).toEqual({ completion: 'all', acceptance_notice: 'all' });
    expect(f.project.branchConvergenceDefaults()).toMatchObject({ scope: 'all', mounted: true, enabled: true });
    restarted = new Project(f.config, f.store); restarted.kick = () => {};
    expect(restarted.taskHooks(order.id).revision).toBe(oldRevision);
    expect(['tasks','events','meta'].map(table => f.store.all(`SELECT * FROM ${table}`))).toEqual(facts);
    patch(f, { mount_scopes: { completion: 'none', acceptance_notice: 'none' } });
    expect(hooks(f, order).revision).toBe(oldRevision);
    const child = await f.project.spawn(order.id, 'legacy defaults all');
    expect(hooks(f, child).mounted_features.convergence).toBe(true); expect(hooks(f, child).convergence.enabled).toBe(true);
    f.store.run('UPDATE meta SET value=? WHERE key=?', JSON.stringify({ ...saved, mounted: false }), 'convergence_defaults:v1');
    expect(f.project.branchConvergenceDefaults()).toMatchObject({ scope: 'none', mounted: false, enabled: true });
    expect(f.store.get('SELECT value FROM meta WHERE key=?', 'convergence_defaults:v1').value).toBe(JSON.stringify({ ...saved, mounted: false }));
  } finally { await restarted?.shutdown(); await f.close(); }
});

test('new project defaults are user mounts disabled; push identity and convergence are real mounts and deletion never reinstalls', async () => {
  const f = await setup();
  try {
    expect(f.project.branchConvergenceDefaults()).toMatchObject({ mounted: true, scope: 'user', enabled: false });
    const order = (await f.project.order('new order', null, [], null, false)).task, main = f.store.task(order.parent_id);
    const child = await f.project.spawn(order.id, 'new child');
    expect(hooks(f, order).mounted_features.convergence).toBe(true);
    expect(hooks(f, child).mounted_features.convergence).toBe(false);
    await f.project.bootstrapMain();
    const initial = hooks(f, main), identity = initial.push;
    expect(initial.mounted_features).toEqual({ completion: false, acceptance_notice: false, convergence: true, push: true });
    expect(initial.mounts.find(m => m.id === identity.hook_id).enabled).toBe(false);
    f.project.removeTaskHook(main.id, identity.hook_id, initial.revision);
    const removed = hooks(f, main);
    expect(removed.mounted_features.push).toBe(false); expect(removed.push).toEqual(identity);
    expect(removed.revision).not.toBe(initial.revision);
    await f.project.bootstrapMain();
    expect(hooks(f, main).mounted_features.push).toBe(false);
    const off = await f.project.setBranchConvergence('main', false, undefined, removed.convergence.revision, false);
    expect(off.mounted).toBe(false); expect(hooks(f, main).mounted_features.convergence).toBe(false);
    expect(hooks(f, main).revision).not.toBe(removed.revision);
    const raw = f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + 'main').value;
    await f.project.ensureMainTask(); f.project.hooksList(); hooks(f, main);
    expect(f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + 'main').value).toBe(raw);
    const unexpected = f.store.create({ task_kind: 'management', role: 'manager', goal: 'internal' });
    expect(hooks(f, unexpected).mounted_features).toEqual({ completion: false, acceptance_notice: false, convergence: false, push: false });
  } finally { await f.close(); }
});

test('deferred creation freezes mount scopes at real birth, not at reservation, without installing early', async () => {
  const f = await setup();
  try {
    const freeze = f.project.branchFreeze.bind(f.project); let frozen = true;
    f.project.branchFreeze = branch => frozen && branch === 'main' ? { reason: 'controlled freeze' } : freeze(branch);
    patch(f, { completion_defaults: { enabled: true, level: 'accept' } });
    const queued = await f.project.order('reserved under all', 'main', [], null, false, undefined, null, true);
    expect(queued.deferred).toBe(true);
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind='order'")).toHaveLength(0);
    patch(f, { mount_scopes: { completion: 'none', acceptance_notice: 'none' } }); await defaults(f, 'none');
    frozen = false; f.project.emitTaskHook(queued.parent_id, 'worker.parent_ready'); await f.project.hookQueue;
    const created = f.store.all("SELECT * FROM tasks WHERE task_kind='order'");
    expect(created).toHaveLength(1);
    expect(hooks(f, created[0])).toMatchObject({ mounted_features: { completion: false, acceptance_notice: false, convergence: false },
      completion: { level: 'off' }, acceptance_notice: { enabled: false } });
    expect(JSON.parse(created[0].auto_merge)).toMatchObject({ enabled: false, mounted_features: { completion: false, acceptance_notice: false } });
  } finally { await f.close(); }
});

test('strict scopes, consistent mounted flag, CAS and omission preserve old API behavior; creation reads after async preparation', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const initial = f.project.automationSettings();
    for (const mount_scopes of [{}, { push: 'all' }, { completion: 'owner' }, { acceptance_notice: null }, { completion: true }])
      expect(() => f.project.setAutomationSettings({ mount_scopes }, initial.revision)).toThrow();
    const d = f.project.branchConvergenceDefaults();
    for (const scope of [null, false, '', 'owner']) await expect(f.project.setBranchConvergenceDefaults(true, false, d.revision, scope)).rejects.toThrow('scope');
    await expect(f.project.setBranchConvergenceDefaults(false, false, d.revision, 'user')).rejects.toThrow('match scope');
    await expect(f.project.setBranchConvergenceDefaults(true, false, d.revision, 'none')).rejects.toThrow('match scope');
    await defaults(f, 'none');
    await expect(f.project.setBranchConvergenceDefaults(true, false, d.revision, 'user')).rejects.toThrow('revision');
    await f.project.setBranchConvergenceDefaults(true, true, f.project.branchConvergenceDefaults().revision);
    expect(f.project.branchConvergenceDefaults().scope).toBe('all');
    const anchor = f.project.anchorInput.bind(f.project);
    f.project.anchorInput = async (...args) => { const value = await anchor(...args); entered.resolve(); await release.promise; return value; };
    const creating = f.project.order('late birth', null, [], null, false); await entered.promise;
    patch(f, { mount_scopes: { completion: 'none', acceptance_notice: 'none' } }); await defaults(f, 'user'); release.resolve();
    const task = (await creating).task;
    expect(hooks(f, task).mounted_features).toMatchObject({ completion: false, acceptance_notice: false, convergence: true });
    expect(await git(task.workspace, 'rev-parse', 'HEAD')).toBe(task.base_commit);
  } finally { release.resolve(); await f.close(); }
});
