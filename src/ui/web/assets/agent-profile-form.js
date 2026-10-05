import { api } from './api.js';
import { button, el } from './dom.js';
import { createAgentConnectionPicker } from './agent-connection-picker.js';
import { CONFIG_MODES, PI_MODE_HELP, normalizeConfigMode, profileForMode } from './agent-config-mode.js';

const backendLabel = value => value === 'pi' ? 'Pi' : value === 'codex' ? 'Codex' : value;
const thinkingLabel = value => value || 'CLI 默认';

function option(value, label = value) {
  const node = el('option', label); node.value = value; return node;
}
function field(label, control, note = '', wide = false) {
  const wrap = el('label', undefined, `retry-field${wide ? ' retry-field-wide' : ''}`);
  wrap.append(el('span', label, 'retry-field-label'), control);
  if (note) wrap.append(el('span', note, 'settings-note'));
  return wrap;
}

/** 每行一个 NAME=value；特殊值用 JSON 字符串保留换行、引号及首尾空白。后端仍校验变量名与保留前缀。 */
export function parseEnvLines(text) {
  const values = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`环境变量必须是 NAME=value：${line}`);
    const value = line.slice(at + 1);
    values[line.slice(0, at).trim()] = value.startsWith('"') ? JSON.parse(value) : value;
  }
  return values;
}
const envLines = values => Object.entries(values || {}).map(([name, value]) => {
  const encoded = /[\r\n]/.test(value) || value.trim() !== value || value.startsWith('"') ? JSON.stringify(value) : value;
  return `${name}=${encoded}`;
}).join('\n');

// 已安装资源读面与「Agent 配置」页保持一致：优先 /api/agent/packages（含安装管理），
// 旧 daemon 没有该接口时退回 /api/agent/resources；两处的条目都归一成 {id(路径),label,...}。
const resourceValue = entry => entry?.path || entry?.id || '';
const resourceLabel = entry => entry?.name || entry?.label || String(resourceValue(entry)).split('/').at(-1) || '未命名资源';
const normalizeResourceEntries = rows => (Array.isArray(rows) ? rows : []).map(entry => ({
  id: resourceValue(entry), label: resourceLabel(entry), description: entry?.description || '', source: entry?.source || '',
})).filter(entry => entry.id);
async function loadResourceCatalog() {
  try {
    const data = await api('/api/agent/packages');
    if (data?.version !== 1 || !Array.isArray(data.packages)) throw new Error('接口数据格式不兼容');
    const list = data.resources || {};
    return { extensions: normalizeResourceEntries(list.extensions), skills: normalizeResourceEntries(list.skills), warning: data.warning || null };
  } catch (error) {
    const legacy = await api('/api/agent/resources');
    return { extensions: normalizeResourceEntries(legacy.extensions), skills: normalizeResourceEntries(legacy.skills),
      warning: legacy.warning || `已安装包管理不可用（${error.message}）；仅显示本地目录发现到的资源。` };
  }
}

function resourceGroup(title, entries, selected, kind, enabled) {
  const group = el('fieldset', undefined, 'retry-resource-group');
  group.append(el('legend', title));
  const known = new Set(entries.map(entry => entry.id));
  const rows = [...entries];
  for (const id of selected) if (!known.has(id)) rows.push({ id, label: id.split('/').at(-1), source: '已配置但当前未发现', missing: true });
  if (!rows.length) group.append(el('p', '没有发现可选项。', 'settings-note'));
  for (const entry of rows) {
    const row = el('label', undefined, `resource-choice${entry.missing ? ' missing' : ''}`);
    const input = el('input'); input.type = 'checkbox'; input.value = entry.id; input.checked = selected.has(entry.id);
    input.disabled = !enabled; input.dataset.retryResource = kind;
    input.onchange = () => input.checked ? selected.add(entry.id) : selected.delete(entry.id);
    const copy = el('span'); copy.append(el('strong', entry.label || entry.id), el('small', entry.description || entry.source || entry.id));
    row.append(input, copy); group.append(row);
  }
  return group;
}

