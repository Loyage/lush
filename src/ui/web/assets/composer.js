import { $, button, el } from './dom.js';
import { paintDisclosure } from './view-controls.js';
import { attachComposerViewport } from './composer-viewport.js';
import { attachComposerResize } from './composer-resize.js';
import { workerKind } from './worker-kind.js';
import { waitingFirstInput } from './worker-create.js';
import { action, api } from './api.js';
import { elevationChoice, confirmProjectElevation, projectElevationDefinition, projectElevationReceipts, pendingProjectElevation, syncProjectElevationSecrets } from './administrator-project-input.js';
import { taskTitle, isHistoricalDelivery } from './format.js';
import { iterationBlocker } from './render-iteration.js';
import { show } from './messages.js';
import { detail, refresh } from './navigate.js';
import { ui } from './state.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { agentHelp } from './help.js';
import { draftLabel } from './draft-label.js';
import { confirmDialog, closeDialog, formDialog } from './dialog.js';
import { createProfileForm } from './agent-profile-form.js';
import { normalizeConfigMode } from './agent-config-mode.js';
import { workerLabel } from './worker-label.js';
import { appendInputBlocker, valetAppendBlocker, inputQueueText, inputWaitReason } from './worker-input.js';
import { emissionAcknowledgement, emissionRequestId } from './emission-form.js';
import { initComposerWorkspace, currentEdit, selectComposerMode, paintComposerWorkspace, finishComposerEdit, collapseComposer, rememberComposer, navigateComposerDraft } from './composer-workspace.js';

// 本条指令可选的运行设置：只打开设置，不调用 Agent；派生 Worker 由后端自动继承。
export const RUN_SETTINGS_HELP = '打开本条指令的运行设置：先选由 Lush 掌握配置，还是交给执行机器上用户自己的 Pi 默认配置。只打开设置，不调用 Agent；派生 Worker 自动继承本次选择，不逐个确认。';

/** 运行设置按钮文案：未选择覆盖时明确显示沿用项目默认。 */
export function runSettingsLabel() {
  if (ui.composerManagement) return `管理运行设置：${ui.composerManagementProfile ? '本条已选择' : '管理默认'}`;
  if (!ui.composerProfile) return '运行设置：项目默认';
  return `运行设置：${normalizeConfigMode(ui.composerProfile.config_mode) === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}`;
}

// 动态插入的按钮节点：DOM 测试的 stub 只能按 id 查静态元素，所以这里保留引用并统一经它重画。
let runSettingsButton = null, managementResultButton = null, textEditor = null, disposeViewport = null, disposeResize = null;
let elevationControl = null, elevationReceipts = null, elevationReceiptKey = null;
function managementDefinition(instruction, client_request_id) {
  const id = ui.composerAppendTarget?.id;
  return projectElevationDefinition({ kind: id != null ? 'append' : 'submit', instruction, client_request_id,
    ...(id != null ? { id } : ui.composerManagementProfile ? { profile: ui.composerManagementProfile } : {}) });
}
function managementPending() {
  return pendingProjectElevation(ui.composerAppendTarget ? 'append' : 'submit', ui.composerAppendTarget?.id);
}
function paintManagementReceipts() {
  if (!ui.composerManagement) { if (elevationReceipts) elevationReceipts.root.hidden = true; return; }
  const identity = ui.composerIdentity, id = ui.composerAppendTarget?.id, edit = currentEdit();
  const revision = ui.composerEditRevision, references = ui.composerReferenceRevision;
  const receiptKey = `${id != null ? `append:${id}` : 'submit'}:${revision}:${references}`;
  if (elevationReceiptKey !== receiptKey) {
    elevationReceipts?.root.remove(); elevationReceiptKey = receiptKey;
    elevationReceipts = projectElevationReceipts({ kind: id != null ? 'append' : 'submit', id,
      current: () => ui.composerIdentity === identity && ui.composerManagement && ui.composerAppendTarget?.id === id
        && currentEdit() === edit && ui.composerEditRevision === revision && ui.composerReferenceRevision === references,
      resolved: receipt => {
        ui.composerManagementResult = receipt.task; ui.composerElevated = false; elevationControl.reset();
        try {
          if (JSON.stringify(managementDefinition($('input').value, receipt.definition.client_request_id)) === JSON.stringify(projectElevationDefinition(receipt.definition))) {
            $('input').value = ''; textEditor?.reset(); finishComposerEdit({ consume: true }); ui.composerManagementProfile = null; rememberComposer();
          }
        } catch { /* A newer or empty edit is not the proved original; preserve it. */ }
        show(`原提权提交已确认存在，实际状态：${receipt.task.management?.state || receipt.task.status || '未知'}；不代表执行成功，请核对详情，不重发。`);
        syncComposer();
      } });
    $('input-form').append(elevationReceipts.root);
  }
  elevationReceipts.refresh();
}

