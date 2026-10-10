import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { openWorkspaceAutomation } from '../../src/ui/web/assets/render-workspace-automation.js';
import { openHooks } from '../../src/ui/web/assets/render-hooks.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { ui } from '../../src/ui/web/assets/state.js';
let dom, model, posts, reads, failWrite, failRead, override;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  model = { version: 1, revision: 'r1', auto_select: { enabled: false }, completion_defaults: { enabled: false, level: 'merge' } };
  posts = []; reads = []; failWrite = failRead = false; override = null;
  dom = installDom({ fetch: async (path, options) => {
    const url = String(path); const body = options?.body ? JSON.parse(options.body) : null;
    if (body) posts.push({ url, body }); else reads.push(url);
    if (override) return override(url, body);
    if (url.endsWith('/api/hooks')) return json({ version: 1, revision: 'hooks', triggers: [], actions: [], templates: [], commands: [], completion_defaults: { enabled: true, level: 'archive', revision: 'old' }, auto_select: { enabled: true, revision: 'old-auto' } });
    if (url !== '/api/host/automation') throw Error(`unexpected ${url}`);
    if (body) { if (failWrite) return json({ error: '版本冲突' }, 409); model = { ...model, ...body.patch, revision: 'r2' }; }
    else if (failRead) throw Error('Host offline');
    return json(model);
  } });
  closeDialog(); activateDetailView({ view: 'overview' }); ui.hooksPage = null; ui.hookCatalogue = null;
});
afterEach(() => { closeDialog(); dom.restore(); });
const root = () => dom.node('detail');
const section = () => root().querySelector('.completion-defaults');
const button = (text, scope = root()) => scope.querySelectorAll('button').find(node => node.textContent === text);
const enabled = () => section().querySelector('input');
const stages = () => section().querySelectorAll('.hook-completion-level');
const level = () => stages().find(node => node.getAttribute('aria-pressed') === 'true')?.dataset.level;
const save = () => button('保存设备默认', section());
async function edit(on, endpoint) {
  if (endpoint) await stages().find(node => node.dataset.level === endpoint).onclick();
  if (on !== undefined) { enabled().checked = on; enabled().onchange(); }
}

test('project Hooks retain actual mounts but remove both project-wide editors', async () => {
  dom.location.pathname = '/p/1111111111111111/'; await openHooks();
  expect(section()).toBeNull(); expect(button('开启后台自动选择')).toBeUndefined();
  expect(root().querySelectorAll('a').some(link => link.href === '/#automation' && link.target === '_blank')).toBe(true);
  expect(root().querySelectorAll('a').some(link => link.href === '/#doc-docs-hooks' && link.target === '_blank')).toBe(true);
  expect(reads).toEqual(['/p/1111111111111111/api/hooks']); expect(posts).toHaveLength(0);
});

test('global defaults load once and draft selection never writes; saved scope is device-wide', async () => {
  await openWorkspaceAutomation(); expect(dom.location.hash).toBe('#automation');
  expect(reads).toEqual(['/api/host/automation']); expect(enabled().checked).toBe(false); expect(level()).toBe('merge'); expect(save().disabled).toBe(true);
  await edit(true, 'accept'); expect(posts).toHaveLength(0); expect(save().classList.contains('agent-call')).toBe(true);
  expect(save().getAttribute('data-help')).toContain('token');
  await save().onclick(); expect(posts).toEqual([{ url: '/api/host/automation', body: { patch: { completion_defaults: { enabled: true, level: 'accept' } }, expected_revision: 'r1' } }]);
  expect(level()).toBe('accept'); expect(save().disabled).toBe(true); expect(deepText(root())).toContain('已有 Worker 不变'); expect(deepText(root())).toContain('child');
});

