import { el, button, badge, block } from './dom.js';
import { api, action, projectApi } from './api.js';
import { ui } from './state.js';
import { detail } from './navigate.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { agentHelp } from './help.js';
import { workerKind } from './worker-kind.js';
import { isHistoricalDelivery, absolute } from './format.js';
import { createHookForm, COMMAND_WARNING } from './hook-form.js';
import { autoMergeControl, autoCompletionControl, COMPLETION_LEVELS, HOOK_STATES as STATES, AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown } from './hook-controls.js';
import { projectBase, routeContext } from './route.js';
import { workerLabel } from './worker-label.js';
import { hookScheduleSummary, scheduledWallTime } from './hook-schedule.js';
import { workerConvergenceControl, validConvergencePolicy, convergenceDiagnostic, CONVERGENCE_ENABLE_HELP } from './convergence-policy-controls.js';
import { commandReferencesIssue, commandSummary, legacyCommands, validCommands, PROMPT_WARNING } from './shortcut-command-model.js';

import { isDeliveryHandler, hookResultLabel, renderOperation, operationAlert, deliveryHandlerCard } from './automation-tools.js';

// Re-export via the already-shared renderer to retain the directory's lazy chunk boundary.
export { AUTOMATION_METADATA, automationMetadata, DISPLAY_PRINCIPLES, automationDefaultShown };

