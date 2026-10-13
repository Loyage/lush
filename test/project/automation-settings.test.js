import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { validateManagementCall, managementCatalog } from '../../src/rpc/management-policy.js';

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
