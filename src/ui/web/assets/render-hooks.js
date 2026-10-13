import { $, el, button, badge, block, syncChildren } from './dom.js';
import { searchField } from './search-field.js';
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
import { autoMergeControl, autoCompletionControl, COMPLETION_LEVELS, HOOK_STATES as STATES } from './hook-controls.js';
import { workerLabel } from './worker-label.js';
import { hookScheduleSummary, scheduledWallTime } from './hook-schedule.js';
import { renderShortcutCommands } from './shortcut-commands.js';
import { workerConvergenceControl } from './convergence-policy-controls.js';
import { pageSubnav } from './page-subnav.js';
import { commandReferencesIssue, commandSummary, legacyCommands, validCommands, PROMPT_WARNING } from './shortcut-command-model.js';

import { automationModule } from './automation-module.js';
import { isDeliveryHandler, hookResultLabel, renderOperation, operationAlert, deliveryHandlerCard, renderAutomationTools } from './automation-tools.js';

const pending = new Set();
export function hookHelpLink() {
  const link = el('a', '使用帮助', 'hook-help-link'); link.href = '/#doc-docs-hooks'; link.target = '_blank'; link.rel = 'noopener'; return link;
}
function projectHookCard(name, scope, className) {
  const card = el('article', undefined, `hook-mount project-hook ${className}`);
  const head = el('div', undefined, 'hook-mount-head');
  head.append(el('h2', name), badge(scope, 'hook-scope'), hookHelpLink()); card.append(head); return card;
}
function sameProject(project) { try { return projectApi('/api/hooks') === project; } catch { return false; } }
const callsAgent = mount => (mount.actions || []).some(a => ['message', 'request_merge', 'integrate_deliveries', 'retry_worker', 'resume_worker', 'prompt_command'].includes(a.type) || (a.type === 'create_worker' && a.start !== false));
const failedSelfTemplate = (template, workerId) => template.trigger === 'time.scheduled'
  && template.actions?.some(a => a.type === 'retry_worker' && a.target_id === workerId)
  && template.actions.every(a => a.type === 'notify' || (a.type === 'retry_worker' && a.target_id === workerId));
