/** Device default/role profiles: mode, model, thinking, prompt and explicit resources. */
import { button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { createAgentConnectionPicker } from './agent-connection-picker.js';
import { CONFIG_MODES, PI_MODE_HELP, normalizeConfigMode, profileForMode } from './agent-config-mode.js';
import { settingsClientFor } from './settings-api.js';
import { draftFingerprint } from './settings-scope.js';
import { field, selectOptions, thinkingLabel } from './settings-controls.js';
import { createProfileResources } from './settings-profile-resources.js';
import { createManagementProfileForm } from './management-profile-form.js';
import { buttonFeedback } from './button-feedback.js';

const modelCatalogs = new Map();
/** Keep failures beside the edited form; never repaint over edits made during a write. */
function profileWriter(card, settings, client, repaint, ownsPage) {
  const feedback = el('p', undefined, 'settings-error agent-profile-feedback'); feedback.hidden = true; feedback.setAttribute('role', 'alert');
  let pending = false;
  const current = () => ownsPage() && card.isConnected !== false;
  const fail = message => { if (current()) { feedback.textContent = message; feedback.hidden = false; } };
  return { feedback, fail, async save(config, message) {
    if (!current() || pending) return;
    pending = true; feedback.hidden = true;
    const draft = draftFingerprint(card);
    try {
      const saved = await client.action('agent.configure', { config });
      if (!current()) return;
      show(message);
      if (draft === draftFingerprint(card)) repaint(saved);
      else { Object.assign(settings, saved); show('配置已保存；保留你随后输入的未保存修改。'); }
    } catch (error) { fail(`配置保存未完成：${error.message}；草稿保留，请核对后重试。`); }
    finally { pending = false; }
  } };
}
export function profileEditor(settings, profile, target, title, subtitle, repaint, ownsPage, savedSummary = null, names = new Map()) {
  if (target === 'manager') return valetProfileEditor(settings, profile, repaint, ownsPage);
  const client = settingsClientFor(settings);
  const card = el('section', undefined, 'agent-profile'); card.dataset.agentTarget = target;
  const head = el('div', undefined, 'agent-profile-head section-title');
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

  let modelsReading = false;
  const loadModels = el('button', '读取 CLI 模型', 'ghost model-load'); loadModels.type = 'button';
  const modelFeedback = el('p', undefined, 'settings-error'); modelFeedback.hidden = true; modelFeedback.setAttribute('role', 'alert');
  const modelBusy = buttonFeedback(loadModels, '读取中…');
  loadModels.setAttribute('data-help', '只读取执行机器的 Codex CLI 模型目录，不调用模型；保留当前名称输入。');
  connectionPicker.actions.append(loadModels); connectionPicker.node.append(modelFeedback);

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
    loadModels.disabled = modelsReading;
    const values = new Map((settings.options.models[agent] || []).map(id => [id, id]));
    const catalog = modelCatalogs.get(`${client.key}:${agent}`);
    for (const entry of catalog?.models || []) values.set(entry.id, entry.label && entry.label !== entry.id ? `${entry.label} · ${entry.id}` : entry.id);
    connectionPicker.setCliModels([...values].map(([id, label]) => ({ id, label })));
    connectionPicker.modelExtras.replaceChildren(...(catalog ? [el('span', catalog.warning || `已从本机 ${agent} CLI 读取当前可用模型。`, `model-catalog-note${catalog.warning ? ' warning' : ''}`)] : []));
  };

  const resources = createProfileResources({ profile, backend, mode, ownsPage, client });

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
    paintModels(); resources.paint();
  };
  backend.addEventListener('change', () => syncBackend(true));
  loadModels.onclick = async () => {
    if (!ownsPage() || modelsReading || backend.value === 'pi' || connectionPicker.value()) return;
    const agent = backend.value;
    modelsReading = true; loadModels.disabled = true; modelBusy(true); modelFeedback.hidden = true;
    try {
      const catalog = await client.read(`/api/agent/models?agent=${encodeURIComponent(agent)}`);
      if (!ownsPage() || card.isConnected === false || backend.value !== agent) return;
      modelCatalogs.set(`${client.key}:${agent}`, catalog); paintModels();
    } catch (error) { if (ownsPage() && card.isConnected !== false && backend.value === agent) { modelFeedback.textContent = `模型目录读取失败：${error.message}；当前模型输入保留。`; modelFeedback.hidden = false; } }
    finally { modelsReading = false; modelBusy(false); if (ownsPage()) paintModels(); }
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
    field('插件与 Skills', resources.node, '从 Lush 独立 Pi 目录发现资源；保留显式配置的资源路径，每个 Agent 配置独立保存。', 'resource-field'));
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
        resources.clear(); syncPromptState();
        connectionPicker.reset('');
      }
    }
    for (const node of managedFields) node.hidden = !lush;
    workstyle.hidden = !lush;
    advanced.hidden = !lush;
    modeNote.textContent = lush
      ? '使用 Lush 托管的模型来源、模型、思考深度、Prompt 与资源；对自己的配置掌握力更强。'
      : PI_MODE_HELP;
    paintModels(); resources.paint(); syncThinking(!lush);
  };
  mode.addEventListener('change', () => syncMode(true));
  card.append(form); syncBackend(false); syncMode(normalizeConfigMode(profile.config_mode) === 'pi');
  void connectionPicker.load();

  const writer = profileWriter(card, settings, client, repaint, ownsPage);
  const actions = el('div', undefined, 'agent-profile-actions');
  actions.append(button('保存配置', async () => {
    if (!ownsPage()) return;
    const selectedMode = normalizeConfigMode(mode.value);
    let nextDefaultPrompt = '';
    if (selectedMode === 'lush') {
      const connectionError = connectionPicker.validate();
      if (connectionError) { writer.fail(connectionError); return; }
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
      ...resources.collect(),
      soft_budget: Object.fromEntries(Object.entries(budgetControls).filter(([, input]) => input.value.trim() !== '')
        .map(([key, input]) => [key, Number(input.value)])),
    });
    const roles = { ...settings.roles };
    const config = target === 'default'
      ? { version: 1, default: next, roles }
      : { version: 1, default: settings.default, roles: { ...roles, [target]: next } };
    await writer.save(config, `${title}已保存；正在运行的调用不受影响，下一次调用使用新配置。`);
  }, undefined, { busyLabel: '保存中…' }));
  if (target !== 'default') actions.append(button('恢复继承默认', async () => {
    const roles = { ...settings.roles }; delete roles[target];
    if (!ownsPage()) return;
    await writer.save({ version: 1, default: settings.default, roles }, `${title}已恢复继承设备默认配置。`);
  }, 'ghost', { busyLabel: '恢复中…', help: '删除这个角色的单独配置，立即改回继承当前编辑层的默认 Agent 配置' }));
  card.append(writer.feedback, actions);
  return card;
}

