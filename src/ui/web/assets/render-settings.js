/** System settings and the Agent settings subpanel used by Agent management. */
import { $, block, button, el } from './dom.js';
import { effectiveTheme, systemThemeMedia } from './appearance.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { PREF_NAMES, POLLING_MODES, THEME_VALUES, TOAST_MODES, TRANSCRIPT_ORDER_MODES, onPrefChange, readPref } from './prefs.js';
import * as devicePreferences from './prefs.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { SORT_MODES } from './tree-order.js';
import { notificationControl } from './notice-notifications.js';
import { createAgentConnectionPicker } from './agent-connection-picker.js';
import { renderNetworkSettings } from './agent-network-settings.js';
import { CONFIG_MODES, PI_MODE_HELP, normalizeConfigMode, profileForMode } from './agent-config-mode.js';
import { settingsClient, settingsClientFor } from './settings-api.js';
import { scopeSummary, scopeLabel, scopeImpact, draftFingerprint } from './settings-scope.js';
import { renderSettingsMigration } from './settings-migration.js';

const TABS = [
  { id: 'interface', label: '界面', note: '阅读、外观与行为' },
  { id: 'system', label: '系统', note: '运行参数与路径' },
];
let activeTab = 'interface';


let preferenceActions = devicePreferences;
let preferenceMessage = '', preferenceFailed = false, preferenceEpoch = 0, disposePreferenceStatus = null, settingsDocument = null;

export function openSettings({ preferenceActions: actions = devicePreferences } = {}) {
  disposePreferenceStatus?.(); disposePreferenceStatus = null;
  preferenceActions = actions; settingsDocument = globalThis.document;
  preferenceMessage = ''; preferenceFailed = false;
  const owner = settingsDocument, view = activateDetailView({ view: 'settings' }), epoch = ++preferenceEpoch;
  const rendering = renderSettings();
  if (typeof actions.onDevicePreferences === 'function') {
    disposePreferenceStatus = actions.onDevicePreferences(status => {
      if (globalThis.document === owner && epoch === preferenceEpoch && ui.view === view && ui.settingsOpen && activeTab === 'interface') updatePreferenceStatus($('detail'), status);
    });
  }
  return Promise.all([rendering, refreshPreferences(view, actions, epoch)]);
}

async function refreshPreferences(view, actions, epoch) {
  const owner = globalThis.document;
  if (typeof actions.refreshDevicePreferences !== 'function') return;
  try { await actions.refreshDevicePreferences(); }
  catch (error) { if (globalThis.document === owner && epoch === preferenceEpoch) preferenceFeedback(`读取设备偏好失败：${error.message}；未将本地缓存写回 Host。`, true, view); }
  finally {
    if (globalThis.document === owner && epoch === preferenceEpoch && ui.view === view && ui.settingsOpen && activeTab === 'interface') updatePreferenceStatus($('detail'), actions.devicePreferencesStatus?.());
  }
}

function preferenceHost(control, help = '设备权威偏好尚未就绪或正在保存；本地缓存不会作为保存来源。') {
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', help); host.append(control); return host;
}

function updatePreferenceStatus(root, status) {
  const note = root.querySelector('[data-device-preference-status=""]');
  if (note) {
    note.textContent = status?.error ? `设备偏好同步失败：${status.error}；可重新读取。`
      : status?.saving ? '正在保存设备偏好…'
      : status?.ready === false ? '正在读取设备权威偏好；当前仅显示缓存，读取完成前不能保存。'
      : status?.ready ? `设备权威偏好已读取${status.revision ? `（版本 ${status.revision}）` : ''}；本地浏览器只保留显示缓存。`
      : '设备偏好由 Host 保存；本地浏览器只保留显示缓存。';
    note.className = status?.error ? 'settings-error' : 'hint'; note.setAttribute('role', status?.error ? 'alert' : 'status');
  }
  const blocked = status?.ready === false || status?.saving === true;
  for (const control of [...root.querySelectorAll('input'), ...root.querySelectorAll('select')]) {
    if (Object.hasOwn(control.dataset, 'pref') && control.dataset.pref !== 'noticeNotifications') control.disabled = blocked || control.dataset.preferencePending === 'true';
  }
  const reset = root.querySelector('.pref-reset'); if (reset) reset.disabled = blocked || reset.dataset.preferencePending === 'true';
}


function preferenceFeedback(message, failed, view) {
  if (ui.view !== view || !ui.settingsOpen) return;
  preferenceMessage = message; preferenceFailed = failed;
  const note = $('detail').querySelector('[data-device-preference-feedback=""]');
  if (note) { note.textContent = message; note.className = failed ? 'settings-error' : 'hint'; note.setAttribute('role', failed ? 'alert' : 'status'); }
}

async function savePreference(name, value, input, view) {
  if (!ui.settingsOpen || ui.view !== view || input.disabled) return;
  const actions = preferenceActions, epoch = preferenceEpoch;
  input.dataset.preferencePending = 'true'; input.disabled = true; preferenceFeedback('正在保存设备偏好…', false, view);
  try {
    if (typeof actions.saveDevicePreference !== 'function') throw new Error('界面尚不支持设备偏好保存，请更新 Host');
    await actions.saveDevicePreference(name, value);
    if (epoch === preferenceEpoch) preferenceFeedback('设备偏好已保存，所有项目使用同一设置。', false, view);
  } catch (error) { if (epoch === preferenceEpoch) preferenceFeedback(`保存失败：${error.message}；未保存修改保留，未退回浏览器本地写入。`, true, view); }
  finally {
    delete input.dataset.preferencePending; input.disabled = false;
    if (epoch === preferenceEpoch && ui.view === view && ui.settingsOpen) updatePreferenceStatus($('detail'), actions.devicePreferencesStatus?.());
  }
}

function row(title, note, control) {
  const container = el('div', undefined, 'settings-row');
  const copy = el('div', undefined, 'settings-copy');
  copy.append(el('span', title, 'settings-name'));
  if (note) copy.append(el('span', note, 'settings-note'));
  container.append(copy, control);
  return container;
}

function toggleControl(name, onLabel = '开启', offLabel = '关闭') {
  const view = ui.view;
  const wrap = el('label', undefined, 'settings-toggle');
  const input = el('input'); input.type = 'checkbox'; input.className = 'pref-toggle'; input.dataset.pref = name;
  input.checked = Boolean(readPref(name));
  input.addEventListener('change', () => savePreference(name, input.checked, input, view));
  wrap.append(input, el('span', input.checked ? onLabel : offLabel));
  return preferenceHost(wrap);
}

function themeControl() {
  const view = ui.view;
  const group = el('div', undefined, 'settings-choices');
  const current = readPref('theme');
  const labels = { system: '跟随系统', light: '浅色', dark: '深色' };
  for (const value of THEME_VALUES) {
    const wrap = el('label', undefined, 'settings-choice');
    const input = el('input'); input.type = 'radio'; input.name = 'theme-preference'; input.className = 'pref-radio';
    input.dataset.pref = 'theme'; input.dataset.value = value; input.checked = current === value;
    input.addEventListener('change', () => input.checked ? savePreference('theme', value, input, view) : undefined);
    wrap.append(input, el('span', labels[value] ?? value)); group.append(preferenceHost(wrap));
  }
  return group;
}

function selectControl(name, modes, title) {
  const view = ui.view;
  const select = el('select'); select.className = 'pref-select'; select.dataset.pref = name;
  if (title) select.setAttribute('aria-label', title);
  for (const mode of modes) { const option = el('option', mode.label); option.value = mode.id; select.append(option); }
  select.value = readPref(name);
  select.addEventListener('change', () => savePreference(name, modes.some(mode => mode.id === select.value) ? select.value : modes[0]?.id, select, view));
  return preferenceHost(select);
}

