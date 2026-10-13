import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
const json = value => ({ ok: true, json: async () => structuredClone(value) });
let reads, writes, intercept, catalogue, pages;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) writes.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (path.includes('/history-page')) return json(pages.shift() || { events: [], cursor: null, truncated: false });
  throw new Error(`unexpected ${path}`);
} });
const { openProjectAutomation } = await import('../../src/ui/web/assets/render-project-automation.js');
const { automationTarget } = await import('../../src/ui/web/assets/automation-features.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const root = () => dom.node('detail');
const btn = label => root().querySelectorAll('button').find(node => node.textContent === label);
beforeEach(() => {
  activateDetailView({ view: 'overview' }); ui.automationPage = null; reads = []; writes = []; intercept = null; pages = [];
  dom.location.pathname = '/p/1111111111111111/';
  catalogue = { version: 1, revision: 'r', triggers: [], actions: [], templates: [], commands: { version: 1, revision: 'commands', items: [] },
    command_example: { worker_id: 1, hook_id: 'push-hook', hooks: { version: 1, worker_id: 1, revision: 'hook-r', mounts: [] } },
    signals: { version: 1, revision: 's', items: [] }, management_workers: [] };
});
afterAll(() => { ui.disposeProjectAutomation?.(); dom.restore(); });

test('directory is four native list entries, not the former settings wall; list browsing is read-only and lazy', async () => {
  await openProjectAutomation();
  const entries = root().querySelectorAll('.automation-feature'); expect(entries).toHaveLength(4);
  expect(entries.map(node => node.dataset.feature)).toEqual(['completion', 'push', 'convergence', 'emission']);
  expect(root().querySelector('.automation-browse').classList.contains('ui-list-page')).toBe(true);
  for (const name of ['开发完成后自动处理', '合并后自动 git push', '归并合并', '条件发射']) expect(deepText(root())).toContain(name);
  for (const selector of ['.hook-signals', '.hook-managers', '.hook-template', '.shortcut-commands', '.branch-convergence', '.project-hooks']) expect(root().querySelector(selector)).toBeNull();
  expect(reads).toEqual([]); expect(writes).toEqual([]);
  const link = entries[1].querySelector('a'); expect(link.getAttribute('href')).toBe('#hooks-push');
  await link.onclick({ ctrlKey: true }); expect(dom.location.hash).toBe('#hooks'); expect(reads).toEqual([]);
  const search = root().querySelector('[aria-label="查找自动化功能"]'); search.value = 'push'; search.listeners.input[0]();
  expect(entries.every(entry => !entry.hidden)).toBe(true); search.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  expect(entries.filter(entry => !entry.hidden).map(entry => entry.dataset.feature)).toEqual(['push']);
});

test('feature route and tabs share a retained node; returning keeps list search without writes', async () => {
  await openProjectAutomation();
  const search = root().querySelector('[aria-label="查找自动化功能"]'); search.value = '尚未提交';
  await root().querySelector('[data-feature="push"]').querySelector('a').onclick({ preventDefault() {} });
  expect(dom.location.hash).toBe('#hooks-push'); expect(root().querySelector('.automation-feature-page').hidden).toBe(false);
  const node = root().querySelector('.automation-push'); expect(node).toBeTruthy(); expect(deepText(node)).toContain('不会自动重装');
  await root().querySelector('[data-subpage="history"]').onclick({ preventDefault() {} });
  expect(dom.location.hash).toBe('#hooks-push-history'); expect(root().querySelector('.automation-push')).toBe(node);
  await until(() => reads.some(path => path.includes('/history-page')));
  await btn('← 返回自动化功能列表').onclick(); expect(dom.location.hash).toBe('#hooks');
  expect(root().querySelector('[aria-label="查找自动化功能"]')).toBe(search); expect(search.value).toBe('尚未提交');
  expect(writes).toHaveLength(0);
});

test('push history matches persistent hook identity including removed attachments, with explicit unread pagination', async () => {
  pages = [{ events: [{ id: 9, type: 'hook.execution_failed', data: JSON.stringify({ hook_id: 'other-hook', error: 'other error' }) }], cursor: 9, truncated: true },
    { events: [{ id: 8, created_at: '2026-01-01T00:00:00Z', type: 'hook.execution_unknown', data: JSON.stringify({ hook_id: 'push-hook', execution_id: 'fixed', error: '<script>unknown push</script>' }) },
      { id: 7, type: 'hook.action_completed', data: JSON.stringify({ hook_id: 'push-hook', command_result: { status: 'failed', exit_code: 9, output: 'SECRET_OUTPUT' } }) }], cursor: null, truncated: false }];
  await openProjectAutomation({ feature: 'push', subpage: 'history' }); await until(() => !!btn('读取更早运行事件') && !btn('读取更早运行事件').hidden);
  expect(deepText(root())).toContain('仍有更早事件未读取'); expect(deepText(root())).not.toContain('other error');
  await btn('读取更早运行事件').onclick(); expect(deepText(root())).toContain('unknown push'); expect(deepText(root())).toContain('退出码 9');
  expect(root().querySelector('script')).toBeNull(); expect(deepText(root())).not.toContain('SECRET_OUTPUT'); expect(writes).toHaveLength(0);
});

test('feature load failure leaves navigation and retries; late response cannot replace another page or project', async () => {
  intercept = path => path.endsWith('/api/hooks') ? Promise.reject(new Error('offline')) : null;
  await openProjectAutomation({ feature: 'push' }); expect(deepText(root())).toContain('offline'); expect(btn('← 返回自动化功能列表')).toBeTruthy();
  let resolve; intercept = path => path.endsWith('/api/hooks') ? new Promise(done => resolve = done) : null;
  const loading = btn('重新读取').onclick(); await until(() => resolve);
  dom.location.pathname = '/p/2222222222222222/'; await openProjectAutomation(); const next = root().querySelector('.project-automation');
  resolve(json(catalogue)); await loading; expect(root().querySelector('.project-automation')).toBe(next); expect(root().querySelector('.automation-push')).toBeNull();
  expect(writes).toHaveLength(0);
});

test('retained push history releases an inactive read and re-reads on return without replay', async () => {
  let release;
  intercept = path => path.includes('/history-page') ? new Promise(resolve => release = resolve) : null;
  const opening = openProjectAutomation({ feature: 'push', subpage: 'history' });
  await until(() => release && ui.automationPage?.nodes.has('push'));
  const node = ui.automationPage.nodes.get('push');
  await openProjectAutomation();
  release(json({ events: [], cursor: null, truncated: false })); await opening;
  expect(deepText(node)).not.toContain('已读取 main 的');
  intercept = null;
  await openProjectAutomation({ feature: 'push', subpage: 'history' });
  expect(root().querySelector('.automation-push')).toBe(node);
  expect(deepText(node)).toContain('已读取 main 的 0 条事件');
  expect(btn('刷新推送记录').disabled).toBe(false);
  expect(reads.filter(path => path.includes('/history-page'))).toHaveLength(2);
  expect(writes).toHaveLength(0);
});

test('late push mount save releases retained controls and only re-reads the authoritative revision', async () => {
  catalogue.command_example.hooks.mounts = [{ id: 'push-hook', name: 'push', trigger: 'worker.merge_received', enabled: true,
    mode: 'persistent', editable: true, removable: true, actions: [] }];
  await openProjectAutomation({ feature: 'push' });
  let release;
  intercept = (_path, body) => body?.method === 'worker.hook_update' ? new Promise(resolve => release = resolve) : null;
  const saving = btn('停用 Hook').onclick(); await until(() => release);
  await openProjectAutomation();
  catalogue.command_example.hooks.mounts[0].enabled = false;
  catalogue.command_example.hooks.revision = 'saved-hook-revision';
  release(json(catalogue.command_example.hooks)); await saving;
  expect(writes).toHaveLength(1); expect(dom.location.hash).toBe('#hooks');
  intercept = null; await openProjectAutomation({ feature: 'push' });
  expect(btn('启用 Hook').disabled).toBe(false);
  expect(reads.filter(path => path.endsWith('/api/hooks'))).toHaveLength(2);
  expect(writes).toHaveLength(1);
});

test('hash target rejects unrelated routes and preserves legacy history as the feature directory', () => {
  expect(automationTarget('#hooks-emission-history')).toEqual({ feature: 'emission', subpage: 'history' });
  expect(automationTarget('#hooks-history')).toEqual({ feature: null, subpage: 'settings' });
  expect(automationTarget('#hooks-commands')).toBeNull(); expect(automationTarget('#hooks-unknown')).toBeNull();
});
