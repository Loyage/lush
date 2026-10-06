import { $, el, button, badge, block } from './dom.js';
import { api, action } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { detail } from './navigate.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { agentHelp } from './help.js';
import { workerKind } from './worker-kind.js';
import { isHistoricalDelivery, absolute } from './format.js';
import { createHookForm } from './hook-form.js';
import { autoMergeControl, autoCompletionControl, COMPLETION_LEVELS, HOOK_STATES as STATES } from './hook-controls.js';
import { workerLabel } from './worker-label.js';

const pending = new Set();
const callsAgent = mount => (mount.actions || []).some(a => a.type === 'message' || a.type === 'request_merge' || (a.type === 'create_worker' && a.start !== false));
function guarded(node, reason) {
  if (!reason) return node;
  node.disabled = true; const host = el('span', undefined, 'help-host'); host.tabIndex = 0;
  host.setAttribute('data-help', `${reason} ${node.getAttribute('data-help') || ''}`); host.append(node); return host;
}
function summary(actionItem) {
  return actionItem.type === 'create_worker' ? `预约创建 Worker${actionItem.start !== false ? '并开始 Agent' : '（待开始）'}：${actionItem.content || ''}`
    : actionItem.type === 'notify' ? `发送告知：${actionItem.title || ''}`
      : actionItem.type === 'message' ? `追加消息到 ${workerLabel(actionItem.target_id, actionItem.target_worker_number)}：${actionItem.body || ''}` : actionItem.type === 'request_merge' ? '冻结源提交并向直接父 Worker 请求合并'
        : actionItem.type === 'accept_worker' ? '安全条件通过后自动验收；不调用质量评审 Agent，不保证业务质量'
          : actionItem.type === 'archive_worker' ? '验收后归档分支及后代，清理 worktree/ref；保留 Worker、会话和历史，不丢弃未提交改动' : actionItem.type;
}
function parameters(mount) {
  const content = el('details', undefined, 'hook-parameters'); content.append(el('summary', '参数与最近执行'));
  for (const item of mount.actions || []) {
    content.append(el('p', summary(item), 'hook-action-preview'));
    if (item.model_selection) content.append(el('p', `动作运行设置：${item.model_selection.config_mode === 'pi' ? '执行机器的 Pi 默认配置' : [item.model_selection.agent, item.model_selection.model, item.model_selection.thinking].filter(Boolean).join(' · ') || '已固定默认配置'}`, 'hint'));
  }
  const selection = mount.model_selection;
  if (selection) content.append(el('p', `预约运行设置：${selection.config_mode === 'pi' ? '执行机器的 Pi 默认配置' : [selection.agent, selection.model, selection.thinking].filter(Boolean).join(' · ') || '已固定默认配置'}`, 'hint'));
  const conditions = mount.conditions || {};
  content.append(el('p', `条件：${conditions.statuses?.length ? `状态 ${conditions.statuses.join(' / ')}` : '状态不限'} · ${conditions.integrations?.length ? `集成 ${conditions.integrations.join(' / ')}` : '集成不限'}`, 'hint'));
  const last = mount.last_execution;
  if (last) {
    content.append(el('p', `最近执行：${STATES[last.status] || last.status} · ${absolute(last.finished_at || last.created_at)}`, 'hint'));
    if (last.error) content.append(el('p', last.error, 'error'));
    if (last.worker_id) content.append(button(`查看创建的 Worker ${workerLabel(last.worker_id, last.worker_number)}`, () => detail(last.worker_id), 'ghost hook-button'));
  } else content.append(el('p', '还没有执行记录。', 'hint'));
  return content;
}
const BUILTIN_STEPS = {
  'auto-merge': { number: 1, help: '第 1 步：交付就绪后尝试合并，沿用父队列和 Git 门禁。不是任意一轮 Agent 返回。' },
  'auto-accept': { number: 2, help: '第 2 步：先合并（或经安全校验确认无需合并），再检查调用退出、后代、消息、待决和交付条件，代替用户确认。不是质量评审。' },
  'auto-archive': { number: 3, help: '第 3 步：先验收，再检查子树终态、冻结、当前检出和清洁度，归档分支及后代；失败不撤销验收，不丢弃未提交改动。' },
};
function mountCard(task, mount, model, refresh, ownsPage, completion) {
  const row = el('article', undefined, 'hook-mount'); row.dataset.hookId = mount.id;
  const head = el('div', undefined, 'hook-mount-head');
  const step = BUILTIN_STEPS[mount.id];
  if (step) head.append(badge(`第 ${step.number} 步`));
  head.append(el('strong', mount.name), badge(mount.mode === 'persistent' ? '持续' : '一次性'), badge(mount.enabled ? '启用' : '停用'), badge(STATES[mount.state] || mount.state || '已挂载'));
  if (mount.locked) head.append(badge('锁定')); row.append(head);
  if (mount.id === 'auto-merge' && !completion) row.append(autoMergeControl(task, refresh, ownsPage));
  else if (mount.builtin || step) {
    row.append(el('p', step?.help || '此动作由内置安全边界授权。', 'hint hook-builtin-step'),
      el('p', completion ? '由上方最高自动级别统一配置；内置 Hook 不可移除。' : '最高自动级别暂不可用；请刷新或更新服务，不能单独调整此内置 Hook。', 'hint'));
  } else {
    const actions = el('div', undefined, 'actions hook-actions');
    const key = `${task.id}:${mount.id}`, busy = pending.has(key);
    const update = async remove => {
      if (!ownsPage() || pending.has(key)) return;
      if (remove && !await confirmDialog({ title: `移除 Hook「${mount.name}」？`,
        message: '仅移除未来触发。不会取消已开始的动作、删除已创建的 Worker，或撤回已发出的合并请求和消息。', confirmLabel: '移除挂载',
        confirmHelp: '移除当前 Worker 的这个 Hook；执行历史与已产生的成果保留。' })) return;
      if (!ownsPage()) return;
      pending.add(key); for (const node of actions.querySelectorAll('button')) node.disabled = true;
      try {
        await action(remove ? 'worker.hook_remove' : 'worker.hook_update', { id: task.id, hook_id: mount.id, expected_revision: model.revision,
          ...(remove ? {} : { enabled: !mount.enabled }) });
        if (ownsPage()) { show(remove ? '已移除挂载，已有成果不变。' : '已保存 Hook 启用状态。'); await refresh(); }
      } catch (error) { if (ownsPage()) show(`${error.message}；请刷新读取最新挂载状态。`, 'error'); }
      finally { pending.delete(key); if (ownsPage()) {
        const [toggle, remove] = actions.querySelectorAll('button');
        if (toggle) toggle.disabled = mount.editable !== true;
        if (remove) remove.disabled = (mount.removable ?? mount.editable) !== true || mount.locked;
      } }
    };
    const agent = !mount.enabled && callsAgent(mount);
    const help = '只修改未来触发；停用不撤回已开始的动作。启用后条件满足即可执行。';
    actions.append(guarded(button(mount.enabled ? '停用 Hook' : '启用 Hook', () => update(false), 'ghost hook-button', { agent, help: agent ? agentHelp(help) : help }),
      busy ? '此挂载正在保存。' : mount.editable !== true ? mount.reason || '当前挂载不可编辑。' : null));
    actions.append(guarded(button('移除挂载', () => update(true), 'ghost hook-button', { help: '移除未来触发，不删除已产生的 Worker、提交或消息。' }),
      busy ? '此挂载正在保存。' : (mount.removable ?? mount.editable) !== true || mount.locked ? mount.reason || '此挂载不可移除。' : null));
    row.append(actions);
  }
  if (mount.reason) row.append(el('p', mount.reason, 'hint'));
  row.append(parameters(mount)); return row;
}