function noticeChannelControl(type, label) {
  const view = ui.view;
  const group = el('div', undefined, 'settings-choices');
  for (const [channel, text] of [['banner', '页面告知条'], ['system', '系统通知']]) {
    const wrap = el('label', undefined, 'settings-choice');
    const input = el('input'); input.type = 'checkbox';
    input.dataset.pref = 'noticeChannels'; input.dataset.noticeType = type; input.dataset.channel = channel;
    input.checked = readPref('noticeChannels')[type][channel];
    input.setAttribute('aria-label', `${label}：${text}`);
    input.addEventListener('change', () => {
      const value = structuredClone(readPref('noticeChannels')); value[type][channel] = input.checked;
      return savePreference('noticeChannels', value, input, view);
    });
    wrap.append(input, el('span', text)); group.append(preferenceHost(wrap));
  }
  return group;
}

function interfaceTab() {
  const view = ui.view;
  const content = el('div', undefined, 'settings-tab-panel');
  const status = preferenceActions.devicePreferencesStatus?.(), epoch = preferenceEpoch, actions = preferenceActions;
  const statusNote = el('p', '', 'hint'); statusNote.dataset.devicePreferenceStatus = ''; content.append(statusNote);
  if (typeof actions.refreshDevicePreferences === 'function') content.append(button('重新读取设备偏好', () => {
    if (ui.view !== view || !ui.settingsOpen || epoch !== preferenceEpoch) return;
    preferenceFeedback('', false, view); return refreshPreferences(view, actions, epoch);
  }, 'ghost', { help: '只重新读取设备权威偏好，不将浏览器缓存写回 Host，不修改项目工作状态。' }));
  const feedback = el('p', preferenceMessage, preferenceFailed ? 'settings-error' : 'hint');
  feedback.dataset.devicePreferenceFeedback = ''; feedback.setAttribute('role', preferenceFailed ? 'alert' : 'status'); content.append(feedback);
  const reading = block('阅读');
  reading.append(row('Markdown 渲染', '控制 Agent 输出的展示方式。', toggleControl('markdown')));
  reading.append(row('执行过程排序', '全屏执行详情默认最新在前，也可在阅读页直接切换为按时间正序。', selectControl('transcriptOrder', TRANSCRIPT_ORDER_MODES, '执行过程阅读顺序')));
  content.append(reading);

  const system = systemThemeMedia();
  const appearance = block('外观');
  appearance.append(row('设备主题', `所有项目共用。系统当前${system?.matches ? '深色' : '浅色'}，实际显示${effectiveTheme() === 'dark' ? '深色' : '浅色'}。`, themeControl()));
  appearance.append(row('减少动态效果', `覆盖系统偏好（系统当前${system?.matches ? '已要求减少' : '未要求'}）。`, toggleControl('reduceMotion')));
  content.append(appearance);

  const navigation = block('导航');
  navigation.append(row('信息列表排序', '各项目的 Worker 与待决事项使用同一排序习惯。', selectControl('sidebarSort', SORT_MODES, '信息列表排序方式')));
  content.append(navigation);

  const behavior = block('刷新与提示');
  behavior.append(row('轮询频率', '控制页面快照与实时状态刷新；修改后立即生效。', selectControl('polling', POLLING_MODES, '页面自动刷新频率')));
  behavior.append(row('消息停留时长', '控制顶部信息与错误提示自动消失的速度。', selectControl('toastDuration', TOAST_MODES, '消息提示停留时长')));
  behavior.append(row('系统通知总开关', '设备统一开关，默认关闭；浏览器仍需单独授权通知权限。窗口打开期间提醒新事项，关闭期间不补发。', notificationControl()));
  content.append(behavior);

  const notices = block('告知渠道');
  notices.append(el('p', '所有项目统一使用这些页面告知条与系统通知偏好；系统通知还需设备总开关及当前浏览器权限。所有记录保留，不改变历史或未读列表计数。待决事项始终独立显示，不能用「已知」消除。', 'settings-note'));
  for (const [type, label, note] of [
    ['created', 'Worker 待开始', '仅创建 Worker 后等待手动开始；尚未调用 Agent。'],
    ['idle', 'Worker 本轮结束', 'Worker 已静息，不代表验收完成或已合并。'],
    ['analysis', '只读分析完成', '用户发起的只读分析已完成。'],
    ['failed', '异常停止', '超时、调用失败或后台中断等异常。'],
  ]) notices.append(row(label, note, noticeChannelControl(type, label)));
  content.append(notices);

  const reset = block('恢复界面默认');
  const resetButton = el('button', '恢复设备偏好默认', 'ghost pref-reset'); resetButton.type = 'button';
  resetButton.onclick = async () => {
    if (ui.view !== view || !ui.settingsOpen || resetButton.disabled) return;
    if (epoch !== preferenceEpoch) return;
    resetButton.dataset.preferencePending = 'true'; resetButton.disabled = true;
    try {
      if (typeof actions.resetDevicePreferences !== 'function') throw new Error('界面尚不支持设备偏好重置，请更新 Host');
      await actions.resetDevicePreferences(); if (epoch === preferenceEpoch) preferenceFeedback('设备偏好已恢复默认；项目工作状态保留。', false, view);
    } catch (error) { if (epoch === preferenceEpoch) preferenceFeedback(`恢复失败：${error.message}；未修改项目工作状态。`, true, view); }
    finally {
      delete resetButton.dataset.preferencePending; resetButton.disabled = false;
      if (epoch === preferenceEpoch && ui.view === view && ui.settingsOpen) updatePreferenceStatus($('detail'), actions.devicePreferencesStatus?.());
    }
  };
  resetButton.setAttribute('data-help', '恢复设备级外观、阅读与提醒偏好；不清项目节点折叠、具体过滤、草稿或 Agent 配置。');
  reset.append(row('恢复界面默认', '只恢复设备偏好，不重置项目的折叠、过滤、输入草稿或 Agent 配置。', preferenceHost(resetButton, resetButton.getAttribute('data-help'))));
  content.append(reset); updatePreferenceStatus(content, status);
  return content;
}

const thinkingLabel = value => value || 'CLI 默认';
function selectOptions(select, values, selected, label = value => value) {
  select.replaceChildren(...values.map(value => { const option = el('option', label(value)); option.value = value; return option; }));
  select.value = values.includes(selected) ? selected : '';
}

function field(label, control, note = '', extraClass = '') {
  const wrap = el('label', undefined, `agent-field${extraClass ? ` ${extraClass}` : ''}`);
  wrap.append(el('span', label, 'agent-field-label'), control);
  if (note) wrap.append(el('span', note, 'settings-note'));
  return wrap;
}

const modelCatalogs = new Map();

/**
 * Agent 配置页共享的已安装资源目录。优先读只读的 /api/agent/packages（含包管理与资源路径）；
 * 旧 daemon 没有该接口时退回 /api/agent/resources，只显示目录发现结果并说明安装管理不可用。
 * 打开页面只读本地，不联网安装、不查询额度、不调用 Agent。
 */
