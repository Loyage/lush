import { $, el, button, badge, block } from './dom.js';
import { api, action, projectApi } from './api.js';
import { ui } from './state.js';
import { activateDetailView } from './sidebar-ui.js';
import { detail } from './navigate.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { agentHelp } from './help.js';
import { workerKind } from './worker-kind.js';
import { isHistoricalDelivery, absolute } from './format.js';
import { createHookForm, COMMAND_WARNING } from './hook-form.js';
import { autoMergeControl, autoCompletionControl, completionLevelButtons, COMPLETION_LEVELS, HOOK_STATES as STATES } from './hook-controls.js';
import { workerLabel } from './worker-label.js';
import { hookScheduleSummary, scheduledWallTime } from './hook-schedule.js';
import { renderSignalManagement } from './hook-signals.js';

const pending = new Set();
function hookHelpLink() {
  const link = el('a', '使用帮助', 'hook-help-link'); link.href = '#doc-docs-hooks'; return link;
}
function projectHookCard(name, scope, className) {
  const card = el('article', undefined, `hook-mount project-hook ${className}`);
  const head = el('div', undefined, 'hook-mount-head');
  head.append(el('h2', name), badge(scope, 'hook-scope'), hookHelpLink()); card.append(head); return card;
}
function sameProject(project) { try { return projectApi('/api/hooks') === project; } catch { return false; } }
const callsAgent = mount => (mount.actions || []).some(a => ['message', 'request_merge', 'retry_worker', 'resume_worker'].includes(a.type) || (a.type === 'create_worker' && a.start !== false));
const failedSelfTemplate = (template, workerId) => template.trigger === 'time.scheduled'
  && template.actions?.some(a => a.type === 'retry_worker' && a.target_id === workerId)
  && template.actions.every(a => a.type === 'notify' || (a.type === 'retry_worker' && a.target_id === workerId));
