import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { makeWorld } from './dom-world.js';
import { setup, fetch as httpFetch } from './harness.js';
import { openAgentStatus } from '../../src/ui/web/assets/render-agent-status.js';
import { openQuickExplanationPage } from '../../src/ui/web/assets/render-quick-explanation.js';
import { openModelSources } from '../../src/ui/web/assets/render-model-sources.js';
import { settingsClient } from '../../src/ui/web/assets/settings-api.js';

// Exercise DOM settings against the merged HTTP/RPC/storage implementation, never live roots.
// Unrelated Worker/history/bootstrap projections remain controlled DOM fixtures.
const world = makeWorld(), requests = [];
let f;
const dom = installDom({ fetch: async (url, options = {}) => {
  const raw = String(url); requests.push({ url: raw, options });
  if (raw.startsWith('/api/host/settings/') || raw.startsWith('/api/settings/')
    || /^\/api\/agent\/(config|connections|environment|network)(?:[/?]|$)/.test(raw)
    || raw.startsWith('/api/quick-explain/config') || raw === '/api/action') return httpFetch(f.url + raw, options);
  return world.fetchImpl(raw, options);
} });
dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
const { boot } = await import('../../src/ui/web/assets/app.js');
const detail = () => dom.node('detail');
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const input = (node, value) => { node.value = value; node.oninput?.(); for (const listener of node.listeners.input || []) listener(); };
const switchScope = async scope => { const select = detail().querySelector('select[data-settings-scope=""]'); select.value = scope; await select.onchange(); };
const system = async () => { await dom.node('settings-open').onclick(); await detail().querySelector('button[data-settings-tab="system"]').onclick(); };

beforeEach(async () => { f = await setup(); dom.location.pathname = '/'; dom.location.hash = ''; await boot(); requests.length = 0; });
afterEach(async () => { await f.web.stop(true); await f.close(); });

const source = { label: '临时共享来源', provider: 'deepseek', auth_type: 'api_key', enabled: true, models: ['deepseek-chat'] };
async function saveSource() {
  return settingsClient().action('agent.connections.save', { connection: source, credential: { api_key: 'TEMPORARY-TEST-KEY' } });
}

test('真实后端的 mixed 元数据包含环境默认；项目逐键覆盖/清除保持设备存储隔离', async () => {
  const device = settingsClient(); await device.action('system.configure', { settings: { concurrency: 5 } });
  await system(); expect(deepText(detail())).toContain('多层默认与覆盖组合');
  expect(deepText(detail())).not.toContain('设备默认与项目覆盖组合');
  await switchScope('project');
  expect(detail().querySelector('input[data-runtime-input="concurrency"]').value).toBe('5');
  expect(detail().querySelector('[data-runtime-source="concurrency"]').textContent).toBe('设备共享');
  input(detail().querySelector('input[data-runtime-input="concurrency"]'), '7');
  await detail().querySelector('button[data-runtime-action="save"]').onclick();
  expect(f.config.runtimeSettings.get().concurrency.value).toBe(7);
  expect(f.config.runtimeSettings.get('device').concurrency.value).toBe(5);
  await detail().querySelector('button[data-runtime-action="reset"]').onclick();
  expect(f.config.runtimeSettings.get().concurrency).toMatchObject({ value: 5, source: 'device', overridden: false });
});

test('真实 Host 投影可供无项目来源编辑及快捷解释保存，不将只读字段写回凭证文档', async () => {
  const saved = await saveSource();
  const profile = f.project.agentConfig('device');
  await settingsClient().action('agent.configure', { config: { version: 1, default: { ...profile.default, agent: 'pi', config_mode: 'pi' }, roles: {} } });
  const original = world.fetchImpl;
  world.fetchImpl = async (url, options) => url === '/api/host'
    ? { ok: true, status: 200, json: async () => ({ mode: 'host', projects: [] }) } : original(url, options);
  try {
    await boot(); requests.length = 0;
    await openAgentStatus(); expect(deepText(detail())).not.toContain('后台未确认所选设置作用域');
    await openModelSources();
    const row = detail().querySelector(`[data-source-id="${saved.id}"]`); expect(deepText(row)).toContain('设备共享');
    await button(row, '详情').onclick(); await button(detail().querySelector('.agent-connection-card'), '编辑').onclick();
    input(detail().querySelector('[data-connection-field="label"]'), '更新临时共享来源'); await button(detail(), '保存连接').onclick();
    const document = JSON.parse(fs.readFileSync(path.join(f.config.deviceHome, 'credentials', 'agent-connections.json'), 'utf8'));
    expect(document.connections[0].label).toBe('更新临时共享来源');
    for (const key of ['configuration_scope', 'storage_scope', 'consumers', 'observation']) expect(document.connections[0]).not.toHaveProperty(key);
    await openQuickExplanationPage();
    const connection = detail().querySelector('[data-quick-field="connection_id"]'); connection.value = saved.id; connection.onchange();
    input(detail().querySelector('[data-quick-field="model"]'), 'deepseek-chat');
    input(detail().querySelector('[data-quick-field="prompt"]'), '临时共享解释规则'); await button(detail(), '保存解释设置').onclick();
    expect(f.project.quickExplanationConfig('device')).toMatchObject({ ready: true, prompt: '临时共享解释规则' });
    expect(requests.every(row => row.url.startsWith('/api/host/settings/'))).toBe(true);
    expect(button(detail(), '刷新历史')).toBeUndefined();
  } finally { world.fetchImpl = original; }
});