const packagesCatalogs = new Map();
const resourceValue = entry => entry?.path || entry?.id || '';
const resourceLabel = entry => entry?.name || entry?.label || String(resourceValue(entry)).split('/').at(-1) || '未命名资源';
const normalizeResourceEntries = rows => (Array.isArray(rows) ? rows : []).map(entry => ({
  value: resourceValue(entry), label: resourceLabel(entry),
  description: entry?.description || '', source: entry?.source || '', package_id: entry?.package_id || null,
})).filter(entry => entry.value);
async function loadPackagesCatalog(force = false, client) {
  let packagesCatalog = packagesCatalogs.get(client.key);
  if (!force && packagesCatalog) return packagesCatalog;
  try {
    const data = await client.read('/api/agent/packages');
    if (data?.version !== 1 || !Array.isArray(data.packages)) throw new Error('接口数据格式不兼容');
    const resources = data.resources || {};
    packagesCatalog = { source: 'packages', installable: true, packages: data.packages,
      resources: { extensions: normalizeResourceEntries(resources.extensions), skills: normalizeResourceEntries(resources.skills) },
      warning: data.warning || null };
  } catch (error) {
    try {
      const legacy = await client.read('/api/agent/resources');
      packagesCatalog = { source: 'resources', installable: false,
        packages: Array.isArray(legacy.packages) ? legacy.packages : [],
        resources: { extensions: normalizeResourceEntries(legacy.extensions), skills: normalizeResourceEntries(legacy.skills) },
        warning: `已安装包管理不可用（${error.message}）；仅显示本地目录发现到的资源，安装 / 移除 / 更新暂不可用。` };
    } catch (second) {
      packagesCatalog = { source: 'resources', installable: false, packages: [],
        resources: { extensions: [], skills: [] }, warning: `资源目录读取失败：${second.message}` };
    }
  }
  packagesCatalogs.set(client.key, packagesCatalog);
  return packagesCatalog;
}

/** 禁用按钮不派发事件，提示必须由外层 `.help-host` 承载；可点按钮直接返回原按钮。 */
function guardedButton(label, enabled, reason, fn, className = 'ghost') {
  const node = button(label, fn, className);
  if (enabled) return node;
  node.disabled = true;
  const host = el('span', undefined, 'help-host'); host.setAttribute('data-help', reason); host.append(node);
  return host;
}

/** 客户端先拒绝未固定版本的远端来源；后端仍会再校验，这里只负责尽早给出可操作的提示。 */
function fixedSourceError(source) {
  const value = String(source || '').trim();
  if (!value) return '请填写安装来源。';
  if (/^npm:(?:@[^/@\s]+\/)?[^@/\s]+@[^@\s]+$/.test(value)) return null;
  if (value.startsWith('npm:')) return 'npm 包必须固定版本，例如 npm:@example/pi-tools@1.0.0；不接受浮动版本。';
  if (/^git:[^\s@]+@[^\s@]+$/.test(value)) return null;
  if (value.startsWith('git:')) return 'git 来源必须固定 commit 或 tag，例如 git:github.com/example/pi-tools@v1。';
  if (/^https?:\/\/[^\s@/]+\/[^\s@]+@[^\s@]+$/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) return '远端 URL 按 git 来源处理，必须固定 commit 或 tag，例如 https://github.com/example/pi-tools@v1。';
  if (/^(\.\.?\/|\/|~\/)/.test(value)) return null;
  return '不支持的来源；请使用固定版本的 npm:、固定 commit/tag 的 git:，或显式本地路径。';
}