/** Synchronous inspect projection; graph uses the same compact, non-mutating entry. */
export function workerHooks(task, { refresh = () => detail(task.id), compact = false } = {}) {
  if (!['order', 'child', 'main', 'owner'].includes(workerKind(task)) || isHistoricalDelivery(task)) return null;
  const identity = ui.view, ownsPage = () => ui.view === identity;
  const model = task.hooks;
  const completion = model && Object.hasOwn(model, 'completion') ? model.completion : task.completion;
  const mounts = Array.isArray(model?.mounts) ? model.mounts : [];
  const fallback = ['order', 'child'].includes(workerKind(task)) ? [{ id: 'auto-merge', name: '自动合并', trigger: 'worker.delivery_ready', mode: 'persistent',
    enabled: task.auto_merge?.enabled === true, builtin: true, locked: task.auto_merge?.locked === true, state: 'idle', reason: task.auto_merge?.reason, actions: [{ type: 'request_merge' }] }] : [];
  const items = model ? mounts : fallback;
  if (compact) {
    const row = el('div', undefined, 'hook-compact');
    row.append(button(`Hooks${model ? ` · ${items.filter(item => item.enabled).length} 已启用` : ''}`, () => detail(task.id), 'ghost hook-button',
      { help: '打开此 Worker 详情中的已挂载 Hooks；只查看，不启动 Agent。' }));
    if (['order', 'child'].includes(workerKind(task))) row.append(el('span', completion ? `自动链：${COMPLETION_LEVELS[completion.level] || '级别未知'} · ${STATES[completion.state] || completion.state || '状态未知'}`
      : task.auto_merge ? `自动合并 ${task.auto_merge.enabled ? '已启用' : '未启用'}` : '自动合并状态未知', 'hint'));
    return row;
  }
  const section = block('Hooks · 已挂载'); section.classList.add('worker-hooks');
  section.append(el('p', completion ? '预约是一次性 Hook；自动链按合并 → 验收 → 归档串行推进，用最高自动级别统一授权。节点触发后仍须复核权限、消息、待决、后代和 Git 安全条件。'
    : '预约是一次性 Hook，自动合并是持续 Hook。节点触发后仍须复核权限、消息、待决、后代和 Git 安全条件。', 'hint'));
  if (completion) section.append(autoCompletionControl(task, { ...model, completion }, refresh, ownsPage,
    editing => { section.dataset.completionEditing = String(editing); }));
  if (!model) section.append(el('p', '完整挂载列表暂不可用；下方仅显示已有自动合并设置，请更新服务或刷新。', 'hint'));
  if (!items.length) section.append(el('p', '此 Worker 尚未挂载 Hook。', 'hint'));
  const groups = new Map(); for (const mount of items) { const group = groups.get(mount.trigger) || []; group.push(mount); groups.set(mount.trigger, group); }
  const descriptions = [];
  const phaseOrder = ['worker.delivery_ready', 'delivery.integrated', 'worker.accepted'];
  for (const [trigger, group] of [...groups].sort(([a], [b]) => (phaseOrder.includes(a) ? phaseOrder.indexOf(a) : 3) - (phaseOrder.includes(b) ? phaseOrder.indexOf(b) : 3))) {
    const part = el('section', undefined, 'hook-trigger-group');
    const heading = el('h3', trigger === 'worker.delivery_ready' ? 'Agent 完成工作后 · 交付就绪' : trigger === 'delivery.integrated' ? '合并完成后 · 已集成' : trigger === 'worker.accepted' ? '验收完成后' : trigger);
    const explanation = el('p', trigger === 'worker.delivery_ready' ? '不是任意一轮返回：实际退出且子 Worker、消息与待决均已处理后才尝试触发。'
      : trigger === 'delivery.integrated' ? '成果落地后才尝试验收，仍须通过原有安全条件。' : trigger === 'worker.accepted' ? '验收后才尝试归档，代码现场清理仍受 Git 与子树安全门保护。' : '节点说明以项目 Hooks 目录为准。', 'hint');
    descriptions.push({ trigger, heading, explanation }); part.append(heading, explanation);
    for (const mount of group) part.append(mountCard(task, mount, model, refresh, ownsPage, completion));
    section.append(part);
  }
  const paintDescriptions = catalogue => {
    if (!ownsPage()) return;
    for (const item of descriptions) {
      const definition = catalogue.triggers?.find(trigger => trigger.id === item.trigger);
      if (!definition || item.trigger === 'worker.delivery_ready') continue;
      item.heading.textContent = definition.label; item.explanation.textContent = definition.description;
    }
  };
  if (ui.hookCatalogue) paintDescriptions(ui.hookCatalogue);
  else if (model) {
    const request = ui.hookCataloguePending || api('/api/hooks'); ui.hookCataloguePending = request;
    request.then(catalogue => { if (ui.hookCataloguePending === request) ui.hookCatalogue = catalogue; paintDescriptions(catalogue); })
      .catch(() => {}).finally(() => { if (ui.hookCataloguePending === request) ui.hookCataloguePending = null; });
  }
  const editor = el('div', undefined, 'hook-editor');
  const controls = el('div', undefined, 'actions hook-actions');
  const writable = model && !['completed', 'failed', 'cancelled'].includes(task.status) && !task.archived && !task.branch_archive?.archived;
  const attach = button('挂载 Hook', async () => {
    if (!ownsPage() || !writable || pending.has(`attach:${task.id}`)) return;
    pending.add(`attach:${task.id}`); attach.disabled = true;
    try {
      const catalogue = await api('/api/hooks'); if (!ownsPage()) return;
      const picker = el('select'); picker.setAttribute('aria-label', '挂载模板');
      const blank = el('option', '新建自定义规则'); blank.value = ''; picker.append(blank);
      for (const template of catalogue.templates || []) { const option = el('option', template.name); option.value = template.id; picker.append(option); }
      const host = el('div'); editor.replaceChildren(picker, host); section.dataset.hookEditing = 'true';
      const paint = () => {
        if (pending.has(`save:${task.id}`)) return;
        const template = catalogue.templates?.find(t => t.id === picker.value);
        let save = null;
        const paintCost = agent => {
          if (!save) return;
          save.classList.toggle('agent-call', agent);
          const help = '保存此 Worker 的 Hook 挂载授权；条件满足时执行受控动作，纯告知不调用 Agent。';
          save.setAttribute('data-help', agent ? agentHelp(help) : help);
        };
        const form = template ? null : createHookForm(catalogue, { ownsPage, workerId: task.id, onChange: paintCost });
        if (template) host.replaceChildren(el('h3', `原样挂载模板：${template.name}`), parameters(template),
          el('p', '服务器按模板身份复制完整参数和私有运行覆盖，不从安全读面重建。挂载时不修改模板参数；需要不同参数，请先编辑模板或新建自定义规则。', 'hint'));
        else host.replaceChildren(form.node);
        save = button(template ? '原样挂载模板' : '确认挂载', async () => {
          if (!ownsPage() || pending.has(`save:${task.id}`) || form?.validate()) return;
          if (form?.replacesPrompt() && !await promptRisk()) return;
          if (!ownsPage()) return;
          const hook = template ? { template_id: template.id } : form.collect(), agent = template ? callsAgent(template) : form.agentCall();
          if (agent && !await confirmDialog({ title: '挂载会安排 Agent 调用的 Hook？', message: '此操作保存授权；条件满足时即可启动或唤醒 Agent。请确认动作、目标和运行设置。',
            confirmLabel: '授权并挂载', agent: true, confirmHelp: agentHelp('挂载此受控规则，允许在指定安全节点执行所配置的调用。') })) return;
          if (!ownsPage()) return;
          pending.add(`save:${task.id}`); form?.setBusy(true); save.disabled = true; picker.disabled = true;
          let attached = false;
          try { await action('worker.hook_attach', { id: task.id, hook, expected_revision: model.revision }); attached = true;
            if (ownsPage()) { section.dataset.hookEditing = 'false'; editor.replaceChildren(); show('Hook 已挂载；实际执行以条件和安全检查为准。'); await refresh(); }
          } catch (error) { if (ownsPage()) show(attached ? `Hook 已挂载，但刷新失败：${error.message}` : `${error.message}；规则编辑已保留。`, 'error'); }
          finally { pending.delete(`save:${task.id}`); if (ownsPage()) { form?.setBusy(false); save.disabled = attached; picker.disabled = attached; } }
        }, 'hook-button');
        paintCost(template ? callsAgent(template) : form.agentCall());
        host.append(save, button('取消编辑', () => { section.dataset.hookEditing = 'false'; editor.replaceChildren(); }, 'ghost'));
      };
      picker.onchange = paint; paint();
    } catch (error) { if (ownsPage()) show(error.message, 'error'); }
    finally { pending.delete(`attach:${task.id}`); attach.disabled = !writable; }
  }, 'ghost hook-button', { help: '打开受控规则编辑器或选择项目模板；打开不调用 Agent，确认挂载前会说明动作代价。' });
  controls.append(guarded(attach, !writable ? '挂载列表不可用、Worker 已结束或分支已归档；请先处理后刷新。' : null),
    button('项目 Hooks 与模板', () => openHooks(), 'ghost hook-button', { help: '查看当前项目的节点、动作和模板；不会自动挂载到 Worker。' }));
  section.append(controls, editor); return section;
}
async function promptRisk() {
  return confirmDialog({ title: '使用替换内置规则的 Prompt？', message: '这份自定义 Prompt 可能影响 Worker 权限、协作、工作区安全和交付协议；只影响新建 Worker 及其派生 Worker。',
    confirmLabel: '仍然使用', danger: true, confirmHelp: '将自定义 Prompt 写入预约运行设置，不修改项目默认。' });
}

