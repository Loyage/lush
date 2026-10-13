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
  model = { version: 1, revision: 'r1', auto_select: { enabled: false }, completion_defaults: { enabled: true, level: 'archive' } };
  posts = []; reads = []; failWrite = failRead = false; override = null;
  dom = installDom({ fetch: async (path, options) => {
    const url = String(path); const body = options?.body ? JSON.parse(options.body) : null;
    if (body) posts.push({ url, body }); else reads.push(url);
    if (override) return override(url, body);
    if (url !== '/api/host/automation') throw Error(`unexpected ${url}`);
    if (body) { if (failWrite) return json({ error: '版本冲突' }, 409); model = { ...model, ...body.patch, revision: 'r2' }; }
    else if (failRead) throw Error('Host offline');
    return json(model);
  } });
  closeDialog(); activateDetailView({ view: 'overview' }); ui.hooksPage = null; ui.hookCatalogue = null;
});
afterEach(() => { closeDialog(); dom.restore(); });
const root = () => dom.node('detail');
const button = text => root().querySelectorAll('button').find(node => node.textContent === text);
const enable = async () => {
  const pending = button('开启全局自动选择').onclick();
  await dialogButton(dom, '授权并开启').onclick(); await pending;
};

test('project directory does not read legacy device defaults or global authorization editors', async () => {
  dom.location.pathname = '/p/1111111111111111/'; await openHooks();
  expect(root().querySelector('.completion-defaults')).toBeNull();
  expect(button('开启后台自动选择')).toBeUndefined();
  expect(root().querySelectorAll('.automation-feature')).toHaveLength(4);
  expect(root().querySelectorAll('a').some(link => link.getAttribute('href') === '#hooks-completion')).toBe(true);
  expect(reads).toEqual([]); expect(posts).toHaveLength(0);
});

test('device completion defaults are retired even when old authorization was enabled', async () => {
  await openWorkspaceAutomation();
  expect(reads).toEqual(['/api/host/automation']);
  expect(root().querySelector('.completion-defaults')).toBeNull();
  expect(root().querySelectorAll('.hook-completion-level')).toHaveLength(0);
  expect(button('保存设备默认')).toBeUndefined();
  expect(deepText(root())).toContain('项目自动化');
  expect(deepText(root())).toContain('旧配置与已有授权保留');
  expect(posts).toHaveLength(0);
});

test('global enable explicitly confirms existing questions and Agent costs; cancellation never writes', async () => {
  await openWorkspaceAutomation(); const toggle = button('开启全局自动选择');
  expect(toggle.classList.contains('agent-call')).toBe(true); expect(toggle.getAttribute('data-help')).toContain('token');
  const pending = toggle.onclick(); expect(deepText(dom.node('modal'))).toContain('已有和新到问题');
  expect(dialogButton(dom, '授权并开启').classList.contains('agent-call')).toBe(true);
  await dialogButton(dom, '取消').onclick(); await pending; expect(posts).toHaveLength(0);
  await enable();
  expect(posts).toEqual([{ url: '/api/host/automation', body: { patch: { auto_select: { enabled: true } }, expected_revision: 'r1' } }]);
  expect(button('关闭全局自动选择').classList.contains('agent-call')).toBe(false);
  expect(model.completion_defaults).toEqual({ enabled: true, level: 'archive' });
});

test('conflicting or failed save blocks repeats until explicitly reread', async () => {
  await openWorkspaceAutomation(); failWrite = true; await enable();
  expect(deepText(root())).toContain('版本冲突'); expect(button('开启全局自动选择').disabled).toBe(true);
  await button('开启全局自动选择').onclick(); expect(posts).toHaveLength(1);
  failWrite = false; await button('重新读取策略').onclick(); expect(button('开启全局自动选择').disabled).toBe(false);
});

test('malformed or wrong-value ACK never claims a saved policy and is not retried', async () => {
  for (const value of [{ version: 1, revision: 'broken' }, model]) {
    override = null; await openWorkspaceAutomation(); override = () => json(value);
    await enable(); expect(button('开启全局自动选择').disabled).toBe(true);
    expect(deepText(root())).toContain('未确认');
  }
  expect(posts).toHaveLength(2);
});

test('offline reload retains last-known policy with accessible disabled explanation', async () => {
  model.auto_select.enabled = true; await openWorkspaceAutomation(); failRead = true;
  await button('重新读取策略').onclick();
  const toggle = button('关闭全局自动选择'); expect(toggle.disabled).toBe(true);
  expect(toggle.parentNode.classList.contains('help-host')).toBe(true); expect(toggle.parentNode.tabIndex).toBe(0);
  expect(deepText(root())).toContain('读取设备自动化失败'); expect(posts).toHaveLength(0);
});

test('late global read or save cannot steal a newer Worker detail view', async () => {
  let release; override = () => new Promise(resolve => release = resolve);
  const opening = openWorkspaceAutomation(); activateDetailView({ view: 'task-detail', title: 'Worker' }); root().replaceChildren(dom.document.createTextNode('still reading'));
  release(json(model)); await opening; expect(ui.view.id).toBe('task-detail'); expect(deepText(root())).toBe('still reading');
  override = null; model.auto_select.enabled = true; await openWorkspaceAutomation();
  override = () => new Promise(resolve => release = resolve);
  const saving = button('关闭全局自动选择').onclick(); activateDetailView({ view: 'task-detail', title: 'Worker' }); root().replaceChildren(dom.document.createTextNode('still reading'));
  release(json({ ...model, revision: 'r2', auto_select: { enabled: false } })); await saving;
  expect(deepText(root())).toBe('still reading');
});