function profileEditor(settings, profile, target, title, subtitle, repaint, ownsPage, savedSummary = null, names = new Map()) {
  const client = settingsClientFor(settings);
  let packagesCatalog = packagesCatalogs.get(client.key);
  const card = el('section', undefined, 'agent-profile'); card.dataset.agentTarget = target;
  const head = el('div', undefined, 'agent-profile-head');
  const copy = el('div'); copy.append(el('h3', title), el('p', subtitle, 'settings-note'));
  head.append(copy, el('span', target === 'default' ? '设备默认' : '独立覆盖', 'badge b-neutral')); card.append(head);

  const form = el('div', undefined, 'agent-form-grid');
  const runtime = el('section', undefined, 'agent-config-section'); runtime.append(el('h4', '模型与运行'));
  const managedFields = [];
  const managedField = (label, control, note, extraClass) => {
    const node = field(label, control, note, extraClass); node.dataset.agentManaged = 'true'; managedFields.push(node); return node;
  };
  const mode = el('select'); mode.className = 'agent-select'; mode.dataset.agentField = 'config_mode';
  for (const item of CONFIG_MODES) { const option = el('option', item.label); option.value = item.id; option.title = item.note; mode.append(option); }
  mode.value = normalizeConfigMode(profile.config_mode);
  const modeNote = el('span', undefined, 'settings-note');
  const modeField = field('配置模式', mode, '', 'config-mode-field'); modeField.append(modeNote);
  let lushBackend = settings.options.agents.includes(profile.agent) ? profile.agent : 'pi';
  const workstyle = el('details', undefined, 'agent-config-section'); workstyle.append(el('summary', '工作方式：Prompt、扩展与 Skills'));
  const advanced = el('details', undefined, 'agent-config-section'); advanced.append(el('summary', '高级设置：替换内置 Prompt'));
  const backend = el('select'); backend.className = 'agent-select'; backend.dataset.agentField = 'agent';
  selectOptions(backend, settings.options.agents, profile.agent, value => value === 'pi' ? 'Pi' : 'Codex');
  const model = el('input'); model.className = 'agent-model'; model.dataset.agentField = 'model'; model.value = profile.model || '';
  model.maxLength = 256;
  const connectionPicker = createAgentConnectionPicker({ backend, model, connectionId: profile.connection_id || '',
    ownsPage, read: client.read, readLabel: '读取设备来源', onChange: () => { paintModels(); if (backend.value === 'pi' && normalizeConfigMode(mode.value) === 'lush') syncThinking(false); } });
  const connection = connectionPicker.connection; connection.dataset.agentField = 'connection_id';
  const thinking = el('select'); thinking.className = 'agent-select'; thinking.dataset.agentField = 'thinking';
  const budgetControls = {};
  for (const [key, max] of [['responses', 10000], ['tokens', 1000000000]]) {
    const input = el('input'); input.type = 'number'; input.min = '1'; input.max = String(max); input.step = '1';
    input.dataset.agentField = `budget_${key}`; input.value = String(profile.soft_budget?.[key] ?? '');
    input.placeholder = '关闭'; input.disabled = ['explainer','butler'].includes(target); budgetControls[key] = input;
  }

  const loadModels = el('button', '读取 CLI 模型', 'ghost model-load'); loadModels.type = 'button';
  loadModels.setAttribute('data-help', '只读取执行机器的 Codex CLI 模型目录，不调用模型；保留当前名称输入。');
  connectionPicker.actions.append(loadModels);

  const paintModels = () => {
    const agent = backend.value;
    if (savedSummary) {
      const saved = settings.default, row = connectionPicker.entry();
      const source = saved.agent === 'pi' ? (saved.connection_id
        ? (row?.id === saved.connection_id ? row.label : names.get(saved.connection_id) || `托管来源 ${saved.connection_id}`) : '未选择来源') : 'Codex CLI 自身认证';
      savedSummary.textContent = normalizeConfigMode(saved.config_mode) === 'pi'
        ? `Pi 默认配置（执行机器 Pi）· 设备默认（已保存），下一次调用生效`
        : `${saved.agent === 'pi' ? 'Pi' : 'Codex'} → ${source} → ${saved.model || (saved.agent === 'pi' ? '请选择来源内模型' : 'CLI 默认模型')} · 设备默认（已保存），下一次调用生效`;
    }
    loadModels.hidden = agent === 'pi';
    if (agent === 'pi') {
      connectionPicker.modelExtras.replaceChildren();
      loadModels.disabled = true; return;
    }
    loadModels.disabled = false;
    const values = new Map((settings.options.models[agent] || []).map(id => [id, id]));
    const catalog = modelCatalogs.get(`${client.key}:${agent}`);
    for (const entry of catalog?.models || []) values.set(entry.id, entry.label && entry.label !== entry.id ? `${entry.label} · ${entry.id}` : entry.id);
    connectionPicker.setCliModels([...values].map(([id, label]) => ({ id, label })));
    connectionPicker.modelExtras.replaceChildren(...(catalog ? [el('span', catalog.warning || `已从本机 ${agent} CLI 读取当前可用模型。`, `model-catalog-note${catalog.warning ? ' warning' : ''}`)] : []));
  };

  const selectedExtensions = new Set(profile.extensions || []);
  const selectedSkills = new Set(profile.skills || []);
  const resourcesBox = el('div', undefined, 'agent-resources-box');
  const resourcesHead = el('div', undefined, 'agent-resources-head');
  const loadResources = el('button', '读取已安装项', 'ghost resource-load'); loadResources.type = 'button';
  const resourcesNote = el('span', undefined, 'settings-note');
  const resourceChoices = el('div', undefined, 'resource-choices');
  resourcesHead.append(loadResources, resourcesNote); resourcesBox.append(resourcesHead, resourceChoices);

  const paintResourceGroup = (title, entries, selected, kind) => {
    const group = el('fieldset', undefined, 'resource-group');
    group.append(el('legend', `${title}（${entries.length}）`));
    const known = new Set(entries.map(entry => entry.value));
    const rows = [...entries];
    for (const value of selected) if (!known.has(value)) rows.push({ value, label: value.split('/').at(-1), source: '已配置但当前未发现，请核对入口路径或取消勾选', missing: true });
    if (!rows.length) group.append(el('p', '没有发现可选项。', 'settings-note'));
    for (const entry of rows) {
      const wrap = el('label', undefined, `resource-choice${entry.missing ? ' missing' : ''}`);
      const input = el('input'); input.type = 'checkbox'; input.dataset.resourceKind = kind; input.value = entry.value;
      input.checked = selected.has(entry.value); input.disabled = backend.value !== 'pi' || mode.value === 'pi';
      input.addEventListener('change', () => input.checked ? selected.add(entry.value) : selected.delete(entry.value));
      const copy = el('span'); copy.append(el('strong', entry.label), el('small', entry.description || entry.source || 'Pi 资源'), el('small', entry.value));
      wrap.append(input, copy); group.append(wrap);
    }
    return group;
  };
  const paintResources = () => {
    const pi = backend.value === 'pi' && mode.value === 'lush';
    loadResources.disabled = !pi;
    if (mode.value === 'pi') {
      resourcesNote.textContent = 'Pi 默认配置由执行机器的 Pi 目录自行决定资源，这里不注入 Lush 的扩展与 Skills。';
    } else if (!pi) {
      resourcesNote.textContent = 'Pi 扩展与 Skills 不会传给 Codex；选择会保留，切回 Pi 后生效。';
    } else if (packagesCatalog?.warning) resourcesNote.textContent = packagesCatalog.warning;
    else resourcesNote.textContent = packagesCatalog
      ? '只列出插件声明的扩展入口，不必勾选目录内所有脚本；独立 MCP 服务不是 Pi 扩展。只加载显式勾选的资源；扩展拥有当前用户的完整系统权限，不是沙箱。安装与移除在页面顶部的「已安装插件与 Skills」里进行。'
      : '按需读取设备 Lush 独立 Pi 目录中的已安装资源；安装与移除在页面顶部的「已安装插件与 Skills」里进行。';
    resourceChoices.replaceChildren(...(packagesCatalog?.resources ? [
      paintResourceGroup('扩展', packagesCatalog.resources.extensions || [], selectedExtensions, 'extensions'),
      paintResourceGroup('Skills', packagesCatalog.resources.skills || [], selectedSkills, 'skills'),
    ] : []));
  };
  loadResources.onclick = async () => {
    loadResources.disabled = true; loadResources.textContent = '读取中…';
    try { packagesCatalog = await loadPackagesCatalog(true, client); if (ownsPage()) paintResources(); }
    catch (error) { if (ownsPage()) show(error.message, 'error'); }
    finally { if (ownsPage()) { loadResources.textContent = '重新读取'; loadResources.disabled = backend.value !== 'pi' || mode.value === 'pi'; } }
  };

  // 思考深度：目录确有元数据时收窄到该模型声明的等级；已保存值不被静默丢弃，未知时保留原选项。
  const syncThinking = (clear, chosen = undefined) => {
    const agent = backend.value;
    let levels = settings.options.thinking[agent] || [''];
    const current = clear ? '' : (chosen ?? (thinking.value || profile.thinking));
    const supported = agent === 'pi' ? connectionPicker.thinkingLevels?.() : null;
    if (supported) {
      levels = ['', ...supported];
      // 目录未声明的已保存等级仍保留为可选项，不静默改写成别的等级。
      if (current && !levels.includes(current)) levels.push(current);
    }
    selectOptions(thinking, levels, current, thinkingLabel);
  };
  const syncBackend = clear => {
    const agent = backend.value;
    if (clear) { model.value = ''; thinking.value = ''; }
    model.placeholder = agent === 'pi' ? '请选择来源内模型（provider/model）' : 'Codex CLI 默认模型';
    connectionPicker.sync();
    syncThinking(clear);
    paintModels(); paintResources();
  };
  backend.addEventListener('change', () => syncBackend(true));
  loadModels.onclick = async () => {
    if (!ownsPage() || backend.value === 'pi' || connectionPicker.value()) return;
    const agent = backend.value;
    loadModels.disabled = true; loadModels.textContent = '读取中…';
    try {
      const catalog = await client.read(`/api/agent/models?agent=${encodeURIComponent(agent)}`);
      if (!ownsPage()) return;
      modelCatalogs.set(`${client.key}:${agent}`, catalog); paintModels();
    } catch (error) { if (ownsPage()) show(error.message, 'error'); }
    finally { if (ownsPage()) { paintModels(); loadModels.textContent = '重新读取'; } }
  };

  // 来源与模型共用一组，不能再包在含多个控件的 label 内。
  connectionPicker.node.dataset.agentManaged = 'true'; managedFields.push(connectionPicker.node);
  // 执行后端始终可见（切换配置模式时它的可选范围会变），其余托管字段随模式整体隐藏。
  runtime.append(modeField,
    field('执行后端', backend, '执行该类 Worker 的 CLI；Pi 默认配置模式下固定为 Pi。'),
    connectionPicker.node,
    managedField('思考深度', thinking, '可用等级随 Agent 与来源模型变化。'),
    managedField('软预算：模型响应数', budgetControls.responses, '每次 invocation 单独计数；达到阈值提醒收尾，不强制终止。仅 Pi；解释角色不继承。'),
    managedField('软预算：累计 token', budgetControls.tokens, '包含缓存读取，非上下文长度；留空关闭。Codex 不支持，切换前需清空。'));

  const roleDefaults = settings.options.default_prompts || null;
  const builtInPrompt = target === 'default' && roleDefaults ? '' : (roleDefaults?.[target] || settings.options.default_prompt || '');
  const defaultPrompt = el('textarea'); defaultPrompt.className = 'agent-prompt'; defaultPrompt.dataset.agentField = 'default_prompt'; defaultPrompt.rows = 12;
  defaultPrompt.maxLength = 32768; defaultPrompt.value = profile.default_prompt || builtInPrompt;
  defaultPrompt.placeholder = target === 'default' && roleDefaults ? '留空：每个角色使用自己的内置组合' : 'Lush 内置角色 Prompt';
  const promptTools = el('div', undefined, 'prompt-field-tools');
  const promptState = el('span', undefined, 'settings-note');
  const restorePrompt = button('恢复默认 Prompt', () => {
    defaultPrompt.value = builtInPrompt;
    promptState.textContent = target === 'default' && roleDefaults
      ? '已恢复为按角色组合内置 Prompt；保存后生效。' : '已恢复为该角色的内置 Prompt；保存后生效。';
  }, 'ghost prompt-reset', { help: '用 Lush 内置 Prompt 覆盖输入框里的现有内容；需要保存配置才真正生效' });
  restorePrompt.type = 'button';
  promptTools.append(promptState, restorePrompt);
  const syncPromptState = () => {
    promptState.textContent = defaultPrompt.value.trim() === builtInPrompt.trim()
      ? (target === 'default' && roleDefaults ? '当前按角色使用各自的内置 Prompt。' : '当前显示该角色的内置 Prompt。')
      : '当前内容会替换 Lush 内置 Prompt。';
  };
  defaultPrompt.addEventListener('input', syncPromptState); syncPromptState();
  const risk = el('div', undefined, 'prompt-risk');
  risk.append(el('strong', '修改会替换内置 Prompt'), el('span', 'Agent 可能失去 Lush 的 Worker 协议、权限边界、协作方式和交付要求，导致调用失败或错误操作。需要撤销修改时可恢复默认。'));
  const defaultPromptBox = el('div', undefined, 'prompt-field-box'); defaultPromptBox.append(defaultPrompt, promptTools, risk);
  advanced.append(field('默认 Prompt', defaultPromptBox, target === 'default' && roleDefaults
    ? '留空时每个角色使用自己的内置组合；填写后会用同一内容替换所有继承角色。'
    : '这里显示该角色实际生效的基础 Prompt；保存内置内容时仍以默认配置存储。', 'prompt-field'));

  const appendPrompt = el('textarea'); appendPrompt.className = 'agent-prompt'; appendPrompt.dataset.agentField = 'append_prompt'; appendPrompt.rows = 4;
  appendPrompt.maxLength = 32768; appendPrompt.value = profile.append_prompt ?? profile.prompt ?? '';
  appendPrompt.placeholder = '例如：优先保持改动小而可审阅；完成后运行移动端 UI 检查。';
  workstyle.append(field('追加 Prompt', appendPrompt, '追加在最终默认 Prompt 之后，适合补充项目约定。', 'prompt-field'),
    field('插件与 Skills', resourcesBox, '从 Lush 独立 Pi 目录发现资源；保留显式配置的资源路径，每个 Agent 配置独立保存。', 'resource-field'));
  form.append(runtime, workstyle, advanced);
  const syncMode = clearManaged => {
    const lush = normalizeConfigMode(mode.value) === 'lush';
    card.dataset.configMode = lush ? 'lush' : 'pi';
    if (lush) {
      if (backend.value === 'pi' && lushBackend !== 'pi') { backend.value = lushBackend; syncBackend(false); }
      backend.disabled = false;
    } else {
      if (backend.value !== 'pi') lushBackend = backend.value;
      backend.value = 'pi';
      backend.disabled = true;
      if (clearManaged) {
        model.value = ''; thinking.value = '';
        for (const input of Object.values(budgetControls)) input.value = '';
        defaultPrompt.value = ''; appendPrompt.value = '';
        selectedExtensions.clear(); selectedSkills.clear(); syncPromptState();
        connectionPicker.reset('');
      }
    }
    for (const node of managedFields) node.hidden = !lush;
    workstyle.hidden = !lush;
    advanced.hidden = !lush;
    modeNote.textContent = lush
      ? '使用 Lush 托管的模型来源、模型、思考深度、Prompt 与资源；对自己的配置掌握力更强。'
      : PI_MODE_HELP;
    paintModels(); paintResources(); syncThinking(!lush);
  };
  mode.addEventListener('change', () => syncMode(true));
  card.append(form); syncBackend(false); syncMode(normalizeConfigMode(profile.config_mode) === 'pi');
  void connectionPicker.load();

  const actions = el('div', undefined, 'agent-profile-actions');
  actions.append(button('保存配置', async () => {
    if (!ownsPage()) return;
    const selectedMode = normalizeConfigMode(mode.value);
    let nextDefaultPrompt = '';
    if (selectedMode === 'lush') {
      const connectionError = connectionPicker.validate();
      if (connectionError) { show(connectionError, 'error'); return; }
      const enteredDefaultPrompt = defaultPrompt.value.trim();
      nextDefaultPrompt = enteredDefaultPrompt === builtInPrompt.trim() ? '' : enteredDefaultPrompt;
      if (nextDefaultPrompt && nextDefaultPrompt !== (profile.default_prompt || '')) {
        const confirmed = await confirmDialog({ title: '替换 Lush 内置 Prompt？',
          message: '保存后，下一次 Agent 调用将不再收到 Lush 内置 Worker 规则。',
          detail: '可能影响：Worker API 使用、权限边界、子 Worker 协作、工作区安全和交付流程。\n请确认你的 Prompt 已完整覆盖这些要求。',
          confirmLabel: '仍然替换并保存', danger: true });
        if (!confirmed || !ownsPage()) return;
      }
    }
    const chosenConnection = selectedMode === 'lush' && backend.value === 'pi' ? connection.value : '';
    // Pi 默认模式只提交后端与模式；托管来源、模型、思考深度、Prompt、资源与预算全部丢弃。
    const next = profileForMode(selectedMode, {
      agent: backend.value, model: model.value.trim(), thinking: thinking.value,
      ...(chosenConnection ? { connection_id: chosenConnection } : {}),
      default_prompt: nextDefaultPrompt, append_prompt: appendPrompt.value.trim(),
      extensions: [...selectedExtensions], skills: [...selectedSkills],
      soft_budget: Object.fromEntries(Object.entries(budgetControls).filter(([, input]) => input.value.trim() !== '')
        .map(([key, input]) => [key, Number(input.value)])),
    });
    const roles = { ...settings.roles };
    const config = target === 'default'
      ? { version: 1, default: next, roles }
      : { version: 1, default: settings.default, roles: { ...roles, [target]: next } };
    const draft = draftFingerprint(card);
    const saved = await client.action('agent.configure', { config });
    if (!ownsPage()) return;
    show(`${title}已保存；正在运行的调用不受影响，下一次调用使用新配置。`);
    if (draft === draftFingerprint(card)) repaint(saved);
    else { Object.assign(settings, saved); show('配置已保存；保留你随后输入的未保存修改。'); }
  }));
  if (target !== 'default') actions.append(button('恢复继承默认', async () => {
    const roles = { ...settings.roles }; delete roles[target];
    if (!ownsPage()) return;
    const saved = await client.action('agent.configure', { config: { version: 1, default: settings.default, roles } });
    if (!ownsPage()) return;
    show(`${title}已恢复继承设备默认配置。`); repaint(saved);
  }, 'ghost', { help: '删除这个角色的单独配置，立即改回继承当前编辑层的默认 Agent 配置' }));
  card.append(actions);
  return card;
}