const hasCommand = hook => hook.actions?.some(item => item.type === 'command');
async function authorizeHook(hook, agent = callsAgent(hook)) {
  if (hook.enabled === false) return true;
  if (hasCommand(hook) && !await confirmDialog({ title: '授权执行 Shell 命令？', message: COMMAND_WARNING,
    detail: hook.actions.filter(item => item.type === 'command').map(item => item.command).join('\n\n'),
    confirmLabel: '授权命令执行', danger: true, confirmHelp: '启用真实命令挂载；以后匹配节点和条件时可能产生不可逆副作用。' })) return false;
  if (agent && !await confirmDialog({ title: '授权会安排 Agent 调用的 Hook？',
    message: '保存授权后，条件满足时可能启动或唤醒 Agent。定时只保证到点提交动作，安全点尽早执行，不保证 Agent 准点开始。请确认节点、时间、条件、目标和运行设置。',
    confirmLabel: '授权并挂载', agent: true, confirmHelp: agentHelp('允许在指定安全节点执行所配置的调用。') })) return false;
  return true;
}
function scheduledLabel(instant, timezone) {
  try { return `${scheduledWallTime(instant, timezone).replace('T', ' ')} · ${timezone}`; } catch { return absolute(instant); }
}
function guarded(node, reason) {
  if (!reason) return node;
  node.disabled = true; const host = el('span', undefined, 'help-host'); host.tabIndex = 0;
  host.setAttribute('data-help', `${reason} ${node.getAttribute('data-help') || ''}`); host.append(node); return host;
}
function summary(actionItem) {
  return actionItem.type === 'command' ? `执行 Shell 命令：\n${actionItem.command || ''}` : actionItem.type === 'create_worker' ? `预约创建 Worker${actionItem.start !== false ? '并开始 Agent' : '（待开始）'}：${actionItem.content || ''}`
    : actionItem.type === 'notify' ? `发送告知：${actionItem.title || ''}`
      : actionItem.type === 'message' ? `追加消息到 ${workerLabel(actionItem.target_id, actionItem.target_worker_number)}：${actionItem.body || ''}`
        : actionItem.type === 'retry_worker' ? `到点时若失败则重试 ${workerLabel(actionItem.target_id, actionItem.target_worker_number)}；保留工作区，不检测额度恢复`
          : actionItem.type === 'resume_worker' ? `到点时若已暂停则继续 ${workerLabel(actionItem.target_id, actionItem.target_worker_number)}；不恢复取消或已验收的 Worker`
            : actionItem.type === 'request_merge' ? '冻结源提交并向直接父 Worker 请求合并'
        : actionItem.type === 'accept_worker' ? '安全条件通过后自动验收；不调用质量评审 Agent，不保证业务质量'
          : actionItem.type === 'archive_worker' ? '验收后归档分支及后代，清理 worktree/ref；保留 Worker、会话和历史，不丢弃未提交改动' : actionItem.type;
}
function parameters(mount) {
  const content = el('details', undefined, 'hook-parameters'); content.append(el('summary', '参数与最近执行'));
  if (mount.schedule) {
    content.append(el('p', `定时：${hookScheduleSummary(mount.schedule)}`, 'hook-schedule-preview'));
    if (mount.pending_due_at) content.append(el('p', `已到点提交，等待安全执行：${scheduledLabel(mount.pending_due_at, mount.schedule.timezone)}`, 'hint'));
    if (mount.next_run_at) content.append(el('p', `下次提交：${scheduledLabel(mount.next_run_at, mount.schedule.timezone)}`, 'hint'));
    content.append(el('p', '到点提交非阻塞动作，安全点尽早执行；不保证 Agent 准点开始。后台停机错过时间跳过，不自动启动项目或检测额度恢复。', 'hint'));
  }
  for (const item of mount.actions || []) {
    const preview = el('p', summary(item), 'hook-action-preview');
    // Commands are literal source, not prose Worker references, even when the
    // surrounding Worker detail receives automatic number links.
    if (item.type === 'command') preview.setAttribute('data-worker-links', 'off');
    content.append(preview);
    if (item.type === 'command') content.append(el('p', COMMAND_WARNING, 'hint hook-command-warning'));
    if (item.type === 'message') content.append(el('p', '追加输入使用目标 Worker 现有运行设置，不隐式切换账号。', 'hint'));
    if (['retry_worker', 'resume_worker'].includes(item.type) && !item.model_selection) content.append(el('p', '未显式覆盖，沿用目标 Worker 已有运行设置。', 'hint'));
    if (item.model_selection) content.append(el('p', `动作运行设置：${item.model_selection.config_mode === 'pi' ? '执行机器的 Pi 默认配置' : [item.model_selection.agent, item.model_selection.model, item.model_selection.thinking].filter(Boolean).join(' · ') || '已固定默认配置'}`, 'hint'));
  }
  const selection = mount.model_selection;
  if (selection) content.append(el('p', `预约运行设置：${selection.config_mode === 'pi' ? '执行机器的 Pi 默认配置' : [selection.agent, selection.model, selection.thinking].filter(Boolean).join(' · ') || '已固定默认配置'}`, 'hint'));
  const conditions = mount.conditions || {};
  content.append(el('p', `条件：${conditions.statuses?.length ? `状态 ${conditions.statuses.join(' / ')}` : '状态不限'} · ${conditions.integrations?.length ? `集成 ${conditions.integrations.join(' / ')}` : '集成不限'}`, 'hint'));
  const last = mount.last_execution;
  if (last) {
    content.append(el('p', `最近执行：${STATES[last.status] || last.status} · ${absolute(last.finished_at || last.created_at)}`, 'hint'));
    if (last.due_at && mount.schedule) content.append(el('p', `原定提交：${scheduledLabel(last.due_at, mount.schedule.timezone)}`, 'hint'));
    if (last.command_result) {
      const result = last.command_result;
      content.append(el('p', `命令结果：${STATES[result.status] || result.status}${result.exit_code !== null && result.exit_code !== undefined ? ` · 退出码 ${result.exit_code}` : ''}${result.reason === 'timeout' ? ' · 超时（最长 60 秒）' : result.reason === 'output_limit' ? ' · 输出超限（64 KiB）' : result.reason === 'spawn' ? ' · 无法启动命令' : ''}；原始输出不公开。`, 'hint'));
    }
    if (last.error) content.append(el('p', last.error, last.status === 'skipped' ? 'hint' : 'error'));
    if (last.worker_id) content.append(button(`查看创建的 Worker ${workerLabel(last.worker_id, last.worker_number)}`, () => detail(last.worker_id), 'ghost hook-button'));
  } else content.append(el('p', '还没有执行记录。', 'hint'));
  return content;
}
const BUILTIN_STEPS = { 'auto-merge': { number: 1 }, 'auto-accept': { number: 2 }, 'auto-archive': { number: 3 } };
function mountCard(task, mount, model, refresh, ownsPage, { setEditing = () => {}, catalogue = null, busy = () => false, scope = null } = {}) {
  const row = el('article', undefined, 'hook-mount'); row.dataset.hookId = mount.id;
  const head = el('div', undefined, 'hook-mount-head');
  const step = BUILTIN_STEPS[mount.id];
  if (step) head.append(badge(`第 ${step.number} 步`));
  head.append(el('strong', mount.name), badge(mount.mode === 'persistent' ? '持续' : '一次性'), badge(mount.enabled ? '启用' : '停用'), badge(STATES[mount.state] || mount.state || '已挂载'));
  if (mount.locked) head.append(badge('锁定'));
  if (scope) { row.classList.add('project-hook'); head.append(badge(scope, 'hook-scope'), hookHelpLink()); }
  row.append(head);
  row.append(el('p', `当前触发节点：${(catalogue || ui.hookCatalogue)?.triggers?.find(item => item.id === mount.trigger)?.label || mount.trigger} · ${mount.trigger}`, 'hint'));
  if (!mount.builtin && !step) {
    const actions = el('div', undefined, 'actions hook-actions');
    const key = `${projectApi('/api/hooks')}:${task.id}:${mount.id}`, saving = pending.has(key);
    const update = async remove => {
      if (!ownsPage() || busy() || pending.has(key) || (remove ? (mount.removable ?? mount.editable) !== true || mount.locked : mount.editable !== true)) return;
      pending.add(key); setEditing(true); for (const node of actions.querySelectorAll('button')) node.disabled = true;
      try {
        if (!remove && !mount.enabled && hasCommand(mount) && !await authorizeHook({ ...mount, enabled: true }, false)) return;
        if (remove && !await confirmDialog({ title: `移除 Hook「${mount.name}」？`,
          message: '仅移除未来触发。不会取消已开始的动作、删除已创建的 Worker，或撤回已发出的合并请求和消息。', confirmLabel: '移除挂载',
          confirmHelp: '移除当前 Worker 的这个 Hook；执行历史与已产生的成果保留。' })) return;
        if (!ownsPage()) return;
        const result = await action(remove ? 'worker.hook_remove' : 'worker.hook_update', { id: task.id, hook_id: mount.id, expected_revision: model.revision,
          ...(remove ? {} : { enabled: !mount.enabled }) });
        if (ownsPage()) { show(remove ? '已移除挂载，已有成果不变。' : '已保存 Hook 启用状态。'); pending.delete(key); setEditing(false); await refresh(result); }
      } catch (error) { if (ownsPage()) show(`${error.message}；请刷新读取最新挂载状态。`, 'error'); }
      finally { pending.delete(key); if (ownsPage()) {
        setEditing(false); restoreControls();
      } }
    };
    const agent = !mount.enabled && callsAgent(mount);
    const help = '只修改未来触发；停用不撤回已开始的动作。启用后条件满足即可执行。';
    actions.append(guarded(button(mount.enabled ? '停用 Hook' : '启用 Hook', () => update(false), 'ghost hook-button', { agent, help: agent ? agentHelp(help) : help }),
      saving || busy() ? '此挂载正在保存。' : mount.editable !== true ? mount.reason || '当前挂载不可编辑。' : null));
    actions.append(guarded(button('移除挂载', () => update(true), 'ghost hook-button', { help: '移除未来触发，不删除已产生的 Worker、提交或消息。' }),
      saving || busy() ? '此挂载正在保存。' : (mount.removable ?? mount.editable) !== true || mount.locked ? mount.reason || '此挂载不可移除。' : null));
    const editor = el('div', undefined, 'hook-editor');
    let editing = false;
    function restoreControls() {
      const [toggle, remove, edit, copy] = actions.querySelectorAll('button');
      if (toggle) toggle.disabled = pending.has(key) || editing || busy() || mount.editable !== true;
      if (remove) remove.disabled = pending.has(key) || editing || busy() || (mount.removable ?? mount.editable) !== true || mount.locked;
      if (edit) edit.disabled = pending.has(key) || editing || busy() || mount.editable !== true || mount.locked;
      if (copy) copy.disabled = pending.has(key) || editing || busy() || model.can_attach === false || ['completed', 'cancelled'].includes(task.status) || task.archived;
    }
    async function editMount(copy = false) {
      if (!ownsPage() || busy() || editing || pending.has(key)
        || (!copy && (mount.editable !== true || mount.locked))
        || (copy && (model.can_attach === false || ['completed', 'cancelled'].includes(task.status) || task.archived))) return;
      editing = true; setEditing(true); restoreControls();
      try {
        const directory = catalogue || await api('/api/hooks'); if (!ownsPage()) return;
        const initial = copy ? { ...mount, name: `${mount.name}（副本）`, enabled: false } : mount;
        let save;
        const paintCost = agent => {
          if (!save) return;
          const cost = !copy && agent;
          save.classList.toggle('agent-call', cost);
          save.setAttribute('data-help', cost ? agentHelp('保存挂载授权；启用时条件满足即可安排调用。')
            : copy ? '复制为新停用挂载，不执行、不复制执行记录或私有运行覆盖。' : '保存完整挂载配置；启用命令前须确认执行授权。');
        };
        const form = createHookForm(directory, { initial, ownsPage, workerId: task.id, failedSelf: task.status === 'failed', copying: copy, onChange: paintCost });
        editor.replaceChildren(el('h3', copy ? '复制为新停用挂载' : `编辑挂载：${mount.name}`), form.node);
        if (copy) editor.append(el('p', '副本是此 Worker 的新停用挂载，不执行，不复制执行记录；私有运行覆盖必须显式重新设置。', 'hint'));
        save = button(copy ? '保存停用副本' : '保存挂载', async () => {
          if (!ownsPage() || pending.has(key) || form.validate()) return;
          const hook = { ...form.collect(), ...(copy ? { enabled: false } : {}) };
          pending.add(key); form.setBusy(true); save.disabled = true; cancel.disabled = true;
          let saved = false;
          try {
            if (form.replacesPrompt() && !await promptRisk()) return;
            if (!ownsPage() || !await authorizeHook(hook, form.agentCall()) || !ownsPage()) return;
            const result = await action(copy ? 'worker.hook_attach' : 'worker.hook_update', { id: task.id,
              ...(!copy ? { hook_id: mount.id } : {}), hook, expected_revision: model.revision });
            saved = true;
            if (ownsPage()) { editing = false; setEditing(false); editor.replaceChildren(); show(copy ? '已复制为新停用挂载，不执行。' : '挂载配置已保存。'); pending.delete(key); await refresh(result); }
          } catch (error) { if (ownsPage()) show(saved ? `已保存，但刷新失败：${error.message}` : `${error.message}；编辑保留，版本冲突时请复制正文后刷新。`, 'error'); }
          finally { pending.delete(key); if (ownsPage()) { form.setBusy(false); save.disabled = saved; cancel.disabled = false; restoreControls(); } }
        }, 'hook-button');
        const cancel = button('取消编辑', () => { if (pending.has(key)) return; editing = false; setEditing(false); editor.replaceChildren(); restoreControls(); }, 'ghost');
        paintCost(!copy && initial.enabled !== false && form.agentCall()); editor.append(save, cancel);
      } catch (error) { if (ownsPage()) { editing = false; setEditing(false); restoreControls(); show(error.message, 'error'); } }
    }
    actions.append(guarded(button('编辑挂载', () => editMount(), 'ghost hook-button', { help: '编辑此实例的命令、节点、条件和模式；不会修改来源模板。' }),
      saving || busy() || mount.editable !== true || mount.locked ? mount.reason || '此挂载不可编辑。' : null),
    guarded(button('复制为停用挂载', () => editMount(true), 'ghost hook-button', { help: '复制配置为此 Worker 的新停用挂载，不执行，也不复制执行记录。' }),
      model.can_attach === false || ['completed', 'cancelled'].includes(task.status) || task.archived ? '此 Worker 当前不允许新增挂载。' : null));
    for (const control of actions.querySelectorAll('button')) {
      const click = control.onclick; control.onclick = async () => { await click(); if (ownsPage()) restoreControls(); };
    }
    row.append(actions, editor);
  }
  if (mount.reason) row.append(el('p', mount.reason, 'hint'));
  row.append(parameters(mount)); return row;
}

