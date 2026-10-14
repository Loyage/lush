import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { validateManagementCall, managementCatalog } from '../../src/rpc/management-policy.js';
import { builtinAutomationMounted } from '../../src/core/automation-scopes.js';

 test('old Workers read safe notice defaults without rewriting authorization or history; lifecycle and reclamation gates are enforced', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const order = (await f.project.order('order', null, [], null, false)).task;
    const child = await f.project.spawn(order.id, 'child');
    for (const [task, enabled] of [[order, true], [child, false]]) {
      const old = JSON.parse(f.store.task(task.id).auto_merge); delete old.acceptance_notice;
      f.store.update(task.id, { auto_merge: JSON.stringify(old) });
      const row = f.store.task(task.id), events = f.store.history(task.id);
      expect(f.project.taskHooks(task.id).acceptance_notice).toMatchObject({ enabled, editable: true });
      expect(f.store.task(task.id)).toEqual(row); expect(f.store.history(task.id)).toEqual(events);
    }
    const before = f.store.task(child.id).auto_merge;
    f.project.acceptanceBusy = new Set([child.id]);
    const busy = f.project.taskHooks(child.id);
    expect(busy.acceptance_notice.editable).toBe(false);
    expect(() => f.project.setTaskAcceptanceNotice(child.id, true, busy.revision)).toThrow('安全收尾');
    expect(f.store.task(child.id).auto_merge).toBe(before);
    f.project.acceptanceBusy.clear();
    f.store.update(child.id, { status: 'cancelled' });
    const ended = f.project.taskHooks(child.id);
    expect(() => f.project.setTaskAcceptanceNotice(child.id, true, ended.revision)).toThrow('结束');
    expect(f.store.task(child.id).auto_merge).toBe(before);
  } finally { await f.close(); }
});

test('historical say retains notice capability and existing normalized order authorization without migrating reads or replaying notices', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const order = (await f.project.order('historical say', null, [], null, false)).task;
    await f.project.setTaskCompletion(order.id, 'accept', f.project.taskHooks(order.id).revision);
    const legacyConfig = JSON.parse(f.store.task(order.id).auto_merge);
    delete legacyConfig.mounted_features; delete legacyConfig.acceptance_notice;
    f.store.run("UPDATE tasks SET task_kind='say',auto_merge=? WHERE id=?", JSON.stringify(legacyConfig), order.id);
    const raw = () => f.store.db.query('SELECT * FROM tasks WHERE id=?').get(order.id);
    const before = raw(), events = f.store.history(order.id);
    const original = f.project.taskHooks(order.id);
    expect(original).toMatchObject({ mounted_features: { acceptance_notice: true, completion: true },
      acceptance_notice: { enabled: true }, completion: { level: 'accept' } });
    // Store's pre-existing say->order normalization remains the source of completion availability.
    expect(f.store.task(order.id).task_kind).toBe('order');
    expect(builtinAutomationMounted(before, 'acceptance_notice')).toBe(true);
    expect(builtinAutomationMounted(before, 'completion')).toBe(false);
    expect(f.project.acceptanceNoticeView(before).enabled).toBe(true);
    f.project.taskHooks(order.id); f.project.hooksList();
    expect(raw()).toEqual(before); expect(f.store.history(order.id)).toEqual(events);
    f.project.setAutomationSettings({ mount_scopes: { completion: 'none', acceptance_notice: 'none' } }, f.project.automationSettings().revision);
    expect(f.project.taskHooks(order.id).revision).toBe(original.revision); expect(raw()).toEqual(before);
    // A legacy merge-only authorization keeps its real awaiting-acceptance reminder.
    const mergeOnly = { ...legacyConfig, level: 'merge' };
    f.store.update(order.id, { auto_merge: JSON.stringify(mergeOnly), status: 'awaiting_acceptance' });
    const source = f.store.event(order.id, 'task.delivered', { no_changes: true });
    const notice = f.project.notifyAcceptanceEntry(order.id, source);
    expect(notice).toMatchObject({ kind: 'info', source_event_id: source });
    expect(notice.title).toContain('待验收');
    expect(f.project.notifyAcceptanceEntry(order.id, source)).toBeNull();
    const closed = f.project.setTaskAcceptanceNotice(order.id, false, f.project.taskHooks(order.id).revision);
    expect(closed).toMatchObject({ mounted_features: { acceptance_notice: true }, acceptance_notice: { enabled: false } });
    f.store.event(order.id, 'task.iteration_started', {});
    const nextSource = f.store.event(order.id, 'task.delivered', { no_changes: true });
    expect(f.project.notifyAcceptanceEntry(order.id, nextSource)).toBeNull();
    const reopened = f.project.setTaskAcceptanceNotice(order.id, true, f.project.taskHooks(order.id).revision);
    expect(reopened.mounted_features.acceptance_notice).toBe(true);
    expect(f.project.notifyAcceptanceEntry(order.id, nextSource)).toBeNull();
    expect(raw().task_kind).toBe('say'); expect(raw().branch).toBe(before.branch); expect(raw().workspace).toBe(before.workspace);
    expect(JSON.parse(raw().auto_merge).level).toBe('merge');
    expect(f.store.all("SELECT * FROM notices WHERE task_id=? AND source_event_id=?", order.id, source)).toHaveLength(1);
  } finally { await f.close(); }
});

test('management discovery keeps project aliases and new user-only settings distinct from device automatic selection', () => {
  const catalog = managementCatalog();
  for (const method of ['hooks.automation_settings','worker.acceptance_notice']) {
    expect(catalog.methods.find(item => item.method === method).access).toBe('unavailable');
    expect(() => validateManagementCall(method, {}, 'configure project')).toThrow('用户界面');
  }
  expect(validateManagementCall('hooks.completion_defaults', { enabled: true, level: 'merge', expected_revision: 'read' }, 'project defaults').access).toBe('confirmation');
  expect(() => validateManagementCall('hooks.completion_defaults', { enabled: true, level: 'merge', expected_revision: 'read', scope: 'device' }, 'device defaults')).toThrow('unknown management parameter');
  expect(() => validateManagementCall('hooks.auto_select', { enabled: false, expected_revision: 'read' }, 'project')).toThrow('explicit scope');
});