export function paintRunSettings() {
  syncProjectElevationSecrets();
  if (!runSettingsButton) return;
  runSettingsButton.textContent = runSettingsLabel();
  runSettingsButton.setAttribute('data-help', ui.composerManagement ? '设置独立 Valet 的模型来源与思考深度；不加载开发 Prompt、环境变量或扩展，只打开设置，不调用 Agent。' : RUN_SETTINGS_HELP);
  runSettingsButton.hidden = Boolean(ui.composerAppendTarget);
}

/**
 * 打开「本条指令的运行设置」弹窗：完整 Profile（Lush）或 Pi 默认模式，确认后只存在本次会话里，
 * 随下一次 input.emit 一起发送；取消或「恢复项目默认」不改变已有输入。
 */
export async function openComposerRunSettings() {
  const view = ui.view, editing = currentEdit(), managementMode = Boolean(ui.composerManagement);
  const ownsPage = () => ui.view === view && currentEdit() === editing && Boolean(ui.composerManagement) === managementMode;
  if (!ownsPage()) return;
  let settings = ui.lastSnapshot?.status?.agent_config;
  if (!settings) {
    try { settings = await api('/api/agent/config'); }
    catch (error) { show(`无法读取项目 Agent 配置：${error.message}`, 'error'); return; }
  }
  if (!ownsPage() || !settings) return;
  if (ui.composerManagement) {
    const { createManagementProfileForm } = await import('./management-profile-form.js');
    if (!ownsPage()) return;
    const form = createManagementProfileForm(settings, { ownsPage });
    await form.ready;
    if (!ownsPage()) return;
    const confirmed = await formDialog({ title: '管理指令的运行设置', content: form.node,
      confirmLabel: '使用这份管理设置', confirmHelp: '只选择管理调用的模型来源，不加载开发 Prompt、环境变量或扩展。',
      onConfirm: () => { const error = form.validate(); if (error) { show(error, 'error'); return false; } return ownsPage(); } });
    if (!confirmed || !ownsPage()) return;
    ui.composerManagementProfile = form.collect(); paintRunSettings(); return;
  }
  const role = 'agent';
  const base = { ...(settings.resolved?.[role] || settings.default || {}) };
  const initial = ui.composerProfile ? { ...ui.composerProfile } : { ...base, config_mode: normalizeConfigMode(base.config_mode) };
  const form = createProfileForm({ profile: initial, settings, role, ownsPage });
  const content = el('div', undefined, 'retry-profile-form-wrap');
  content.append(form.node, el('p', '确认后，本条指令创建 Worker 时会带上这份运行设置；派生 Worker 自动继承，不逐个弹窗。', 'retry-scope-note'));
  let requestedDefault = false;
  const useDefault = button('恢复项目默认（本条不覆盖）', () => { requestedDefault = true; closeDialog(); }, 'ghost',
    { help: '本条指令改回沿用项目默认运行配置；不修改输入内容，也不调用 Agent' });
  content.append(useDefault);
  await form.ready;
  if (!ownsPage()) return;
  for (;;) {
    requestedDefault = false;
    const confirmed = await formDialog({
      title: '工作指令的运行设置', message: '默认使用 Lush 托管配置；也可以选择执行机器上用户自己的 Pi 默认配置。',
      content, confirmLabel: '使用这份设置', cancelLabel: '取消', agent: false,
      confirmHelp: '把这份运行设置固定给将要创建的那条指令；只保存设置，不调用 Agent、不创建 Worker。',
    });
    if (requestedDefault && ownsPage()) {
      ui.composerProfile = null; paintRunSettings();
      show('本条指令将沿用项目默认运行配置。'); return;
    }
    if (!confirmed || !ownsPage()) return;
    const error = form.validate();
    if (error) { show(error, 'error'); continue; }
    break;
  }
  const profile = form.collect();
  const builtIn = form.builtInPrompt;
  const entered = form.defaultPromptValue();
  const nextDefault = entered === builtIn.trim() ? '' : entered;
  if (form.mode() !== 'pi' && nextDefault && nextDefault !== (initial.default_prompt || '')) {
    const accepted = await confirmDialog({ title: '用自定义 Prompt 创建指令？',
      message: '自定义内容会替换 Lush 内置 Worker 规则，只对这一条指令及其派生 Worker 生效。',
      detail: '可能影响：Worker API 使用、权限边界、子 Worker 协作、工作区安全和交付流程。',
      confirmLabel: '仍然使用', cancelLabel: '取消', danger: true, agent: false,
      confirmHelp: '把这份自定义 Prompt 固定给将要创建的指令。' });
    if (!accepted || !ownsPage()) return;
  }
  ui.composerProfile = profile; paintRunSettings();
  show(`本条指令将使用${normalizeConfigMode(profile.config_mode) === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}运行设置；创建 Worker 时生效。`);
}