/** Synchronous inspect projection; graph uses the same compact, non-mutating entry. */
export function workerHooks(task, { refresh = () => detail(task.id), compact = false } = {}) {
  if (!['order', 'child', 'main', 'owner'].includes(workerKind(task)) || isHistoricalDelivery(task)) return null;
  const identity = ui.view, project = projectApi('/api/hooks'), ownsPage = () => ui.view === identity && sameProject(project);
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
  const section = el('section', undefined, 'block worker-hooks');
  section.setAttribute('aria-label', 'Worker Hooks');
  const row = el('div', undefined, 'worker-hooks-row');
  row.append(el('strong', 'Hooks', 'worker-hooks-label'));
  if (completion) row.append(autoCompletionControl(task, { ...model, completion }, refresh, ownsPage,
    editing => { section.dataset.completionEditing = String(editing); }));
  else if (['order', 'child'].includes(workerKind(task))) row.append(autoMergeControl(task, refresh, ownsPage));
  const alerts = items.filter(item => !BUILTIN_STEPS[item.id] && (['running', 'failed', 'unknown', 'skipped'].includes(item.state) || item.pending_due_at));
  for (const mount of alerts) {
    const alert = el('span', `${mount.name}：${STATES[mount.state]}`, 'hint hook-mount-alert');
    alert.setAttribute('data-help', mount.last_execution?.error || mount.reason || STATES[mount.state]); alert.tabIndex = 0;
    if (['failed', 'unknown'].includes(mount.state)) alert.classList.add('error');
    row.append(alert);
  }
  const management = el('details', undefined, 'hook-management');
  const customCount = items.filter(item => !item.builtin && !BUILTIN_STEPS[item.id]).length;
  management.append(el('summary', `管理${customCount ? ` · ${customCount}` : ''}`));
  if (!model) management.append(el('p', '完整挂载列表暂不可用；请更新服务或刷新。', 'hint'));
  if (!items.length) management.append(el('p', '此 Worker 尚未挂载 Hook。', 'hint'));
  const groups = new Map(); for (const mount of items) { const group = groups.get(mount.trigger) || []; group.push(mount); groups.set(mount.trigger, group); }
  const phaseOrder = ['worker.delivery_ready', 'delivery.integrated', 'worker.accepted'];
  const labels = { 'worker.delivery_ready': 'Agent 完成工作后 · 交付就绪', 'delivery.integrated': '合并完成后 · 已集成', 'worker.accepted': '验收完成后', 'worker.merge_received': '此 Worker 成功收到一次合并后' };
  for (const [trigger, group] of [...groups].sort(([a], [b]) => (phaseOrder.includes(a) ? phaseOrder.indexOf(a) : 3) - (phaseOrder.includes(b) ? phaseOrder.indexOf(b) : 3))) {
    const part = el('section', undefined, 'hook-trigger-group');
    part.append(el('h3', ui.hookCatalogue?.triggers?.find(item => item.id === trigger)?.label || labels[trigger] || trigger));
    for (const mount of group) part.append(mountCard(task, mount, model, refresh, ownsPage,
      { setEditing(value) { section.dataset.hookEditing = String(value); }, busy: () => section.dataset.hookEditing === 'true' }));
    management.append(part);
  }
  const editor = el('div', undefined, 'hook-editor');
  const controls = el('div', undefined, 'actions hook-actions');
  const failedSelf = task.status === 'failed';
  const writable = model && !['completed', 'cancelled'].includes(task.status) && !task.archived && !task.branch_archive?.archived
    && (model.can_attach !== undefined ? model.can_attach === true : !failedSelf);
  const attach = button('挂载 Hook', async () => {
    if (!ownsPage() || !writable || section.dataset.hookEditing === 'true' || pending.has(`attach:${task.id}`)) return;
    management.open = true;
    pending.add(`attach:${task.id}`); attach.disabled = true;
    try {
      const catalogue = await api('/api/hooks'); if (!ownsPage()) return;
      const picker = el('select'); picker.setAttribute('aria-label', '挂载模板');
      const blank = el('option', '新建自定义规则'); blank.value = ''; picker.append(blank);
      const templates = (catalogue.templates || []).filter(template => !failedSelf || failedSelfTemplate(template, task.id));
      for (const template of templates) { const option = el('option', template.name); option.value = template.id; picker.append(option); }
      const host = el('div'); editor.replaceChildren(picker, host); section.dataset.hookEditing = 'true';
      const paint = () => {
        if (pending.has(`save:${task.id}`)) return;
        const template = templates.find(t => t.id === picker.value);
        let save = null;
        const paintCost = agent => {
          if (!save) return;
          save.classList.toggle('agent-call', agent);
          const help = '保存此 Worker 的 Hook 挂载授权；启用时条件满足即可执行。命令需明确授权，停用配置不执行。';
          save.setAttribute('data-help', agent ? agentHelp(help) : help);
        };
        const form = template ? null : createHookForm(catalogue, { ownsPage, workerId: task.id, failedSelf, onChange: paintCost });
        if (template) host.replaceChildren(el('h3', `原样挂载模板：${template.name}`), parameters(template),
          el('p', '服务器按模板身份复制完整参数和私有运行覆盖，不从安全读面重建。挂载时不修改模板参数；需要不同参数，请先编辑模板或新建自定义规则。', 'hint'));
        else host.replaceChildren(form.node);
        save = button(template ? '原样挂载模板' : '确认挂载', async () => {
          if (!ownsPage() || pending.has(`save:${task.id}`) || form?.validate()) return;
          const hook = template ? { template_id: template.id } : form.collect(), agent = template ? callsAgent(template) : form.agentCall();
          pending.add(`save:${task.id}`); form?.setBusy(true); save.disabled = true; picker.disabled = true; cancel.disabled = true;
          let attached = false;
          try {
            if (form?.replacesPrompt() && !await promptRisk()) return;
            if (!ownsPage() || !await authorizeHook(template || hook, agent) || !ownsPage()) return;
            await action('worker.hook_attach', { id: task.id, hook, expected_revision: model.revision }); attached = true;
            if (ownsPage()) { section.dataset.hookEditing = 'false'; editor.replaceChildren(); show('Hook 已挂载；实际执行以条件和安全检查为准。'); await refresh(); }
          } catch (error) { if (ownsPage()) show(attached ? `Hook 已挂载，但刷新失败：${error.message}` : `${error.message}；规则编辑已保留。`, 'error'); }
          finally { pending.delete(`save:${task.id}`); if (ownsPage()) { form?.setBusy(false); save.disabled = attached; picker.disabled = attached; cancel.disabled = attached; } }
        }, 'hook-button');
        paintCost(template ? template.enabled !== false && callsAgent(template) : form.enabled() && form.agentCall());
        const cancel = button('取消编辑', () => { if (pending.has(`save:${task.id}`)) return; section.dataset.hookEditing = 'false'; editor.replaceChildren(); }, 'ghost');
        host.append(save, cancel);
      };
      picker.onchange = paint; paint();
    } catch (error) { if (ownsPage()) show(error.message, 'error'); }
    finally { pending.delete(`attach:${task.id}`); attach.disabled = !writable; }
  }, 'ghost hook-button', { help: '打开受控规则编辑器或选择项目模板；打开不调用 Agent，确认挂载前会说明动作代价。' });
  controls.append(guarded(attach, !writable ? '挂载列表不可用、Worker 已结束或分支已归档；请先处理后刷新。' : null),
    button('项目自动化与模板', () => openHooks(), 'ghost hook-button', { help: '查看当前项目的节点、动作和模板；不会自动挂载到 Worker。' }));
  management.append(controls, editor); row.append(management); section.append(row); return section;
}
async function promptRisk() {
  return confirmDialog({ title: '使用替换内置规则的 Prompt？', message: '这份自定义 Prompt 可能影响 Worker 权限、协作、工作区安全和交付协议；作用于所配置动作的新建或重试／继续目标 Worker。',
    confirmLabel: '仍然使用', danger: true, confirmHelp: '将自定义 Prompt 写入预约运行设置，不修改项目默认。' });
}