function inheritedRole(settings, role, repaint, names = new Map(), ownsPage = () => true) {
  const client = settingsClientFor(settings);
  const meta = settings.options.roles.find(item => item.id === role) || { id: role, label: role };
  const resolved = settings.resolved[role];
  const card = el('section', undefined, 'agent-role-summary'); card.dataset.agentTarget = role;
  const copy = el('div', undefined, 'agent-role-copy');
  const named = resolved.connection_id ? (names.get(resolved.connection_id) || resolved.connection_id) : '';
  const source = resolved.agent === 'pi' ? (named ? `来源 ${named}` : '未选择来源') : 'Codex CLI 自身认证';
  const summary = normalizeConfigMode(resolved.config_mode) === 'pi' ? 'Pi 默认配置（执行机器 Pi）'
    : `${resolved.agent} · ${source} · ${resolved.model || (resolved.agent === 'pi' ? '请选择来源内模型' : 'CLI 默认模型')} · ${thinkingLabel(resolved.thinking)}`;
  copy.append(el('h3', meta.label), el('p', summary, 'settings-note'));
  card.append(copy, el('span', '继承默认', 'badge b-neutral'), button('单独配置', async () => {
    if (!ownsPage()) return;
    const saved = await client.action('agent.configure', { config: { version: 1, default: settings.default,
      roles: { ...settings.roles, [role]: { ...resolved } } } });
    if (!ownsPage()) return;
    repaint(saved);
  }, 'ghost', { help: '为这个角色建立独立配置；保存后不再跟随默认配置一起变化' }));
  return card;
}