// Historical panel helpers remain for legacy readers; new drafts live in #drafts.
export function paintDraftPanel() {
  const open = Boolean(ui.draftPanelOpen);
  $('draft-panel')?.classList.toggle('open', open);
  $('draft-toggle')?.setAttribute('aria-expanded', String(open));
}
export function toggleDraftPanel(force) {
  ui.draftPanelOpen = force === undefined ? !ui.draftPanelOpen : Boolean(force);
  paintDraftPanel();
}
// Legacy pure projection; the active composer uses the complete /api/input-parents read model.
export function parentTasks(tasks = []) {
  return tasks.filter(task => task.execution_retired !== true && ['main', 'owner', 'order'].includes(workerKind(task)) && task.branch
    && ['queued', 'running', 'waiting', 'awaiting', 'awaiting_acceptance', 'paused'].includes(task.status)
    && !task.archived && !task.branch_archive?.archived && !task.branch_info?.archived && !task.freeze
    && !isHistoricalDelivery(task) && task.reservation?.status !== 'requested').sort((a, b) => a.id - b.id);
}
function creationTarget(branch, task = null) {
  const selected = task || ui.composerParents?.find(item => item.branch === branch);
  const freeze = selected?.freeze || selected?.branch_archive?.freeze
    || (ui.lastSnapshot?.status?.branch_freeze || []).find(item => item.branch === branch) || null;
  // A frozen root remains a valid identity for a deferred creation; missing/archived roots do not.
  const blocker = selected?.execution_retired === true ? '远端执行已退役，仅保留只读历史。' : task ? iterationBlocker(task) : null;
  return { branch, task: selected || task, freeze, reason: blocker && !/冻结/.test(blocker) ? blocker : null };
}
/** New work is the default on every page; only an explicit action selects an inbox. */
function destination() {
  if (!ui.composerAppendTarget) return ui.composerManagement ? {} : creationTarget($('input-parent')?.value.trim() || 'main');
  const { id } = ui.composerAppendTarget;
  // Page detail is only a freshness hint, never the owner of the pinned editor target.
  const task = ui.composerTask?.id === id ? ui.composerTask : ui.composerAppendTarget.task;
  if (task) ui.composerAppendTarget.task = task;
  if (!task) return { id, reason: ui.composerAppendTarget.error || ui.composerError || '正在读取 Worker；加载成功后才能输入。' };
  if (ui.composerManagement) return { id, task, reason: currentEdit()?.request?.uncertain
    ? '追加结果未确认；请刷新管家详情核对结果，再显式选择「追加输入」决定是否继续。原文保留，不自动重发。' : valetAppendBlocker(task) };
  return { id, task, reason: appendInputBlocker(task), wait: inputWaitReason(task), queueText: inputQueueText(task) };
}
function selectedParentLabel() {
  const select = $('input-parent');
  if (!select?.value) return null;
  const option = [...select.children].find(node => node.value === select.value);
  return option?.dataset.label ?? option?.textContent ?? select.value;
}
/** Select an explicitly chosen detail/tree Worker without sending or discarding a draft. */
export function appendToWorker(task) {
  const inDetail = ui.view?.id === 'task' && ui.selected === task.id;
  const inGraph = ui.view?.id === 'task-graph' && ui.taskGraphIds?.has(task.id);
  if (!inDetail && !inGraph) return;
  selectComposerMode('append', task);
}
export function resetComposerMode() {
  selectComposerMode('order');
}
export function paintComposerDetails() {
  const open = Boolean(ui.composerExpanded), followup = Boolean(ui.composerAppendTarget);
  $('input-form').dataset.expanded = String(open);
  if ($('composer-details')) $('composer-details').hidden = !open || followup;
  if ($('composer-shortcuts')) $('composer-shortcuts').hidden = !open || followup;
  if ($('composer-editor-tools')) $('composer-editor-tools').hidden = !open;
  if ($('composer-management-settings')) $('composer-management-settings').hidden = !open || !ui.composerManagement;
  const toggle = $('composer-expand');
  if (!toggle) return;
  const parent = followup ? null : selectedParentLabel();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('data-help', open ? '收起：只留输入与操作按钮。' : ui.composerManagement
    ? '展开：显示正文的撤销与重做按钮、以管理员身份运行选项及适用的管理运行设置；不提交或改变本条权限。' : followup
    ? '展开：显示正文的撤销与重做按钮、草稿、历史输入；不改变追加目标。'
    : `展开：显示正文的撤销与重做按钮、草稿、历史输入、运行设置，可以选择父 Worker，并查看键盘快捷键${parent ? `（当前父 Worker：${parent}）` : ''}。`);
  paintDisclosure(toggle, open, { expand: '高级设置', collapse: '收起高级' });
}
export function renderParentOptions() {
  const select = $('input-parent');
  if (!select) return;
  const tasks = ui.composerParents ?? [];
  const signature = JSON.stringify(tasks);
  if (select.dataset.signature === signature) { paintComposerDetails(); return; }
  select.dataset.signature = signature;
  const previous = select.value;
  const placeholder = el('option', 'main（默认父 Worker）'); placeholder.value = '';
  const options = tasks.map(task => {
    const option = el('option', `${workerLabel(task)} ${taskTitle(task)} · ${task.branch}${task.freeze ? ' · 冻结，可提交后等待' : ''}`);
    option.value = task.branch; option.dataset.label = `${workerLabel(task)} ${taskTitle(task)}`;
    return option;
  });
  if (previous && !tasks.some(task => task.branch === previous)) {
    const missing = el('option', `${previous}（父 Worker 已不可选，请重选）`); missing.value = previous; options.push(missing);
  }
  select.replaceChildren(placeholder, ...options); select.value = previous || '';
  paintComposerDetails();
}
export function loadComposerParents() {
  const identity = ui.composerIdentity;
  if (!identity) return Promise.resolve();
  if (identity.parentsPending) return identity.parentsPending;
  const current = () => ui.composerIdentity === identity;
  identity.parentsPending = (async () => {
    try {
      const data = await api('/api/input-parents');
      if (!current()) return;
      if (!Array.isArray(data.items)) throw new Error('父 Worker 列表格式不兼容');
      ui.composerParents = data.items; syncComposer();
    } catch (error) { if (current()) show(`父 Worker 列表读取失败：${error.message}`, 'error'); }
    finally { identity.parentsPending = null; }
  })();
  return identity.parentsPending;
}
export function toggleComposerDetails(force) {
  ui.composerExpanded = force === undefined ? !ui.composerExpanded : Boolean(force);
  paintComposerDetails();
  if (ui.composerExpanded) return loadComposerParents();
}
export function syncComposer() {
  renderParentOptions();
  const management = Boolean(ui.composerManagement);
  if (!management) ui.composerElevated = false;
  if (!ui.composerElevated) elevationControl?.reset();
  syncProjectElevationSecrets();
  if (elevationControl) elevationControl.root.hidden = !management;
  paintManagementReceipts();
  const target = destination(), followup = target.id != null, firstInput = !management && followup && waitingFirstInput(target.task);
  const input = $('input');
  const shortcuts = 'Enter 换行 · Ctrl/⌘+S 保存草稿 · Ctrl/⌘+Enter';
  const label = followup ? `Worker ${workerLabel(target.task || target.id)}` : target.task
    ? `Worker ${workerLabel(target.task)} · ${target.branch}` : selectedParentLabel() || 'main';
  $('input-form').dataset.mode = management ? 'management' : followup ? 'append' : 'create';
  $('input-form').dataset.blocked = String(Boolean(target.reason));
  // Admission facts must remain readable without opening shortcuts/settings, including over a keyboard.
  const targetStatus = target.reason || [target.queueText || target.wait || (target.freeze ? target.freeze.reason || '父分支冻结，等待安全边界' : ''),
    firstInput ? '等待首条输入 · 提交才授权 Agent 执行' : followup && target.task?.status === 'paused' ? '暂停中，需开始 / 继续后处理' : ''].filter(Boolean).join(' · ');
  $('composer-target-status').hidden = !targetStatus;
  const modeText = {
    'composer-target-status': targetStatus,
    'composer-mode-icon': management ? '⚙' : followup ? '↳' : '＋',
    'composer-mode-title': management ? followup ? '追加管理输入' : '管理 Lush' : firstInput ? '输入工作指令' : followup ? '追加输入' : '新建工作',
    'composer-mode-target': followup ? `去向：${management ? `管家 ${workerLabel(target.task || target.id)}` : label}${target.task ? ` · ${taskTitle(target.task)}` : ''}` : management ? '去向：管家 · 当前项目' : `去向：新 Worker · 基于 ${label}${target.task ? ` · ${taskTitle(target.task)}` : ''}`,
    'composer-mode-behavior': target.reason || (management
      ? ui.composerElevated ? '仅本条当前项目管理员 · 重新验证 Web 登录密码 · 执行中不逐项询问 · 下一条默认普通'
        : followup ? '向同一管家授权新一轮，不重放旧操作 · 沿用模型来源 · Enter 换行 · Ctrl/⌘+Enter 提交追加 · 其他管家占位时拒绝，不排队保存'
          : '由普通管家处理 · 接口按普通权限执行 · Ctrl/⌘+Enter 提交管理指令 · 暂不支持暂存'
      : firstInput ? `不创建新 Worker · ${shortcuts} 提交首条工作指令并授权 Agent 执行 · 生成真实原始输入 O · 暂存不执行`
      : followup ? `不创建新 Worker · ${shortcuts} 提交追加 · 安全点交付，导航不改变目标${target.queueText ? ` · ${target.queueText}` : target.wait ? ` · ${target.wait}` : ''}${target.task.status === 'paused' ? ' · 暂停中，需开始 / 继续后处理' : ''}`
        : `${shortcuts} 提交指令 · 条件满足且安全准入后创建新 Worker${target.freeze ? ` · ${target.freeze.reason || '父分支冻结，等待安全边界'}` : ''}`),
  };
  // Keep mode/destination visible while typing, without repeating live announcements on every keystroke.
  for (const [id, text] of Object.entries(modeText)) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }
  input.placeholder = management ? '描述你希望管家查询、调整或安排的事项…'
    : firstInput ? '描述你希望此 Worker 完成的工作…'
    : followup ? '补充要求、提供反馈，或说明需要调整的地方…'
      : '描述你希望新 Worker 完成的工作…';
  input.setAttribute('aria-label', management ? '管理指令正文' : followup && !firstInput ? '追加指令正文' : '工作指令正文');
  input.disabled = Boolean(target.reason);
  const disabled = Boolean(ui.composerSubmitting || target.reason) || !input.value.trim()
    || management && managementPending().length > 0;
  $('draft-commit').disabled = disabled;
  $('draft-commit').classList.add('agent-call');
  const saved = currentEdit()?.saved, conditions = saved || currentEdit()?.localOptions, conditional = Boolean(conditions?.conditions?.length || conditions?.exclusive);
  $('draft-commit').textContent = conditional ? '按条件提交' : management ? ui.composerElevated ? '核对本条提权指令' : followup ? '提交追加' : '提交管理指令' : firstInput ? '提交工作指令' : followup ? '提交追加' : '提交新工作';
  $('draft-commit').classList.toggle('hook-button', Boolean(!management && target.freeze));
  const description = target.reason || (management
    ? ui.composerElevated ? `核对完整指令、${followup ? '原管家目标' : '创建管家'}并重新验证 Web 登录密码后，仅本条以当前项目管理员权限执行；下一条默认普通权限。`
      : followup ? `向同一管家 ${workerLabel(target.task || target.id)} 提交追加管理指令，明确授权新一轮；保留原始指令和历史，不重放旧操作。沿用模型来源；项目已有管家占位时拒绝，不会排队保存。`
        : '提交普通管理指令，创建并安排管家（Valet）；受控接口按普通管家权限执行，不因上条提权自动升级。'
    : firstInput ? `向 ${label} 提交首条工作指令，创建真实 Input 并授权 Agent 执行；无需另点开始，不创建新 Worker。`
    : followup ? `提交追加指令给 ${label}，可靠保存后等待安全准入；不代表 Agent 已收到，冻结不打断交付或源侧修复，暂停中仍需显式继续。`
      : `提交工作指令，基于 ${label} 创建新 Worker；提交是执行授权，条件满足且安全准入后才创建并开始，不保证立即出现在工作树。`);
  const help = agentHelp(conditional ? `保存此草稿并授权按原条件提交；等待全部条件与安全准入，不保证立即执行。${description}` : description);
  $('draft-commit').setAttribute('data-help', help);
  $('input-send-help')?.setAttribute('data-help', help);
  textEditor?.sync();
  if ($('input-buffer')) { $('input-buffer').disabled = disabled; $('input-buffer').hidden = management; $('input-buffer').textContent = saved ? '保存草稿' : '暂存为草稿'; }
  if ($('input-buffer-help')) {
    $('input-buffer-help').hidden = management;
    const bufferHelp = firstInput ? `保存首条工作指令正文和目标 ${label} 为草稿，尚未授权执行，不产生 Input、不调用 Agent；稍后提交才绑定真实原始输入。` : followup ? `保存追加指令正文和目标 ${label} 为草稿，尚未授权执行，不创建 Worker、不投递消息、不调用 Agent；稍后可在草稿页编辑条件并提交。` : '保存工作指令正文、引用和父 Worker 为草稿，尚未授权执行，不创建 Worker 或工作区、不调用 Agent；稍后可在草稿页设置条件并提交。';
    $('input-buffer-help').setAttribute('data-help', bufferHelp); $('input-buffer')?.setAttribute('data-help', bufferHelp);
  }
  if ($('composer-management')) $('composer-management').textContent = management ? '回到新建工作' : '管理 Lush';
  // More also exposes text editing in inbox mode, without showing parent selection.
  $('composer-expand').hidden = false;
  $('composer-reset').hidden = !followup && !management;
  if (management) { $('composer-details').hidden = true; $('composer-shortcuts').hidden = true; }
  if (managementResultButton) managementResultButton.hidden = !management || !Number.isSafeInteger(ui.composerManagementResult?.id);
  paintRunSettings(); paintComposerWorkspace();
}

