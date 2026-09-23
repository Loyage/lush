import { action, api } from './api.js';
import { button, el } from './dom.js';
import { confirmDialog, formDialog } from './dialog.js';
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
 * Retry a failed/cancelled task with a complete task-local Agent profile. The profile is sent
 * only to task.retry; it never mutates project agent.json and expires when this attempt settles.
 */
export async function retryTask(task) {
  try {
    const settings = await api('/api/agent/config');
    const { role, profile } = roleProfile(settings, task.role);
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
        ? (resources.warning || '勾选项只在本轮重试中加载；扩展拥有当前用户的完整系统权限。')
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
      field('Agent', backend, '只覆盖本轮重试，不修改项目或角色默认配置。'),
      field('模型', modelBox, '可直接填写模型 ID，或从预设与本机目录中选择。'),
      field('思考深度', thinking, '可用等级随 Agent 变化。'),
      field('软预算：响应数', budgetResponses, '留空关闭；仅 Pi。'),
      field('软预算：累计 token', budgetTokens, '留空关闭；仅 Pi。'),
      field('默认 Prompt', promptBox, '修改后会替换 Lush 内置角色 Prompt，可能影响任务协议与交付行为。', true),
      field('追加 Prompt', appendPrompt, '追加在基础 Prompt 与项目补充之后，仅本轮重试生效。', true),
      field('扩展与 Skills', resourcesBox, '保留当前角色配置，可按本轮需要增删。', true));
    form.append(grid, el('p', '确认后，所选完整 Profile 会固定到这个任务，直到它再次完成、失败或取消。', 'retry-scope-note'));

    try { resources = await api('/api/agent/resources'); }
    catch (error) { resources = { extensions: [], skills: [], warning: `资源目录读取失败：${error.message}` }; }
    await loadModels(backend.value);
    syncBackend(false);

    const confirmed = await formDialog({
      title: `检查后重试任务 #${task.id}`,
      message: `任务因“${task.status === 'cancelled' ? '已取消' : '失败'}”停止。请检查并调整 ${task.role} Agent；这些设置只用于本轮重试。`,
      content: form, confirmLabel: '使用这些设置重试', cancelLabel: '暂不重试', cardClass: 'retry-modal',
    });
    if (!confirmed) return false;

    const enteredDefault = defaultPrompt.value.trim();
    const nextDefault = enteredDefault === builtInPrompt.trim() ? '' : enteredDefault;
    if (nextDefault && nextDefault !== (profile.default_prompt || '')) {
      const accepted = await confirmDialog({
        title: '用自定义 Prompt 重试？',
        message: '自定义内容会替换 Lush 内置任务规则，仅本轮重试生效。',
        detail: '可能影响：任务 API 使用、权限边界、子任务协作、工作区安全和交付流程。',
        confirmLabel: '仍然重试', cancelLabel: '取消重试', danger: true,
      });
      if (!accepted) return false;
    }
    const softBudget = {};
    if (backend.value === 'pi' && task.role !== 'explainer') {
      if (budgetResponses.value.trim()) softBudget.responses = Number(budgetResponses.value);
      if (budgetTokens.value.trim()) softBudget.tokens = Number(budgetTokens.value);
    }
    const retryProfile = {
      agent: backend.value, model: model.value.trim(), thinking: thinking.value,
      default_prompt: nextDefault, append_prompt: appendPrompt.value.trim(),
      extensions: [...selectedExtensions], skills: [...selectedSkills], soft_budget: softBudget,
    };
    await action('task.retry', { id: task.id, profile: retryProfile });
    show(`任务 #${task.id} 已按本轮 Agent 设置进入重试队列。`);
    return true;
  } catch (error) {
    show(`无法重试：${error.message}`, 'error');
    return false;
  }
}