const environmentTargets = new Map();
const environmentModels = new Map();
const environmentDrafts = new Map();

function environmentRows(model, key) {
  if (!environmentDrafts.has(key)) environmentDrafts.set(key, Object.entries(model.values || {}).map(([name, value]) => ({ name, value, visible: false })));
  return environmentDrafts.get(key);
}

async function loadEnvironment(target, force = false, client, active = () => true) {
  const key = `${client.key}:${target}`;
  if (!force && environmentModels.has(key)) return environmentModels.get(key);
  const model = await client.read(`/api/agent/environment?target=${encodeURIComponent(target)}`);
  if (!active()) return model;
  environmentModels.set(key, model); environmentDrafts.delete(key); return model;
}

function environmentEditor(settings, repaint, ownsPage) {
  const client = settingsClientFor(settings), selectedTarget = environmentTargets.get(client.key) || 'common', key = `${client.key}:${selectedTarget}`;
  const active = () => ownsPage() && (environmentTargets.get(client.key) || 'common') === selectedTarget && client.isCurrent();
  const section = block('环境变量'); section.classList.add('agent-env-block');
  section.append(el('p', '按需读取并编辑 Agent 子进程环境。值返回浏览器后默认遮罩；公共变量先加载，角色变量随后覆盖。保存会规范化 env 文件并移除原注释与排序。', 'settings-note settings-section-note'));

  const toolbar = el('div', undefined, 'agent-env-toolbar');
  const target = el('select'); target.className = 'agent-env-target'; target.dataset.envTarget = '';
  const targets = [{ id: 'common', label: '公共 · agent.env' }, ...settings.options.roles.filter(item => item.id === 'agent').map(item => ({ id: item.id, label: `${item.label} · ${item.id}.env` }))];
  for (const item of targets) { const option = el('option', item.label); option.value = item.id; target.append(option); }
  target.value = selectedTarget;
  target.addEventListener('change', () => { if (!active()) return; environmentTargets.set(client.key, target.value); repaint(); });
  const model = environmentModels.get(key);
  const load = button(model ? '重新读取' : '读取变量', async () => {
    if (!active()) return;
    load.disabled = true; load.textContent = '读取中…';
    try { await loadEnvironment(selectedTarget, true, client, active); if (active()) repaint(); }
    catch (error) { if (active()) { show(error.message, 'error'); load.disabled = false; load.textContent = model ? '重新读取' : '读取变量'; } }
  }, 'ghost agent-env-load');
  load.type = 'button';
  toolbar.append(target, load); section.append(toolbar);

  if (!model) {
    section.append(el('p', '尚未把变量值读入浏览器。点击“读取变量”后可编辑；读取与写入仅允许用户会话，Agent token 无权访问。', 'settings-readonly settings-note agent-env-empty'));
    return section;
  }

  section.append(scopeSummary(model, client.scope));
  const rows = environmentRows(model, key);
  const list = el('div', undefined, 'agent-env-list');
  if (!rows.length) list.append(el('p', '这个文件还没有变量。', 'settings-note agent-env-empty'));
  rows.forEach((entry, index) => {
    const line = el('div', undefined, 'agent-env-row'); line.dataset.envRow = String(index);
    const name = el('input'); name.value = entry.name; name.placeholder = 'VARIABLE_NAME'; name.maxLength = 256;
    name.className = 'agent-env-name'; name.dataset.envName = String(index); name.autocomplete = 'off';
    name.addEventListener('input', () => { entry.name = name.value; });
    const value = el('input'); value.type = entry.visible ? 'text' : 'password'; value.value = entry.value; value.placeholder = '值';
    value.className = 'agent-env-value'; value.dataset.envValue = String(index); value.autocomplete = 'off';
    value.addEventListener('input', () => { entry.value = value.value; });
    const reveal = button(entry.visible ? '隐藏' : '显示', () => {
      entry.visible = !entry.visible; value.type = entry.visible ? 'text' : 'password'; reveal.textContent = entry.visible ? '隐藏' : '显示';
    }, 'ghost agent-env-reveal', { help: entry.visible ? '重新遮罩这条环境变量的值；不改变保存内容' : '以明文显示这条环境变量的值；不改变保存内容' }); reveal.type = 'button';
    const remove = button('删除', () => { rows.splice(index, 1); repaint(); }, 'ghost agent-env-remove',
      { help: '从编辑列表移除这条变量；保存环境变量后才会真正删除' }); remove.type = 'button';
    line.append(name, value, reveal, remove); list.append(line);
  });
  section.append(list);

  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.envError = '';
  const fail = message => { errorBox.textContent = message; errorBox.hidden = false; show(message, 'error'); };
  const actions = el('div', undefined, 'agent-env-actions');
  const add = button('新增变量', () => { rows.push({ name: '', value: '', visible: false }); repaint(); }, 'ghost'); add.type = 'button'; add.dataset.envAction = 'add';
  const save = button('保存环境变量', async () => {
    if (!active()) return;
    const values = {};
    for (const [index, entry] of rows.entries()) {
      const name = entry.name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { fail(`第 ${index + 1} 行的变量名无效。`); return; }
      if (name.startsWith('LUSH_')) { fail(`${name} 由 Lush 保留，不能在这里覆盖。`); return; }
      if (Object.hasOwn(values, name)) { fail(`变量名重复：${name}`); return; }
      values[name] = entry.value;
    }
    errorBox.hidden = true; save.disabled = true;
    const savingTarget = selectedTarget;
    try {
      const saved = await client.action('agent.environment.configure', { target: savingTarget, values });
      if (!active()) return;
      environmentModels.set(key, saved); environmentDrafts.delete(key);
      show(`${scopeLabel(client.scope)}环境变量已保存；下一次 Agent 调用生效。`); repaint();
    } catch (error) { fail(error.message); save.disabled = false; }
  }, 'primary'); save.type = 'button'; save.dataset.envAction = 'save';
  actions.append(add, save, el('code', model.file, 'settings-path agent-env-path'));
  section.append(actions, errorBox);
  return section;
}

const PACKAGE_SOURCE_HELP = '安装到设备的 Lush 独立 Pi 目录，不改用户默认 Pi。来源必须固定版本：npm:name@1.0.0、git:host/repo@commit-or-tag，或显式本地路径（./、../、/、~/）。安装不会自动启用，也不会调用 Agent。';