/**
 * 项目 Profile 与单 Worker 运行设置共用的 Agent Profile 表单。
 *
 * 第一位是「配置模式」：`lush`（默认）摆出全部托管选项，`pi` 交给执行机器上用户自己的 Pi 配置，
 * 隐藏并在提交时丢弃托管来源/模型/思考深度/Prompt/扩展与 Skills/软预算/环境变量。切换模式保留其他字段
 * 的未保存编辑（只在提交时裁剪），不混用两种来源。
 *
 * 只负责取值与校验；调用方决定送 `worker.retry` / `worker.configure`，还是随 `order.submit` 提交。
 */
export function createProfileForm({ profile, settings, role, ownsPage = () => true, onChange = () => {} }) {
  const initial = { ...(profile || {}) };
  const selectedExtensions = new Set(initial.extensions || []);
  const selectedSkills = new Set(initial.skills || []);
  const catalogs = new Map();
  let resources = { extensions: [], skills: [], warning: null };

  const node = el('div', undefined, 'retry-profile-form');
  const modeBox = el('div', undefined, 'retry-config-mode');
  const modeSelect = el('select'); modeSelect.dataset.retryField = 'config_mode';
  modeSelect.setAttribute('aria-label', '配置模式');
  modeSelect.replaceChildren(...CONFIG_MODES.map(mode => option(mode.id, mode.label)));
  modeSelect.value = normalizeConfigMode(initial.config_mode);
  const modeNote = el('span', undefined, 'settings-note'); modeNote.dataset.configModeNote = '';
  // 隔离的 explainer / butler 继续要求 Lush 模式，不能通过界面切到 Pi 默认配置。
  const isolatedRole = ['explainer', 'butler'].includes(role);
  if (isolatedRole) for (const child of modeSelect.children) if (child.value === 'pi') child.disabled = true;
  modeBox.append(field('配置模式', modeSelect, '先选由谁掌握运行配置；保存不影响正在运行的调用。'), modeNote);

  const grid = el('div', undefined, 'retry-profile-grid');
  const managed = el('div', undefined, 'retry-managed'); managed.dataset.configManaged = 'managed';
  managed.append(grid);

  const backend = el('select'); backend.dataset.retryField = 'agent';
  const availableAgents = role === 'explainer' ? ['pi'] : (settings.options?.agents || ['pi', 'codex']);
  backend.replaceChildren(...availableAgents.map(value => option(value, backendLabel(value))));
  const inheritedBackend = availableAgents.includes(initial.agent);
  backend.value = inheritedBackend ? initial.agent : availableAgents[0];

  const model = el('input'); model.type = 'text'; model.maxLength = 256; model.value = inheritedBackend ? (initial.model || '') : '';
  model.dataset.retryField = 'model';
  const modelBox = el('div', undefined, 'retry-model-box');
  const modelChoices = el('select'); modelChoices.dataset.retryField = 'model-choice';
  modelChoices.onchange = () => { if (modelChoices.value) { model.value = modelChoices.value; onChange(); } };
  modelBox.append(model, modelChoices);
  const connectionPicker = createAgentConnectionPicker({ backend, model, connectionId: initial.connection_id || '',
    ownsPage, onChange: () => paintModels() });
  connectionPicker.connection.dataset.retryField = 'connection_id';
  const fillNote = el('span', undefined, 'settings-note');
  const fillDefaults = button('填入来源默认（模型 + 思考深度）', () => {
    const row = connectionPicker.entry();
    if (!row) { fillNote.textContent = '请先读取并选择模型来源。'; return; }
    const applied = [];
    if (row.default_model) { model.value = `${row.provider}/${row.default_model}`; applied.push('模型'); }
    const levels = [...thinking.children].map(option => option.value);
    if (row.default_thinking && levels.includes(row.default_thinking)) { thinking.value = row.default_thinking; applied.push('思考深度'); }
    if (!applied.length) { fillNote.textContent = '该来源未设置默认模型或思考深度。'; return; }
    fillNote.textContent = `已填入来源默认${applied.join('与')}；保存前仍可修改。`;
    connectionPicker.sync(); onChange();
  }, 'ghost', { help: '把所选来源保存的默认模型与思考深度填入本表单；只改这两项，不调用 Agent，保存前仍可修改。' });
  fillDefaults.type = 'button';
  const defaultsRow = el('div', undefined, 'profile-source-defaults'); defaultsRow.append(fillDefaults, fillNote);
  const connectionControl = el('div', undefined, 'retry-connection-control'); connectionControl.append(connectionPicker.node, defaultsRow);

  const thinking = el('select'); thinking.dataset.retryField = 'thinking';
  thinking.onchange = () => onChange();
  const budgetResponses = el('input'); budgetResponses.type = 'number'; budgetResponses.min = '1'; budgetResponses.max = '10000';
  budgetResponses.value = String(initial.soft_budget?.responses ?? ''); budgetResponses.placeholder = '关闭';
  budgetResponses.dataset.retryField = 'budget-responses';
  const budgetTokens = el('input'); budgetTokens.type = 'number'; budgetTokens.min = '1'; budgetTokens.max = '1000000000';
  budgetTokens.value = String(initial.soft_budget?.tokens ?? ''); budgetTokens.placeholder = '关闭';
  budgetTokens.dataset.retryField = 'budget-tokens';

  const builtInPrompt = settings.options?.default_prompts?.[role] || settings.options?.default_prompt || '';
  const defaultPrompt = el('textarea'); defaultPrompt.rows = 10; defaultPrompt.maxLength = 32768;
  defaultPrompt.value = initial.default_prompt || builtInPrompt; defaultPrompt.dataset.retryField = 'default-prompt';
  const promptTools = el('div', undefined, 'retry-prompt-tools');
  const promptState = el('span', undefined, 'settings-note');
  const syncPromptState = () => { promptState.textContent = defaultPrompt.value.trim() === builtInPrompt.trim()
    ? '使用该角色的 Lush 内置 Prompt。' : '当前内容会替换 Lush 内置 Prompt。'; };
  defaultPrompt.oninput = syncPromptState;
  const restorePrompt = button('恢复内置 Prompt', () => { defaultPrompt.value = builtInPrompt; syncPromptState(); }, 'ghost');
  restorePrompt.type = 'button'; promptTools.append(promptState, restorePrompt); syncPromptState();
  const promptBox = el('div', undefined, 'retry-prompt-box'); promptBox.append(defaultPrompt, promptTools);

  const appendPrompt = el('textarea'); appendPrompt.rows = 4; appendPrompt.maxLength = 32768;
  appendPrompt.value = initial.append_prompt || ''; appendPrompt.dataset.retryField = 'append-prompt';

  const envBox = el('div', undefined, 'retry-env-box');
  const env = el('textarea'); env.rows = 4; env.maxLength = 16384;
  env.value = envLines(initial.env); env.dataset.retryField = 'env';
  env.placeholder = 'NAME=value，每行一个；特殊值可用 JSON 字符串';
  const envNote = el('span', '留空表示不覆盖；NAME 不能以 LUSH_ 开头，含换行的值使用 JSON 字符串。', 'settings-note');
  envBox.append(env, envNote);

  const resourcesBox = el('div', undefined, 'retry-resources');
  const resourceNote = el('p', '正在读取已安装的 Pi 扩展与 Skills…', 'settings-note');
  const resourceChoices = el('div', undefined, 'retry-resource-choices');
  resourcesBox.append(resourceNote, resourceChoices);

  const paintModels = () => {
    const agent = backend.value;
    if (connectionPicker.value()) {
      modelChoices.replaceChildren(option('', '使用账号连接内的模型选项…')); modelChoices.disabled = true; return;
    }
    modelChoices.disabled = false;
    const values = new Map();
    for (const id of settings.options?.models?.[agent] || []) values.set(id, id);
    for (const entry of catalogs.get(agent)?.models || []) values.set(entry.id, entry.label && entry.label !== entry.id ? `${entry.label} · ${entry.id}` : entry.id);
    modelChoices.replaceChildren(option('', '选择常用或本机可用模型…'), ...[...values].map(([id, label]) => option(id, label)));
    modelChoices.value = '';
  };
  const loadModels = async agent => {
    if (connectionPicker.value() || catalogs.has(agent)) return;
    try { catalogs.set(agent, await api(`/api/agent/models?agent=${encodeURIComponent(agent)}`)); }
    catch (error) { catalogs.set(agent, { models: [], warning: error.message }); }
    if (ownsPage() && backend.value === agent) paintModels();
  };
  const paintResources = () => {
    const enabled = backend.value === 'pi';
    resourceNote.textContent = enabled
      ? (resources.warning || '勾选项只在本轮运行中加载；扩展拥有当前用户的完整系统权限，不是沙箱。安装与移除在「Agent 配置」页的「已安装插件与 Skills」里进行。')
      : 'Codex 不加载 Pi 扩展与 Skills；已选项会保留，但本轮不使用。';
    resourceChoices.replaceChildren(
      resourceGroup('扩展', resources.extensions || [], selectedExtensions, 'extensions', enabled),
      resourceGroup('Skills', resources.skills || [], selectedSkills, 'skills', enabled));
  };
  const syncBackend = clear => {
    const agent = backend.value;
    if (clear) { model.value = ''; thinking.value = ''; }
    model.placeholder = `${agent} CLI 默认模型`;
    connectionPicker.sync();
    const levels = settings.options?.thinking?.[agent] || [''];
    const selected = clear || !inheritedBackend || !levels.includes(initial.thinking) ? '' : initial.thinking;
    thinking.replaceChildren(...levels.map(value => option(value, thinkingLabel(value)))); thinking.value = selected;
    const budgetEnabled = agent === 'pi' && role !== 'explainer';
    budgetResponses.disabled = !budgetEnabled; budgetTokens.disabled = !budgetEnabled;
    paintModels(); paintResources(); void loadModels(agent);
  };
  backend.onchange = () => { syncBackend(true); onChange(); };

  grid.append(
    field('Agent', backend, '只覆盖本轮运行，不修改项目或角色默认配置。'),
    field('模型', modelBox, '可直接填写模型 ID，或从预设与本机目录中选择。'),
    field('账号连接', connectionControl, '只覆盖本 Worker 的后续调用；API Key 与登录共享保存，当前仅 Pi 支持托管连接。'),
    field('思考深度', thinking, '可用等级随 Agent 变化。'),
    field('软预算：响应数', budgetResponses, '留空关闭；仅 Pi。'),
    field('软预算：累计 token', budgetTokens, '留空关闭；仅 Pi。'),
    field('默认 Prompt', promptBox, '修改后会替换 Lush 内置角色 Prompt，可能影响 Worker 协议与交付行为。', true),
    field('追加 Prompt', appendPrompt, '追加在基础 Prompt 与项目补充之后，仅本轮运行生效。', true),
    field('Pi 环境变量', envBox, '每行一个 NAME=value，仅本轮运行覆盖；留空表示沿用角色设置。', true),
    field('扩展与 Skills', resourcesBox, '保留当前角色配置，可按本轮需要增删。', true));

  const modeDescription = () => {
    const mode = CONFIG_MODES.find(item => item.id === normalizeConfigMode(modeSelect.value));
    return modeSelect.value === 'pi'
      ? `${mode.note} ${PI_MODE_HELP}`
      : `${mode.note}${isolatedRole ? '隔离的 explainer / butler 必须使用 Lush 配置。' : ''}保存只影响后续调用，不改变正在运行的调用。`;
  };
  const applyMode = () => {
    const pi = normalizeConfigMode(modeSelect.value) === 'pi';
    managed.hidden = pi;
    for (const tag of ['input', 'select', 'textarea', 'button']) {
      for (const control of managed.querySelectorAll(tag)) control.disabled = pi;
    }
    modeNote.textContent = modeDescription();
    onChange();
  };
  modeSelect.onchange = () => {
    // Pi 模式只允许 Pi 后端；切回 Lush 时保留其余字段的未保存编辑。
    if (normalizeConfigMode(modeSelect.value) === 'pi') backend.value = 'pi';
    applyMode();
    if (normalizeConfigMode(modeSelect.value) !== 'pi') syncBackend(false);
  };

  const defaultsTools = el('div', undefined, 'retry-prompt-tools');
  const restoreDefaults = button('加载默认参数', () => {
    modeSelect.value = normalizeConfigMode(initial.config_mode);
    backend.value = inheritedBackend ? initial.agent : availableAgents[0];
    model.value = inheritedBackend ? (initial.model || '') : '';
    connectionPicker.reset(initial.connection_id || '');
    thinking.value = '';
    budgetResponses.value = String(initial.soft_budget?.responses ?? '');
    budgetTokens.value = String(initial.soft_budget?.tokens ?? '');
    defaultPrompt.value = initial.default_prompt || builtInPrompt;
    appendPrompt.value = initial.append_prompt || '';
    env.value = envLines(initial.env);
    selectedExtensions.clear(); selectedSkills.clear();
    for (const id of initial.extensions || []) selectedExtensions.add(id);
    for (const id of initial.skills || []) selectedSkills.add(id);
    syncPromptState(); syncBackend(false); applyMode();
  }, 'ghost', { help: '用打开面板时读取的项目与角色默认参数替换表单中全部改动（含环境变量与模式）；不保存、不启动 Agent。' });
  restoreDefaults.type = 'button'; defaultsTools.append(restoreDefaults);
  node.append(modeBox, managed, defaultsTools);
  applyMode();

  const collect = () => {
    const mode = normalizeConfigMode(modeSelect.value);
    if (mode === 'pi') return profileForMode('pi', { agent: 'pi' });
    const entered = defaultPrompt.value.trim();
    const nextDefault = entered === builtInPrompt.trim() ? '' : entered;
    const softBudget = {};
    if (backend.value === 'pi' && role !== 'explainer') {
      if (budgetResponses.value.trim()) softBudget.responses = Number(budgetResponses.value);
      if (budgetTokens.value.trim()) softBudget.tokens = Number(budgetTokens.value);
    }
    return profileForMode('lush', {
      agent: backend.value, model: model.value.trim(), thinking: thinking.value,
      ...(connectionPicker.value() ? { connection_id: connectionPicker.value() } : {}),
      default_prompt: nextDefault, append_prompt: appendPrompt.value.trim(),
      extensions: [...selectedExtensions], skills: [...selectedSkills], soft_budget: softBudget,
      env: parseEnvLines(env.value),
    });
  };
  const validate = () => {
    if (normalizeConfigMode(modeSelect.value) === 'pi') return null;
    const connectionError = connectionPicker.validate();
    if (connectionError) return connectionError;
    try { parseEnvLines(env.value); }
    catch (error) { return error.message; }
    return null;
  };
  const ready = (async () => {
    // 不静默打开不完整表单：资源目录与当前后端模型目录先读取；读取失败仍可用已保存范围。
    try { resources = await loadResourceCatalog(); }
    catch (error) { resources = { extensions: [], skills: [], warning: `资源目录读取失败：${error.message}` }; }
    await loadModels(backend.value);
    if (!ownsPage()) return;
    syncBackend(false);
    applyMode();
  })();

  return { node, ready, collect, validate, reset: restoreDefaults.onclick,
    mode: () => normalizeConfigMode(modeSelect.value), modeSelect, picker: connectionPicker,
    builtInPrompt, defaultPromptValue: () => defaultPrompt.value.trim(), applyMode };
}