test('真实项目环境读取是有效叠加值；UI 明示整表写入与删除后设备变量继承', async () => {
  await settingsClient().action('agent.environment.configure', { target: 'common', values: { SHARED_VALUE: 'shared' } });
  await settingsClient('project').action('agent.environment.configure', { target: 'common', values: { PROJECT_VALUE: 'local' } });
  await openAgentStatus(); await switchScope('project'); await button(detail().querySelector('.agent-env-block'), '读取变量').onclick();
  const env = detail().querySelector('.agent-env-block');
  expect(env.querySelectorAll('input.agent-env-name').map(node => node.value)).toEqual(['SHARED_VALUE', 'PROJECT_VALUE']);
  expect(deepText(env)).toContain('包括未改动的继承值');
  expect(deepText(env)).toContain('同名设备变量仍会继承');
  const clearing = env.querySelector('button[data-clear-override="environment"]').onclick();
  await dialogButton(dom, '清除并继承').onclick(); await clearing;
  expect(f.project.agentEnvironment('common')).toMatchObject({ values: { SHARED_VALUE: 'shared' }, configuration_scope: { source: 'device', project_override: false } });
});

test('真实迁移空预检不能应用；有条目时按实际 revision 确认并显示私有备份', async () => {
  await system(); await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备共享').disabled).toBe(true);
  expect(deepText(detail())).toContain('当前项目没有可迁移的设置；未修改任何配置。');
  f.project.configureRuntimeSettings({ concurrency: 6 }, 'project');
  await button(detail(), '预检迁移范围').onclick();
  expect(button(detail(), '确认迁移到设备共享').disabled).toBe(false);
  expect(deepText(detail())).toContain(path.join(f.config.deviceHome, 'settings.json'));
  const applying = button(detail(), '确认迁移到设备共享').onclick(); await dialogButton(dom, '备份并迁移').onclick(); await applying;
  expect(deepText(detail())).toContain('迁移完成，当前项目继承设备共享默认');
  expect(deepText(detail())).toContain(path.join(f.config.home, 'device-migration'));
  expect(fs.existsSync(path.join(f.config.home, 'settings.json'))).toBe(false);
  expect(f.config.runtimeSettings.get().concurrency).toMatchObject({ value: 6, source: 'device', overridden: false });
});

test('真实HTTP/RPC/SQLite：共享来源刷新持续留样到项目趋势，旧存档不接收新数据', async () => {
  let balance = 12, calls = 0, now = Date.now();
  const service = f.project.agentConnections;
  service.now = () => now;
  service.managerOptions.now = () => now;
  service.managerOptions.fetch = async url => {
    expect(String(url)).toBe('https://api.deepseek.com/user/balance'); calls++;
    return Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: balance }] });
  };
  service.forScope('device').now = () => now;
  const saved = await saveSource();
  await openModelSources();
  const trends = detail().querySelector('.model-source-trends');
  expect(calls).toBe(0); expect(trends.hidden).toBe(false);
  await button(trends, '查看余额与额度趋势').onclick();
  expect(deepText(trends)).toContain('暂无缓存样本'); expect(calls).toBe(0);
  const refresh = () => button(detail().querySelector(`[data-source-id="${saved.id}"]`), '刷新').onclick();
  await refresh(); now += 60000; balance = 10; await refresh();
  expect(calls).toBe(2);
  expect(service.history(saved.id).series[0].points.map(point => point.remaining)).toEqual([12, 10]);
  expect(f.store.get('SELECT COUNT(*) AS n FROM agent_connection_queries').n).toBe(2);
  expect(trends.querySelectorAll('.agent-usage-dot')).toHaveLength(2);
  expect(trends.querySelectorAll('.agent-usage-connection')).toHaveLength(1);
  expect(requests.filter(row => row.url.includes('/usage/history'))).toHaveLength(0);
  expect(requests.filter(row => row.url.includes('/connections/history')).every(row => !row.url.includes('scope='))).toBe(true);
  // The sampling shortcut reads the actual project policy, not device defaults, and saves nothing.
  await button(trends, '本项目采样设置').onclick();
  expect(detail().querySelector('select[data-settings-scope=""]').value).toBe('project');
  const sampling = detail().querySelector('[data-connection-field="sampling-enabled"]');
  expect(sampling.checked).toBe(false); expect(sampling.parentNode.parentNode.parentNode.hidden).toBe(false);
  expect(calls).toBe(2); expect(service.config().sampling.enabled).toBe(false);
  expect(requests.filter(row => row.options.body && JSON.parse(row.options.body).method === 'agent.connections.sampling')).toHaveLength(0);
  expect(JSON.stringify(service.history(saved.id))).not.toContain('TEMPORARY-TEST-KEY');
  // Reused panes after navigation must update the new page, not a detached scope selector.
  await openAgentStatus(); await openModelSources();
  expect(detail().querySelector('select[data-settings-scope=""]').value).toBe('device');
  await button(detail(), '本项目采样设置').onclick();
  expect(detail().querySelector('select[data-settings-scope=""]').value).toBe('project');
  expect(detail().querySelector('[data-connection-field="sampling-enabled"]').parentNode.parentNode.parentNode.hidden).toBe(false);
  expect(calls).toBe(2);
});

// Each suite runs in its own DOM process; release the installed globals once all cases finish.
afterAll(() => dom.restore());