test('archive draft requires explicit destructive authorization, cancellation retains draft', async () => {
  await openWorkspaceAutomation(); await edit(true, 'archive');
  const saving = save().onclick(); const accept = dialogButton(dom, '授权并保存默认');
  expect(accept.classList.contains('agent-call')).toBe(true); expect(accept.getAttribute('data-help')).toContain('token');
  await dialogButton(dom, '取消').onclick(); await saving;
  expect(posts).toHaveLength(0); expect(level()).toBe('archive'); expect(enabled().checked).toBe(true);
  const confirmed = save().onclick(); await dialogButton(dom, '授权并保存默认').onclick(); await confirmed;
  expect(posts[0].body.patch.completion_defaults.level).toBe('archive');
});

test('failed or conflicting save preserves draft and blocks repeating an unconfirmed operation', async () => {
  await openWorkspaceAutomation(); await edit(true, 'accept'); failWrite = true;
  await save().onclick(); expect(level()).toBe('accept'); expect(enabled().checked).toBe(true);
  expect(deepText(root())).toContain('编辑值已保留'); expect(save().disabled).toBe(true);
  await save().onclick(); expect(posts).toHaveLength(1);
});

test('unexpected ACK shape keeps draft and never claims saved success', async () => {
  await openWorkspaceAutomation(); await edit(true, 'accept'); override = () => json({ version: 1, revision: 'broken' });
  await save().onclick(); expect(level()).toBe('accept'); expect(save().disabled).toBe(true);
  expect(deepText(root())).toContain('响应无效');
});

test('rereading asks before discarding a draft and cancellation does not fetch', async () => {
  await openWorkspaceAutomation(); await edit(true, 'accept');
  const cancelled = button('重新读取策略').onclick(); await dialogButton(dom, '取消').onclick(); await cancelled;
  expect(level()).toBe('accept'); expect(reads).toHaveLength(1);
  const discarding = button('重新读取策略').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await discarding;
  expect(level()).toBe('merge'); expect(enabled().checked).toBe(false); expect(reads).toHaveLength(2);
});

test('global enable explicitly confirms existing unanswered questions and costs', async () => {
  await openWorkspaceAutomation(); const toggle = button('开启全局自动选择');
  expect(toggle.classList.contains('agent-call')).toBe(true); expect(toggle.getAttribute('data-help')).toContain('token');
  const pending = toggle.onclick(); expect(deepText(dom.node('modal'))).toContain('已有和新到问题');
  await dialogButton(dom, '授权并开启').onclick(); await pending;
  expect(posts[0].body.patch).toEqual({ auto_select: { enabled: true } }); expect(button('关闭全局自动选择').classList.contains('agent-call')).toBe(false);
});

test('saving auto-selection does not discard independent unsaved completion edits', async () => {
  model.auto_select.enabled = true; await openWorkspaceAutomation(); await edit(true, 'accept');
  await button('关闭全局自动选择').onclick();
  expect(level()).toBe('accept'); expect(enabled().checked).toBe(true); expect(save().disabled).toBe(false);
  expect(posts[0].body.patch).toEqual({ auto_select: { enabled: false } });
});

test('offline reload preserves draft and disables writes with accessible explanations', async () => {
  model.auto_select.enabled = true; await openWorkspaceAutomation(); failRead = true;
  await button('重新读取策略').onclick();
  const toggle = button('关闭全局自动选择'); expect(toggle.disabled).toBe(true); expect(toggle.parentNode.classList.contains('help-host')).toBe(true); expect(toggle.parentNode.tabIndex).toBe(0);
  expect(deepText(root())).toContain('读取设备自动化失败'); expect(posts).toHaveLength(0);
});

test('late global read must not steal a newer project detail view', async () => {
  let release; override = () => new Promise(resolve => release = resolve);
  const opening = openWorkspaceAutomation(); activateDetailView({ view: 'task-detail', title: 'Worker' }); root().replaceChildren(dom.document.createTextNode('still reading'));
  release(json(model)); await opening; expect(ui.view.id).toBe('task-detail'); expect(deepText(root())).toBe('still reading');
});
