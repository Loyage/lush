import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { dialogButton } from '../dom-stub.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../../src/rpc/management-policy.js';
import { ui } from '../../src/ui/web/assets/state.js';
const world = makeWorld();
const methods = managementPermissionMethods();
const value = { version: 1, scope: 'project', revision: 'r1', groups: MANAGEMENT_GROUPS, methods, permissions: Object.fromEntries(methods.map(item => [item.method, item.access])) };
let reads = 0;
const dom = installDom({ fetch: (url, options) => String(url).endsWith('/api/management/permissions') ? (reads++, Response.json(value)) : world.fetchImpl(url, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
afterAll(() => dom.restore());
const btn = id => dom.node(id);
const edit = () => { const select = btn('detail').querySelectorAll('.valet-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select'); select.value = 'confirmation'; select.onchange(); };

test('project navigation opens lazy settings, selected chrome and repeat hash preserves expanded edits during refresh', async () => {
  await btn('valet-settings-open').onclick(); expect(dom.location.hash).toBe('#valet-settings'); expect(ui.view.id).toBe('valet-settings');
  expect(btn('view-title').textContent).toBe('管家设置'); expect(btn('valet-settings-open').getAttribute('aria-current')).toBe('page');
  const details = btn('detail').querySelector('details'); details.open = true; edit(); const count = reads;
  await dom.fire('hashchange'); expect(btn('detail').querySelector('details')).toBe(details); expect(details.open).toBe(true); expect(reads).toBe(count);
  await import('../../src/ui/web/assets/refresh.js').then(module => module.refresh()); expect(btn('detail').querySelector('details')).toBe(details);
});

test('project nav buttons, fallback back and browser hash routes respect dirty editor guard', async () => {
  for (const id of ['overview-open', 'inputs-open', 'hooks-open', 'task-graph-open', 'view-back']) {
    const leave = btn(id).onclick(); await dialogButton(dom, '取消').onclick(); await leave;
    expect(ui.view.id).toBe('valet-settings'); expect(dom.location.hash).toBe('#valet-settings');
  }
  dom.location.hash = '#workers'; const back = dom.fire('hashchange'); await dialogButton(dom, '取消').onclick(); await back;
  expect(ui.view.id).toBe('valet-settings'); expect(dom.location.hash).toBe('#valet-settings');
  const accepted = btn('hooks-open').onclick(); await dialogButton(dom, '丢弃并离开').onclick(); await accepted;
  expect(ui.view.id).toBe('hooks'); expect(ui.valetSettingsPage).toBeNull();
});

test('old management routes remain retired and lead to persistent Valet list not new editor', async () => {
  for (const hash of ['#management', '#management-history']) {
    dom.location.hash = hash; await dom.fire('hashchange'); expect(ui.view.id).toBe('valets'); expect(dom.location.hash).toBe('#valets');
    expect(btn('detail').querySelector('.valet-settings-page')).toBeNull(); expect(btn('error').textContent).toContain('设置入口已移除');
  }
});

test('global/no-project shell disables settings with project explanation and rejects manual settings hash without API read', async () => {
  const before = reads; dom.location.pathname = '/'; dom.location.hash = '#valet-settings'; await boot();
  expect(btn('valet-settings-open').disabled).toBe(true); expect(btn('valet-settings-open').getAttribute('aria-disabled')).toBe('true');
  expect(ui.view.id).toBe('unavailable'); expect(reads).toBe(before);
});