/** Explicit project-local template management, separate from actual Worker attachments. */
export async function openHooks() {
  const view = activateDetailView({ view: 'hooks', title: '自动化', context: '工作', hint: '时间信号与管理 Agent · 生命周期 · 受控动作 · 模板', hash: '#hooks' });
  const project = projectApi('/api/hooks');
  const ownsPage = () => ui.view === view && sameProject(project);
  if (ui.hooksPage?.view === view && ui.hooksPage.project === project) return ui.hooksPage.pending;
  const state = { view, project, pending: null, catalogue: null, editing: false, busy: false, completionDraft: null, completionError: null, completionBlocked: false, templateQuery: '' }; ui.hooksPage = state;
  const owns = () => ownsPage() && ui.hooksPage === state;
  const root = el('div', undefined, 'hooks-page'); $('detail').replaceChildren(root);
  const editor = el('div', undefined, 'hook-editor');
  function edit(initial = {}, copying = false) {
    if (!owns() || state.busy) return;
    state.editing = true;
    const revision = state.catalogue.revision;
    const form = createHookForm(state.catalogue, { initial: copying ? { ...initial, name: `${initial.name}（副本）`, enabled: false } : initial, ownsPage: owns, copying });
    editor.replaceChildren(el('h2', copying ? '复制为新停用模板' : initial.id ? `编辑模板：${initial.name}` : '新建模板'), form.node);
    if (copying) editor.append(el('p', '复制为新停用模板，不执行、不挂载、不复制执行记录；私有运行覆盖必须显式重新设置。', 'hint'));
    const save = button(copying ? '保存停用模板副本' : '保存模板', async () => {
      if (!owns() || state.busy || form.validate()) return;
      if (form.replacesPrompt() && !await promptRisk()) return;
      if (!owns()) return;
      state.busy = true; form.setBusy(true); save.disabled = true;
      try {
        const result = await action('hooks.save', { template: { ...(!copying && initial.id ? { id: initial.id } : {}), ...form.collect(), ...(copying ? { enabled: false } : {}) }, expected_revision: revision });
        if (owns()) { state.catalogue = result; state.editing = false; editor.replaceChildren(); paint(); show('模板已保存；已有实例不变。保存不执行、不挂载，也不调用 Agent。'); }
      } catch (error) { if (owns()) show(`${error.message}；编辑保留。版本冲突时请复制内容后刷新。`, 'error'); }
      finally { state.busy = false; if (owns()) { form.setBusy(false); save.disabled = false; paint(); } }
    }, 'hook-button', { help: '保存可复用项目模板；不挂载到 Worker、不调用 Agent。' });
    editor.append(save, button('取消编辑', () => { if (!state.busy) { state.editing = false; editor.replaceChildren(); } }, 'ghost'));
  }
  async function load({ preserveDefaults = false } = {}) {
    try { const catalogue = await api('/api/hooks'); if (!owns()) return; state.catalogue = catalogue; ui.hookCatalogue = catalogue;
      if (!preserveDefaults) { state.completionDraft = null; state.completionError = null; state.completionBlocked = false; }
      paint(); }
    catch (error) { if (owns()) { root.replaceChildren(el('h1', '自动化'), el('p', `读取失败：${error.message}`, 'error'), button('重新读取', load, 'ghost')); } }
  }
  function commandExample(catalogue) {
    const section = el('div', undefined, 'command-hook-example');
    const example = catalogue.command_example;
    const model = example?.hooks;
    const mount = Array.isArray(model?.mounts) ? model.mounts.find(item => item.id === example.hook_id) : null;
    const valid = Number.isSafeInteger(example?.worker_id) && model?.worker_id === example.worker_id && typeof model?.revision === 'string' && model.revision.trim();
    if (!valid || !mount) {
      const card = projectHookCard('main 收到合并后 git push', '仅 main Worker', '');
      card.append(el('p', example ? '挂载已删除或不可用；不会自动重装。可从项目模板自行新建规则。' : '挂载状态暂不可用；请更新服务后刷新，不会凭空创建或启用挂载。', 'hint')); section.append(card);
    } else {
      section.append(mountCard({ id: example.worker_id, task_kind: 'main', status: 'waiting' }, mount, model,
        // Runtime observations can advance the mount revision after the mutation response.
        // Read the authoritative catalogue before offering the next edit/toggle.
        async () => { if (owns()) await load({ preserveDefaults: true }); }, owns, { catalogue, scope: '仅 main Worker', busy: () => state.busy || state.commandEditing, setEditing(value) { state.commandEditing = value; state.editing = value; } }));
      section.querySelector('.project-hook').append(button('查看 main Worker Hooks', () => detail(example.worker_id), 'ghost hook-button', { help: '只打开此规则所挂载的 main Worker；两个入口管理同一挂载。' }));
    }
    const template = catalogue.templates?.find(item => item.id === example?.template_id);
    if (template) section.querySelector('.project-hook').append(button('编辑来源模板', () => edit(template), 'ghost hook-button', { help: '只编辑模板，已经挂载在 main 上的实例不会改变。' }),
      button('复制为停用模板', () => edit(template, true), 'ghost hook-button', { help: '保存为新的停用模板，不执行、不挂载，也不复制执行记录。' }));
    return section;
  }
  const validDefaults = model => model?.version === 1 && typeof model.enabled === 'boolean'
    && ['merge', 'accept', 'archive'].includes(model.level) && typeof model.revision === 'string' && !!model.revision.trim();
  function completionDefaultsSection(catalogue) {
    const section = projectHookCard('结束后自动处理流程', '仅之后新建的指令 Worker', 'completion-defaults');
    section.append(el('p', '保存当前项目的新指令默认授权；已有 Worker 不变。', 'hint'));
    const model = catalogue.completion_defaults;
    if (!validDefaults(model)) {
      section.append(el('p', '项目默认状态暂不可用；请更新后台服务后刷新目录。未假定此功能已关闭。', 'error')); return section;
    }
    const draft = state.completionDraft ||= { enabled: model.enabled, level: model.level, revision: model.revision };
    const dirty = () => draft.enabled !== model.enabled || draft.level !== model.level;
    const enabled = el('input'); enabled.type = 'checkbox'; enabled.setAttribute('aria-label', '启用新指令 Worker 自动流程'); enabled.checked = draft.enabled;
    const toggle = el('label', undefined, 'hook-check'); toggle.append(enabled, el('span', '启用新指令 Worker 自动流程'));
    const { group, choices } = completionLevelButtons('默认最高自动环节', selected => {
      if (!owns() || state.busy) return;
      draft.level = selected; sync();
    }, { includeOff: false });
    for (const { control } of choices) {
      const clicked = control.onclick; control.onclick = async () => { await clicked(); sync(); };
    }
    const field = el('div', undefined, 'hook-completion-control'); field.append(el('span', '自动到', 'hook-completion-label'), group);
    const status = el('p', undefined, 'hint');
    const saveHost = el('span', undefined, 'help-host'); saveHost.tabIndex = 0;
    const save = button('保存项目默认', async () => {
      if (!owns() || state.busy || state.completionBlocked || !dirty()) return;
      const params = { enabled: draft.enabled, level: draft.level, expected_revision: draft.revision };
      state.busy = true; state.completionError = null; paint();
      try {
        if (params.enabled && params.level === 'archive' && !await confirmDialog({ title: '授权新指令 Worker 自动到归档？',
          message: '仅授权之后实际创建的新指令 Worker：合并并通过安全验收后，清理新 Worker 及后代的 worktree/ref；保留 Worker、会话和 Git 历史，不丢弃脏改动。自动验收不是质量评审。保存不会调用已有 Agent；未来合并分歧可能唤醒新 Worker 的 Agent。',
          confirmLabel: '授权并保存默认', danger: true, agent: true,
          confirmHelp: agentHelp('授权未来新指令 Worker 自动合并、验收和子树归档，清理 worktree/ref 但保留历史与脏改动。') })) return;
        if (!owns()) return;
        // No global refresh: a late save must not refresh another page/project.
        const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'hooks.completion_defaults', params }) });
        if (!owns()) return;
        if (!validDefaults(result?.completion_defaults)) {
          state.completionBlocked = true; throw new Error('保存响应缺少有效默认状态；请刷新目录确认，勿重复提交。');
        }
        state.catalogue = result; ui.hookCatalogue = result;
        const saved = result.completion_defaults;
        state.completionDraft = { enabled: saved.enabled, level: saved.level, revision: saved.revision };
        show('项目默认已保存；仅影响之后新建的指令 Worker，已有 Worker 不变。');
      } catch (error) { if (owns()) { state.completionError = `${error.message}；编辑值已保留。版本过期（stale/revision conflict）时请刷新目录读取最新状态。`; show(state.completionError, 'error'); } }
      finally { state.busy = false; if (owns()) paint(); }
    }, 'hook-button');
    const sync = () => {
      const agent = draft.enabled;
      const help = agent ? agentHelp('保存当前项目对未来新指令 Worker 的自动流程授权；保存不调用已有 Agent，未来合并分歧可能唤醒新 Worker 的 Agent。')
        : '保存关闭未来新指令 Worker 的自动流程；记住所选最高环节，不修改已有 Worker。';
      save.classList.toggle('agent-call', agent); save.setAttribute('data-help', help);
      save.disabled = state.busy || state.completionBlocked || !dirty(); enabled.disabled = state.busy;
      for (const { level, control, host } of choices) {
        control.disabled = state.busy;
        control.setAttribute('aria-pressed', String(level === draft.level));
        control.classList.toggle('is-selected', level === draft.level);
        control.classList.toggle('is-included', ['merge', 'accept', 'archive'].indexOf(level) < ['merge', 'accept', 'archive'].indexOf(draft.level));
        const consequence = level === 'merge' ? '交付就绪后自动合并。' : level === 'accept'
          ? '自动合并后验收；不评审或保证业务质量。'
          : '自动合并、验收并归档；清理 worktree/ref，保留历史，不丢弃脏改动。';
        const help = `${state.busy ? '正在确认或保存。' : ''}${consequence}仅选择默认最高环节；点击保存后才生效，关闭仍记住所选环节。`;
        control.setAttribute('data-help', help); host.setAttribute('data-help', help); host.tabIndex = control.disabled ? 0 : -1;
      }
      saveHost.setAttribute('data-help', save.disabled ? `${state.busy ? '正在确认或保存，请稍候。' : state.completionBlocked ? '保存结果未确认，请刷新目录，勿重复提交。' : '没有未保存更改。'} ${help}` : help);
      status.textContent = `已保存：${model.enabled ? '启用' : '关闭'} · 默认到${{ merge: '合并', accept: '验收', archive: '归档' }[model.level]}${dirty() ? '；有未保存更改，保存后才生效。' : '。'}`;
    };
    enabled.onchange = () => { if (!owns() || state.busy) return; draft.enabled = enabled.checked; sync(); };
    const clicked = save.onclick; save.onclick = async () => { await clicked(); sync(); };
    saveHost.append(save); sync();
    section.append(toggle, field, status, saveHost);
    if (state.completionError) section.append(el('p', state.completionError, 'error'));
    return section;
  }
  function daemonSection(catalogue) {
    const section = projectHookCard('自动选择', '当前项目后台', 'daemon-auto-select');
    const model = catalogue.daemon_hooks;
    const mount = Array.isArray(model?.mounts) ? model.mounts.find(item => item?.id === 'auto-select') : null;
    if (model?.version !== 1 || !mount || typeof mount.enabled !== 'boolean' || typeof model.revision !== 'string' || !model.revision.trim()) {
      section.append(el('p', '自动选择状态暂不可用；请更新后台服务后刷新。', 'hint')); return section;
    }
    const row = el('div', undefined, 'project-hook-body');
    const head = el('div', undefined, 'hook-mount-head');
    head.append(badge('持续'), badge(mount.enabled ? '已启用' : '已关闭'));
    if (mount.state && STATES[mount.state]) head.append(badge(STATES[mount.state]));
    row.append(head, el('p', '自动答复已有和新收到的问题，让等待中的 Worker 继续；可能产生 Agent 调用费用。', 'hint'));
    const key = `daemon-auto-select:${project}`;
    const help = mount.enabled ? '关闭当前项目后台的未来自动答复；不会撤回答复或停止已继续的 Worker。'
      : agentHelp('授权当前项目后台自动答复已有和新收到的问题，让等待中的 Worker 继续。');
    const update = async () => {
      if (!owns() || state.busy || pending.has(key) || mount.editable === false) return;
      pending.add(key); state.busy = true; paint();
      try {
        if (!mount.enabled && !await confirmDialog({ title: '开启项目自动选择？',
          message: '将立即答复当前项目已有的待答问题，以后收到的新问题也会自动答复。单选选第一项，多选和文字问答交由 Agent 自行判断。这可能唤醒多个 Worker 并产生调用费用；答复会标记为 Lush 自动选择，不代表用户亲自作出了决定。',
          confirmLabel: '授权并开启', agent: true, confirmHelp: agentHelp('保存持续授权，并允许已有待答 Worker 自动继续。') })) return;
        if (!owns()) return;
        const result = await action('hooks.auto_select', { enabled: !mount.enabled, expected_revision: model.revision });
        if (owns()) { state.catalogue = result; ui.hookCatalogue = result;
          show(mount.enabled ? '自动选择已关闭；已有答复不变。' : '自动选择已开启；答复来源记录为 Lush。'); }
      } catch (error) { if (owns()) show(`${error.message}；未假定开关已更改，请刷新目录读取最新状态。`, 'error'); }
      finally { pending.delete(key); state.busy = false; if (owns()) paint(); }
    };
    const control = button(pending.has(key) ? '正在保存…' : mount.enabled ? '关闭自动选择' : '开启自动选择', update, 'hook-button',
      { agent: !mount.enabled, help });
    row.append(guarded(control, state.busy || pending.has(key) ? '正在确认或保存设置，请稍候。'
      : mount.editable === false ? mount.reason || '当前设置不可编辑。' : null));
    if (mount.reason) row.append(el('p', mount.reason, 'hint'));
    const execution = mount.last_execution;
    if (execution) {
      row.append(el('p', `最近执行：${STATES[execution.status] || execution.status} · 问题 #${execution.notice_id || execution.id} · ${absolute(execution.finished_at || execution.created_at)}`, 'hint'));
      if (execution.error) row.append(el('p', execution.error, 'error'));
    }
    section.append(row); return section;
  }
  function paint() {
    if (!owns()) return;
    const catalogue = state.catalogue;
    const preservedExample = state.commandEditing ? root.querySelector('.command-hook-example') : null;
    const header = el('div', undefined, 'hooks-page-header'); header.append(el('h1', '自动化'), hookHelpLink());
    const hooks = block('项目 Hooks'); hooks.classList.add('project-hooks');
    hooks.append(completionDefaultsSection(catalogue), preservedExample || commandExample(catalogue), daemonSection(catalogue));
    root.replaceChildren(header, el('p', '按作用范围管理自动规则；模板可复用，已挂载实例独立保存。', 'hint'), hooks);
    root.append(...renderSignalManagement({ catalogue, editor, ownsPage: owns, busy: () => state.busy,
      setBusy(value) { state.busy = value; if (owns()) paint(); }, setEditing(value) { state.editing = value; },
      onCatalogue(result) { if (owns()) { state.catalogue = result; ui.hookCatalogue = result; paint(); } },
      onManagement(result) { if (owns()) {
        const task = result.task || result;
        const existing = state.catalogue.management_workers || [];
        state.catalogue = { ...state.catalogue, management_workers: existing.some(item => item.id === task.id)
          ? existing.map(item => item.id === task.id ? task : item) : [task, ...existing].slice(0, 100) };
        ui.hookCatalogue = state.catalogue; paint();
      } },
    }));
    const controls = el('div', undefined, 'actions'); controls.append(button('新建模板', () => edit(), 'hook-button', { help: '编辑可复用规则，不启动 Agent，也不自动安装到 Worker。' }),
      button('刷新目录', async () => { if (state.busy) return; if ((state.editing || state.commandEditing || (state.completionDraft && (state.completionDraft.enabled !== state.catalogue.completion_defaults?.enabled || state.completionDraft.level !== state.catalogue.completion_defaults?.level))) && !await confirmDialog({ title: '放弃未保存编辑并刷新？', message: '刷新会读取后台最新目录与项目默认，当前未保存编辑会丢失。', confirmLabel: '放弃并刷新' })) return;
        if (!owns()) return; state.editing = false; state.commandEditing = false; editor.replaceChildren(); await load(); }, 'ghost hook-button', { help: '显式读取最新节点和模板；未保存编辑会先确认，不进行后台自动刷新。' })); root.append(controls);
    const templates = block('项目模板', String(catalogue.templates?.length || 0));
    templates.querySelector('.section-title').append(hookHelpLink());
    const search = el('input', undefined, 'hook-template-search'); search.type = 'search';
    search.placeholder = '按名称、触发节点或动作查找模板'; search.setAttribute('aria-label', '查找 Hook 模板');
    const cards = [], empty = el('p', '没有匹配的模板。', 'hint'); empty.hidden = true;
    search.value = state.templateQuery;
    search.oninput = () => {
      state.templateQuery = search.value;
      const query = search.value.trim().toLowerCase(); let count = 0;
      for (const { card, text } of cards) { card.hidden = !text.includes(query); if (!card.hidden) count++; }
      empty.hidden = count !== 0 || !query;
    };
    if (catalogue.templates?.length) templates.append(search);
    if (!catalogue.templates?.length) templates.append(el('p', '还没有模板。自动合并是 Worker 内置 Hook，不需要创建模板。', 'hint'));
    for (const template of catalogue.templates || []) {
      const card = projectHookCard(template.name, '模板 · 尚未挂载', 'hook-template');
      card.append(el('p', `${catalogue.triggers?.find(t => t.id === template.trigger)?.label || template.trigger} · ${template.mode === 'persistent' ? '持续' : '一次性'}`, 'hint'), parameters(template));
      cards.push({ card, text: [template.name, template.trigger, catalogue.triggers?.find(t => t.id === template.trigger)?.label,
        ...(template.actions || []).flatMap(item => [item.type, catalogue.actions?.find(action => action.type === item.type)?.label])].filter(Boolean).join(' ').toLowerCase() });
      const buttons = el('div', undefined, 'actions'); buttons.append(button('编辑模板', () => edit(template), 'ghost hook-button', { help: '只修改可复用模板；已有挂载实例不会改变。' }),
        button('复制为停用模板', () => edit(template, true), 'ghost hook-button', { help: '保存为新的停用模板，不执行、不挂载，不复制执行记录。' }),
        button('删除模板', async () => {
          if (!owns() || state.busy || !await confirmDialog({ title: `删除模板「${template.name}」？`, message: '只删除可复用模板，不移除已挂载到 Worker 的实例。', confirmLabel: '删除模板', confirmHelp: '删除这个模板；实际挂载独立保留。' })) return;
          if (!owns()) return; state.busy = true;
          try { const result = await action('hooks.remove', { id: template.id, expected_revision: catalogue.revision });
            if (owns()) { state.catalogue = result; paint(); show('模板已删除，已挂载实例不变。'); }
          } catch (error) { if (owns()) show(error.message, 'error'); } finally { state.busy = false; if (owns()) paint(); }
        }, 'ghost hook-button', { help: '经确认删除模板，不撤销已挂载的规则或执行成果。' })); card.append(buttons); templates.append(card);
    }
    search.oninput(); templates.append(empty); root.append(templates, editor);

  }
  state.pending = load(); return state.pending;
}