/** Explicit project-local template management, separate from actual Worker attachments. */
export async function openHooks() {
  const view = activateDetailView({ view: 'hooks', title: 'Hooks', context: '工作', hint: '生命周期节点 · 受控动作 · 可复用模板', hash: '#hooks' });
  const ownsPage = () => ui.view === view;
  if (ui.hooksPage?.view === view) return ui.hooksPage.pending;
  const state = { view, pending: null, catalogue: null, editing: false, busy: false }; ui.hooksPage = state;
  const owns = () => ownsPage() && ui.hooksPage === state;
  const root = el('div', undefined, 'hooks-page'); $('detail').replaceChildren(root);
  const editor = el('div', undefined, 'hook-editor');
  function edit(initial = {}) {
    if (!owns() || state.busy) return;
    state.editing = true;
    const form = createHookForm(state.catalogue, { initial, ownsPage: owns });
    editor.replaceChildren(el('h2', initial.id ? `编辑模板：${initial.name}` : '新建模板'), form.node);
    const save = button('保存模板', async () => {
      if (!owns() || state.busy || form.validate()) return;
      if (form.replacesPrompt() && !await promptRisk()) return;
      if (!owns()) return;
      state.busy = true; form.setBusy(true); save.disabled = true;
      try {
        const result = await action('hooks.save', { template: { ...(initial.id ? { id: initial.id } : {}), ...form.collect() }, expected_revision: state.catalogue.revision });
        if (owns()) { state.catalogue = result; state.editing = false; editor.replaceChildren(); paint(); show('模板已保存；尚未挂载，不会启动 Agent。'); }
      } catch (error) { if (owns()) show(`${error.message}；编辑保留。版本冲突时请复制内容后刷新。`, 'error'); }
      finally { state.busy = false; if (owns()) { form.setBusy(false); save.disabled = false; } }
    }, 'hook-button', { help: '保存可复用项目模板；不挂载到 Worker、不调用 Agent。' });
    editor.append(save, button('取消编辑', () => { if (!state.busy) { state.editing = false; editor.replaceChildren(); } }, 'ghost'));
  }
  async function load() {
    try { const catalogue = await api('/api/hooks'); if (!owns()) return; state.catalogue = catalogue; ui.hookCatalogue = catalogue; paint(); }
    catch (error) { if (owns()) { root.replaceChildren(el('h1', 'Hooks'), el('p', `读取失败：${error.message}`, 'error'), button('重新读取', load, 'ghost')); } }
  }
  function paint() {
    if (!owns()) return;
    const catalogue = state.catalogue;
    root.replaceChildren(el('h1', 'Hooks'), el('p', '当前项目的 Worker 生命周期自动动作。模板只保存配置；实际挂载、启停和执行结果在 Worker 详情管理。自定义仅组合受控动作，不执行脚本，不自动重试未知副作用。', 'hint'));
    const controls = el('div', undefined, 'actions'); controls.append(button('新建模板', () => edit(), 'hook-button', { help: '编辑可复用规则，不启动 Agent，也不自动安装到 Worker。' }),
      button('刷新目录', async () => { if (state.busy) return; if (state.editing && !await confirmDialog({ title: '放弃未保存编辑并刷新？', message: '刷新会读取后台最新模板，当前未保存编辑会丢失。', confirmLabel: '放弃并刷新' })) return;
        if (!owns()) return; state.editing = false; editor.replaceChildren(); await load(); }, 'ghost hook-button', { help: '显式读取最新节点和模板；未保存编辑会先确认，不进行后台自动刷新。' })); root.append(controls);
    const templates = block('项目模板', String(catalogue.templates?.length || 0));
    if (!catalogue.templates?.length) templates.append(el('p', '还没有模板。自动合并是 Worker 内置 Hook，不需要创建模板。', 'hint'));
    for (const template of catalogue.templates || []) {
      const card = el('article', undefined, 'hook-mount'); card.append(el('strong', template.name), el('p', `${catalogue.triggers?.find(t => t.id === template.trigger)?.label || template.trigger} · ${template.mode === 'persistent' ? '持续' : '一次性'}`, 'hint'), parameters(template));
      const buttons = el('div', undefined, 'actions'); buttons.append(button('编辑模板', () => edit(template), 'ghost hook-button'),
        button('删除模板', async () => {
          if (!owns() || state.busy || !await confirmDialog({ title: `删除模板「${template.name}」？`, message: '只删除可复用模板，不移除已挂载到 Worker 的实例。', confirmLabel: '删除模板', confirmHelp: '删除这个模板；实际挂载独立保留。' })) return;
          if (!owns()) return; state.busy = true;
          try { const result = await action('hooks.remove', { id: template.id, expected_revision: catalogue.revision });
            if (owns()) { state.catalogue = result; paint(); show('模板已删除，已挂载实例不变。'); }
          } catch (error) { if (owns()) show(error.message, 'error'); } finally { state.busy = false; }
        }, 'ghost hook-button', { help: '经确认删除模板，不撤销已挂载的规则或执行成果。' })); card.append(buttons); templates.append(card);
    }
    root.append(templates, editor);
    const nodes = block('允许的触发节点');
    for (const trigger of catalogue.triggers || []) { const row = el('article', undefined, 'hook-catalogue-row'); row.append(el('strong', trigger.label), el('code', trigger.id), el('p', trigger.description, 'hint')); nodes.append(row); }
    const actions = block('受控动作与代价');
    for (const item of catalogue.actions || []) { const row = el('article', undefined, 'hook-catalogue-row'); row.append(el('strong', item.label), badge(item.agent_call ? '可能安排 Agent' : '不调用 Agent'), ...(item.builtin_only ? [badge('仅内置自动链 · 不可自定义安装')] : []), el('p', item.agent_call ? agentHelp(item.description) : item.description, 'hint'), el('p', `允许节点：${item.triggers?.length ? item.triggers.join(' / ') : '目录中的允许节点'}`, 'hint')); actions.append(row); }
    root.append(nodes, actions);
  }
  state.pending = load(); return state.pending;
}
