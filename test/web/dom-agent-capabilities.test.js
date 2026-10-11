import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { makeWorld } from './dom-world.js';
import { gate } from '../helpers.js';

const keys = ['progress_reporting', 'worker_delegation', 'worker_auto_title', 'context_retrieval'];
const world = makeWorld(), initial = structuredClone(world.state.runtimeSettings), requests = [];
let failSave = false, blockedSave = null;
const dom = installDom({ fetch: async (url, options = {}) => {
  const raw = String(url); requests.push({ url: raw, options });
  if (raw === '/api/host/settings/action') {
    if (failSave) return { ok: false, status: 500, json: async () => ({ error: '能力设置保存失败测试' }) };
    if (blockedSave) { const block = blockedSave; block.entered.resolve(); await block.release.promise; }
  }
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { openSettings, renderSettings } = await import('../../src/ui/web/assets/render-settings.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const panel = () => dom.node('detail');
const checkbox = key => panel().querySelector(`input[data-runtime-input="${key}"]`);
const actions = () => requests.filter(row => row.url === '/api/host/settings/action').map(row => JSON.parse(row.options.body));
const system = async () => { await openSettings(); await panel().querySelector('button[data-settings-tab="system"]').onclick(); };
beforeEach(async () => {
  world.state.runtimeSettings = structuredClone(initial); world.state.actions.length = 0;
  failSave = false; blockedSave = null; requests.length = 0;
  await boot(); await system(); requests.length = 0;
});
afterAll(() => dom.restore());

test('global system page has four named capability switches with clear non-permission and deferred effects', () => {
  for (const key of keys) {
    const input = checkbox(key); expect(input.type).toBe('checkbox'); expect(input.checked).toBe(true);
    expect(input.getAttribute('aria-label')).toMatch(/^启用/);
    expect(input.parentNode.classList.contains('help-host')).toBe(true);
    expect(input.parentNode.getAttribute('data-help')).toContain('不立即调用 Agent');
  }
  expect(deepText(panel())).toContain('Agent 能力');
  expect(deepText(panel())).toContain('不是权限隔离');
  expect(deepText(panel())).toContain('当前调用与已有子 Worker 继续');
  expect(deepText(panel())).toContain('保存不会立即调用 Agent');
  expect(panel().querySelector('[data-capability-reset=""]')).not.toBeNull();
  expect(checkbox('worker_delegation').parentNode.querySelector('.agent-call')).toBeNull();
});

test('each switch saves one independent device patch and restoration sends null without starting an Agent', async () => {
  for (const key of keys) {
    checkbox(key).checked = false; await checkbox(key).onchange();
    expect(actions().at(-1)).toEqual({ method: 'system.configure', params: { settings: { [key]: false }, scope: 'device' } });
    expect(checkbox(key).checked).toBe(false);
    expect(world.state.runtimeSettings[key].value).toBe(false);
  }
  expect(panel().querySelector('[data-capability-status=""]').getAttribute('role')).toBe('status');
  expect(deepText(panel())).toContain('能力设置已保存');
  await panel().querySelector('[data-capability-reset=""]').onclick();
  expect(actions().at(-1)).toEqual({ method: 'system.configure', params: { settings: Object.fromEntries(keys.map(key => [key, null])), scope: 'device' } });
  for (const key of keys) { expect(checkbox(key).checked).toBe(true); expect(world.state.runtimeSettings[key].overridden).toBe(false); }
  expect(requests.filter(row => row.options.method === 'POST').every(row => row.url === '/api/host/settings/action')).toBe(true);
});

test('capability saving preserves unrelated numeric drafts and missing older fields fall back to enabled', async () => {
  const number = panel().querySelector('[data-runtime-input="call_timeout"]'); number.value = '777';
  checkbox('worker_delegation').checked = false; await checkbox('worker_delegation').onchange();
  expect(panel().querySelector('[data-runtime-input="call_timeout"]')).toBe(number);
  expect(number.value).toBe('777');
  for (const key of keys.slice(1)) delete world.state.runtimeSettings[key];
  activateDetailView({ view: 'overview' }); await system();
  for (const key of keys.slice(1)) expect(checkbox(key).checked).toBe(true);
});

test('failed switch/reset restores the saved state, reports an alert and keeps the controls usable', async () => {
  checkbox('worker_auto_title').checked = false; await checkbox('worker_auto_title').onchange();
  failSave = true;
  try {
    checkbox('context_retrieval').checked = false; await checkbox('context_retrieval').onchange();
    expect(checkbox('context_retrieval').checked).toBe(true);
    expect(checkbox('worker_auto_title').checked).toBe(false);
    expect(world.state.runtimeSettings.context_retrieval.value).toBe(true);
    await panel().querySelector('[data-capability-reset=""]').onclick();
    expect(checkbox('worker_auto_title').checked).toBe(false);
    for (const key of keys) expect(checkbox(key).disabled).toBe(false);
    expect(panel().querySelector('[data-capability-reset=""]').disabled).toBe(false);
    const feedback = panel().querySelector('[data-capability-status=""]');
    expect(feedback.getAttribute('role')).toBe('alert'); expect(deepText(panel())).toContain('能力设置保存失败测试');
  } finally { failSave = false; }
});

test('one pending capability save disables all switches and reset with outer help and no duplicate write', async () => {
  const block = { entered: gate(), release: gate() }; blockedSave = block;
  const input = checkbox('worker_delegation'); input.checked = false;
  const pending = input.onchange(); await block.entered.promise;
  try {
    for (const key of keys) { expect(checkbox(key).disabled).toBe(true); expect(checkbox(key).parentNode.getAttribute('data-help')).toContain('正在保存'); }
    const reset = panel().querySelector('[data-capability-reset=""]'); expect(reset.disabled).toBe(true);
    expect(reset.parentNode.classList.contains('help-host')).toBe(true);
    expect(reset.parentNode.getAttribute('data-help')).toContain('正在保存');
    await input.onchange(); await reset.onclick(); expect(actions()).toHaveLength(1);
  } finally { blockedSave = null; block.release.resolve(); await pending; }
  expect(input.checked).toBe(false);
  for (const key of keys) expect(checkbox(key).disabled).toBe(false);
});

test('late saved response does not reclaim another tab and system re-entry reads the persisted value', async () => {
  const block = { entered: gate(), release: gate() }; blockedSave = block;
  const input = checkbox('context_retrieval'); input.checked = false;
  const pending = input.onchange(); await block.entered.promise;
  try {
    await panel().querySelector('button[data-settings-tab="interface"]').onclick();
    const before = deepText(panel());
    blockedSave = null; block.release.resolve(); await pending;
    expect(deepText(panel())).toBe(before);
    expect(panel().querySelector('[data-capability-status=""]')).toBeNull();
    const reads = requests.filter(row => row.url.startsWith('/api/host/settings/runtime')).length;
    await panel().querySelector('button[data-settings-tab="system"]').onclick();
    expect(requests.filter(row => row.url.startsWith('/api/host/settings/runtime')).length).toBe(reads + 1);
    expect(checkbox('context_retrieval').checked).toBe(false);
    renderSettings(); expect(checkbox('context_retrieval').checked).toBe(false);
  } finally { blockedSave = null; block.release.resolve(); await pending; }
});
