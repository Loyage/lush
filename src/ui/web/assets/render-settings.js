/** Settings: project Agent profiles, browser-local interface preferences, and read-only daemon information. */
import { $, block, button, el } from './dom.js';
import { effectiveTheme, systemThemeMedia } from './appearance.js';
import { action, api } from './api.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { PREF_NAMES, POLLING_MODES, THEME_VALUES, TOAST_MODES, TRANSCRIPT_ORDER_MODES, onPrefChange, readPref, resetPrefs, setPref } from './prefs.js';
import { activateDetailView } from './sidebar-ui.js';
import { ui } from './state.js';
import { SORT_MODES } from './tree-order.js';
import { notificationControl } from './notice-notifications.js';
import { sleepSettings } from './sleep-ui.js';
import { DEFAULT_INPUT_ROUTES, ROUTE_TARGETS } from './input-routes.js';
import { paintInputHighlight } from './composer.js';

const TABS = [
  { id: 'sleep', label: '我去睡觉了', note: '离开期间由管家决策' },
  { id: 'agent', label: 'Agent', note: '任务行为与模型' },
  { id: 'interface', label: '界面', note: '阅读、外观与行为' },
  { id: 'system', label: '系统', note: '运行参数与路径' },
];
let activeTab = 'agent';
let agentConfigPromise = null;