function valetProfileEditor(settings, profile, repaint, ownsPage) {
  const client = settingsClientFor(settings);
  const card = el('section', undefined, 'agent-profile'); card.dataset.agentTarget = 'manager';
  card.append(el('h3', 'Valet'), el('p', '管理调用的默认来源与模型；使用独立提示词和受限工具，不继承开发 Prompt、扩展或环境变量。已创建的 Valet 保留其固定配置。', 'settings-note'));
  const form = createManagementProfileForm(settings, { profile, ownsPage, read: client.read });
  const writer = profileWriter(card, settings, client, repaint, ownsPage);
  card.append(form.node, writer.feedback, button('保存配置', async () => {
    if (!ownsPage()) return;
    const issue = form.validate(); if (issue) { writer.fail(issue); return; }
    await writer.save({ version: 1, default: settings.default,
      roles: { ...settings.roles, manager: form.collect() } }, 'Valet 默认配置已保存；仅新建管理工作生效。');
  }, undefined, { busyLabel: '保存中…' }), button('恢复继承默认', async () => {
    if (!ownsPage()) return;
    const roles = { ...settings.roles }; delete roles.manager;
    await writer.save({ version: 1, default: settings.default, roles }, 'Valet 已恢复继承默认；已创建的管理工作保持其固定配置。');
  }, 'ghost', { busyLabel: '恢复中…', help: '删除 Valet 单独默认配置；已创建的管理工作保持其固定配置。' }));
  return card;
}

export function inheritedRole(settings, role, repaint, names = new Map(), ownsPage = () => true) {
  const client = settingsClientFor(settings);
  const meta = settings.options.roles.find(item => item.id === role) || { id: role, label: role };
  const resolved = settings.resolved[role];
  const card = el('section', undefined, 'agent-role-summary'); card.dataset.agentTarget = role;
  const copy = el('div', undefined, 'agent-role-copy');
  const named = resolved.connection_id ? (names.get(resolved.connection_id) || resolved.connection_id) : '';
  const source = resolved.agent === 'pi' ? (named ? `来源 ${named}` : '未选择来源') : 'Codex CLI 自身认证';
  const summary = normalizeConfigMode(resolved.config_mode) === 'pi' ? 'Pi 默认配置（执行机器 Pi）'
    : `${resolved.agent} · ${source} · ${resolved.model || (resolved.agent === 'pi' ? '请选择来源内模型' : 'CLI 默认模型')} · ${thinkingLabel(resolved.thinking)}`;
  copy.append(el('h3', role === 'manager' ? 'Valet' : meta.label), el('p', summary, 'settings-note'));
  const writer = profileWriter(card, settings, client, repaint, ownsPage);
  copy.append(writer.feedback);
  card.append(copy, el('span', '继承默认', 'badge b-neutral'), button('单独配置', async () => {
    await writer.save({ version: 1, default: settings.default,
      roles: { ...settings.roles, [role]: { ...resolved } } }, '已建立独立配置。');
  }, 'ghost', { busyLabel: '建立中…', help: '为这个角色建立独立配置；保存后不再跟随默认配置一起变化' }));
  return card;
}
