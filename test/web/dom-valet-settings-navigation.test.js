import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { dialogButton } from '../dom-stub.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../../src/rpc/management-policy.js';
import { ui } from '../../src/ui/web/assets/state.js';
const world = makeWorld();
const methods = managementPermissionMethods();
const value = { version: 1, scope: 'project', revision: 'r1', groups: MANAGEMENT_GROUPS, methods, permissions: Object.fromEntries(methods.map(item => [item.method, item.access])) };
let reads = 0;
const dom = installDom({ fetch: (url, options) => String(url).endsWith('/cli/catalog') ? Response.json(cliCatalog()) : String(url).endsWith('/api/management/permissions') ? (reads++, Response.json(value)) : world.fetchImpl(url, options) });
const { boot } = await import('../../src/ui/web/assets/app.js');
afterAll(() => dom.restore());
const btn = id => dom.node(id);
const edit = () => {
  const input = btn('detail').querySelector('input'); input.value = 'order'; input.oninput({});
  btn('detail').querySelector('.cli-command-link').onclick();
  const select = btn('detail').querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select'); select.value = 'confirmation'; select.onchange();
};

test('project navigation opens lazy CLI page, selected chrome and repeat hash retains expanded edits during refresh', async () => {
  await btn('cli-interfaces-open').onclick(); expect(dom.location.hash).toBe('#cli-interfaces'); expect(ui.view.id).toBe('cli-interfaces');
  expect(btn('view-title').textContent).toBe('CLI 接口'); expect(btn('cli-interfaces-open').getAttribute('aria-current')).toBe('page');
  expect(reads).toBe(0);
  await btn('detail').querySelectorAll('button').find(node => node.textContent === '读取项目权限').onclick();
  edit(); const details = btn('detail').querySelector('details'); details.open = true; const count = reads;
  await dom.fire('hashchange'); expect(btn('detail').querySelector('details')).toBe(details); expect(details.open).toBe(true); expect(reads).toBe(count);
  await import('../../src/ui/web/assets/refresh.js').then(module => module.refresh()); expect(btn('detail').querySelector('details')).toBe(details);
});

test('project nav buttons, fallback back and browser hash respect dirty editor guard', async () => {
  for (const id of ['overview-open', 'inputs-open', 'hooks-open', 'task-graph-open', 'view-back']) {
    const leave = btn(id).onclick(); await dialogButton(dom, '取消').onclick(); await leave;
    expect(ui.view.id).toBe('cli-interfaces'); expect(dom.location.hash).toBe('#cli-interfaces');
  }
  dom.location.hash = '#workers'; const back = dom.fire('hashchange'); await dialogButton(dom, '取消').onclick(); await back;
  expect(ui.view.id).toBe('cli-interfaces'); expect(dom.location.hash).toBe('#cli-interfaces');
  const accepted = btn('hooks-open').onclick(); await dialogButton(dom, '丢弃并离开').onclick(); await accepted;
  expect(ui.view.id).toBe('hooks'); expect(ui.valetSettingsPage).toBeNull();
});

test('old management routes stay retired and lead to persistent Valet list, not new editor', async () => {
  for (const hash of ['#management', '#management-history']) {
    dom.location.hash = hash; await dom.fire('hashchange'); expect(ui.view.id).toBe('valets'); expect(dom.location.hash).toBe('#valets');
    expect(btn('view-hint').textContent).toBe('管理记录、执行与安全删除');
    expect(btn('detail').querySelector('.cli-interfaces-page')).toBeNull(); expect(btn('error').textContent).toContain('设置入口已移除');
  }
});

test('old settings bookmark redirects; global/no-project CLI browsing never reads project defaults', async () => {
  const before = reads; dom.location.pathname = '/'; dom.location.hash = '#valet-settings'; await boot();
  expect(btn('cli-interfaces-open').disabled).toBe(false); expect(ui.view.id).toBe('cli-interfaces'); expect(dom.location.hash).toBe('#cli-interfaces'); expect(reads).toBe(before);
  expect(deepText(btn('detail'))).toContain('当前没有项目');
});