export function openSettings() {
  activateDetailView({ view: 'settings' });
  renderSettings();
  // The overview summary intentionally omits this large profile; only the settings view asks for it.
  if (!ui.lastSnapshot?.status?.agent_config && !agentConfigPromise) {
    agentConfigPromise = api('/api/agent/config').then(config => {
      if (ui.lastSnapshot?.status) ui.lastSnapshot.status.agent_config = config;
      if (ui.settingsOpen) renderSettings();
    }).catch(error => show(error.message, 'error')).finally(() => { agentConfigPromise = null; });
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
  const wrap = el('label', undefined, 'settings-toggle');
  const input = el('input'); input.type = 'checkbox'; input.className = 'pref-toggle'; input.dataset.pref = name;
  input.checked = Boolean(readPref(name));
  input.addEventListener('change', () => setPref(name, input.checked));
  wrap.append(input, el('span', input.checked ? onLabel : offLabel));
  return wrap;
}

function themeControl() {
  const group = el('div', undefined, 'settings-choices');
  const current = readPref('theme');
  const labels = { system: '跟随系统', light: '浅色', dark: '深色' };
  for (const value of THEME_VALUES) {
    const wrap = el('label', undefined, 'settings-choice');
    const input = el('input'); input.type = 'radio'; input.name = 'theme-preference'; input.className = 'pref-radio';
    input.dataset.pref = 'theme'; input.dataset.value = value; input.checked = current === value;
    input.addEventListener('change', () => { if (input.checked) setPref('theme', value); });
    wrap.append(input, el('span', labels[value] ?? value)); group.append(wrap);
  }
  return group;
}

function selectControl(name, modes, title) {
  const select = el('select'); select.className = 'pref-select'; select.dataset.pref = name;
  if (title) select.title = title;
  for (const mode of modes) { const option = el('option', mode.label); option.value = mode.id; select.append(option); }
  select.value = readPref(name);
  select.addEventListener('change', () => setPref(name, modes.some(mode => mode.id === select.value) ? select.value : modes[0]?.id));
  return select;
}

function interfaceTab() {
  const content = el('div', undefined, 'settings-tab-panel');
  const reading = block('阅读');
  reading.append(row('Markdown 渲染', '控制 Agent 输出的展示方式。', toggleControl('markdown')));
  reading.append(row('执行过程排序', '普通查看默认最新在前，可切换为按时间正序；终端模式始终从最早按时间正序阅读。', selectControl('transcriptOrder', TRANSCRIPT_ORDER_MODES, '执行过程阅读顺序')));
  content.append(reading);

  const system = systemThemeMedia();
  const appearance = block('外观');
  appearance.append(row('主题', `系统当前${system?.matches ? '深色' : '浅色'}，实际显示${effectiveTheme() === 'dark' ? '深色' : '浅色'}。`, themeControl()));
  appearance.append(row('减少动态效果', `覆盖系统偏好（系统当前${system?.matches ? '已要求减少' : '未要求'}）。`, toggleControl('reduceMotion')));
  content.append(appearance);

  const navigation = block('导航');
  navigation.append(row('信息列表排序', '行动任务、Intent、Plan 与待决事项共用。', selectControl('sidebarSort', SORT_MODES, '信息列表排序方式')));
  content.append(navigation);

  const behavior = block('刷新与提示');
  behavior.append(row('轮询频率', '控制页面快照与实时状态刷新；修改后立即生效。', selectControl('polling', POLLING_MODES, '页面自动刷新频率')));
  behavior.append(row('消息停留时长', '控制顶部信息与错误提示自动消失的速度。', selectControl('toastDuration', TOAST_MODES, '消息提示停留时长')));
  behavior.append(row('待决事项系统提醒', '默认关闭，仅当前客户端生效。窗口打开期间提醒新事项；关闭提醒不影响记录和决策。', notificationControl()));
  content.append(behavior);

  const reset = block('恢复界面默认');
  const resetButton = el('button', '恢复默认设置', 'ghost pref-reset'); resetButton.type = 'button'; resetButton.onclick = () => resetPrefs();
  reset.append(row('恢复界面默认', '只清除当前浏览器的界面偏好，不改项目 Agent 配置。', resetButton));
  content.append(reset);
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
let resourceCatalog = null;

function profileEditor(settings, profile, target, title, subtitle) {
  const card = el('section', undefined, 'agent-profile'); card.dataset.agentTarget = target;
  const head = el('div', undefined, 'agent-profile-head');
  const copy = el('div'); copy.append(el('h3', title), el('p', subtitle, 'settings-note'));
  head.append(copy, el('span', target === 'default' ? '项目默认' : '独立覆盖', 'badge b-neutral')); card.append(head);

  const form = el('div', undefined, 'agent-form-grid');
  const backend = el('select'); backend.className = 'agent-select'; backend.dataset.agentField = 'agent';
  selectOptions(backend, settings.options.agents, profile.agent, value => value === 'pi' ? 'Pi' : 'Codex');
  const model = el('input'); model.className = 'agent-model'; model.dataset.agentField = 'model'; model.value = profile.model || '';
  model.maxLength = 256;
  const thinking = el('select'); thinking.className = 'agent-select'; thinking.dataset.agentField = 'thinking';
  const budgetControls = {};
  for (const [key, max] of [['responses', 10000], ['tokens', 1000000000]]) {
    const input = el('input'); input.type = 'number'; input.min = '1'; input.max = String(max); input.step = '1';
    input.dataset.agentField = `budget_${key}`; input.value = String(profile.soft_budget?.[key] ?? '');
    input.placeholder = '关闭'; input.disabled = ['explainer','butler'].includes(target); budgetControls[key] = input;
  }

  const modelBox = el('div', undefined, 'agent-model-box');
  const modelLine = el('div', undefined, 'agent-model-line');
  const loadModels = el('button', '读取 CLI 模型', 'ghost model-load'); loadModels.type = 'button';
  const choices = el('div', undefined, 'model-choices');
  modelLine.append(model, loadModels); modelBox.append(modelLine, choices);

  const paintModels = () => {
    const agent = backend.value;
    const preset = settings.options.models[agent] || [];
    const catalog = modelCatalogs.get(agent);
    const nodes = [];
    if (preset.length) {
      const presets = el('div', undefined, 'model-presets');
      presets.append(el('span', '常用', 'model-choice-label'));
      for (const value of preset) {
        const chip = el('button', value, 'model-preset'); chip.type = 'button'; chip.onclick = () => { model.value = value; }; presets.append(chip);
      }
      nodes.push(presets);
    }
    if (catalog) {
      const picker = el('select', undefined, 'model-catalog');
      const first = el('option', `从 ${catalog.models.length} 个可用模型中选择…`); first.value = ''; picker.append(first);
      for (const entry of catalog.models) {
        const option = el('option', entry.label && entry.label !== entry.id ? `${entry.label} · ${entry.id}` : entry.id);
        option.value = entry.id; picker.append(option);
      }
      picker.value = '';
      picker.addEventListener('change', () => { if (picker.value) model.value = picker.value; });
      nodes.push(picker, el('span', catalog.warning || `已从本机 ${agent} CLI 读取当前可用模型。`, `model-catalog-note${catalog.warning ? ' warning' : ''}`));
    }
    choices.replaceChildren(...nodes);
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
    const known = new Set(entries.map(entry => entry.id));
    const rows = [...entries];
    for (const id of selected) if (!known.has(id)) rows.push({ id, label: id.split('/').at(-1), source: '已配置但当前未发现', missing: true });
    if (!rows.length) group.append(el('p', '没有发现可选项。', 'settings-note'));
    for (const entry of rows) {
      const wrap = el('label', undefined, `resource-choice${entry.missing ? ' missing' : ''}`);
      const input = el('input'); input.type = 'checkbox'; input.dataset.resourceKind = kind; input.value = entry.id;
      input.checked = selected.has(entry.id); input.disabled = backend.value !== 'pi';
      input.addEventListener('change', () => input.checked ? selected.add(entry.id) : selected.delete(entry.id));
      const copy = el('span'); copy.append(el('strong', entry.label), el('small', entry.description || entry.source || 'Pi 资源'));
      wrap.append(input, copy); group.append(wrap);
    }
    return group;
  };
  const paintResources = () => {
    const pi = backend.value === 'pi';
    loadResources.disabled = !pi;
    if (!pi) {
      resourcesNote.textContent = 'Pi 扩展与 Skills 不会传给 Codex；选择会保留，切回 Pi 后生效。';
    } else if (resourceCatalog?.warning) resourcesNote.textContent = resourceCatalog.warning;
    else resourcesNote.textContent = resourceCatalog ? '只会加载勾选项；扩展拥有当前用户的完整系统权限。' : '按需读取本机 Pi 已安装资源。';
    resourceChoices.replaceChildren(...(resourceCatalog ? [
      paintResourceGroup('扩展', resourceCatalog.extensions || [], selectedExtensions, 'extensions'),
      paintResourceGroup('Skills', resourceCatalog.skills || [], selectedSkills, 'skills'),
    ] : []));
  };
  loadResources.onclick = async () => {
    loadResources.disabled = true; loadResources.textContent = '读取中…';
    try { resourceCatalog = await api('/api/agent/resources'); paintResources(); }
    catch (error) { show(error.message, 'error'); }
    finally { loadResources.textContent = '重新读取'; loadResources.disabled = backend.value !== 'pi'; }
  };

  const syncBackend = clear => {
    const agent = backend.value;
    if (clear) { model.value = ''; thinking.value = ''; }
    model.placeholder = `${agent} CLI 默认模型`;
    selectOptions(thinking, settings.options.thinking[agent] || [''], clear ? '' : profile.thinking, thinkingLabel);
    paintModels(); paintResources();
  };
  backend.addEventListener('change', () => syncBackend(true));
  loadModels.onclick = async () => {
    const agent = backend.value;
    loadModels.disabled = true; loadModels.textContent = '读取中…';
    try {
      const catalog = await api(`/api/agent/models?agent=${encodeURIComponent(agent)}`);
      modelCatalogs.set(agent, catalog); paintModels();
    } catch (error) { show(error.message, 'error'); }
    finally { loadModels.disabled = false; loadModels.textContent = '重新读取'; }
  };

  form.append(field('Agent', backend, '执行该类任务的 CLI。'),
    field('模型', modelBox, '留空使用所选 CLI 的默认模型；也可以读取 CLI 当前目录或直接填写模型 ID。'),
    field('思考深度', thinking, '可用等级随 Agent 变化。'),
    field('软预算：模型响应数', budgetControls.responses, '每次 invocation 单独计数；达到阈值提醒收尾，不强制终止。仅 Pi；解释角色不继承。'),
    field('软预算：累计 token', budgetControls.tokens, '包含缓存读取，非上下文长度；留空关闭。Codex 不支持，切换前需清空。'),
    field('插件与 Skills', resourcesBox, '从当前用户已安装的 Pi 资源中选择；每个 Agent 配置独立保存。', 'resource-field'));

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
  risk.append(el('strong', '修改会替换内置 Prompt'), el('span', 'Agent 可能失去 Lush 的任务协议、权限边界、协作方式和交付要求，导致调用失败或错误操作。需要撤销修改时可恢复默认。'));
  const defaultPromptBox = el('div', undefined, 'prompt-field-box'); defaultPromptBox.append(defaultPrompt, promptTools, risk);
  form.append(field('默认 Prompt', defaultPromptBox, target === 'default' && roleDefaults
    ? '留空时每个角色使用自己的内置组合；填写后会用同一内容替换所有继承角色。'
    : '这里显示该角色实际生效的基础 Prompt；保存内置内容时仍以默认配置存储。', 'prompt-field'));

  const appendPrompt = el('textarea'); appendPrompt.className = 'agent-prompt'; appendPrompt.dataset.agentField = 'append_prompt'; appendPrompt.rows = 4;
  appendPrompt.maxLength = 32768; appendPrompt.value = profile.append_prompt ?? profile.prompt ?? '';
  appendPrompt.placeholder = '例如：优先保持改动小而可审阅；完成后运行移动端 UI 检查。';
  form.append(field('追加 Prompt', appendPrompt, '追加在最终默认 Prompt 之后，适合补充项目约定。', 'prompt-field'));
  card.append(form); syncBackend(false);

  const actions = el('div', undefined, 'agent-profile-actions');
  actions.append(button('保存配置', async () => {
    const enteredDefaultPrompt = defaultPrompt.value.trim();
    const nextDefaultPrompt = enteredDefaultPrompt === builtInPrompt.trim() ? '' : enteredDefaultPrompt;
    if (nextDefaultPrompt && nextDefaultPrompt !== (profile.default_prompt || '')) {
      const confirmed = await confirmDialog({ title: '替换 Lush 内置 Prompt？',
        message: '保存后，下一次 Agent 调用将不再收到 Lush 内置任务规则。',
        detail: '可能影响：任务 API 使用、权限边界、子任务协作、工作区安全和交付流程。\n请确认你的 Prompt 已完整覆盖这些要求。',
        confirmLabel: '仍然替换并保存', danger: true });
      if (!confirmed) return;
    }
    const next = {
      agent: backend.value, model: model.value.trim(), thinking: thinking.value,
      default_prompt: nextDefaultPrompt, append_prompt: appendPrompt.value.trim(),
      extensions: [...selectedExtensions], skills: [...selectedSkills],
      soft_budget: Object.fromEntries(Object.entries(budgetControls).filter(([, input]) => input.value.trim() !== '')
        .map(([key, input]) => [key, Number(input.value)])),
    };
    const roles = { ...settings.roles };
    const config = target === 'default'
      ? { version: 1, default: next, roles }
      : { version: 1, default: settings.default, roles: { ...roles, [target]: next } };
    const saved = await action('agent.configure', { config });
    if (ui.lastSnapshot?.status) ui.lastSnapshot.status.agent_config = saved;
    show(`${title}已保存；正在运行的调用不受影响，下一次调用使用新配置。`);
    renderSettings();
  }));
  if (target !== 'default') actions.append(button('恢复继承默认', async () => {
    const roles = { ...settings.roles }; delete roles[target];
    const saved = await action('agent.configure', { config: { version: 1, default: settings.default, roles } });
    if (ui.lastSnapshot?.status) ui.lastSnapshot.status.agent_config = saved;
    show(`${title}已恢复继承项目默认配置。`); renderSettings();
  }, 'ghost', { help: '删除这个角色的单独配置，立即改回继承项目默认 Agent 配置' }));
  card.append(actions);
  return card;
}

function inheritedRole(settings, role) {
  const meta = settings.options.roles.find(item => item.id === role) || { id: role, label: role };
  const resolved = settings.resolved[role];
  const card = el('section', undefined, 'agent-role-summary'); card.dataset.agentTarget = role;
  const copy = el('div', undefined, 'agent-role-copy');
  copy.append(el('h3', meta.label), el('p', `${resolved.agent} · ${resolved.model || '默认模型'} · ${thinkingLabel(resolved.thinking)}`, 'settings-note'));
  card.append(copy, el('span', '继承默认', 'badge b-neutral'), button('单独配置', async () => {
    const saved = await action('agent.configure', { config: { version: 1, default: settings.default,
      roles: { ...settings.roles, [role]: { ...resolved } } } });
    if (ui.lastSnapshot?.status) ui.lastSnapshot.status.agent_config = saved;
    renderSettings();
  }, 'ghost', { help: '为这个角色建立独立配置；保存后不再跟随默认配置一起变化' }));
  return card;
}

let environmentTarget = 'common';
const environmentModels = new Map();
const environmentDrafts = new Map();

function environmentRows(model) {
  if (!environmentDrafts.has(model.target)) {
    environmentDrafts.set(model.target, Object.entries(model.values || {}).map(([name, value]) => ({ name, value, visible: false })));
  }
  return environmentDrafts.get(model.target);
}

async function loadEnvironment(target, force = false) {
  if (!force && environmentModels.has(target)) return environmentModels.get(target);
  const model = await api(`/api/agent/environment?target=${encodeURIComponent(target)}`);
  environmentModels.set(target, model);
  environmentDrafts.delete(target);
  return model;
}

function environmentEditor(settings) {
  const section = block('环境变量'); section.classList.add('agent-env-block');
  section.append(el('p', '按需读取并编辑 Agent 子进程环境。值返回浏览器后默认遮罩；公共变量先加载，角色变量随后覆盖。保存会规范化 env 文件并移除原注释与排序。', 'settings-note settings-section-note'));

  const toolbar = el('div', undefined, 'agent-env-toolbar');
  const target = el('select'); target.className = 'agent-env-target'; target.dataset.envTarget = '';
  const targets = [{ id: 'common', label: '公共 · agent.env' }, ...settings.options.roles.map(item => ({ id: item.id, label: `${item.label} · ${item.id}.env` }))];
  for (const item of targets) { const option = el('option', item.label); option.value = item.id; target.append(option); }
  target.value = environmentTarget;
  target.addEventListener('change', () => { environmentTarget = target.value; renderSettings(); });
  const model = environmentModels.get(environmentTarget);
  const load = button(model ? '重新读取' : '读取变量', async () => {
    load.disabled = true; load.textContent = '读取中…';
    try { await loadEnvironment(environmentTarget, true); renderSettings(); }
    catch (error) { show(error.message, 'error'); load.disabled = false; load.textContent = model ? '重新读取' : '读取变量'; }
  }, 'ghost agent-env-load');
  load.type = 'button';
  toolbar.append(target, load); section.append(toolbar);

  if (!model) {
    section.append(el('p', '尚未把变量值读入浏览器。点击“读取变量”后可编辑；读取与写入仅允许用户会话，Agent token 无权访问。', 'settings-readonly settings-note agent-env-empty'));
    return section;
  }

  const rows = environmentRows(model);
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
    const remove = button('删除', () => { rows.splice(index, 1); renderSettings(); }, 'ghost agent-env-remove',
      { help: '从编辑列表移除这条变量；保存环境变量后才会真正删除' }); remove.type = 'button';
    line.append(name, value, reveal, remove); list.append(line);
  });
  section.append(list);

  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.envError = '';
  const fail = message => { errorBox.textContent = message; errorBox.hidden = false; show(message, 'error'); };
  const actions = el('div', undefined, 'agent-env-actions');
  const add = button('新增变量', () => { rows.push({ name: '', value: '', visible: false }); renderSettings(); }, 'ghost'); add.type = 'button'; add.dataset.envAction = 'add';
  const save = button('保存环境变量', async () => {
    const values = {};
    for (const [index, entry] of rows.entries()) {
      const name = entry.name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { fail(`第 ${index + 1} 行的变量名无效。`); return; }
      if (name.startsWith('LUSH_')) { fail(`${name} 由 Lush 保留，不能在这里覆盖。`); return; }
      if (Object.hasOwn(values, name)) { fail(`变量名重复：${name}`); return; }
      values[name] = entry.value;
    }
    errorBox.hidden = true; save.disabled = true;
    const savingTarget = environmentTarget;
    try {
      const saved = await action('agent.environment.configure', { target: savingTarget, values });
      environmentModels.set(savingTarget, saved); environmentDrafts.delete(savingTarget);
      show(`${savingTarget === 'common' ? '公共' : savingTarget}环境变量已保存；下一次 Agent 调用生效。`);
      renderSettings();
    } catch (error) { fail(error.message); save.disabled = false; }
  }, 'primary'); save.type = 'button'; save.dataset.envAction = 'save';
  actions.append(add, save, el('code', model.file, 'settings-path agent-env-path'));
  section.append(actions, errorBox);
  return section;
}