const hasCommand = hook => hook.actions?.some(item => ['command', 'prompt_command'].includes(item.type));
async function authorizeHook(hook, agent = callsAgent(hook), catalogue = null) {
  if (hasCommand(hook)) {
    const directory = catalogue || await api('/api/hooks');
    const issue = commandReferencesIssue(hook, directory);
    if (issue) { show(issue, 'error'); return false; }
    if (hook.enabled === false) return true;
    if (!await confirmDialog({ title: '启用快捷指令 Hook？', message: `${hook.actions.some(item => item.type === 'command') ? COMMAND_WARNING : PROMPT_WARNING} 未来执行跟随所引用指令的最新定义；本操作仅保存挂载启用状态，不立即执行指令。`,
      detail: hook.actions.filter(item => ['command', 'prompt_command'].includes(item.type)).map(item => commandSummary(item, directory)).join('\n\n'),
      confirmLabel: '启用指令 Hook', danger: true, agent, confirmHelp: agent ? agentHelp(hook.actions.some(item => item.type === 'prompt_command')
        ? '启用提示词引用，触发后在可创建安全点创建并启动独立 Worker；未来执行跟随最新定义。'
        : '启用指令 Hook 及所配置的 Agent 动作；触发后按条件和安全门执行，指令跟随最新定义。') : '启用指令 Hook；后续匹配节点时按最新定义执行，可能产生不可逆副作用，启用本身不执行。' })) return false;
  }
  if (hook.enabled === false) return true;
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
function summary(actionItem, catalogue) {
  return ['command', 'prompt_command'].includes(actionItem.type) ? commandSummary(actionItem, catalogue) : actionItem.type === 'create_worker' ? `预约创建 Worker${actionItem.start !== false ? '并开始 Agent' : '（待开始）'}：${actionItem.content || ''}`
    : actionItem.type === 'notify' ? `发送告知：${actionItem.title || ''}`
      : actionItem.type === 'message' ? `追加消息到 ${workerLabel(actionItem.target_id, actionItem.target_worker_number)}：${actionItem.body || ''}`
        : actionItem.type === 'retry_worker' ? `到点时若失败则重试 ${workerLabel(actionItem.target_id, actionItem.target_worker_number)}；保留工作区，不检测额度恢复`
          : actionItem.type === 'resume_worker' ? `到点时若已暂停则继续 ${workerLabel(actionItem.target_id, actionItem.target_worker_number)}；不恢复取消或已验收的 Worker`
            : actionItem.type === 'request_merge' ? '冻结源提交并向直接父 Worker 请求合并；请求提交完成不等于本轮交付完成'
            : actionItem.type === 'integrate_deliveries' ? `接收目标的已授权交付，使用${actionItem.strategy === 'converge' ? '归并' : actionItem.strategy === 'serial' ? '普通串行' : '尚未确认的'}处理策略；不提高来源授权`
        : actionItem.type === 'accept_worker' ? '安全条件通过后自动验收即归档，表示不再有异议，回收 worktree/ref 并保留运行历史；脏工作区会阻止验收，不调用质量评审 Agent，不保证业务质量'
          : actionItem.type === 'archive_worker' ? '历史资源回收阶段（现已包含在验收中）：清理 worktree/ref，保留 Worker、会话和历史，不丢弃未提交改动' : actionItem.type;
}
function parameters(mount, catalogue = ui.hookCatalogue) {
  const content = el('details', undefined, 'hook-parameters'); content.append(el('summary', '参数与最近执行'));
  if (mount.schedule) {
    content.append(el('p', `定时：${hookScheduleSummary(mount.schedule)}`, 'hook-schedule-preview'));
    if (mount.pending_due_at) content.append(el('p', `已到点提交，等待安全执行：${scheduledLabel(mount.pending_due_at, mount.schedule.timezone)}`, 'hint'));
    if (mount.next_run_at) content.append(el('p', `下次提交：${scheduledLabel(mount.next_run_at, mount.schedule.timezone)}`, 'hint'));
    content.append(el('p', '到点提交非阻塞动作，安全点尽早执行；不保证 Agent 准点开始。后台停机错过时间跳过，不自动启动项目或检测额度恢复。', 'hint'));
  }
  for (const item of mount.actions || []) {
    const preview = el('p', summary(item, catalogue), 'hook-action-preview');
    // Commands are literal source, not prose Worker references, even when the
    // surrounding Worker detail receives automatic number links.
    if (['command', 'prompt_command'].includes(item.type)) preview.setAttribute('data-worker-links', 'off');
    content.append(preview);
    if (['command', 'prompt_command'].includes(item.type)) content.append(el('p', item.type === 'prompt_command' ? PROMPT_WARNING : COMMAND_WARNING, 'hint hook-command-warning'));
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
    const promptExecution = last.kind === 'prompt' || mount.actions?.some(item => item.type === 'prompt_command');
    content.append(el('p', `最近 Hook 动作：${hookResultLabel(mount, last.status) || STATES[last.status] || last.status} · ${absolute(last.finished_at || last.created_at)}`, 'hint'));
    if (last.due_at && mount.schedule) content.append(el('p', `原定提交：${scheduledLabel(last.due_at, mount.schedule.timezone)}`, 'hint'));
    if (last.command_result && !promptExecution) {
      const result = last.command_result;
      content.append(el('p', `命令结果：${STATES[result.status] || result.status}${result.exit_code !== null && result.exit_code !== undefined ? ` · 退出码 ${result.exit_code}` : ''}${result.reason === 'timeout' ? ' · 超时（最长 60 秒）' : result.reason === 'output_limit' ? ' · 输出超限（64 KiB）' : result.reason === 'spawn' ? ' · 无法启动命令' : ''}；原始输出不公开。`, 'hint'));
    }
    if (last.error) content.append(el('p', last.error, last.status === 'skipped' ? 'hint' : 'error'));
    if (promptExecution) {
      content.append(el('p', last.status === 'succeeded' ? '提示词已创建／提交独立 Agent Worker，不代表 Agent 工作完成。' : '提示词创建状态与 Agent 工作状态独立；未知结果不自动重试。', 'hint'));
    }
    // Hook action receipts use worker_id for the created Worker. Typed command
    // history instead uses worker_id for the parent and created_worker_id for the result.
    const createdId = last.created_worker_id ?? (last.kind === 'prompt' ? null : last.worker_id);
    const createdNumber = last.created_worker_id ? last.created_worker_number : last.worker_number;
    if (!mount.actions?.some(item => ['request_merge', 'accept_worker', 'integrate_deliveries'].includes(item.type)) && Number.isSafeInteger(createdId) && createdId > 0) content.append(button(`查看创建的 Worker ${workerLabel(createdId, createdNumber)}`, () => detail(createdId), 'ghost hook-button', { worker: createdId }));
  } else content.append(el('p', '还没有执行记录。', 'hint'));
  const operation = renderOperation(mount); if (operation) content.append(operation);
  return content;
}
function importButton(source, revision, ownsPage, refresh, { busy = () => false, setEditing = () => {}, unavailable = null, catalogue = null } = {}) {
  let running = false;
  const help = '显式将旧 Shell 注册为快捷指令并替换此规则的引用；规则停用，不执行或重放旧触发。';
  const control = button('导入为快捷指令', async () => {
    if (!ownsPage() || running || busy() || unavailable) return;
    running = true; setEditing(true);
    try {
      const directory = catalogue || await api('/api/hooks');
      if (!ownsPage()) return;
      if (!validCommands(directory.commands)) { show('快捷指令目录不可用；请更新服务并刷新，不能导入或校验指令引用。', 'error'); return; }
      if (!await confirmDialog({ title: '导入旧命令为快捷指令？', message: `${help} 导入后请检查指令定义，再明确启用此 Hook。`,
        confirmLabel: '确认导入', confirmHelp: help }) || !ownsPage()) return;
      const result = await action('hooks.command_import', { source, expected_revision: revision }, { refresh: false });
      if (ownsPage()) { ui.hookCatalogue = result; setEditing(false); show('已导入快捷指令，Hook 保持停用；不会执行旧触发。'); await refresh(source.worker_id ? result.worker_hooks || result : result); }
    } catch (error) { if (ownsPage()) show(`${error.message}；旧命令仍不可直接执行，请刷新检查导入结果。`, 'error'); }
    finally { running = false; if (ownsPage()) { setEditing(false); control.disabled = !!unavailable || busy(); } }
  }, 'ghost hook-button', { help });
  const clicked = control.onclick; control.onclick = async () => { await clicked(); control.disabled = !!unavailable || busy(); };
  const unavailableDirectory = catalogue && !validCommands(catalogue.commands) ? '快捷指令目录不可用；请更新服务。' : null;
  if (unavailableDirectory) unavailable ||= unavailableDirectory;
  return guarded(control, unavailable || (busy() ? '正在编辑或保存，请稍后。' : null));
}
const BUILTIN_STEPS = { 'auto-merge': { number: 1 }, 'auto-accept': { number: 2 }, 'auto-archive': { number: 3 } };
export function mountCard(task, mount, model, refresh, ownsPage, { setEditing = () => {}, catalogue = null, busy = () => false, scope = null } = {}) {
  if (isDeliveryHandler(mount)) return deliveryHandlerCard({ mount, policy: model?.convergence });
  const row = el('article', undefined, 'hook-mount'); row.dataset.hookId = mount.id;
  const head = el('div', undefined, 'hook-mount-head');
  const step = BUILTIN_STEPS[mount.id];
  if (step) head.append(badge(`第 ${step.number} 步`));
  head.append(el('strong', mount.name), badge(mount.mode === 'persistent' ? '持续' : '一次性'), badge(mount.enabled ? '启用' : '停用'), badge(hookResultLabel(mount, mount.state) || STATES[mount.state] || mount.state || '已挂载'));
  if (mount.locked) head.append(badge('锁定'));
  if (scope) { row.classList.add('project-hook'); head.append(badge(scope, 'hook-scope'), hookHelpLink()); }
  row.append(head);
  row.append(el('p', `当前触发节点：${(catalogue || ui.hookCatalogue)?.triggers?.find(item => item.id === mount.trigger)?.label || mount.trigger} · ${mount.trigger}`, 'hint'));
  if (!mount.builtin && !step) {
    const actions = el('div', undefined, 'actions hook-actions');
    const legacy = legacyCommands(mount);
    const commandIssue = legacy ? commandReferencesIssue(mount, catalogue) : catalogue ? commandReferencesIssue(mount, catalogue) : null;
    const key = `${projectApi('/api/hooks')}:${task.id}:${mount.id}`, saving = pending.has(key);
    const update = async remove => {
      if (!ownsPage() || busy() || pending.has(key) || (remove ? (mount.removable ?? mount.editable) !== true || mount.locked : mount.editable !== true)) return;
      pending.add(key); setEditing(true); for (const node of actions.querySelectorAll('button')) node.disabled = true;
      try {
        if (!remove && !mount.enabled && hasCommand(mount) && !await authorizeHook({ ...mount, enabled: true }, callsAgent(mount), catalogue)) return;
        if (remove && !await confirmDialog({ title: `移除 Hook「${mount.name}」？`,
          message: '仅移除未来触发。不会取消已开始的动作、删除已创建的 Worker，或撤回已发出的合并请求和消息。', confirmLabel: '移除挂载',
          confirmHelp: '移除当前 Worker 的这个 Hook；执行历史与已产生的成果保留。' })) return;
        if (!ownsPage()) return;
        const result = await action(remove ? 'worker.hook_remove' : 'worker.hook_update', { id: task.id, hook_id: mount.id, expected_revision: model.revision,
          ...(remove ? {} : { enabled: !mount.enabled }) });
        if (ownsPage()) { show(remove ? '已移除挂载，已有成果不变。' : '已保存 Hook 启用状态。'); pending.delete(key); setEditing(false); await refresh(result); }
      } catch (error) { if (ownsPage()) show(`${error.message}；请刷新读取最新挂载状态。`, 'error'); }
      finally {
        pending.delete(key); setEditing(false); row.needsRefresh ||= !ownsPage();
        if (ownsPage()) restoreControls();
      }
    };
    const agent = !mount.enabled && callsAgent(mount);
    const help = '只修改未来触发；停用不撤回已开始的动作。启用后条件满足即可执行。';
    actions.append(guarded(button(mount.enabled ? '停用 Hook' : '启用 Hook', () => update(false), `ghost hook-button ${agent ? '' : mount.enabled ? 'hook-disable' : 'hook-enable'}`, { agent, help: agent ? agentHelp(help) : help }),
      saving || busy() ? '此挂载正在保存。' : mount.editable !== true ? mount.reason || '当前挂载不可编辑。' : !mount.enabled ? commandIssue : null));
    actions.append(guarded(button('移除挂载', () => update(true), 'ghost hook-button', { help: '移除未来触发，不删除已产生的 Worker、提交或消息。' }),
      saving || busy() ? '此挂载正在保存。' : (mount.removable ?? mount.editable) !== true || mount.locked ? mount.reason || '此挂载不可移除。' : null));
    const editor = el('div', undefined, 'hook-editor');
    let editing = false, resumeEditor = () => {};
    row.resume = () => { if (ownsPage()) { resumeEditor(); restoreControls(); } };
    function restoreControls() {
      const [toggle, remove, edit, copy] = actions.querySelectorAll('button');
      if (toggle) toggle.disabled = pending.has(key) || editing || busy() || mount.editable !== true || (!mount.enabled && !!commandIssue);
      if (remove) remove.disabled = pending.has(key) || editing || busy() || (mount.removable ?? mount.editable) !== true || mount.locked;
      if (edit) edit.disabled = pending.has(key) || editing || busy() || mount.editable !== true || mount.locked || legacy;
      if (copy) copy.disabled = pending.has(key) || editing || busy() || legacy || model.can_attach === false || ['completed', 'cancelled'].includes(task.status) || task.archived;
    }
    async function editMount(copy = false) {
      if (!ownsPage() || busy() || editing || pending.has(key) || legacy
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
            : copy ? '复制为新停用挂载，不执行、不复制执行记录或私有运行覆盖。' : '保存完整挂载配置；启用指令 Hook 前须确认未来执行风险。');
        };
        const form = createHookForm(directory, { initial, ownsPage, workerId: task.id, workerTaskKind: task.task_kind, failedSelf: task.status === 'failed', copying: copy, onChange: paintCost });
        editor.replaceChildren(el('h3', copy ? '复制为新停用挂载' : `编辑挂载：${mount.name}`), form.node);
        if (copy) editor.append(el('p', '副本是此 Worker 的新停用挂载，不执行，不复制执行记录；私有运行覆盖必须显式重新设置。', 'hint'));
        save = button(copy ? '保存停用副本' : '保存挂载', async () => {
          if (!ownsPage() || pending.has(key) || form.validate()) return;
          const hook = { ...form.collect(), ...(copy ? { enabled: false } : {}) };
          pending.add(key); form.setBusy(true); save.disabled = true; cancel.disabled = true;
          let saved = false;
          try {
            if (form.replacesPrompt() && !await promptRisk()) return;
            if (!ownsPage() || !await authorizeHook(hook, form.agentCall(), directory) || !ownsPage()) return;
            const result = await action(copy ? 'worker.hook_attach' : 'worker.hook_update', { id: task.id,
              ...(!copy ? { hook_id: mount.id } : {}), hook, expected_revision: model.revision });
            saved = true;
            if (ownsPage()) { editing = false; setEditing(false); editor.replaceChildren(); show(copy ? '已复制为新停用挂载，不执行。' : '挂载配置已保存。'); pending.delete(key); await refresh(result); }
          } catch (error) { if (ownsPage()) show(saved ? `已保存，但刷新失败：${error.message}` : `${error.message}；编辑保留，版本冲突时请复制正文后刷新。`, 'error'); }
          finally {
            pending.delete(key); row.needsRefresh ||= !ownsPage();
            resumeEditor = () => { form.setBusy(pending.has(key)); save.disabled = pending.has(key) || saved; cancel.disabled = pending.has(key); };
            if (ownsPage()) { resumeEditor(); restoreControls(); }
          }
        }, 'hook-button');
        const cancel = button('取消编辑', () => { if (pending.has(key)) return; editing = false; setEditing(false); editor.replaceChildren(); restoreControls(); }, 'ghost');
        paintCost(!copy && initial.enabled !== false && form.agentCall()); editor.append(save, cancel);
      } catch (error) { if (ownsPage()) { editing = false; setEditing(false); restoreControls(); show(error.message, 'error'); } }
      finally { if (!editor.children.length) { editing = false; setEditing(false); } }
    }
    actions.append(guarded(button('编辑挂载', () => editMount(), 'ghost hook-button', { help: '编辑此实例的命令、节点、条件和模式；不会修改来源模板。' }),
      legacy ? '旧内联命令须先显式导入快捷指令。' : saving || busy() || mount.editable !== true || mount.locked ? mount.reason || '此挂载不可编辑。' : null),
    guarded(button('复制为停用挂载', () => editMount(true), 'ghost hook-button', { help: '复制配置为此 Worker 的新停用挂载，不执行，也不复制执行记录。' }),
      legacy ? '旧内联命令须先显式导入，不复制旧内联命令。' : model.can_attach === false || ['completed', 'cancelled'].includes(task.status) || task.archived ? '此 Worker 当前不允许新增挂载。' : null));
    if (legacy) actions.append(importButton({ worker_id: task.id, hook_id: mount.id }, model.revision, ownsPage, refresh,
      { busy, setEditing, catalogue, unavailable: mount.editable !== true || mount.locked ? mount.reason || '此挂载不可编辑。' : null }));
    for (const control of actions.querySelectorAll('button')) {
      const click = control.onclick; control.onclick = async () => { await click(); if (ownsPage()) restoreControls(); };
    }
    row.append(actions, editor);
  }
  if (mount.reason) row.append(el('p', mount.reason, 'hint'));
  if (legacyCommands(mount)) row.append(el('p', '旧内联命令已停止直接执行；须显式导入快捷指令，再启用 Hook。', 'error'));
  row.append(parameters(mount, catalogue || ui.hookCatalogue)); return row;
}