/** 项目级插件与 Skills 安装管理：安装与启用分开，安装 / 更新 / 移除都不调用 Agent。 */
function packagesManager(ownsPage, client) {
  let packagesCatalog = packagesCatalogs.get(client.key);
  const section = block('已安装插件与 Skills'); section.classList.add('agent-packages');
  section.append(el('p', `安装库属于${scopeLabel(client.scope)}的 Lush 独立 Pi 目录，不改用户默认 Pi。安装与启用分开：安装不会自动勾选任何 Agent 的扩展 / Skills，启用仍在各 Agent 配置的“工作方式”里选择。设备库的移除/更新会影响其他项目使用的相同路径；不调用 Agent 或模型。`, 'settings-note settings-section-note'));
  const warning = el('p', undefined, 'settings-warning'); warning.hidden = true; warning.dataset.packageWarning = '';
  const toolbar = el('div', undefined, 'agent-package-toolbar');
  const state = el('span', undefined, 'settings-note'); state.dataset.packageState = '';
  const list = el('div', undefined, 'agent-package-list'); list.dataset.packageList = '';
  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.packageError = '';
  const source = el('input'); source.type = 'text'; source.className = 'agent-package-source'; source.dataset.packageSource = '';
  source.placeholder = 'npm:@example/pi-tools@1.0.0 或 git:github.com/example/pi-tools@v1 或 ./local-package';
  source.maxLength = 512; source.spellcheck = false; source.autocomplete = 'off';
  source.setAttribute('aria-label', '要安装的 Pi 包来源（必须固定版本）');
  const installRow = el('div', undefined, 'agent-package-install'); installRow.append(source);
  const fail = message => { errorBox.textContent = message; errorBox.hidden = false; };
  const clearInstall = () => { for (const node of [...installRow.children]) if (node !== source) node.remove(); };
  let pending = false;
  const reload = button('读取已安装包', () => load(true), 'ghost agent-package-load',
    { help: '读取设备 Lush 独立 Pi 目录中的已安装包与资源；只读本地，不联网安装、不查询额度、不调用 Agent。' });
  toolbar.append(reload, state);
  async function load(force) {
    if (!ownsPage() || pending) return;
    pending = true; reload.disabled = true; reload.textContent = '读取中…';
    try { packagesCatalog = await loadPackagesCatalog(force, client); if (ownsPage()) paint(); }
    catch (error) { if (ownsPage()) fail(error.message); }
    finally { pending = false; if (ownsPage()) { reload.disabled = false; reload.textContent = '重新读取'; } }
  }
  const mutate = async (method, params, success) => {
    errorBox.hidden = true;
    try {
      if (!ownsPage()) return false;
      await client.action(method, params);
      packagesCatalog = await loadPackagesCatalog(true, client);
      if (ownsPage()) { paint(); show(success); }
      return true;
    } catch (error) { if (ownsPage()) fail(error.message); return false; }
  };
  const removePackage = async (entry, label) => {
    const confirmed = await confirmDialog({ title: '移除已安装包？',
      message: `将从${scopeLabel(client.scope)}的 Lush 独立 Pi 安装库移除“${label}”。`,
      detail: '不会删除用户默认 Pi 的安装，也不会取消各 Agent 已勾选的启用路径；找不到的显式路径会保留为“已配置但当前未发现”。',
      confirmLabel: '移除该包', danger: true });
    if (!confirmed || !ownsPage()) return;
    await mutate('agent.packages.remove', { id: entry.id }, `已移除 ${label}。`);
  };
  const install = async () => {
    const value = source.value.trim();
    const invalid = fixedSourceError(value);
    if (invalid) { fail(invalid); return; }
    if (await mutate('agent.packages.install', { source: value }, `已安装 ${value}；安装不会自动启用，请在 Agent 配置的「工作方式」里勾选。`)) source.value = '';
  };
  const packageRow = entry => {
    const row = el('div', undefined, 'agent-package-row');
    const copy = el('div', undefined, 'agent-package-copy');
    const label = entry.label || entry.source || entry.id || '未命名包';
    copy.append(el('strong', label));
    if (entry.label && entry.source) copy.append(el('small', `来源：${entry.source}`));
    const meta = [entry.version ? `版本 ${entry.version}` : null, entry.requested ? `引用 ${entry.requested}` : null, entry.root || null].filter(Boolean).join(' · ');
    if (meta) copy.append(el('small', meta));
    if (packagesCatalog?.source === 'packages') {
      const extensions = packagesCatalog.resources.extensions.filter(resource => resource.package_id === entry.id);
      const skills = packagesCatalog.resources.skills.filter(resource => resource.package_id === entry.id);
      const details = el('details'); details.dataset.packageResources = '';
      details.append(el('summary', `可启用资源：${extensions.length} 个扩展 · ${skills.length} 个 Skill`));
      for (const [kind, resources] of [['扩展入口', extensions], ['Skill', skills]]) {
        for (const resource of resources) details.append(el('p', `${kind}：${resource.label}`), el('code', resource.value, 'settings-path'));
      }
      details.append(el('p', '扩展按插件声明或目录 index 入口识别，不需要全选目录内脚本；独立 MCP 服务不作为 Pi 扩展加载。安装不等于启用。', 'settings-note'));
      copy.append(details);
    }
    const canEdit = Boolean(entry.id) && packagesCatalog?.installable;
    const reason = '这个 daemon 未提供安装管理接口或包 ID；升级 daemon 后再试。';
    const actions = el('div', undefined, 'agent-package-actions');
    actions.append(
      guardedButton('更新', canEdit, reason, () => mutate('agent.packages.update', { id: entry.id }, `已更新 ${label}。`)),
      guardedButton('移除', canEdit, reason, () => removePackage(entry, label)));
    row.append(copy, actions); return row;
  };
  const paint = () => {
    const catalog = packagesCatalog;
    clearInstall();
    if (!catalog) {
      list.replaceChildren(el('p', '尚未读取已安装包。', 'settings-note'));
      state.textContent = ''; warning.hidden = true;
      installRow.append(guardedButton('安装', false, '请先读取已安装包，确认 daemon 是否提供安装管理接口。', () => {}, 'primary agent-package-install'));
      return;
    }
    warning.hidden = !catalog.warning; warning.textContent = catalog.warning || '';
    const packages = catalog.packages || [];
    state.textContent = `${catalog.installable ? '已安装包管理可用' : '只读目录发现'} · ${packages.length} 个包`;
    list.replaceChildren(...(packages.length ? packages.map(packageRow) : [el('p', '未发现已安装的 Pi 包。', 'settings-note')]));
    installRow.append(catalog.installable
      ? button('安装', install, 'primary agent-package-install', { help: `${scopeLabel(client.scope)}：${PACKAGE_SOURCE_HELP}` })
      : guardedButton('安装', false, '当前 daemon 没有提供安装管理接口；升级 daemon 后再试。', () => {}, 'primary agent-package-install'));
  };
  paint();
  section.append(toolbar, warning, list, installRow, errorBox);
  // 打开配置页只读一次本地目录（有缓存后不重复）；失败会退回只读发现并说明安装管理不可用。
  if (!packagesCatalog) void load(false);
  return section;
}