function agentTab() {
  const content = el('div', undefined, 'settings-tab-panel agent-settings');
  const settings = ui.lastSnapshot?.status?.agent_config;
  if (!settings) {
    const waiting = block('Agent 配置');
    waiting.append(el('p', '正在等待 daemon 快照。连接建立后可配置 Pi、Codex、模型、思考深度与各任务角色的追加 Prompt。', 'settings-placeholder'));
    content.append(waiting); return content;
  }
  const intro = el('div', undefined, 'agent-callout');
  intro.append(el('strong', '项目级 · 动态生效'), el('p', `配置保存在 ${settings.file}。正在运行的调用保持不变，排队任务与后续唤醒会读取最新配置。`, 'settings-note'));
  content.append(intro);
  content.append(profileEditor(settings, settings.default, 'default', '默认 Agent', '所有未单独配置的任务行为都继承这里。'));

  const roles = block('按任务行为覆盖'); roles.classList.add('agent-roles-block');
  roles.append(el('p', '只为需要不同模型、思考深度或工作方式的行为建立覆盖；其余保持继承，后续调整默认值时会一起更新。', 'settings-note settings-section-note'));
  const list = el('div', undefined, 'agent-role-list');
  for (const item of settings.options.roles) {
    if (settings.roles[item.id]) list.append(profileEditor(settings, settings.roles[item.id], item.id, item.label, `仅用于 ${item.id} 角色。`));
    else list.append(inheritedRole(settings, item.id));
  }
  roles.append(list); content.append(roles, environmentEditor(settings));
  return content;
}