/** Synchronous inspect projection; graph reuses stage controls without the full Hook editor. */
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
    const row = el('div', undefined, 'hook-compact'); row.setAttribute('aria-label', 'Worker 自动化');
    if (completion && ['order', 'child'].includes(workerKind(task))) {
      row.append(el('strong', '自动化', 'worker-hooks-label'), autoCompletionControl(task, { ...model, completion }, refresh, ownsPage,
        editing => { row.dataset.completionEditing = String(editing); }));
      return row;
    }
    row.append(button(`自动化${model ? ` · ${items.filter(item => item.enabled).length} 已启用` : ''}`, () => detail(task.id), 'ghost hook-button',
      { worker: task }));
    if (['order', 'child'].includes(workerKind(task))) row.append(el('span', completion ? `自动链：${COMPLETION_LEVELS[completion.level] || '级别未知'} · ${STATES[completion.state] || completion.state || '状态未知'}`
      : task.auto_merge ? `自动合并 ${task.auto_merge.enabled ? '已启用' : '未启用'}` : '自动合并状态未知', 'hint'));
    return row;
  }
  const section = el('section', undefined, 'block worker-hooks');
  section.setAttribute('aria-label', 'Worker 自动化');
  const row = el('div', undefined, 'worker-hooks-row');
  row.append(el('strong', '自动化', 'worker-hooks-label'));
  if (completion) row.append(autoCompletionControl(task, { ...model, completion }, refresh, ownsPage,
    editing => { section.dataset.completionEditing = String(editing); }));
  else if (['order', 'child'].includes(workerKind(task))) row.append(autoMergeControl(task, refresh, ownsPage));
  let handlerCard;
  const convergence = workerConvergenceControl(task, { ownsPage, refresh,
    onPolicyChange(policy) { handlerCard?.updatePolicy(policy); },
    onEditing(value) { section.dataset.convergenceEditing = String(value); },
    busy: () => section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true' });
  const handler = items.find(isDeliveryHandler);
  if (convergence && !handler) row.append(convergence);
  for (const mount of items) {
    const diagnostic = operationAlert(mount);
    if (diagnostic && !isDeliveryHandler(mount)) row.append(el('span', `${mount.name}：${diagnostic}`, 'error hook-operation-alert'));
  }
  const alerts = items.filter(item => (!BUILTIN_STEPS[item.id] || !completion) && (['running', 'failed', 'unknown', 'skipped'].includes(item.state) || item.pending_due_at));
  for (const mount of alerts) {
    const diagnostic = ['failed', 'unknown'].includes(mount.state) ? mount.last_execution?.error || mount.reason : null;
    const alert = el('span', `${mount.name}：${hookResultLabel(mount, mount.state) || STATES[mount.state] || '状态未知'}${diagnostic ? ` · ${diagnostic}` : ''}`, 'hint hook-mount-alert');
    alert.setAttribute('data-help', mount.last_execution?.error || mount.reason || STATES[mount.state]); alert.tabIndex = 0;
    if (['failed', 'unknown'].includes(mount.state)) alert.classList.add('error');
    row.append(alert);
  }
  const management = el('div', undefined, 'hook-management');
  management.id = `worker-hooks-management-${task.id}`;
  const toggle = button('展开', () => { management.open = !management.open; }, 'ghost hook-management-toggle');
  toggle.setAttribute('aria-controls', management.id);
  // Keep one open-state seam for detail refreshes and programmatic editor expansion.
  Object.defineProperty(management, 'open', {
    get: () => !management.hidden,
    set(value) {
      management.hidden = !value;
      toggle.textContent = value ? '收起' : '展开';
      toggle.setAttribute('aria-expanded', String(Boolean(value)));
    },
  });
  management.open = false;
  if (!model) management.append(el('p', '完整挂载列表暂不可用；请更新服务或刷新。', 'hint'));
  if (!items.length) management.append(el('p', '此 Worker 尚未挂载 Hook。', 'hint'));
  const groups = new Map(); for (const mount of items.filter(item => !isDeliveryHandler(item))) { const group = groups.get(mount.trigger) || []; group.push(mount); groups.set(mount.trigger, group); }
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
          const help = '保存此 Worker 的 Hook 挂载授权；启用时条件满足即可执行。指令未来执行跟随最新定义，停用配置不执行。';
          save.setAttribute('data-help', agent ? agentHelp(help) : help);
        };
        const form = template ? null : createHookForm(catalogue, { ownsPage, workerId: task.id, workerTaskKind: task.task_kind, failedSelf, onChange: paintCost });
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
            if (!ownsPage() || !await authorizeHook(template || hook, agent, catalogue) || !ownsPage()) return;
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
    button('指令与 Hook 工具', () => openHookTools(), 'ghost hook-button', { help: '管理当前项目的快捷指令和可复用模板；不会自动挂载到 Worker。' }));
  management.append(controls, editor); row.append(toggle, management); section.append(row);
  if (handler) { handlerCard = deliveryHandlerCard({ mount: handler, policy: model?.convergence, control: convergence }); section.append(handlerCard); }
  return section;
}
async function promptRisk() {
  return confirmDialog({ title: '使用替换内置规则的 Prompt？', message: '这份自定义 Prompt 可能影响 Worker 权限、协作、工作区安全和交付协议；作用于所配置动作的新建或重试／继续目标 Worker。',
    confirmLabel: '仍然使用', danger: true, confirmHelp: '将自定义 Prompt 写入预约运行设置，不修改项目默认。' });
}

