import { test, expect, beforeEach, afterEach } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { automationTarget, automationHash } from '../../src/ui/web/assets/automation-features.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
let dom, reads, writes, intercept, catalogue;
const json = value => Response.json(value);
const policy = () => ({ version: 1, revision: 'r1', completion_defaults: { enabled: false, level: 'merge' }, acceptance_notice_defaults: { enabled: true },
  mount_scopes: { completion: 'all', acceptance_notice: 'all' }, display_principles: { completion: 'all', push: 'all', convergence: 'all', acceptance_notice: 'all' } });
beforeEach(() => {
  reads = []; writes = []; intercept = null;
  catalogue = { version: 1, revision: 'r', automation_settings: policy(), commands: { version: 1, revision: 'c', items: [] },
    command_example: { worker_id: 1, hook_id: 'push-hook', hooks: { version: 1, worker_id: 1, revision: 'hook-r', mounts: [] } }, triggers: [], actions: [], templates: [] };
  dom = installDom({ fetch: async (url, options = {}) => {
    const path = String(url), body = options.body ? JSON.parse(options.body) : null;
    if (body) writes.push(body); else reads.push(path);
    const custom = intercept?.(path, body); if (custom) return custom;
    if (path.endsWith('/api/hooks')) return json(catalogue);
    if (path.endsWith('/api/branch-convergence/defaults')) return json({ version: 1, mounted: false, scope: 'none', enabled: false, editable: true, reason: null, revision: 'defaults-r' });
    if (body?.method === 'worker.hook_update') { catalogue.command_example.hooks.mounts[0].enabled = body.params.enabled; catalogue.command_example.hooks.revision = 'saved'; return json(catalogue.command_example.hooks); }
    if (path.includes('/api/inputs')) return json({ items: [], next_cursor: null });
    throw Error(`unexpected ${path}`);
  } });
  activateDetailView({ view: 'overview' }); ui.automationPage = null; dom.location.pathname = '/p/1111111111111111/';
});
afterEach(() => { ui.disposeProjectAutomation?.(); dom.restore(); });
const root = () => dom.node('detail');
const btn = label => root().querySelectorAll('button').find(node => node.textContent === ({ '启用 Hook': '开启', '停用 Hook': '关闭' }[label] || label));

test('four lazy settings entries share name/function/principle; explicit search excludes conditional input', async () => {
  await openProjectAutomation(); const entries = root().querySelectorAll('.automation-feature');
  expect(entries.map(item => item.dataset.feature)).toEqual(['completion', 'push', 'convergence', 'acceptance_notice']);
  for (const entry of entries) { expect(deepText(entry)).toContain('功能简介：'); expect(deepText(entry)).toContain('原理简介：'); }
  expect(deepText(root())).toContain('成果自动合并与验收'); expect(deepText(root())).not.toContain('条件提交'); expect(reads).toEqual([]);
  const search = root().querySelector('[aria-label="查找自动化功能"]'); search.value = 'push'; search.listeners.input[0]();
  expect(entries.every(item => !item.hidden)).toBe(true); search.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  expect(entries.filter(item => !item.hidden).map(item => item.dataset.feature)).toEqual(['push']);
  await entries[1].querySelector('a').onclick({ ctrlKey: true }); expect(reads).toEqual([]);
});

test('back and feature changes preserve submitted search, draft and original revision without history routes/reads', async () => {
  await openProjectAutomation(); const search = root().querySelector('[aria-label="查找自动化功能"]'); search.value = '尚未提交';
  await openProjectAutomation({ feature: 'completion' }); const node = root().querySelector('.automation-completion'), choice = node.querySelector('[data-level="accept"]');
  await choice.onclick();
  await openProjectAutomation({ feature: 'push', subpage: 'history' }); expect(dom.location.hash).toBe('#hooks-push'); expect(root().querySelector('.page-subnav')).toBeNull();
  await btn('← 返回自动化功能列表').onclick(); expect(root().querySelector('[aria-label="查找自动化功能"]')).toBe(search);
  await openProjectAutomation({ feature: 'completion', subpage: 'history' }); expect(root().querySelector('.automation-completion')).toBe(node); expect(choice.getAttribute('aria-pressed')).toBe('true');
  expect(reads.every(path => path.endsWith('/api/hooks'))).toBe(true); expect(writes).toEqual([]);
});

test('push retains main current authorization but no execution records or raw results even in legacy history link', async () => {
  catalogue.command_example.hooks.mounts = [{ id: 'push-hook', enabled: true, editable: true, state: 'unknown', reason: '需要核对 main 安全现场', last_execution: { error: 'PRIVATE_OUTPUT' }, actions: [] }];
  await openProjectAutomation({ feature: 'push', subpage: 'history' });
  expect(btn('停用 Hook')).toBeTruthy(); expect(deepText(root())).toContain('需要核查'); expect(deepText(root())).toContain('需要核对 main 安全现场'); expect(deepText(root())).toContain('结果未知'); expect(deepText(root())).not.toContain('PRIVATE_OUTPUT');
  expect(root().querySelector('.push-history')).toBeNull(); expect(reads.every(path => path.endsWith('/api/hooks'))).toBe(true);
  await btn('展开推送高级设置').onclick(); expect(btn('查看 main Worker 自动化')).toBeTruthy();
});