// 并发上限是唯一可以在浏览器里改写的运行设置；范围与核心 RUNTIME_SETTINGS_LIMITS 一致。
const RUNTIME_FIELDS = [
  { key: 'concurrency', label: '执行通道', max: 64 },
  { key: 'control_concurrency', label: '控制通道', max: 16 },
];

/** 候选状态回写快照：保存 / 恢复成功后，不依赖下一次轮询就能重画出新值。 */
function applyRuntimeSettings(settings) {
  const status = ui.lastSnapshot?.status;
  if (!status || !settings) return;
  status.settings = settings;
  status.concurrency = settings.concurrency?.value;
  status.control_concurrency = settings.control_concurrency?.value;
}

/** 「并发额度」编辑器：两个数字输入 + 保存 / 恢复环境默认；越界与后端报错都在页面上说清。 */
function concurrencyEditor(runtime, plain) {
  const box = el('div', undefined, 'settings-runtime');
  const grid = el('div', undefined, 'settings-runtime-grid');
  const inputs = {};
  for (const spec of RUNTIME_FIELDS) {
    const entry = runtime[spec.key] || {};
    const cell = el('label', undefined, 'settings-runtime-field'); cell.dataset.runtimeField = spec.key;
    const input = el('input'); input.type = 'number'; input.min = '1'; input.max = String(spec.max); input.step = '1';
    input.className = 'settings-number'; input.dataset.runtimeInput = spec.key; input.value = plain(entry.value);
    input.setAttribute('aria-label', `${spec.label}并发上限（1..${spec.max}）`);
    const source = el('span', entry.overridden ? '已覆盖' : '环境默认', `settings-source${entry.overridden ? ' overridden' : ''}`);
    source.dataset.runtimeSource = spec.key;
    const state = el('span', `生效 ${plain(entry.value)} · 环境默认 ${plain(entry.default)} · ${entry.overridden ? '已覆盖' : '环境默认'}`, 'settings-note');
    state.dataset.runtimeState = spec.key;
    cell.append(el('span', spec.label, 'settings-field-label'), input, source, state);
    grid.append(cell); inputs[spec.key] = input;
  }
  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.runtimeError = '';
  const fail = message => { errorBox.textContent = message; errorBox.hidden = false; show(message, 'error'); };
  const actions = el('div', undefined, 'settings-runtime-actions');
  const save = button('保存', async () => {
    const patch = {};
    for (const spec of RUNTIME_FIELDS) {
      const raw = String(inputs[spec.key].value).trim();
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > spec.max) {
        fail(`${spec.label}需要 1 到 ${spec.max} 之间的整数。`); return;
      }
      patch[spec.key] = value;
    }
    errorBox.hidden = true;
    const saved = await action('system.configure', { settings: patch });
    applyRuntimeSettings(saved);
    show('并发额度已保存，立即对排队任务生效。');
    renderSettings();
  }, 'primary settings-runtime-save');
  save.dataset.runtimeAction = 'save';
  const reset = button('恢复环境默认', async () => {
    errorBox.hidden = true;
    const settings = {}; for (const spec of RUNTIME_FIELDS) settings[spec.key] = null;
    const saved = await action('system.configure', { settings });
    applyRuntimeSettings(saved);
    show('并发额度已恢复环境默认。');
    renderSettings();
  }, 'ghost settings-runtime-reset', { help: '清除两项并发额度的覆盖值，立即恢复环境默认' });
  reset.dataset.runtimeAction = 'reset';
  actions.append(save, reset);
  box.append(grid, actions, errorBox);
  return box;
}