const pending = new Set();
const workerFeatureStates = new WeakMap();
function featureStates(document, identity, project, taskId) {
  let state = workerFeatureStates.get(document);
  if (!state || state.identity !== identity || state.project !== project || state.taskId !== taskId) {
    state = { identity, project, taskId, features: new Map(), pushIdentity: null };
    workerFeatureStates.set(document, state);
  }
  return state;
}
function workerFeature(item, task, principles, state) {
  const previous = state.features.get(item.id), section = el('article', undefined, 'worker-automation-feature');
  section.dataset.feature = item.id;
  const head = el('div', undefined, 'worker-automation-feature-head');
  head.append(el('h3', item.name));
  const body = el('div', undefined, 'worker-automation-feature-body');
  body.id = `worker-${task.id}-automation-${item.id}`;
  let explicit = previous?.explicit === true;
  const toggle = button('收起', () => { explicit = true; section.featureOpen = !section.featureOpen; }, 'ghost worker-feature-toggle');
  toggle.setAttribute('aria-controls', body.id);
  Object.defineProperty(section, 'featureOpen', {
    get: () => !body.hidden,
    set(value) { body.hidden = !value; toggle.textContent = value ? '收起' : '展开'; toggle.setAttribute('aria-expanded', String(Boolean(value))); },
  });
  const principle = el('details', undefined, 'worker-feature-principle');
  principle.append(el('summary', '原理简介'), el('p', item.principle, 'hint'));
  principle.open = previous?.principle.open === true;
  const advanced = el('details', undefined, 'worker-feature-advanced');
  advanced.append(el('summary', '高级设置与执行记录'));
  advanced.open = previous?.advanced.open === true;
  body.append(el('p', item.description, 'worker-feature-description'));
  section.featureOpen = explicit ? previous.section.featureOpen : automationDefaultShown(item.id, task, principles);
  head.append(toggle); section.append(head, body);
  const nodes = { section, body, principle, advanced, get explicit() { return explicit; } };
  state.features.set(item.id, nodes); return nodes;
}
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
function guardedControl(control, reason) {
  const host = el('span', undefined, 'help-host'); host.append(control);
  host.sync = () => {
    const blocked = reason(); control.disabled = Boolean(blocked); host.tabIndex = control.disabled ? 0 : -1;
    host.setAttribute('data-help', `${blocked || ''} ${control.getAttribute('data-help') || ''}`);
  };
  host.sync(); return host;
}
/** Independent user switch: child delivery/acceptance authorization remains locked. */
function acceptanceNoticeControl(task, model, refresh = () => {}, ownsPage = () => true, onEditing = () => {}, busy = () => false) {
  const scope = projectBase(), owner = globalThis.document, key = `${scope}:${task.id}:acceptance-notice`;
  const owns = () => ownsPage() && owner === globalThis.document && !routeContext().invalid && projectBase() === scope;
  const valid = value => typeof value?.enabled === 'boolean' && typeof value.editable === 'boolean'
    && (value.reason === null || typeof value.reason === 'string');
  let setting = model?.acceptance_notice, revision = model?.revision, uncertain = false, error = '';
  const node = el('div', undefined, 'hook-completion-control acceptance-notice-control');
  const status = el('span', undefined, 'hint acceptance-notice-state'); status.setAttribute('role', 'status');
  const group = el('div', undefined, 'hook-completion-levels'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', `Worker ${workerLabel(task)} 待验收告知`);
  const choices = [];
  const frozen = ['requested', 'executing', 'resolving', 'blocked', 'suspended'].includes(task.reservation?.status);
  const ended = ['completed', 'failed', 'cancelled'].includes(task.status) || task.archived || task.branch_archive?.archived;
  const editable = () => owns() && !busy() && valid(setting) && typeof revision === 'string' && revision.length > 0 && setting.editable
    && ['order', 'say', 'child'].includes(task.task_kind) && !ended && !frozen && !uncertain;
  function paint() {
    const reason = pending.has(key) ? '正在保存。' : busy() ? '其他自动化正在编辑或保存，请稍候。' : uncertain ? '保存结果未确认，请只读刷新，不要重复提交。'
      : !valid(setting) || !revision ? '待验收告知设置不可用，请刷新或更新服务。' : ended ? 'Worker 已结束或归档。'
        : frozen ? '交付请求已冻结，不能修改告知。' : setting.reason || (!setting.editable ? '此 Worker 当前不可编辑。' : '');
    for (const { enabled, control, host } of choices) {
      const selected = valid(setting) && setting.enabled === enabled;
      control.disabled = !editable() || pending.has(key) || selected;
      control.setAttribute('aria-pressed', String(selected)); control.classList.toggle('is-selected', selected);
      const help = enabled ? '仅今后真实进入待验收时生成纯告知；派生 Worker 标为待父确认，不调用 Agent，不改变合并或验收授权，不补发历史。'
        : '停止未来成功收尾告知，不删除历史，也不隐藏失败、未知结果或待决问题，不改变合并或验收授权。';
      control.setAttribute('data-help', help); host.setAttribute('data-help', `${reason}${selected && !reason ? '已是当前设置。' : ''} ${help}`); host.tabIndex = control.disabled ? 0 : -1;
    }
    status.textContent = error || (pending.has(key) ? '正在保存…' : valid(setting) ? `待验收告知：${setting.enabled ? '开启' : '关闭'}` : '待验收告知状态尚未确认。');
    status.classList.toggle('error', !!error);
  }
  async function save(enabled) {
    if (!editable() || pending.has(key) || setting.enabled === enabled) return;
    pending.add(key); onEditing(true); paint(); node.setAttribute('aria-busy', 'true');
    let acknowledged = false;
    try {
      const result = await action('worker.acceptance_notice', { id: task.id, enabled, expected_revision: revision }, { refresh: false });
      acknowledged = true;
      if (!owns()) return;
      if (result?.version !== 1 || result.worker_id !== task.id || typeof result.revision !== 'string' || !result.revision
        || !Array.isArray(result.mounts) || !valid(result.acceptance_notice) || result.acceptance_notice.enabled !== enabled) {
        uncertain = true; throw new Error('设置已提交，但未收到匹配的告知状态；请只读刷新，勿重复提交。');
      }
      setting = result.acceptance_notice; revision = result.revision; error = '';
      show(`Worker ${workerLabel(task)} 待验收告知已${enabled ? '开启' : '关闭'}；不补发历史。`);
    } catch (cause) { if (owns()) { uncertain = true; error = `${cause.message}；请刷新读取最新 Hook 版本，勿重复提交未确认操作。`; show(error, 'error'); } }
    finally { pending.delete(key); onEditing(false); paint(); node.removeAttribute('aria-busy'); }
    if (acknowledged && !uncertain && owns()) try { await refresh(); } catch (cause) {
      if (owns()) { error = `告知设置已保存，但刷新失败：${cause.message}；不要重复提交。`; status.textContent = error; status.classList.add('error'); show(error, 'error'); }
    }
  }
  if (!valid(setting)) { node.append(status); paint(); return node; }
  for (const enabled of [false, true]) {
    const control = button(enabled ? '开启告知' : '关闭告知', () => save(enabled), 'hook-completion-level'); control.dataset.noticeEnabled = String(enabled);
    const host = el('span', undefined, 'help-host'); host.append(control); choices.push({ enabled, control, host }); group.append(host);
    const clicked = control.onclick; control.onclick = async () => { await clicked(); paint(); };
  }
  node.append(group, status); paint(); return node;
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
  const ownerDocument = globalThis.document;
  const featureState = featureStates(ownerDocument, identity, project, task.id);
  const pushIdentity = model?.push;
  if (Number.isSafeInteger(pushIdentity?.worker_id) && pushIdentity.worker_id > 0
    && (pushIdentity.hook_id === null || typeof pushIdentity.hook_id === 'string')) featureState.pushIdentity = { workerId: pushIdentity.worker_id, hookId: pushIdentity.hook_id };
  const featureList = el('div', undefined, 'worker-automation-features');
  const featureNodes = new Map(AUTOMATION_METADATA.map(item => [item.id, workerFeature(item, task, model?.automation_settings?.display_principles, featureState)]));
  const completionFeature = featureNodes.get('completion');
  if (completion && ['failed', 'unknown'].includes(completion.state)) row.append(el('span',
    `${AUTOMATION_METADATA.find(item => item.id === 'completion').name}：${completion.last_execution?.error || STATES[completion.state]}`, 'error hook-completion-alert'));
  if (completion && ['order', 'child'].includes(workerKind(task))) completionFeature.body.append(autoCompletionControl(task, { ...model, completion }, refresh, ownsPage,
    editing => { section.dataset.completionEditing = String(editing); },
    () => section.dataset.hookEditing === 'true' || section.dataset.convergenceEditing === 'true'));
  else if (['order', 'child'].includes(workerKind(task))) {
    completionFeature.body.append(el('p', '自动链完整状态不可用，保留兼容自动合并入口；请刷新或更新服务。', 'hint'), autoMergeControl(task, refresh, ownsPage));
  } else completionFeature.body.append(el('p', 'main／分支所有者接收交付，不向父 Worker 自动合并；此功能不适用。', 'hint'));
  const noticeFeature = featureNodes.get('acceptance_notice');
  if (['order', 'child'].includes(workerKind(task))) noticeFeature.body.append(acceptanceNoticeControl(task, model, refresh, ownsPage,
    editing => { section.dataset.hookEditing = String(editing); },
    () => section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true' || section.dataset.convergenceEditing === 'true'));
  else noticeFeature.body.append(el('p', 'main／分支所有者不进入开发成果待验收状态，此告知不适用。', 'hint'));
  if (!model?.automation_settings?.display_principles) row.append(el('span', '默认显示原则尚未提供；当前仅展示功能入口，不推断执行授权。', 'hint'));
  let handlerCard;
  const convergenceAlert = el('span', undefined, 'error hook-convergence-alert');
  const syncConvergenceAlert = policy => {
    convergenceAlert.textContent = validConvergencePolicy(policy, task.branch) && policy.owner_id === task.id ? convergenceDiagnostic(policy) : '';
    convergenceAlert.hidden = !convergenceAlert.textContent;
  };
  syncConvergenceAlert(model?.convergence); row.append(convergenceAlert);
  const convergence = workerConvergenceControl(task, { ownsPage, refresh,
    onPolicyChange(policy) { handlerCard?.updatePolicy(policy); syncConvergenceAlert(policy); },
    onEditing(value) { section.dataset.convergenceEditing = String(value); },
    busy: () => section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true' });
  const handler = items.find(isDeliveryHandler);
  const convergenceFeature = featureNodes.get('convergence');
  if (convergence) convergenceFeature.body.append(convergence);
  const policy = model?.convergence;
  if (!convergence && validConvergencePolicy(policy, task.branch) && policy.owner_id === task.id && !policy.mounted) {
    const mountedStatus = el('p', '当前目标尚未挂载归并，仍串行处理合法交付。', 'hint');
    convergenceFeature.body.append(mountedStatus);
    let mounting = false, uncertain = false, mountHost;
    const mount = button('挂载并开启归并', async () => {
      if (!ownsPage() || mounting || uncertain || !policy.editable || section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true') return;
      mounting = true; section.dataset.convergenceEditing = 'true'; mountHost.sync();
      try {
        if (!await confirmDialog({ title: `挂载并开启 ${policy.branch} 的归并？`, message: CONVERGENCE_ENABLE_HELP, confirmLabel: '确认挂载并开启', agent: true, confirmHelp: CONVERGENCE_ENABLE_HELP }) || !ownsPage()) return;
        const result = await action('branch.convergence_set', { branch: policy.branch, mounted: true, enabled: true, expected_revision: policy.revision }, { refresh: false });
        if (!ownsPage()) return;
        if (!validConvergencePolicy(result, task.branch) || result.owner_id !== task.id || !result.mounted || !result.enabled) throw new Error('归并保存结果未确认，请只读刷新，不要重复提交。');
        uncertain = true; mountedStatus.textContent = '当前目标已挂载归并，归并合并：开启。'; handlerCard?.updatePolicy(result);
        show('归并已挂载并开启，不改变来源合并或验收授权。');
        section.dataset.convergenceEditing = 'false';
        try { await refresh(); } catch (error) { if (ownsPage()) show(`归并已保存，但刷新失败：${error.message}；不要重复提交。`, 'error'); }
      } catch (error) { if (ownsPage()) { uncertain = true; show(`${error.message}；请刷新核对设置，勿重发未确认操作。`, 'error'); } }
      finally { mounting = false; section.dataset.convergenceEditing = 'false'; mountHost.sync(); }
    }, 'hook-button', { agent: true, help: CONVERGENCE_ENABLE_HELP });
    mountHost = guardedControl(mount, () => mounting ? '正在确认或保存。' : uncertain ? '保存结果已提交，请只读刷新，不要重复提交。'
      : !policy.editable ? policy.reason || '当前目标不能修改归并。' : !ownsPage() ? '已离开此 Worker。' : null);
    const clicked = mount.onclick; mount.onclick = async () => { await clicked(); mountHost.sync(); };
    convergenceFeature.body.append(mountHost);
  }
  if (handler) {
    handlerCard = deliveryHandlerCard({ mount: handler, policy });
    convergenceFeature.advanced.append(handlerCard);
  }
  for (const mount of items) {
    const diagnostic = operationAlert(mount);
    if (diagnostic) row.append(el('span', `${mount.name}：${diagnostic}`, 'error hook-operation-alert'));
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
      { setEditing(value) { section.dataset.hookEditing = String(value); }, busy: () => section.dataset.hookEditing === 'true'
        || section.dataset.completionEditing === 'true' || section.dataset.convergenceEditing === 'true' }));
    management.append(part);
  }
  const editor = el('div', undefined, 'hook-editor');
  const controls = el('div', undefined, 'actions hook-actions');
  const failedSelf = task.status === 'failed';
  const writable = model && !['completed', 'cancelled'].includes(task.status) && !task.archived && !task.branch_archive?.archived
    && (model.can_attach !== undefined ? model.can_attach === true : !failedSelf);
  const attach = button('挂载 Hook', async () => {
    if (!ownsPage() || !writable || section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true'
      || section.dataset.convergenceEditing === 'true' || pending.has(`attach:${task.id}`)) return;
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
  controls.append(guarded(attach, !writable ? '挂载列表不可用、Worker 已结束或分支已归档；请先处理后刷新。' : null));
  management.append(controls, editor); row.append(toggle, management);
  const pushFeature = featureNodes.get('push'), pushHost = el('div', undefined, 'worker-push-setting');
  pushFeature.body.append(pushHost);
  const pushKey = `${project}:${task.id}:push`;
  let pushControlHost = null;
  const pushMain = ['main', 'owner'].includes(workerKind(task)) && task.branch === 'main';
  async function readPush(goToMain = false) {
    if (!ownsPage() || pending.has(pushKey) || section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true' || section.dataset.convergenceEditing === 'true') return;
    pending.add(pushKey); section.dataset.hookEditing = 'true';
    try {
      const directory = await api('/api/hooks'); if (!ownsPage() || ownerDocument !== globalThis.document) return;
      const source = directory?.command_example;
      if (!Number.isSafeInteger(source?.worker_id) || source.worker_id < 1) throw new Error('main 推送身份不可用；不会猜测 Worker ID。');
      if (goToMain) { section.dataset.hookEditing = 'false'; return detail(source.worker_id); }
      if (source.worker_id !== task.id || source.hooks?.worker_id !== task.id || typeof source.hooks.revision !== 'string') throw new Error('推送挂载与当前 main 身份不匹配。');
      featureState.pushIdentity = { workerId: source.worker_id, hookId: source.hook_id };
      paintPush(source.hooks, directory);
    } catch (error) { if (ownsPage()) show(`推送设置读取失败：${error.message}`, 'error'); }
    finally { pending.delete(pushKey); section.dataset.hookEditing = 'false'; pushControlHost?.sync(); }
  }
  function paintPush(current = model, catalogue = null) {
    pushHost.replaceChildren(); pushControlHost = null;
    if (!pushMain) {
      pushHost.append(el('p', '仅 main 执行推送；本 Worker 不挂载或执行此功能。', 'hint'),
        button('查看 main 自动化', () => ownsPage() && featureState.pushIdentity?.workerId
          ? detail(featureState.pushIdentity.workerId) : readPush(true), 'ghost hook-button', { help: '只读定位本项目 main Worker 并打开其自动化；不会推送或开启挂载。' })); return;
    }
    const mount = featureState.pushIdentity?.workerId === task.id && current?.mounts?.find(item => item.id === featureState.pushIdentity.hookId);
    pushFeature.advanced.hidden = !mount;
    if (mount) {
      pushHost.append(el('p', `当前 main 推送：${mount.enabled ? '开启' : '关闭'}`, 'hint'));
      let uncertain = false, controlHost;
      const control = button(mount.enabled ? '关闭推送' : '开启推送', async () => {
        if (!ownsPage() || pending.has(pushKey) || uncertain || mount.editable !== true || mount.locked || section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true' || section.dataset.convergenceEditing === 'true') return;
        pending.add(pushKey); section.dataset.hookEditing = 'true'; controlHost.sync();
        try {
          if (!mount.enabled && !await authorizeHook({ ...mount, enabled: true }, callsAgent(mount))) return;
          if (!ownsPage()) return;
          const result = await action('worker.hook_update', { id: task.id, hook_id: mount.id, enabled: !mount.enabled, expected_revision: current.revision }, { refresh: false });
          if (!ownsPage()) return;
          const saved = result?.mounts?.find(item => item.id === mount.id);
          if (result?.worker_id !== task.id || typeof result.revision !== 'string' || saved?.enabled !== !mount.enabled) throw new Error('推送保存结果未确认，请只读刷新，勿重复提交。');
          uncertain = true; show(`main 推送已${saved.enabled ? '开启' : '关闭'}；不立即执行或重放旧触发。`);
          section.dataset.hookEditing = 'false'; paintPush(result, catalogue);
          try { await refresh(); } catch (error) { if (ownsPage()) show(`推送设置已保存，但刷新失败：${error.message}；不要重复提交。`, 'error'); }
        } catch (error) { if (ownsPage()) { uncertain = true; show(`${error.message}；请刷新核对挂载，勿重复提交未确认操作。`, 'error'); } }
        finally { pending.delete(pushKey); section.dataset.hookEditing = 'false'; controlHost.sync(); pushControlHost?.sync(); }
      }, 'hook-button', { agent: !mount.enabled && callsAgent(mount), help: !mount.enabled && callsAgent(mount) ? agentHelp('开启 main 的未来推送挂载及已配置的 Agent 动作；不立即执行。') : '只修改 main 推送挂载的未来触发，不立即执行、撤回或重放旧推送。' });
      controlHost = guardedControl(control, () => pending.has(pushKey) ? '正在确认或保存。' : uncertain ? '请只读刷新核对已提交的设置，不要重复提交。'
        : mount.editable !== true || mount.locked ? mount.reason || '当前推送挂载不可编辑。' : !ownsPage() ? '已离开此 Worker。' : null);
      pushControlHost = controlHost;
      const clicked = control.onclick; control.onclick = async () => { await clicked(); controlHost.sync(); pushControlHost?.sync(); };
      pushHost.append(controlHost);
      pushFeature.advanced.replaceChildren(el('summary', '高级设置与执行记录'), mountCard(task, mount, current, refresh, ownsPage,
        { catalogue, scope: '仅 main Worker', setEditing(value) { section.dataset.hookEditing = String(value); }, busy: () => pending.has(pushKey) || section.dataset.hookEditing === 'true' || section.dataset.completionEditing === 'true' || section.dataset.convergenceEditing === 'true' }));
    } else pushHost.append(el('p', featureState.pushIdentity ? '推送挂载已删除或不可用；不会自动重装。' : '推送挂载身份尚未读取，不推断启用状态。', 'hint'));
    pushHost.append(button('读取推送设置', () => readPush(), 'ghost hook-button'));
  }
  paintPush();
  for (const nodes of featureNodes.values()) {
    nodes.body.append(nodes.principle);
    if (nodes.advanced.children.length > 1) nodes.body.append(nodes.advanced);
    featureList.append(nodes.section);
  }
  // Push settings may acquire an advanced editor only after an explicit identity read.
  if (pushMain && !pushFeature.advanced.parentNode) pushFeature.body.append(pushFeature.advanced);
  section.append(row, featureList);
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

/** Retired compatibility entry; no definition/template editor is reachable from Web. */
export async function openHookTools() {
  const { openRetiredTools } = await import('./retired-pages.js');
  return openRetiredTools();
}