/** Reads are not part of submission: release the composer before starting them. */
async function updateAfterSubmit({ identity, submission, view, appendTarget, detailId, editRevision, referenceRevision, canNavigate }) {
  const current = () => ui.composerIdentity === identity && identity.submission === submission;
  const ownsNavigation = () => canNavigate && current() && ui.view === view && ui.composerAppendTarget === appendTarget
    && ui.composerEditRevision === editRevision && ui.composerReferenceRevision === referenceRevision
    && !$('input').value.trim() && !composerReferences().length;
  let updateView = view;
  const taskBefore = ui.composerTask, renderedBefore = ui.detailRenderedAt;
  try {
    await refresh();
    if (!current()) return;
    // refresh currently reports network errors itself rather than rejecting.
    if (ui.offline) {
      if (ui.view === view) show('提交已成功，但页面更新失败；请稍后刷新，不要重复提交。', 'error');
      return;
    }
    if (detailId == null || !ownsNavigation()) return;
    // A refresh of the current Worker may already have fetched its detail.
    if (ui.detailTask === detailId && (ui.composerTask !== taskBefore || ui.detailRenderedAt !== renderedBefore)) return;
    const pending = detail(detailId);
    updateView = ui.view;
    await pending;
  } catch (error) {
    if (current() && ui.view === updateView) show(`提交已成功，但页面更新失败：${error.message}；请稍后刷新，不要重复提交。`, 'error');
  }
}