/**
 * 「输入前缀（快速路由）」编辑器：列出命中后直接派活的前缀与目标，可增删。
 * 保存写 system.configure 的 input_routes，恢复默认送 null 清除项目覆盖；保存后立即重画输入框高亮。
 * 只读 fast path：这里只是把同一套结构交给核心，真正的匹配规则在 core 与浏览器 input-routes.js。
 */
const ROUTE_TARGET_LABELS = { worker: 'worker · 开发', research: 'research · 调研' };

function inputRoutesEditor(runtime) {
  const fallback = { value: DEFAULT_INPUT_ROUTES.map(route => ({ ...route })), default: DEFAULT_INPUT_ROUTES.map(route => ({ ...route })), overridden: false };
  const entry = runtime.input_routes || fallback;
  const section = block('输入前缀（快速路由）');
  section.append(el('p', '以这些前缀开头的输入不调用规划模型，直接按目标创建根任务：worker 会进入开发流程，research 只做调研。保存后立即生效，输入框会高亮命中的前缀。', 'settings-note settings-section-note'));

  const list = el('div', undefined, 'settings-route-list'); list.dataset.routeList = '';
  const addRow = (prefix = '', target = 'worker') => {
    const line = el('div', undefined, 'settings-route-row');
    const prefixInput = el('input'); prefixInput.type = 'text'; prefixInput.className = 'settings-route-prefix';
    prefixInput.maxLength = 32; prefixInput.value = prefix; prefixInput.placeholder = '例如：开发'; prefixInput.spellcheck = false;
    prefixInput.setAttribute('aria-label', '快速路由前缀'); prefixInput.dataset.routePrefix = '';
    const select = el('select'); select.className = 'settings-route-target'; select.setAttribute('aria-label', '命中后的派活目标');
    for (const value of ROUTE_TARGETS) { const option = el('option', ROUTE_TARGET_LABELS[value] || value); option.value = value; select.append(option); }
    select.value = ROUTE_TARGETS.includes(target) ? target : 'worker'; select.dataset.routeTarget = '';
    const remove = button('删除', () => { line.remove(); paintState(); }, 'ghost settings-route-remove',
      { help: '从列表移除这个前缀；点「保存前缀」后才会真正删除' });
    remove.dataset.routeAction = 'remove';
    line.append(prefixInput, select, remove); list.append(line); return line;
  };
  for (const route of entry.value) addRow(route.prefix, route.target);

  const stateNote = el('span', '', 'settings-note'); stateNote.dataset.routeState = '';
  const paintState = () => {
    stateNote.textContent = `共 ${list.children.length} 个前缀 · ${entry.overridden ? '已覆盖项目默认' : '默认前缀'}`;
  };
  paintState();

  const errorBox = el('p', undefined, 'settings-error'); errorBox.hidden = true; errorBox.dataset.routeError = '';
  const fail = message => { errorBox.textContent = message; errorBox.hidden = false; show(message, 'error'); };

  const collect = () => {
    const routes = [], seen = new Set();
    for (const [index, line] of [...list.children].entries()) {
      const prefix = line.querySelector('.settings-route-prefix').value.trim();
      const target = line.querySelector('.settings-route-target').value;
      if (!prefix) { fail(`第 ${index + 1} 个前缀为空；填写前缀或先删除该行。`); return null; }
      if (prefix.length > 32 || /\s/u.test(prefix)) { fail(`前缀「${prefix}」不能包含空白，且最多 32 个字符。`); return null; }
      if (seen.has(prefix.toLowerCase())) { fail(`前缀「${prefix}」重复；每个前缀只能配一个目标。`); return null; }
      seen.add(prefix.toLowerCase());
      routes.push({ prefix, target });
    }
    if (routes.length > 32) { fail('前缀最多 32 个。'); return null; }
    return routes;
  };

  const actions = el('div', undefined, 'settings-route-actions');
  const add = button('新增前缀', () => {
    const line = addRow(); paintState(); line.querySelector('.settings-route-prefix').focus();
  }, 'ghost settings-route-add');
  add.dataset.routeAction = 'add';
  const save = button('保存前缀', async () => {
    const routes = collect(); if (!routes) return;
    errorBox.hidden = true;
    const saved = await action('system.configure', { settings: { input_routes: routes } });
    applyRuntimeSettings(saved);
    paintInputHighlight();
    show(routes.length ? `已保存 ${routes.length} 个快速路由前缀，立即生效。` : '已清空快速路由前缀；所有输入都会走规划模型。');
    renderSettings();
  }, 'primary settings-route-save');
  save.dataset.routeAction = 'save';
  const reset = button('恢复默认前缀', async () => {
    errorBox.hidden = true;
    const saved = await action('system.configure', { settings: { input_routes: null } });
    applyRuntimeSettings(saved);
    paintInputHighlight();
    show('已恢复默认快速路由前缀（开发 / 解释）。');
    renderSettings();
  }, 'ghost settings-route-reset', { help: '清除项目覆盖的前缀表，恢复内置默认（开发 / 解释）；点击后立即写入项目设置' });
  reset.dataset.routeAction = 'reset';
  actions.append(add, save, reset, stateNote);
  section.append(list, actions, errorBox);
  return section;
}

