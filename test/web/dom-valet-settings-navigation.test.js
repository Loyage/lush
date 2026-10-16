import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { dialogButton } from '../dom-stub.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { MANAGEMENT_GROUPS, managementPermissionMethods } from '../../src/rpc/management-policy.js';
import { ui } from '../../src/ui/web/assets/state.js';
const world = makeWorld();
const methods = managementPermissionMethods();
const value = { version: 1, scope: 'device', configured: true, revision: 'r1', groups: MANAGEMENT_GROUPS, methods, permissions: Object.fromEntries(methods.map(item => [item.method, item.access])) };
let reads = 0;
const dom = installDom({ fetch: (url, options) => String(url).endsWith('/cli/catalog') ? Response.json(cliCatalog()) : String(url) === '/api/host/management/permissions' ? (reads++, Response.json(value)) : world.fetchImpl(url, options) });
// Stub DOM does not parse HTML: mirror the declared native global navigation.
const html = fs.readFileSync(new URL('../../src/ui/web/assets/index.html', import.meta.url), 'utf8');
expect(html).toMatch(/<nav[^>]*aria-label="CLI 接口学习"[^>]*data-global-navigation="true">\s*<a id="cli-interfaces-open" href="\/#cli-interfaces"/);
dom.node('cli-interfaces-open').tagName = 'A';
const cliNav = dom.document.createElement('nav'); cliNav.append(dom.node('cli-interfaces-open'));
dom.document.querySelectorAll = selector => selector === '[data-global-navigation="true"]' ? [cliNav] : [];
const { boot } = await import('../../src/ui/web/assets/app.js');
afterAll(() => dom.restore());
const btn = id => dom.node(id);
const edit = () => {
  const input = btn('detail').querySelector('input'); input.value = 'order'; input.oninput({});
  btn('detail').querySelector('.cli-command-link').onclick();
  const select = btn('detail').querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select'); select.value = 'confirmation'; select.onchange();
};

test('project CLI entry is hidden; both legacy project bookmarks preserve the project tab and link natively to global CLI', async () => {
  expect(btn('cli-interfaces-open').tagName).toBe('A');
  expect(btn('cli-interfaces-open').parentNode.hidden).toBe(true);
  expect(btn('cli-interfaces-open').href).toBe('/#cli-interfaces');
  expect(btn('cli-interfaces-open').target).toBe('_blank');
  btn('input').value = 'unsent project work';
  for (const hash of ['#cli-interfaces', '#valet-settings']) {
    dom.location.hash = hash; await dom.fire('hashchange');
    expect(ui.view.id).toBe('workspace-link'); expect(dom.location.hash).toBe(hash);
    expect(btn('detail').querySelector('.cli-interfaces-page')).toBeNull();
    const link = btn('detail').querySelector('a');
    expect(link.href).toBe(`/${hash}`); expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener');
    expect(link.onclick).toBeUndefined(); expect(btn('input').value).toBe('unsent project work');
    expect(reads).toBe(0);
  }
});

test('old management routes stay retired and lead to persistent Valet list, not new editor', async () => {
  for (const hash of ['#management', '#management-history']) {
    dom.location.hash = hash; await dom.fire('hashchange'); expect(ui.view.id).toBe('valets'); expect(dom.location.hash).toBe('#valets');
    expect(btn('view-hint').textContent).toBe('管理记录、执行与安全删除');
    expect(btn('detail').querySelector('.cli-interfaces-page')).toBeNull(); expect(btn('error').textContent).toContain('设置入口已移除');
  }
});

test('global legacy bookmark opens lazy CLI page; repeat hash and refresh retain expanded drafts without eager permission reads', async () => {
  dom.location.pathname = '/'; dom.location.hash = '#valet-settings'; await boot();
  expect(btn('cli-interfaces-open').parentNode.hidden).toBe(false);
  expect(ui.view.id).toBe('cli-interfaces'); expect(dom.location.hash).toBe('#cli-interfaces');
  expect(btn('view-title').textContent).toBe('CLI 接口'); expect(btn('view-context').textContent).toBe('用户工作台');
  expect(btn('cli-interfaces-open').getAttribute('aria-current')).toBe('page');
  expect(btn('view-hint').textContent).toBe('搜索与学习命令 · 此设备用户所有项目的管家权限');
  expect(deepText(btn('detail'))).toContain('所有项目后台离线也可配置'); expect(reads).toBe(0);
  await btn('detail').querySelectorAll('button').find(node => node.textContent === '读取全局权限').onclick();
  edit(); const details = btn('detail').querySelector('details'); details.open = true; const count = reads;
  await dom.fire('hashchange'); expect(btn('detail').querySelector('details')).toBe(details); expect(details.open).toBe(true); expect(reads).toBe(count);
  await btn('cli-interfaces-open').onclick(); expect(btn('detail').querySelector('details')).toBe(details);
  await import('../../src/ui/web/assets/refresh.js').then(module => module.refresh()); expect(btn('detail').querySelector('details')).toBe(details);
});

test('global navigation buttons, fallback back and browser hash respect dirty editor guard', async () => {
  for (const id of ['projects-open', 'settings-open', 'runners-open', 'automation-open', 'docs-open', 'view-back']) {
    const leave = btn(id).onclick(); await dialogButton(dom, '取消').onclick(); await leave;
    expect(ui.view.id).toBe('cli-interfaces'); expect(dom.location.hash).toBe('#cli-interfaces');
  }
  dom.location.hash = '#projects'; const back = dom.fire('hashchange'); await dialogButton(dom, '取消').onclick(); await back;
  expect(ui.view.id).toBe('cli-interfaces'); expect(dom.location.hash).toBe('#cli-interfaces');
  const accepted = btn('runners-open').onclick(); await dialogButton(dom, '丢弃并离开').onclick(); await accepted;
  expect(ui.view.id).toBe('runners'); expect(ui.valetSettingsPage).toBeNull(); expect(ui.runnersPage).toBeTruthy();
  const count = reads;
  await btn('cli-interfaces-open').onclick();
  expect(ui.view.id).toBe('cli-interfaces'); expect(ui.runnersPage).toBeNull(); expect(reads).toBe(count);
});