/** Shared subpanel: its owner supplies configuration and an identity-guarded repaint callback. */
export function renderAgentSettings(settings, repaint, { ownsPage = () => true, connections = null } = {}) {
  const names = new Map();
  const rows = Array.isArray(connections) ? connections : (Array.isArray(connections?.connections) ? connections.connections : []);
  for (const row of rows) {
    if (typeof row?.id === 'string' && typeof row?.label === 'string' && row.label.trim()) names.set(row.id, row.label.trim());
  }
  const content = el('div', undefined, 'settings-tab-panel agent-settings');
  if (!settings) {
    const waiting = block('Agent 配置');
    waiting.append(el('p', '正在等待 daemon 快照。连接建立后可配置 Pi、Codex、模型、思考深度与各 Worker 角色的追加 Prompt。', 'settings-placeholder'));
    content.append(waiting); return content;
  }
  const intro = el('div', undefined, 'agent-callout');
  intro.append(el('strong', `${scopeLabel()} · 双配置模式`), el('p', `每个 Agent 先选配置模式：Lush 配置使用 Lush 托管的来源、模型、Prompt 与资源，Pi 调用不继承用户全局 Pi 设置或 Prompt；Pi 默认配置使用执行机器上的 Pi 目录。配置保存在 ${settings.file}，项目 AGENTS 与显式资源保留。正在运行的调用保持不变，后续调用读取最新配置。`, 'settings-note'));
  const summary = el('p', undefined, 'agent-default-summary'); summary.setAttribute('role', 'status');
  content.append(intro, summary);
  const client = settingsClientFor(settings);
  content.append(packagesManager(ownsPage, client));
  content.append(profileEditor(settings, settings.default, 'default', '默认 Agent', '所有未单独配置的 Worker 行为都继承这里。', repaint, ownsPage, summary, names));

  const roles = block('按 Worker 行为覆盖'); roles.classList.add('agent-roles-block');
  roles.append(el('p', '只为需要不同模型、思考深度或工作方式的行为建立覆盖；其余保持继承，后续调整默认值时会一起更新。', 'settings-note settings-section-note'));
  const list = el('div', undefined, 'agent-role-list');
  for (const item of settings.options.roles.filter(item => item.id === 'agent')) {
    if (settings.roles[item.id]) list.append(profileEditor(settings, settings.roles[item.id], item.id, item.label, `仅用于 ${item.id} 角色。`, repaint, ownsPage, null, names));
    else list.append(inheritedRole(settings, item.id, repaint, names, ownsPage));
  }
  const advanced = el('details', undefined, 'agent-config-advanced'), environmentHost = el('div', undefined, 'agent-env-host');
  const repaintEnvironment = () => { if (ownsPage()) environmentHost.replaceChildren(environmentEditor(settings, repaintEnvironment, ownsPage)); };
  environmentHost.resume = repaintEnvironment; repaintEnvironment();
  advanced.append(el('summary', '高级配置：Agent 环境变量'), environmentHost);
  roles.append(list); content.append(roles, advanced);
  return content;
}

// 运行设置可在浏览器里改写；范围与核心 RUNTIME_SETTINGS_LIMITS 一致，单位只用于展示。
const CONCURRENCY_FIELDS = [
  { key: 'concurrency', label: '执行通道', max: 64, unit: '' },
  { key: 'control_concurrency', label: '控制通道', max: 16, unit: '' },
];
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
  }, 'primary settings-runtime-save');
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
  }, 'ghost settings-runtime-reset', { help: `只清除设备设置中${note}的这些键，回到环境／内置默认；不删除历史或中断调用` });
  reset.dataset.runtimeAction = 'reset';
  actions.append(save, reset);
  box.append(grid, actions, errorBox);
  return box;
}


let systemPage = null;
function systemTab() {
  if (systemPage?.view !== ui.view) systemPage = { view: ui.view, node: el('div', undefined, 'settings-scope-pane'), loaded: false, pending: null };
  const state = systemPage, content = el('div', undefined, 'settings-tab-panel'), client = settingsClient();
  const owns = () => ui.view === state.view && ui.settingsOpen && activeTab === 'system';
  ui.clearSettingsSecrets = () => state.network?.clearSecrets?.();
  const plain = value => value == null || value === '' ? '—' : String(value);
  const paint = runtime => {
    if (!owns()) return;
    state.loaded = true;
    const concurrency = block('并发额度');
    concurrency.append(el('p', '所有项目使用同一并发上限；这是每个项目的上限，不是整机总预算。降低上限不取消在跑 Worker，后续准入读取新配置。', 'settings-note'),
      runtimeFieldsEditor(runtime, CONCURRENCY_FIELDS, plain, '并发额度', client, paint, owns),
      row('设置文件', '设备唯一运行设置的保存位置。', el('code', plain(runtime.file), 'settings-path')));
    const limits = block('调用与拆解限额');
    limits.append(runtimeFieldsEditor(runtime, LIMIT_FIELDS, plain, '调用与拆解限额', client, paint, owns));
    const reporting = block('进度汇报'), enabled = runtime.progress_reporting?.value !== false;
    const input = el('input'); input.type = 'checkbox'; input.checked = enabled; input.dataset.runtimeInput = 'progress_reporting';
    input.setAttribute('aria-label', '启用进度汇报');
    const error = el('p', '', 'settings-error'); error.hidden = true;
    input.onchange = async () => {
      if (!owns() || input.disabled) return;
      input.parentNode.classList.add('help-host'); input.parentNode.setAttribute('data-help', '正在保存设备进度汇报设置；完成后可继续编辑。');
      input.disabled = true;
      try {
        const saved = await client.action('system.configure', { settings: { progress_reporting: input.checked } });
        if (owns()) paint(saved);
      } catch (failure) { if (owns()) { input.checked = enabled; error.textContent = failure.message; error.hidden = false; } }
      finally { input.disabled = false; }
    };
    reporting.append(row('启用进度汇报', `${scopeImpact()} 关闭后所有项目不再显示进度指引；已有记录、自定义 Prompt 与当前调用不改写。`, input), error);
    state.network ||= renderNetworkSettings({ ownsPage: owns, scope: 'device' });
    state.migration ||= renderSettingsMigration({ ownsPage: owns, onMigrated: async () => {
      state.loaded = false; const value = await client.read('/api/settings/runtime'); if (owns()) paint(value);
    } });
    state.node.replaceChildren(scopeSummary(runtime), concurrency, limits, reporting, state.network, state.migration,
      el('p', '项目运行状态、历史与后台控制在项目工作页管理；本页不会因配置读取启动项目。', 'settings-note'));
  };
  function load() {
    if (state.loaded) return Promise.resolve(); if (state.pending) return state.pending;
    state.node.replaceChildren(el('p', '正在读取设备运行设置…', 'hint'));
    const pending = client.read('/api/settings/runtime').then(value => { if (owns()) { paint(value); return state.migration.ready; } })
      .catch(error => { if (owns()) state.node.replaceChildren(el('p', `读取设置失败：${error.message}`, 'settings-error'), button('重新读取设置', load, 'ghost')); })
      .finally(() => { state.pending = null; });
    state.pending = pending; return pending;
  }
  state.network?.resume?.(); content.append(state.node); load(); return content;
}

function tabBar() {
  const nav = el('div', undefined, 'settings-tabs'); nav.setAttribute('role', 'tablist');
  for (const tab of TABS) {
    const node = el('button', undefined, `settings-tab${activeTab === tab.id ? ' active' : ''}`); node.type = 'button'; node.dataset.settingsTab = tab.id;
    node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(activeTab === tab.id));
    node.append(el('strong', tab.label), el('span', tab.note));
    node.onclick = () => { activeTab = tab.id; return renderSettings(); };
    nav.append(node);
  }
  return nav;
}

export function renderSettings() {
  if (!ui.settingsOpen) return; // 保存或读取配置的迟到回调不能抢回其他页面。
  if (activeTab !== 'system') ui.clearSettingsSecrets?.();
  const panel = $('detail'); panel.dataset.view = 'settings';
  const view = el('div', undefined, 'settings-view');
  const head = el('div', undefined, 'settings-head');
  const intro = el('div'); intro.append(el('span', 'SYSTEM SETTINGS', 'eyebrow'), el('h1', '设备设置'),
    el('p', '界面偏好与运行配置统一保存在执行机器的同一用户设备设置中，项目不再单独覆盖。项目辨识配色在工作台的项目管理页调整。Agent 配置、模型来源与快捷解释各有独立设备页面。', 'hint'));
  head.append(intro); view.append(head, tabBar());
  view.append(activeTab === 'interface' ? interfaceTab() : systemTab());
  panel.replaceChildren(view);
  return activeTab === 'system' ? systemPage?.pending : undefined;
}

for (const name of PREF_NAMES) onPrefChange(name, () => { if (globalThis.document === settingsDocument && ui.settingsOpen && activeTab === 'interface') renderSettings(); });