function systemTab() {
  const content = el('div', undefined, 'settings-tab-panel');
  const snapshot = ui.lastSnapshot?.status ?? null;
  const section = block('运行状态');
  section.append(el('p', '这里展示 daemon 的当前状态。Agent 配置请在 Agent 页修改；并发额度可在下方改写并立即生效，其余参数在 daemon 启动时从环境变量读取。', 'settings-note settings-readonly'));
  if (!snapshot) {
    section.append(el('p', '尚未收到 daemon 快照。', 'settings-value settings-placeholder')); content.append(section); return content;
  }
  const plain = value => (value === null || value === undefined || value === '') ? '—' : String(value);
  const line = (fieldName, title, note, value) => { const node = el('span', value, 'settings-value'); node.dataset.systemField = fieldName; return row(title, note, node); };
  section.append(line('provider', '默认 Agent', '当前项目未覆盖角色时使用的 Agent。', plain(snapshot.provider)));
  section.append(line('call_timeout', '单次调用超时', 'LUSH_CALL_TIMEOUT。', `${plain(snapshot.call_timeout)} 秒`));
  section.append(line('task_call_limit', '单任务调用上限', 'LUSH_TASK_CALLS。', plain(snapshot.task_call_limit)));
  section.append(line('max_depth', '最大拆解深度', 'LUSH_MAX_DEPTH。', plain(snapshot.max_depth)));
  content.append(section);

  // 核心总是给出 settings；缺失时退回顶层生效值，至少不编造来源。
  const runtime = snapshot.settings ?? { file: null,
    concurrency: { value: snapshot.concurrency, default: null, overridden: false },
    control_concurrency: { value: snapshot.control_concurrency, default: null, overridden: false } };
  const concurrency = block('并发额度');
  concurrency.append(el('p', '执行通道与控制通道的并发上限；保存后写入项目设置文件，排队任务立即重新准入，不需要重启 daemon。', 'settings-note settings-section-note'));
  concurrency.append(concurrencyEditor(runtime, plain));
  concurrency.append(row('设置文件', '运行设置的保存位置；文件不存在表示全部使用环境默认。', el('code', plain(runtime.file), 'settings-path')));
  content.append(concurrency);

  content.append(inputRoutesEditor(runtime));

  const paths = block('项目路径');
  paths.append(line('project', '项目', 'daemon 绑定的 canonical 项目目录。', plain(snapshot.project)));
  paths.append(line('home', '状态目录', '项目数据库、会话、配置与工作区。', plain(snapshot.home)));
  paths.append(line('agent_config_file', 'Agent 配置', '项目级 Agent 配置文件。', plain(snapshot.agent_config?.file)));
  content.append(paths);
  return content;
}