async function submitElevatedManagement() {
  const input = $('input'), identity = ui.composerIdentity, view = ui.view, edit = currentEdit();
  const value = input.value, revision = ui.composerEditRevision, profile = ui.composerManagementProfile;
  const profileText = JSON.stringify(profile), referenceRevision = ui.composerReferenceRevision, appendTarget = ui.composerAppendTarget;
  if (managementPending().length) { elevationReceipts?.refresh(); show('原提权提交未知，请先只读核对收据，不重复发送。', 'error'); return; }
  const current = () => ui.composerIdentity === identity && ui.view === view && currentEdit() === edit && ui.composerManagement && ui.composerElevated
    && ui.composerAppendTarget === appendTarget && ui.composerEditRevision === revision && input.value === value && ui.composerReferenceRevision === referenceRevision
    && JSON.stringify(ui.composerManagementProfile) === profileText;
  let resetMode = false;
  ui.composerSubmitting = true; syncComposer();
  try {
    if (composerReferences().length) { show('管家提权输入不支持引用附件；请先移除引用，原稿保留。', 'error'); return; }
    const definition = managementDefinition(value, emissionRequestId());
    const result = await confirmProjectElevation(definition, { current });
    if (!result) return;
    const unchanged = current();
    if (ui.composerIdentity !== identity) return;
    ui.composerElevated = false; elevationControl?.reset(); ui.composerManagementResult = result.task;
    if (unchanged) { input.value = ''; textEditor?.reset(); finishComposerEdit({ consume: true }); ui.composerManagementProfile = null; resetMode = Boolean(appendTarget); }
    rememberComposer(); show(`本条项目管理员指令已提交 ${workerLabel(result.task)}；下一条默认普通权限，提交不代表执行完成。`);
    try { await refresh(); if (ui.offline) show('提权指令已提交，但页面刷新失败；请只读刷新，不要重发。', 'error'); }
    catch { show('提权指令已提交，但页面刷新失败；请只读刷新，不要重发。', 'error'); }
  } catch { if (ui.composerIdentity === identity) show('提权输入未完成；原稿保留，请核对确认状态，不自动重试。', 'error'); }
  finally {
    if (ui.composerIdentity === identity) {
      ui.composerSubmitting = false;
      if (resetMode && currentEdit() === edit && ui.composerEditRevision === revision && !input.value && !composerReferences().length)
        selectComposerMode('order', null, 'main', { open: Boolean(ui.composerWorkspace?.open) });
      syncComposer();
    }
  }
}