/** Compatibility entry; the project automation page is now a feature directory. */
export async function openHooks(options = {}) {
  if (options.subpage === 'commands' || options.subpage === 'templates') return openHookTools({ subpage: options.subpage === 'commands' ? 'commands' : 'settings' });
  const { openProjectAutomation } = await import('./render-project-automation.js');
  return openProjectAutomation(options);
}

/** Auxiliary definitions and templates; never part of the feature directory. */
export async function openHookTools({ subpage = 'settings' } = {}) {
  subpage = ['commands', 'history'].includes(subpage) ? subpage : 'settings';
  const view = activateDetailView({ view: 'hook-tools', title: '指令与 Hook 工具', context: '工作', hint: '指令定义与可复用模板', hash: subpage === 'history' ? '#hook-tools-history' : subpage === 'commands' ? '#hooks-commands' : '#hook-tools' });
  const project = projectApi('/api/hooks'), owner = globalThis.document;
  const ownsPage = () => owner === globalThis.document && ui.view === view && sameProject(project);
  if (ui.hooksPage?.view === view && ui.hooksPage.project === project) {
    ui.hooksPage.switchSubpage(subpage); return ui.hooksPage.pending;
  }
  ui.hooksPage?.shortcutNode?.dispose?.();
  const state = { view, project, subpage, pending: null, catalogue: null, templateEditing: false, busy: false, templateQuery: '', folds: new Map(), details: new Map() }; ui.hooksPage = state;
  const owns = () => ownsPage() && ui.hooksPage === state;
  const root = el('div', undefined, 'hooks-page'); $('detail').replaceChildren(root);
  const subnav = pageSubnav('指令与 Hook 工具子页面', [
    { id: 'settings', label: 'Hook 模板', href: '#hook-tools' },
    { id: 'commands', label: '指令管理', href: '#hooks-commands' },
    { id: 'history', label: '指令运行记录', href: '#hook-tools-history' },
  ], subpage, next => owns() ? openHookTools({ subpage: next }) : undefined);
  state.switchSubpage = next => {
    state.subpage = next;
    for (const link of subnav.children) {
      const selected = link.dataset.subpage === next;
      link.classList.toggle('active', selected); link.setAttribute('aria-current', selected ? 'page' : 'false');
    }
    for (const node of state.settingsNodes || []) node.hidden = next !== 'settings';
    state.shortcutNode?.setSubpage?.(next);
  };
  root.append(subnav);
  const editor = el('div', undefined, 'hook-editor');
  const searchControl = searchField({ label: '查找 Hook 模板', placeholder: '按名称、触发节点或动作查找模板', scope: '范围：当前项目目录全部模板', onSubmit: value => { state.templateQuery = value; applyTemplateSearch(); } });
  const search = searchControl.input; search.classList.add('hook-template-search');
  let applyTemplateSearch = () => {};
  function edit(initial = {}, copying = false) {
    if (!owns() || state.busy || state.templateEditing) return;
    state.folds.set('templates', true);
    const templates = root.querySelector('[data-module="templates"]'); if (templates) templates.moduleOpen = true;
    if (legacyCommands(initial)) { show('旧内联命令须先显式导入快捷指令，不直接编辑或复制旧内联命令。', 'error'); return; }
    state.templateEditing = true;
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
        if (owns()) { state.catalogue = result; state.templateEditing = false; editor.replaceChildren(); paint(); show('模板已保存；已有实例不变。保存不执行、不挂载，也不调用 Agent。'); }
      } catch (error) { if (owns()) show(`${error.message}；编辑保留。版本冲突时请复制内容后刷新。`, 'error'); }
      finally { state.busy = false; if (owns()) { form.setBusy(false); save.disabled = false; paint(); } }
    }, 'hook-button', { help: '保存可复用项目模板；不挂载到 Worker、不调用 Agent。' });
    editor.append(save, button('取消编辑', () => { if (!state.busy) { state.templateEditing = false; editor.replaceChildren(); } }, 'ghost'));
  }
  async function load() {
    try { const catalogue = await api('/api/hooks'); if (!owns()) return; state.catalogue = catalogue; ui.hookCatalogue = catalogue; paint(); }
    catch (error) {
      if (!owns()) return;
      if (state.catalogue) show(`读取失败：${error.message}；已加载记录与未保存编辑保留。`, 'error');
      else root.replaceChildren(subnav, el('h1', '指令与 Hook 工具'), el('p', `读取失败：${error.message}`, 'error'), button('重新读取', load, 'ghost'));
    }
  }
  function paint() {
    if (!owns()) return;
    const catalogue = state.catalogue;
    const focused = document.activeElement, selection = focused && typeof focused.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    // Busy changes do not require a full redraw: every mutation checks this shared gate.
    if (state.paintedCatalogue === catalogue && (state.busy || state.paintedBusy === state.busy)) {
      state.shortcutNode?.updateCommands?.(catalogue.commands, catalogue);
      return;
    }
    for (const card of root.querySelectorAll('.hook-mount')) {
      const key = card.dataset.hookId || card.dataset.templateId;
      if (key) state.details.set(key, card.querySelector('details')?.open === true);
    }
    const preservedCommands = state.shortcutNode;
    const header = el('div', undefined, 'hooks-page-header'); header.append(el('h1', '指令与 Hook 工具'), hookHelpLink());
    const commands = preservedCommands || renderShortcutCommands({ catalogue, folds: state.folds, ownsPage: owns, busy: () => state.busy,
      setBusy(value) { state.busy = value; if (owns()) paint(); }, setEditing(value) { state.shortcutEditing = value; },
      onCatalogue(result) { if (owns()) { state.catalogue = result; ui.hookCatalogue = result; paint(); } },
    });
    state.shortcutNode = commands;
    commands.updateCommands?.(catalogue.commands, catalogue);
    const controls = el('div', undefined, 'actions'); controls.append(button('新建模板', () => edit(), 'hook-button', { help: '编辑可复用规则，不启动 Agent，也不自动安装到 Worker。' }),
      button('刷新目录', async () => { if (state.busy) return; if (state.templateEditing && !await confirmDialog({ title: '放弃未保存编辑并刷新？', message: '刷新会读取后台最新项目目录，当前未保存模板编辑会丢失。', confirmLabel: '放弃并刷新' })) return;
        if (!owns()) return; state.templateEditing = false;
        // Shortcut drafts retain their original revision across explicit reads.
        editor.replaceChildren(); state.paintedCatalogue = null; await load(); }, 'ghost hook-button', { help: '显式读取最新目录；快捷指令草稿与选择保留，其他未保存编辑先确认。不执行任何指令。' }));
    const templates = block('项目模板', String(catalogue.templates?.length || 0));
    templates.querySelector('.section-title').append(hookHelpLink());

    const cards = [], empty = el('p', '没有匹配的模板。', 'hint'); empty.hidden = true;
    applyTemplateSearch = () => {
      const query = searchControl.applied.toLowerCase(); let count = 0;
      for (const { card, text } of cards) { card.hidden = !text.includes(query); if (!card.hidden) count++; }
      empty.hidden = count !== 0 || !query;
    };
    if (catalogue.templates?.length) templates.append(searchControl.root);
    if (!catalogue.templates?.length) templates.append(el('p', '还没有模板。自动合并是 Worker 内置 Hook，不需要创建模板。', 'hint'));
    for (const template of catalogue.templates || []) {
      const card = projectHookCard(template.name, '模板 · 尚未挂载', 'hook-template'); card.dataset.templateId = template.id;
      card.append(el('p', `${catalogue.triggers?.find(t => t.id === template.trigger)?.label || template.trigger} · ${template.mode === 'persistent' ? '持续' : '一次性'}`, 'hint'), parameters(template, catalogue));
      if (legacyCommands(template)) card.append(el('p', '旧内联命令已停止直接执行；请先显式导入，再启用 Hook。', 'error'),
        importButton({ template_id: template.id }, catalogue.revision, owns, result => {
          if (owns()) { state.catalogue = result; ui.hookCatalogue = result; paint(); }
        }, { catalogue, busy: () => state.busy, setEditing(value) { state.busy = value; } }));
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
    applyTemplateSearch(); templates.append(empty, editor);
    automationModule(templates, 'templates', state.folds, `${catalogue.templates?.length || 0} 个可复用模板；保存不挂载、不执行。${catalogue.templates?.some(legacyCommands) ? '含已停用的旧内联命令，需显式导入。' : ''}`);
    for (const card of templates.querySelectorAll('.hook-mount')) {
      const key = card.dataset.hookId || card.dataset.templateId, details = card.querySelector('details');
      if (key && details && state.details.has(key)) details.open = state.details.get(key);
    }
    const introduction = el('p', '模板可复用，实际挂载独立保存。这里管理项目指令定义与可复用模板，不运行指令。', 'hint');
    const tools = renderAutomationTools(catalogue, state.folds);
    state.settingsNodes = [introduction, tools, controls, templates];
    syncChildren(root, [subnav, header, introduction, commands, tools, controls, templates]);
    state.switchSubpage(state.subpage);
    // Moving a retained editor/search into a fresh module must not discard keyboard focus or caret.
    let ancestor = focused;
    while (ancestor && ancestor !== root) ancestor = ancestor.parentNode;
    if (ancestor === root && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
      if (selection && focused.setSelectionRange) focused.setSelectionRange(...selection);
    }
    state.paintedCatalogue = catalogue; state.paintedBusy = state.busy;

  }
  state.pending = load(); return state.pending;
}
