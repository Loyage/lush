import { action, api } from './api.js';
import { button, el } from './dom.js';
import { confirmDialog, formDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';

const roleProfile = (settings, role) => {
  const resolved = role === 'scheduler' ? 'planner' : role;
  return { role: resolved, profile: { ...(settings.resolved?.[resolved] || settings.default) } };
};
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
 * 任务级 Agent Profile 面板：terminal retry 与 paused 的「调整运行设置」共用同一套字段。
 * 字段含本轮 Agent / 模型 / 思考深度 / Prompt / 扩展 / Skills / 软预算，以及只在本任务生效的 Pi 环境变量。
 * Profile 只送到 task.retry / task.configure，不修改项目 agent.json，任务结算时失效。
 */
export async function retryTask(task) {
  return profileDialog(task, { method: 'task.retry' });
}

/** 暂停中的「调整运行设置」：只保存 Profile，不启动 Agent；点详情里的「继续」才生效。 */
export async function configureTask(task) {
  return profileDialog(task, { method: 'task.configure' });
}

async function profileDialog(task, options) {
  const configuring = options.method === 'task.configure';
  try {
    const settings = await api('/api/agent/config');
    const { role, profile } = roleProfile(settings, task.role);
    // agent.json does not contain the env-file layers. Match invocation precedence:
    // common env < role env < profile env. Do not silently open an incomplete form on read failure.
    const [commonEnv, roleEnv] = await Promise.all([
      api('/api/agent/environment?target=common'),
      api(`/api/agent/environment?target=${encodeURIComponent(role)}`),
    ]);
    profile.env = { ...commonEnv.values, ...roleEnv.values, ...(profile.env || {}) };
    const builtInPrompt = settings.options?.default_prompts?.[role] || settings.options?.default_prompt || '';
    const selectedExtensions = new Set(profile.extensions || []);
    const selectedSkills = new Set(profile.skills || []);
    const catalogs = new Map();
    let resources = { extensions: [], skills: [], warning: null };

    const form = el('div', undefined, 'retry-profile-form');
    const grid = el('div', undefined, 'retry-profile-grid');
    const backend = el('select'); backend.dataset.retryField = 'agent';
    const availableAgents = task.role === 'explainer' ? ['pi'] : (settings.options?.agents || ['pi', 'codex']);
    backend.replaceChildren(...availableAgents.map(value => option(value, backendLabel(value))));
    const inheritedBackend = availableAgents.includes(profile.agent);
    backend.value = inheritedBackend ? profile.agent : availableAgents[0];

    const model = el('input'); model.type = 'text'; model.maxLength = 256; model.value = inheritedBackend ? (profile.model || '') : '';
    model.dataset.retryField = 'model';
    const modelBox = el('div', undefined, 'retry-model-box');
    const modelChoices = el('select'); modelChoices.dataset.retryField = 'model-choice';
    modelChoices.onchange = () => { if (modelChoices.value) model.value = modelChoices.value; };
    modelBox.append(model, modelChoices);

    const thinking = el('select'); thinking.dataset.retryField = 'thinking';
    const budgetResponses = el('input'); budgetResponses.type = 'number'; budgetResponses.min = '1'; budgetResponses.max = '10000';
    budgetResponses.value = String(profile.soft_budget?.responses ?? ''); budgetResponses.placeholder = '关闭';
    budgetResponses.dataset.retryField = 'budget-responses';
    const budgetTokens = el('input'); budgetTokens.type = 'number'; budgetTokens.min = '1'; budgetTokens.max = '1000000000';
    budgetTokens.value = String(profile.soft_budget?.tokens ?? ''); budgetTokens.placeholder = '关闭';
    budgetTokens.dataset.retryField = 'budget-tokens';

    const defaultPrompt = el('textarea'); defaultPrompt.rows = 10; defaultPrompt.maxLength = 32768;
    defaultPrompt.value = profile.default_prompt || builtInPrompt; defaultPrompt.dataset.retryField = 'default-prompt';
    const promptTools = el('div', undefined, 'retry-prompt-tools');
    const promptState = el('span', undefined, 'settings-note');
    const syncPromptState = () => { promptState.textContent = defaultPrompt.value.trim() === builtInPrompt.trim()
      ? '使用该角色的 Lush 内置 Prompt。' : '当前内容会替换 Lush 内置 Prompt。'; };
    defaultPrompt.oninput = syncPromptState;
    const restorePrompt = button('恢复内置 Prompt', () => { defaultPrompt.value = builtInPrompt; syncPromptState(); }, 'ghost');
    restorePrompt.type = 'button'; promptTools.append(promptState, restorePrompt); syncPromptState();
    const promptBox = el('div', undefined, 'retry-prompt-box'); promptBox.append(defaultPrompt, promptTools);

    const appendPrompt = el('textarea'); appendPrompt.rows = 4; appendPrompt.maxLength = 32768;
    appendPrompt.value = profile.append_prompt || ''; appendPrompt.dataset.retryField = 'append-prompt';

    const envBox = el('div', undefined, 'retry-env-box');
    const env = el('textarea'); env.rows = 4; env.maxLength = 16384;
    env.value = envLines(profile.env); env.dataset.retryField = 'env';
    env.placeholder = 'NAME=value，每行一个；特殊值可用 JSON 字符串';
    const envNote = el('span', '已加载公共与角色环境变量，角色同名值优先；保存后只在本任务覆盖。NAME 不能以 LUSH_ 开头，含换行的值使用 JSON 字符串。', 'settings-note');
    envBox.append(env, envNote);

    const resourcesBox = el('div', undefined, 'retry-resources');
    const resourceNote = el('p', '正在读取已安装的 Pi 扩展与 Skills…', 'settings-note');
    const resourceChoices = el('div', undefined, 'retry-resource-choices');
    resourcesBox.append(resourceNote, resourceChoices);

    const paintModels = () => {
      const agent = backend.value;
      const values = new Map();
      for (const id of settings.options?.models?.[agent] || []) values.set(id, id);
      for (const entry of catalogs.get(agent)?.models || []) values.set(entry.id, entry.label && entry.label !== entry.id ? `${entry.label} · ${entry.id}` : entry.id);
      modelChoices.replaceChildren(option('', '选择常用或本机可用模型…'), ...[...values].map(([id, label]) => option(id, label)));
      modelChoices.value = '';
    };
    const loadModels = async agent => {
      if (catalogs.has(agent)) return;
      try { catalogs.set(agent, await api(`/api/agent/models?agent=${encodeURIComponent(agent)}`)); }
      catch (error) { catalogs.set(agent, { models: [], warning: error.message }); }
      if (backend.value === agent) paintModels();
    };
    const paintResources = () => {
      const enabled = backend.value === 'pi';
      resourceNote.textContent = enabled
        ? (resources.warning || '勾选项只在本轮运行中加载；扩展拥有当前用户的完整系统权限。')
        : 'Codex 不加载 Pi 扩展与 Skills；已选项会保留，但本轮不使用。';
      resourceChoices.replaceChildren(
        resourceGroup('扩展', resources.extensions || [], selectedExtensions, 'extensions', enabled),
        resourceGroup('Skills', resources.skills || [], selectedSkills, 'skills', enabled));
    };
    const syncBackend = clear => {
      const agent = backend.value;
      if (clear) { model.value = ''; thinking.value = ''; }
      model.placeholder = `${agent} CLI 默认模型`;
      const levels = settings.options?.thinking?.[agent] || [''];
      const selected = clear || !inheritedBackend || !levels.includes(profile.thinking) ? '' : profile.thinking;
      thinking.replaceChildren(...levels.map(value => option(value, thinkingLabel(value)))); thinking.value = selected;
      const budgetEnabled = agent === 'pi' && task.role !== 'explainer';
      budgetResponses.disabled = !budgetEnabled; budgetTokens.disabled = !budgetEnabled;
      paintModels(); paintResources(); void loadModels(agent);
    };
    backend.onchange = () => syncBackend(true);

    grid.append(
      field('Agent', backend, '只覆盖本轮运行，不修改项目或角色默认配置。'),
      field('模型', modelBox, '可直接填写模型 ID，或从预设与本机目录中选择。'),
      field('思考深度', thinking, '可用等级随 Agent 变化。'),
      field('软预算：响应数', budgetResponses, '留空关闭；仅 Pi。'),
      field('软预算：累计 token', budgetTokens, '留空关闭；仅 Pi。'),
      field('默认 Prompt', promptBox, '修改后会替换 Lush 内置角色 Prompt，可能影响任务协议与交付行为。', true),
      field('追加 Prompt', appendPrompt, '追加在基础 Prompt 与项目补充之后，仅本轮运行生效。', true),
      field('Pi 环境变量', envBox, '每行一个 NAME=value，仅本轮运行覆盖；留空表示沿用角色设置。', true),
      field('扩展与 Skills', resourcesBox, '保留当前角色配置，可按本轮需要增删。', true));
    const defaultsTools = el('div', undefined, 'retry-prompt-tools');
    const restoreDefaults = button('加载默认参数', () => {
      backend.value = inheritedBackend ? profile.agent : availableAgents[0];
      model.value = inheritedBackend ? (profile.model || '') : '';
      budgetResponses.value = String(profile.soft_budget?.responses ?? '');
      budgetTokens.value = String(profile.soft_budget?.tokens ?? '');
      defaultPrompt.value = profile.default_prompt || builtInPrompt;
      appendPrompt.value = profile.append_prompt || '';
      env.value = envLines(profile.env);
      selectedExtensions.clear(); selectedSkills.clear();
      for (const id of profile.extensions || []) selectedExtensions.add(id);
      for (const id of profile.skills || []) selectedSkills.add(id);
      syncPromptState(); syncBackend(false);
    }, 'ghost', { help: '用打开面板时读取的项目与角色默认参数替换表单中全部改动（含环境变量）；不保存、不启动 Agent。' });
    restoreDefaults.type = 'button'; defaultsTools.append(restoreDefaults);
    form.append(defaultsTools, grid, el('p', '确认后，所选完整 Profile 会固定到这个任务，直到它再次完成、失败或取消。', 'retry-scope-note'));

    try { resources = await api('/api/agent/resources'); }
    catch (error) { resources = { extensions: [], skills: [], warning: `资源目录读取失败：${error.message}` }; }
    await loadModels(backend.value);
    syncBackend(false);

    const confirmed = await formDialog({
      title: configuring ? `调整任务 #${task.id} 的运行设置` : `检查后重试任务 #${task.id}`,
      message: configuring
        ? `任务已暂停。这些设置固定到这次暂停，点「继续」时生效；任务结算后自动清除。`
        : `任务因“${task.status === 'cancelled' ? '已取消' : '失败'}”停止。请检查并调整 ${task.role} Agent；这些设置只用于本轮重试。`,
      content: form, confirmLabel: configuring ? '保存设置' : '使用这些设置重试',
      cancelLabel: configuring ? '不修改' : '暂不重试', cardClass: 'retry-modal',
      agent: !configuring,
      confirmHelp: configuring
        ? '保存这次运行设置；点任务详情的「继续」后按新设置启动 Agent。'
        : agentHelp('用上面选定的 Agent 设置重新启动这个任务。'),
    });
    if (!confirmed) return false;

    const enteredDefault = defaultPrompt.value.trim();
    const nextDefault = enteredDefault === builtInPrompt.trim() ? '' : enteredDefault;
    if (nextDefault && nextDefault !== (profile.default_prompt || '')) {
      const accepted = await confirmDialog({
        title: configuring ? '用自定义 Prompt 保存设置？' : '用自定义 Prompt 重试？',
        message: '自定义内容会替换 Lush 内置任务规则，仅本轮生效。',
        detail: '可能影响：任务 API 使用、权限边界、子任务协作、工作区安全和交付流程。',
        confirmLabel: configuring ? '仍然保存' : '仍然重试', cancelLabel: configuring ? '取消修改' : '取消重试', danger: true,
        agent: !configuring,
        confirmHelp: configuring ? '保存这份自定义 Prompt 作为本轮运行设置。' : agentHelp('用这份自定义 Prompt 重新启动这个任务。'),
      });
      if (!accepted) return false;
    }
    const softBudget = {};
    if (backend.value === 'pi' && task.role !== 'explainer') {
      if (budgetResponses.value.trim()) softBudget.responses = Number(budgetResponses.value);
      if (budgetTokens.value.trim()) softBudget.tokens = Number(budgetTokens.value);
    }
    const envValues = parseEnvLines(env.value);
    const taskProfile = {
      agent: backend.value, model: model.value.trim(), thinking: thinking.value,
      default_prompt: nextDefault, append_prompt: appendPrompt.value.trim(),
      extensions: [...selectedExtensions], skills: [...selectedSkills], soft_budget: softBudget,
      ...(Object.keys(envValues).length ? { env: envValues } : {}),
    };
    await action(options.method, { id: task.id, profile: taskProfile });
    show(configuring
      ? `任务 #${task.id} 的运行设置已保存；点「继续」按新设置运行。`
      : `任务 #${task.id} 已按本轮 Agent 设置进入重试队列。`);
    return true;
  } catch (error) {
    show(configuring ? `无法保存运行设置：${error.message}` : `无法重试：${error.message}`, 'error');
    return false;
  }
}