function tabBar() {
  const nav = el('div', undefined, 'settings-tabs'); nav.setAttribute('role', 'tablist');
  for (const tab of TABS) {
    const node = el('button', undefined, `settings-tab${activeTab === tab.id ? ' active' : ''}`); node.type = 'button'; node.dataset.settingsTab = tab.id;
    node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(activeTab === tab.id));
    node.append(el('strong', tab.label), el('span', tab.note));
    node.onclick = () => { activeTab = tab.id; renderSettings(); };
    nav.append(node);
  }
  return nav;
}

export function renderSettings() {
  if (!ui.settingsOpen) return; // 保存或读取配置的迟到回调不能抢回其他页面。
  const panel = $('detail'); panel.dataset.view = 'settings';
  const view = el('div', undefined, 'settings-view');
  const head = el('div', undefined, 'settings-head');
  const intro = el('div'); intro.append(el('span', 'PROJECT SETTINGS', 'eyebrow'), el('h1', '设置'), el('p', '项目 Agent 与当前浏览器体验，分开管理。', 'hint'));
  head.append(intro); view.append(head, tabBar());
  view.append(activeTab === 'sleep' ? sleepSettings() : activeTab === 'agent' ? agentTab() : activeTab === 'interface' ? interfaceTab() : systemTab());
  panel.replaceChildren(view);
}

for (const name of PREF_NAMES) onPrefChange(name, () => { if (ui.settingsOpen && activeTab === 'interface') renderSettings(); });
