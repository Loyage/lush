/** Runtime limits/capabilities and device system-page loading/re-entry lifecycle. */
import { block, button, el } from './dom.js';
import { show } from './messages.js';
import { pageBlocks, replacePageContent } from './page-modules.js';
import { ui } from './state.js';
import { renderNetworkSettings } from './agent-network-settings.js';
import { settingsClient } from './settings-api.js';
import { scopeSummary, scopeLabel, draftFingerprint } from './settings-scope.js';
import { renderSettingsMigration } from './settings-migration.js';
import { row } from './settings-controls.js';
// 运行设置可在浏览器里改写；范围与核心 RUNTIME_SETTINGS_LIMITS 一致，单位只用于展示。
const LIMIT_FIELDS = [
  { key: 'call_timeout', label: '单次调用超时', max: 86400, unit: '秒' },
  { key: 'task_call_limit', label: '单 Worker 调用上限', max: 1000, unit: '次' },
  { key: 'max_depth', label: '最大拆解深度', max: 64, unit: '层' },
];

/** 候选状态回写快照：保存 / 恢复成功后，不依赖下一次轮询就能重画出新值。 */
function runtimeFieldsEditor(runtime, fields, plain, note, client, repaint, ownsPage) {
  const box = el('div', undefined, 'settings-runtime');
  const grid = el('div', undefined, 'settings-runtime-grid');
  const inputs = {};
  for (const spec of fields) {
    const entry = runtime[spec.key] || {};
    const unit = spec.unit ? ` ${spec.unit}` : '';
    const cell = el('label', undefined, 'settings-runtime-field'); cell.dataset.runtimeField = spec.key;
    const input = el('input'); input.type = 'number'; input.min = '1'; input.max = String(spec.max); input.step = '1';
    input.className = 'settings-number'; input.dataset.runtimeInput = spec.key; input.value = plain(entry.value);
    input.setAttribute('aria-label', `${spec.label}（1..${spec.max}${spec.unit ? `，单位${spec.unit}` : ''}）`);
    const sourceText = { device: '设备配置', default: '环境默认' }[entry.source] || (entry.overridden ? '设备配置' : '环境默认');
    const source = el('span', sourceText, `settings-source${entry.overridden ? ' overridden' : ''}`);
    source.dataset.runtimeSource = spec.key;
    const state = el('span', `生效 ${plain(entry.value)}${unit} · 环境默认 ${plain(entry.default)}${unit} · ${sourceText}`, 'settings-note');
    state.dataset.runtimeState = spec.key;
    cell.append(el('span', spec.label, 'settings-field-label'), input, source, state);
    grid.append(cell); inputs[spec.key] = input;
  }
  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.runtimeError = '';
  const fail = message => { errorBox.textContent = message; errorBox.hidden = false; show(message, 'error'); };
  const actions = el('div', undefined, 'settings-runtime-actions');
  const save = button('保存', async () => {
    if (!ownsPage()) return;
    const patch = {};
    for (const spec of fields) {
      const raw = String(inputs[spec.key].value).trim();
      const value = Number(raw);
      const unit = spec.unit ? `（${spec.unit}）` : '';
      if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > spec.max) {
        fail(`${spec.label}${unit}需要 1 到 ${spec.max} 之间的整数。`); return;
      }
      patch[spec.key] = value;
    }
    errorBox.hidden = true;
    const draft = draftFingerprint(box);
    try {
      const saved = await client.action('system.configure', { settings: patch });
      if (!ownsPage()) return;
      show(`${scopeLabel()}${note}已保存；所有项目后续准入读取新配置，不打断当前调用。`);
      if (draft === draftFingerprint(box)) repaint(saved);
    } catch (error) { if (ownsPage()) fail(error.message); }
  }, 'primary settings-runtime-save', { busyLabel: '保存中…' });
  save.dataset.runtimeAction = 'save';
  const reset = button('恢复环境默认', async () => {
    if (!ownsPage()) return;
    errorBox.hidden = true;
    const settings = {}; for (const spec of fields) settings[spec.key] = null;
    const draft = draftFingerprint(box);
    try {
      const saved = await client.action('system.configure', { settings });
      if (!ownsPage()) return;
      show(`${note}已恢复环境默认。`); if (draft === draftFingerprint(box)) repaint(saved);
    } catch (error) { if (ownsPage()) fail(error.message); }
  }, 'ghost settings-runtime-reset', { busyLabel: '恢复中…', help: `只清除设备设置中${note}的这些键，回到环境／内置默认；不删除历史或中断调用` });
  reset.dataset.runtimeAction = 'reset';
  actions.append(save, reset);
  box.append(grid, actions, errorBox);
  return box;
}


function skillsLink() {
  const box = block('Skills');
  const link = el('a', '了解与管理 Skills', 'nav-link'); link.href = '/#skills';
  box.append(el('p', 'Lush 内置 Agent 能力已移至工作台独立页面；设备统一开关在 Skills 页面管理。', 'settings-note'), link);
  return box;
}

export function createSystemSettings({ isActive }) {
  let systemPage = null;
  function render() {
    if (systemPage?.view !== ui.view) systemPage = { view: ui.view, node: el('div', undefined, 'settings-scope-pane'), loaded: false, pending: null };
    const state = systemPage, content = el('div', undefined, 'settings-tab-panel'), client = settingsClient();
    const owns = () => ui.view === state.view && ui.settingsOpen && isActive();
    ui.clearSettingsSecrets = () => state.network?.clearSecrets?.();
    const plain = value => value == null || value === '' ? '—' : String(value);
    const paint = runtime => {
      if (!owns()) return;
      state.loaded = true;
      const limits = block('调用与拆解限额');
      limits.append(runtimeFieldsEditor(runtime, LIMIT_FIELDS, plain, '调用与拆解限额', client, paint, owns),
        row('设置文件', '设备唯一运行设置的保存位置。', el('code', plain(runtime.file), 'settings-path')));
      state.network ||= renderNetworkSettings({ ownsPage: owns, scope: 'device' });
      state.migration ||= renderSettingsMigration({ ownsPage: owns, onMigrated: async () => {
        state.loaded = false; const value = await client.read('/api/settings/runtime'); if (owns()) paint(value);
      } });
      replacePageContent(state.node, scopeSummary(runtime), limits, skillsLink(), state.network, state.migration,
        el('p', '项目运行状态、历史与后台控制在项目工作页管理；本页不会因配置读取启动项目。', 'settings-note'));
      pageBlocks(state.node, 'settings-system', 'fold');
    };
    function load() {
      if (state.loaded) return Promise.resolve(); if (state.pending) return state.pending;
      state.node.replaceChildren(el('p', '正在读取设备运行设置…', 'hint'));
      const pending = client.read('/api/settings/runtime').then(value => { if (owns()) { paint(value); return state.migration.ready; } })
        .catch(error => { if (owns()) state.node.replaceChildren(el('p', `读取设置失败：${error.message}`, 'settings-error'), button('重新读取设置', load, 'ghost', { busyLabel: '读取中…' })); })
        .finally(() => { state.pending = null; });
      state.pending = pending; return pending;
    }
    state.network?.resume?.(); content.append(state.node); load(); return content;
  }

  return { render, get pending() { return systemPage?.pending; } };
}
