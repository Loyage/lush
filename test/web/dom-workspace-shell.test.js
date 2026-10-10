import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { configureWorkspaceShell, renderGlobalInboxSummary, workspaceLink } from '../../src/ui/web/assets/workspace-shell.js';
import { workspaceHref, isProjectWorkspace } from '../../src/ui/web/assets/route.js';
let dom;
beforeEach(() => { dom = installDom({ fetch: async () => { throw Error('network forbidden in shell fixture'); } }); });
afterEach(() => dom.restore());

test('root navigation belongs to user workspace even with a single bound project', () => {
  configureWorkspaceShell(); expect(isProjectWorkspace()).toBe(false);
  expect(dom.document.documentElement.dataset.lushSpace).toBe('global');
  expect(dom.node('project').textContent).toBe('用户工作台'); expect(dom.node('composer-shell').hidden).toBe(true);
  expect(dom.node('sidebar').getAttribute('aria-label')).toBe('用户工作台导航');
});

test('project global links are native new-tab links and preserve input, selection and reading position', async () => {
  dom.location.pathname = '/p/1111111111111111/'; const link = dom.document.createElement('a'); dom.byId.set('settings-open', link);
  dom.node('input').value = 'keep unsent input'; dom.node('detail').scrollTop = 123; dom.setSelection('quoted selection');
  let called = 0, prevented = 0; workspaceLink('settings-open', '#settings', () => called++); configureWorkspaceShell();
  await link.onclick({ preventDefault: () => prevented++ });
  expect(link.href).toBe('/#settings'); expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener');
  expect(called).toBe(0); expect(prevented).toBe(0); expect(dom.node('input').value).toBe('keep unsent input'); expect(dom.node('detail').scrollTop).toBe(123); expect(dom.window.getSelection().toString()).toBe('quoted selection');
  expect(dom.document.documentElement.dataset.lushSpace).toBe('project');
});

test('root ordinary click opens its view; modified click remains native', async () => {
  const link = dom.document.createElement('a'); dom.byId.set('settings-open', link);
  let called = 0, prevented = 0; workspaceLink('settings-open', '#settings', () => called++);
  await link.onclick({ preventDefault: () => prevented++ });
  await link.onclick({ ctrlKey: true, preventDefault: () => prevented++ });
  expect(called).toBe(1); expect(prevented).toBe(1); expect(link.href).toBe('/#settings');
});

test('partial or offline inbox counts are not advertised as complete or live', () => {
  renderGlobalInboxSummary({ open: 3, unread: 2, complete: false, projects: [{ id: '1111111111111111', online: false }] });
  expect(dom.node('global-inbox-count').textContent).toBe('5+'); expect(dom.node('global-inbox-count').getAttribute('aria-label')).toContain('未完整确认');
  expect(deepText(dom.node('global-inbox-summary'))).toContain('缓存不代表实时状态');
  expect(dom.node('global-inbox-summary').querySelector('a').href).toBe('/#notices');
  renderGlobalInboxSummary({ open: 0, unread: 0, complete: true, projects: [] }); expect(dom.node('global-inbox-summary').hidden).toBe(true);
});

test('global routes are origin-root hashes, never arbitrary external URLs', () => {
  expect(workspaceHref('#inbox-notice-1111111111111111-7')).toBe('/#inbox-notice-1111111111111111-7');
  expect(() => workspaceHref('https://outside.invalid')).toThrow(); expect(() => workspaceHref('#settings/../../secret')).toThrow();
});

test('entry HTML exposes independent global anchors and project-only work navigation', async () => {
  const html = await Bun.file(new URL('../../src/ui/web/assets/index.html', import.meta.url)).text();
  for (const id of ['projects-open', 'global-inbox-open', 'settings-open', 'automation-open']) expect(html).toMatch(new RegExp(`<a id="${id}" href="/#`));
  expect(html).toContain('data-project-navigation'); expect(html).toContain('quick-explain-history-open');
  expect(html).not.toContain('项目可覆盖'); expect(html).not.toContain('项目可按需覆盖');
});