/** One flight across buffering, button submission and all keyboard shortcuts. */
async function submitInput(mode) {
  const input = $('input'), value = input.value, content = value.trim();
  if (ui.composerSubmitting || !content) return;
  const identity = ui.composerIdentity, editRevision = ui.composerEditRevision, view = ui.view;
  const editing = currentEdit(), saved = editing?.saved;
  const appendTarget = ui.composerAppendTarget;
  const referenceRevision = ui.composerReferenceRevision;
  const management = Boolean(ui.composerManagement);
  const creationProfile = management ? ui.composerManagementProfile : ui.composerProfile;
  const references = composerReferences(), signature = JSON.stringify(references);
  const target = destination(), branch = target.branch;
  if (target.reason) { show(target.reason, 'error'); return; }
  if (management && mode === 'buffer') return;
  if (management && managementPending().length) { elevationReceipts?.refresh(); return; }
  if (management && ui.composerElevated) return submitElevatedManagement();
  const request = editing?.request || identity;
  const localOptions = editing?.localOptions || {};
  const requestDefinition = JSON.stringify([content, references, branch, target.id, management, creationProfile, localOptions]);
  if (!saved && request.requestDefinition !== requestDefinition) { request.requestDefinition = requestDefinition; request.requestId = emissionRequestId(); }
  const submission = {}; identity.submission = submission;
  let update = null, retainedOptions = null;
  ui.composerSubmitting = true; syncComposer();
  try {
    if ((target.id != null || management) && references.length) throw new Error(`${management ? '管理指令' : '追加指令'}暂不支持引用附件；原文与引用已保留，请先移除引用或回到新建工作模式。`);
    if (branch && branch !== 'main' && !target.task && !ui.composerParents?.some(task => task.branch === branch)) throw new Error('所选父 Worker 已不可用，请展开输入区重新选择。');
    const params = { content, references, ...localOptions, ...(branch ? { branch } : {}),
      ...(target.id != null ? { mode: 'append', target_id: target.id } : {}) };
    let result;
    if (saved) {
      const { draftOptions, updateDraft, emitDraft } = await import('./draft-editor.js');
      if (ui.composerIdentity !== identity) return;
      // The recovered identity owns its exact version, conditions and destination. Never draft.add it again.
      const parent = ui.composerParents?.find(parent => parent.id === saved.parent_id && parent.branch === saved.branch);
      if (target.id == null && !parent) throw new Error('草稿原父 Worker 已不可用，请到草稿页显式重选；本地内容保留，不会改投 main。');
      retainedOptions = draftOptions(saved);
      if (saved.content !== value || JSON.stringify(saved.references) !== signature) {
        editing.saved = await updateDraft(saved, { content: value, references, ...retainedOptions });
      }
      if (ui.composerIdentity !== identity) return;
      result = mode === 'buffer' ? editing.saved : await emitDraft(editing.saved, target.id == null ? creationProfile : null, editing.request);
    } else result = management
      ? target.id != null
        ? await action('worker.message', { id: target.id, body: value }, { refresh: false })
        : await action('management.submit', { instruction: content, client_request_id: request.requestId, ...(creationProfile ? { profile: creationProfile } : {}) }, { refresh: false })
      : await action(mode === 'buffer' ? 'draft.add' : 'input.emit', mode === 'buffer' ? params
        : { ...params, client_request_id: request.requestId, ...(creationProfile && target.id == null ? { profile: creationProfile } : {}) }, { refresh: false });
    if (ui.composerIdentity !== identity) return;
    if (!management && mode === 'buffer' && (!Number.isSafeInteger(result.id) || result.id <= 0))
      throw new Error('暂存响应缺少可靠草稿身份；本地内容保留，请核验草稿列表，不会自动重试。');
    if (management && (target.id != null ? result.id !== target.id || result.role !== 'manager' || result.task_kind !== 'management'
      : result.management !== true || !Number.isSafeInteger(result.task?.id)))
      throw new Error('管理响应缺少可靠记录身份；请核对服务版本与管理历史，不会自动重试。');
    if (!management && mode !== 'buffer' && (result.emitted !== true || !Number.isSafeInteger(result.draft_id)))
      throw new Error('提交响应缺少可靠挂载收据；请核对服务版本与草稿授权收据，原文保留，不会自动重试。');
    // The composer survives page navigation: consume unchanged submitted content even after a page switch.
    // Still protect edits (including edit-and-undo) and explicit inbox mode changes; view guards below only own navigation.
    const untouched = Boolean(ui.composerManagement) === management && ui.composerAppendTarget === appendTarget && ui.composerEditRevision === editRevision && input.value === value
      && (management ? ui.composerManagementProfile : ui.composerProfile) === creationProfile
      && ui.composerReferenceRevision === referenceRevision && JSON.stringify(composerReferences()) === signature;
    if (untouched) {
      input.value = ''; textEditor?.reset(); setComposerReferences([]); request.requestDefinition = null;
      finishComposerEdit({ consume: true });
    } else if (saved && mode !== 'buffer') {
      // New typing while an authorization was in flight is a new local input, not an editable authorized draft.
      finishComposerEdit({ detached: true, options: retainedOptions });
    } else if (!saved && mode === 'buffer' && !untouched) {
      // Saving the earlier snapshot must not create a duplicate on the next save.
      if (result.kind === 'draft') finishComposerEdit({ saved: result });
    }
    if (management) {
      if (untouched && ui.composerManagementProfile === creationProfile) ui.composerManagementProfile = null;
      ui.composerManagementResult = target.id != null ? result : result.task || null;
      show(target.id != null ? `追加管理输入已提交 ${workerLabel(result)}，等待新一轮运行；旧操作不会重放。`
        : `管理指令已提交${result.task?.id ? ` ${workerLabel(result.task)}` : ''}，等待管家处理；未创建开发 Worker，记录可在「管家列表」查看，接口按最新权限执行。`);
    } else if (mode === 'buffer') {
      show(`已${saved ? '更新' : '暂存为'}${draftLabel(result)}，尚未提交；可在「草稿」继续编辑与设定条件，下次打开不自动加载，未创建 Worker、未调用 Agent。`);
      ui.draftsPage?.added?.();
    } else {
      if (untouched && target.id == null && ui.composerProfile === creationProfile) ui.composerProfile = null;
      paintRunSettings(); show(emissionAcknowledgement(result, target.id != null, waitingFirstInput(target.task)));
      ui.draftsPage?.added?.();
      ui.inputsPage?.added?.();
    }
    rememberComposer();
    update = { identity, submission, view, appendTarget: ui.composerAppendTarget, resetMode: mode !== 'buffer' && target.id != null && untouched,
      // The just-sent inbox may refresh its detail after returning to creation, never re-enter append.
      detailId: view?.id === 'task' ? target.id ?? null : null,
      editRevision: ui.composerEditRevision, referenceRevision: ui.composerReferenceRevision, canNavigate: untouched };
  } catch (error) {
    if (ui.composerIdentity === identity) {
      if (management && target.id != null) { request.uncertain = true; rememberComposer(); }
      show(management && target.id != null ? `追加未确认：${error.message}；原文已保留。请刷新详情核对结果，不自动重发。` : error.message, 'error');
    }
  }
  finally { if (ui.composerIdentity === identity) { ui.composerSubmitting = false; if (update?.resetMode) selectComposerMode('order', null, 'main', { open: Boolean(ui.composerWorkspace?.open) }); syncComposer(); } }
  if (update) void updateAfterSubmit(update);
}
export function buffer() { return submitInput('buffer'); }
/** Enter inserts a newline; Ctrl/Meta+S saves, Ctrl/Meta(+Shift)+Enter submits. */
export function initComposer() {
  textEditor?.dispose(); disposeViewport?.(); disposeResize?.(); textEditor = null;
  ui.composerIdentity = {}; ui.composerEditRevision = 0; ui.syncComposer = syncComposer;
  const identity = ui.composerIdentity, input = $('input'), editorTools = $('composer-editor-tools');
  editorTools.replaceChildren();
  ui.composerAppendTarget = null; ui.composerManagement = false; ui.composerElevated = false; ui.composerManagementProfile = null;
  // 每次装配（含 boot 重跑）都从项目默认开始，不让上一条指令的运行设置跨会话残留。
  ui.composerProfile = null;
  runSettingsButton = button(runSettingsLabel(), () => openComposerRunSettings(), 'ghost composer-run-settings', { help: RUN_SETTINGS_HELP });
  runSettingsButton.id = 'composer-run-settings'; runSettingsButton.dataset.composerRunSettings = '';
  const anchor = $('input-buffer-help');
  const host = anchor?.parentNode ?? $('composer-shell') ?? null;
  // 重复 boot 时先移除上次装的按钮，避免入口重复。
  host?.querySelector?.('.composer-run-settings')?.remove?.();
  if (anchor?.parentNode) anchor.parentNode.insertBefore(runSettingsButton, anchor);
  else host?.append(runSettingsButton);
  host?.querySelector?.('.composer-management')?.remove?.();
  host?.querySelector?.('.composer-management-result')?.remove?.();
  managementResultButton = button('查看最近管理记录', () => { if (Number.isSafeInteger(ui.composerManagementResult?.id)) return detail(ui.composerManagementResult.id); }, 'ghost composer-management-result');
  managementResultButton.hidden = true; host?.append(managementResultButton);
  $('input-form').querySelector?.('.project-elevation-receipts')?.remove?.();
  elevationReceiptKey = null; elevationReceipts = null;
  elevationControl = elevationChoice(checked => { ui.composerElevated = checked; syncComposer(); });
  $('composer-management-settings').replaceChildren(elevationControl.root);
  const sendHelp = agentHelp('提交工作指令并可靠保存执行授权，安全准入后创建并开始新 Worker；不保证立即创建。');
  $('draft-commit').setAttribute('data-help', sendHelp);
  $('draft-commit').setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter Control+Shift+Enter Meta+Shift+Enter');
  $('input-buffer')?.setAttribute('aria-keyshortcuts', 'Control+s Meta+s');
  $('input-send-help')?.setAttribute('data-help', sendHelp);
  initComposerWorkspace({ resetEditor: () => textEditor?.reset() });
  renderComposerReferences();
  $('composer-expand').onclick = () => toggleComposerDetails();
  $('composer-reset').onclick = resetComposerMode;
  if ($('input-buffer')) $('input-buffer').onclick = buffer;
  renderParentOptions();
  $('input-parent').onchange = () => selectComposerMode('order', null, $('input-parent').value || 'main');
  $('input-form').onsubmit = event => { event.preventDefault(); return submitInput('create'); };
  $('input').oninput = () => { ui.composerEditRevision++; syncComposer(); };
  let composing = false;
  $('input').oncompositionstart = () => { composing = true; };
  $('input').oncompositionend = () => { composing = false; };
  $('input').onkeydown = event => {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); collapseComposer(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === 's' && !event.altKey && !event.shiftKey && !ui.composerManagement) {
      event.preventDefault(); if (!event.repeat) return buffer(); return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const navigation = navigateComposerDraft(event.key === 'ArrowUp' ? 1 : -1);
      if (navigation) { event.preventDefault(); return navigation; }
    }
    if (event.key !== 'Enter' || event.altKey || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (event.repeat) return;
    return submitInput('emit');
  };
  // Load the shared editor outside the static startup closure. Initialization
  // still waits for its visible controls; stale boot generations cannot attach
  // them to a replaced composer. No page-global state is duplicated by the helper.
  const editorReady = import('./text-editor.js').then(({ attachTextEditor }) => {
    if (ui.composerIdentity !== identity || $('input') !== input) return;
    textEditor = attachTextEditor(input, { onChange: () => { ui.composerEditRevision++; syncComposer(); } });
    editorTools.replaceChildren(textEditor.controls); textEditor.sync();
  }).catch(error => {
    if (ui.composerIdentity === identity) show(`正文编辑工具加载失败，请刷新页面：${error.message}`, 'error');
  });
  disposeResize = attachComposerResize(input, $('composer-resize'));
  disposeViewport = attachComposerViewport(input, $('composer-shell'));
  syncComposer();
  return Promise.all([loadComposerParents(), editorReady]);
}