test('late main toggle releases busy state but cannot repeat until explicit authoritative reload', async () => {
  catalogue.command_example.hooks.mounts = [{ id: 'push-hook', enabled: true, editable: true, mode: 'persistent', actions: [] }];
  await openProjectAutomation({ feature: 'push' }); let release;
  intercept = (_path, body) => body ? new Promise(resolve => release = resolve) : null;
  const saving = btn('停用 Hook').onclick(); await until(() => release); await openProjectAutomation();
  catalogue.command_example.hooks.mounts[0].enabled = false; catalogue.command_example.hooks.revision = 'saved';
  release(json(catalogue.command_example.hooks)); await saving; intercept = null;
  await openProjectAutomation({ feature: 'push' }); expect(btn('停用 Hook').disabled).toBe(true); expect(writes).toHaveLength(1);
  await btn('重新读取推送设置').onclick(); expect(btn('启用 Hook').disabled).toBe(false); expect(writes).toHaveLength(1);
});

test('feature load failure remains retryable and late project read cannot replace a different project', async () => {
  intercept = path => path.endsWith('/api/hooks') ? Promise.reject(Error('offline')) : null;
  await openProjectAutomation({ feature: 'completion' }); expect(deepText(root())).toContain('offline');
  let release; intercept = () => new Promise(resolve => release = resolve); const loading = btn('重新读取').onclick(); await until(() => release);
  dom.location.pathname = '/p/2222222222222222/'; await openProjectAutomation(); const next = root().querySelector('.project-automation');
  release(json(catalogue)); await loading; expect(root().querySelector('.project-automation')).toBe(next); expect(root().querySelector('.automation-completion')).toBeNull();
});

test('convergence reads future defaults only, without target directory, runs or actual authorization controls', async () => {
  await openProjectAutomation({ feature: 'convergence' }); expect(root().querySelector('.convergence-defaults')).toBeTruthy();
  expect(root().querySelector('[aria-label="目标分支"]')).toBeNull(); expect(root().querySelector('.convergence-history')).toBeNull();
  expect(reads).toEqual(['/p/1111111111111111/api/hooks', '/p/1111111111111111/api/branch-convergence/defaults']);
});

test('inactive convergence default save keeps selection and blocks replay until explicit readonly verification', async () => {
  await openProjectAutomation({ feature: 'convergence' });
  const mounted = root().querySelector('[aria-label="挂载范围"]'); mounted.value = 'all'; mounted.onchange();
  let release;
  intercept = (_path, body) => body?.method === 'branch.convergence_defaults_set' ? new Promise(resolve => release = resolve) : null;
  const saving = btn('保存新 Worker 归并默认').onclick(); await until(() => release); await openProjectAutomation();
  const saved = { version: 1, mounted: true, scope: 'all', enabled: false, editable: true, reason: null, revision: 'saved-defaults' };
  release(json(saved)); await saving; await openProjectAutomation({ feature: 'convergence' });
  expect(root().querySelector('[aria-label="挂载范围"]')).toBe(mounted); expect(mounted.value).toBe('all');
  expect(btn('保存新 Worker 归并默认').disabled).toBe(true); expect(writes[0].params.expected_revision).toBe('defaults-r');
  const checking = btn('核对归并默认保存结果').onclick(); await dialogButton(dom, '取消').onclick(); await checking;
  expect(btn('保存新 Worker 归并默认').disabled).toBe(true); expect(writes).toHaveLength(1);
  intercept = path => path.endsWith('/api/branch-convergence/defaults') ? json(saved) : null;
  const confirmed = btn('核对归并默认保存结果').onclick(); await dialogButton(dom, '放弃并读取').onclick(); await confirmed;
  expect(mounted.disabled).toBe(false); expect(writes).toHaveLength(1);
});

test('old feature history bookmarks resolve to settings; conditional bookmarks lead to existing input browser', async () => {
  expect(automationTarget('#hooks-push-history')).toEqual({ feature: 'push', subpage: 'settings' });
  expect(automationTarget('#hooks-acceptance_notice')).toEqual({ feature: 'acceptance_notice', subpage: 'settings' });
  expect(automationTarget('#hooks-history')).toEqual({ feature: null, subpage: 'settings' }); expect(automationTarget('#hooks-commands')).toBeNull();
  expect(automationHash('push', 'history')).toBe('#hooks-push');
  await openProjectAutomation({ feature: 'emission', subpage: 'history' }); expect(dom.location.hash).toBe('#inputs'); expect(root().querySelector('.inputs-page')).toBeTruthy();
  expect(root().querySelector('.project-automation')).toBeNull(); expect(writes).toEqual([]);
});
