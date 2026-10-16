import { $, button, el } from './dom.js';
import { attachComposerViewport, usesTouchEnter } from './composer-viewport.js';
import { workerKind } from './worker-kind.js';
import { action, api } from './api.js';
import { taskTitle, isHistoricalDelivery } from './format.js';
import { iterationBlocker } from './render-iteration.js';
import { show } from './messages.js';
import { detail, refresh } from './navigate.js';
import { ui } from './state.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { agentHelp } from './help.js';
import { confirmDialog, closeDialog, formDialog } from './dialog.js';
import { createProfileForm } from './agent-profile-form.js';
import { normalizeConfigMode } from './agent-config-mode.js';
import { workerLabel } from './worker-label.js';
import { appendInputBlocker, inputQueueText, inputWaitReason } from './worker-input.js';
import { emissionAcknowledgement, emissionRequestId } from './emission-form.js';

// 本条指令可选的运行设置：只打开设置，不调用 Agent；派生 Worker 由后端自动继承。
export const RUN_SETTINGS_HELP = '打开本条指令的运行设置：先选由 Lush 掌握配置，还是交给执行机器上用户自己的 Pi 默认配置。只打开设置，不调用 Agent；派生 Worker 自动继承本次选择，不逐个确认。';

/** 运行设置按钮文案：未选择覆盖时明确显示沿用项目默认。 */
export function runSettingsLabel() {
  if (ui.composerManagement) return `管理运行设置：${ui.composerManagementProfile ? '本条已选择' : '管理默认'}`;
  if (!ui.composerProfile) return '运行设置：项目默认';
  return `运行设置：${normalizeConfigMode(ui.composerProfile.config_mode) === 'pi' ? 'Pi 默认配置' : 'Lush 配置'}`;
}

// 动态插入的按钮节点：DOM 测试的 stub 只能按 id 查静态元素，所以这里保留引用并统一经它重画。
let runSettingsButton = null, managementResultButton = null, textEditor = null, disposeViewport = null, runnerChoice = null;

export function paintRunSettings() {
  if (!runSettingsButton) return;
  runSettingsButton.textContent = runSettingsLabel();
  runSettingsButton.setAttribute('data-help', ui.composerManagement ? '设置独立 Valet 的模型来源与思考深度；不加载开发 Prompt、环境变量或扩展，只打开设置，不调用 Agent。' : RUN_SETTINGS_HELP);
  runSettingsButton.hidden = $('input-form')?.dataset.mode === 'append';
}

/**
 * 打开「本条指令的运行设置」弹窗：完整 Profile（Lush）或 Pi 默认模式，确认后只存在本次会话里，
 * 随下一次 input.emit 一起发送；取消或「恢复项目默认」不改变已有输入。
 */
export async function openComposerRunSettings() {
  const view = ui.view, managementMode = Boolean(ui.composerManagement);
  const ownsPage = () => ui.view === view && Boolean(ui.composerManagement) === managementMode;
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
    if (!confirmed || ui.view !== view) return;
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


// Historical panel helpers remain for legacy readers; new drafts live in #inputs.
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
  return tasks.filter(task => ['main', 'owner', 'order'].includes(workerKind(task)) && task.branch
    && ['queued', 'running', 'waiting', 'awaiting', 'awaiting_acceptance', 'paused'].includes(task.status)
    && !task.archived && !task.branch_archive?.archived && !task.branch_info?.archived && !task.freeze
    && !isHistoricalDelivery(task) && task.reservation?.status !== 'requested').sort((a, b) => a.id - b.id);
}
function creationTarget(branch, task = null) {
  const selected = task || ui.composerParents?.find(item => item.branch === branch);
  const freeze = selected?.freeze || selected?.branch_archive?.freeze
    || (ui.lastSnapshot?.status?.branch_freeze || []).find(item => item.branch === branch) || null;
  // A frozen root remains a valid identity for a deferred creation; missing/archived roots do not.
  const blocker = task ? iterationBlocker(task) : null;
  return { branch, task, freeze, reason: blocker && !/冻结/.test(blocker) ? blocker : null };
}
/** New work is the default on every page; only an explicit action selects an inbox. */
function destination() {
  if (!ui.composerAppendTarget) return creationTarget($('input-parent')?.value.trim() || 'main');
  const { id } = ui.composerAppendTarget;
  const task = ui.composerTask?.id === id ? ui.composerTask : null;
  if (!task) return { id, reason: ui.composerError || '正在读取 Worker；加载成功后才能输入。' };
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
  ui.composerManagement = false;
  ui.composerTask = task;
  ui.composerAppendTarget = { id: task.id };
  syncComposer();
  $('input').focus();
}
export function resetComposerMode() {
  ui.composerManagement = false;
  ui.composerAppendTarget = null;
  syncComposer();
  $('input').focus();
}
export function paintComposerDetails() {
  const open = Boolean(ui.composerExpanded), followup = Boolean(ui.composerAppendTarget);
  $('input-form').dataset.expanded = String(open);
  if ($('composer-details')) $('composer-details').hidden = !open || followup;
  if ($('composer-shortcuts')) $('composer-shortcuts').hidden = !open || followup;
  if ($('composer-editor-tools')) $('composer-editor-tools').hidden = !open;
  const toggle = $('composer-expand');
  if (!toggle) return;
  const parent = followup ? null : selectedParentLabel();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('data-help', open ? '收起：只留输入与操作按钮。' : followup
    ? '展开：显示正文的撤销与重做按钮、历史输入；不改变追加目标。'
    : `展开：显示正文的撤销与重做按钮、历史输入、运行设置，可以选择父 Worker，并查看键盘快捷键${parent ? `（当前父 Worker：${parent}）` : ''}。`);
  toggle.textContent = open ? '⌃ 收起' : (parent ? `⌃ 更多 · 父 Worker：${parent}` : '⌃ 更多');
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
  const target = management ? {} : destination(), followup = target.id != null;
  const input = $('input');
  const touch = usesTouchEnter();
  const enter = touch ? '回车换行 · 按钮' : 'Enter';
  const label = followup ? `Worker ${workerLabel(target.task || target.id)}` : target.task
    ? `Worker ${workerLabel(target.task)} · ${target.branch}` : selectedParentLabel() || 'main';
  $('input-form').dataset.mode = management ? 'management' : followup ? 'append' : 'create';
  $('input-form').dataset.blocked = String(Boolean(target.reason));
  const modeText = {
    'composer-mode-icon': management ? '⚙' : followup ? '↳' : '＋',
    'composer-mode-title': management ? '管理 Lush' : followup ? '追加输入' : '新建工作',
    'composer-mode-target': management ? '去向：管家 · 当前项目' : followup ? `去向：${label}${target.task ? ` · ${taskTitle(target.task)}` : ''}` : `去向：新 Worker · 基于 ${label}`,
    'composer-mode-behavior': target.reason || (management
      ? '由管家处理，不直接创建开发 Worker · 危险操作先确认 · Ctrl/⌘+Enter 提交管理指令 · 暂不支持暂存'
      : followup ? `不创建新 Worker · ${enter} 暂存 · Ctrl/⌘+Enter 提交追加 · 安全点交付，确认后回到新建工作${target.queueText ? ` · ${target.queueText}` : target.wait ? ` · ${target.wait}` : ''}${target.task.status === 'paused' ? ' · 暂停中，需开始 / 继续后处理' : ''}`
        : `${enter} 暂存 · Ctrl/⌘+Enter 提交指令 · 条件满足且安全准入后创建新 Worker${target.freeze ? ` · ${target.freeze.reason || '父分支冻结，等待安全边界'}` : ''}`),
  };
  // Keep mode/destination visible while typing, without repeating live announcements on every keystroke.
  for (const [id, text] of Object.entries(modeText)) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }
  input.placeholder = management ? '描述你希望管家查询、调整或安排的事项…'
    : followup ? '补充要求、提供反馈，或说明需要调整的地方…'
      : '描述你希望新 Worker 完成的工作…';
  input.setAttribute('aria-label', management ? '管理指令正文' : followup ? '追加指令正文' : '工作指令正文');
  input.disabled = Boolean(target.reason);
  const disabled = Boolean(ui.composerSubmitting || target.reason) || !input.value.trim();
  $('draft-commit').disabled = disabled;
  $('draft-commit').classList.add('agent-call');
  $('draft-commit').textContent = management ? '提交管理指令' : followup ? '提交追加' : '提交指令';
  $('draft-commit').classList.toggle('hook-button', Boolean(!management && target.freeze));
  const description = target.reason || (management
    ? '提交管理指令，创建并安排独立管家（Valet），处理当前项目运行历史、草稿与 Hook 等管理事项；取消、回收、删除和敏感设置等危险操作须用户确认，不提供开发工具。'
    : followup ? `提交追加指令给 ${label}，可靠保存后等待安全准入；不代表 Agent 已收到，冻结不打断交付或源侧修复，暂停中仍需显式继续。`
      : `提交工作指令，基于 ${label} 创建新 Worker；提交是执行授权，条件满足且安全准入后才创建并开始，不保证立即出现在工作树。`);
  const help = agentHelp(description);
  $('draft-commit').setAttribute('data-help', help);
  $('input-send-help')?.setAttribute('data-help', help);
  textEditor?.sync();
  if ($('input-buffer')) { $('input-buffer').disabled = disabled; $('input-buffer').hidden = management; }
  if ($('input-buffer-help')) {
    $('input-buffer-help').hidden = management;
    const bufferHelp = followup ? `保存追加指令正文和目标 ${label} 为草稿，尚未授权执行，不创建 Worker、不投递消息、不调用 Agent；稍后可在历史输入编辑条件并提交。` : '保存工作指令正文、引用和父 Worker 为草稿，尚未授权执行，不创建 Worker 或工作区、不调用 Agent；稍后可在草稿页设置条件并提交。';
    $('input-buffer-help').setAttribute('data-help', bufferHelp); $('input-buffer')?.setAttribute('data-help', bufferHelp);
  }
  if ($('composer-management')) $('composer-management').textContent = management ? '回到新建工作' : '管理 Lush';
  // More also exposes text editing in inbox mode, without showing parent selection.
  $('composer-expand').hidden = false;
  $('composer-reset').hidden = !followup && !management;
  if (management) { $('composer-details').hidden = true; $('composer-shortcuts').hidden = true; }
  if (managementResultButton) managementResultButton.hidden = !management || !Number.isSafeInteger(ui.composerManagementResult?.id);
  runnerChoice?.setActive(!management && !followup);
  paintRunSettings();
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

/** One flight across buffering, button submission and all keyboard shortcuts. */
async function submitInput(mode) {
  const input = $('input'), value = input.value, content = value.trim();
  if (ui.composerSubmitting || !content) return;
  const identity = ui.composerIdentity, editRevision = ui.composerEditRevision, view = ui.view;
  const appendTarget = ui.composerAppendTarget;
  const referenceRevision = ui.composerReferenceRevision;
  const management = Boolean(ui.composerManagement);
  const creationProfile = management ? ui.composerManagementProfile : ui.composerProfile;
  const references = composerReferences(), signature = JSON.stringify(references);
  const target = management ? {} : destination(), branch = target.branch;
  if (target.reason) { show(target.reason, 'error'); return; }
  if (management && mode === 'buffer') return;
  const runnerNodeId = !management && target.id == null ? ui.composerRunnerNodeId : undefined;
  const requestDefinition = JSON.stringify([content, references, branch, target.id, management, creationProfile, runnerNodeId]);
  if (identity.requestDefinition !== requestDefinition) { identity.requestDefinition = requestDefinition; identity.requestId = emissionRequestId(); }
  const submission = {}; identity.submission = submission;
  let update = null;
  ui.composerSubmitting = true; syncComposer();
  try {
    if ((target.id != null || management) && references.length) throw new Error(`${management ? '管理指令' : '追加指令'}暂不支持引用附件；原文与引用已保留，请先移除引用或回到新建工作模式。`);
    if (branch && branch !== 'main' && !target.task && !ui.composerParents?.some(task => task.branch === branch)) throw new Error('所选父 Worker 已不可用，请展开输入区重新选择。');
    const params = { content, references, ...(branch ? { branch } : {}),
      ...(runnerNodeId === undefined ? {} : { runner_node_id: runnerNodeId }),
      ...(target.id != null ? { mode: 'append', target_id: target.id } : {}) };
    const result = management
      ? await action('management.submit', { instruction: content, client_request_id: identity.requestId, ...(creationProfile ? { profile: creationProfile } : {}) }, { refresh: false })
      : await action(mode === 'buffer' ? 'draft.add' : 'input.emit', mode === 'buffer' ? params
        : { ...params, client_request_id: identity.requestId, ...(creationProfile && target.id == null ? { profile: creationProfile } : {}) }, { refresh: false });
    if (ui.composerIdentity !== identity) return;
    if (management && (result.management !== true || !Number.isSafeInteger(result.task?.id)))
      throw new Error('管理响应缺少可靠记录身份；请核对服务版本与管理历史，不会自动重试。');
    if (!management && mode !== 'buffer' && (result.emitted !== true || !Number.isSafeInteger(result.draft_id)))
      throw new Error('提交响应缺少可靠挂载收据；请核对服务版本与历史输入，原文保留，不会自动重试。');
    // The composer survives page navigation: consume unchanged submitted content even after a page switch.
    // Still protect edits (including edit-and-undo) and explicit inbox mode changes; view guards below only own navigation.
    const untouched = Boolean(ui.composerManagement) === management && ui.composerAppendTarget === appendTarget && ui.composerEditRevision === editRevision && input.value === value
      && ui.composerReferenceRevision === referenceRevision && JSON.stringify(composerReferences()) === signature;
    if (untouched) {
      input.value = ''; textEditor?.reset(); setComposerReferences([]); identity.requestDefinition = null;
      if (!management && target.id == null) { ui.composerRunnerNodeId = undefined; runnerChoice?.setValue(undefined); }
    }
    if (management) {
      if (ui.composerManagementProfile === creationProfile) ui.composerManagementProfile = null;
      ui.composerManagementResult = result.task || null;
      show(`管理指令已提交${result.task?.id ? ` ${workerLabel(result.task)}` : ''}，等待管家处理；未创建开发 Worker，记录可在「管家列表」查看，危险操作须确认。`);
    } else if (mode === 'buffer') {
      if (target.id != null && untouched) ui.composerAppendTarget = null;
      show(`已暂存为草稿 #${result.id}，尚未提交；可到「历史输入」编辑或提交，未创建 Worker、未调用 Agent。`);
      ui.inputsPage?.added?.();
    } else {
      if (target.id != null && untouched) ui.composerAppendTarget = null;
      if (target.id == null && ui.composerProfile === creationProfile) ui.composerProfile = null;
      paintRunSettings(); show(emissionAcknowledgement(result, target.id != null));
      ui.inputsPage?.added?.();
    }
    update = { identity, submission, view, appendTarget: ui.composerAppendTarget,
      // The just-sent inbox may refresh its detail after returning to creation, never re-enter append.
      detailId: view?.id === 'task' ? target.id ?? null : null,
      editRevision: ui.composerEditRevision, referenceRevision: ui.composerReferenceRevision, canNavigate: untouched };
  } catch (error) { if (ui.composerIdentity === identity) show(error.message, 'error'); }
  finally { if (ui.composerIdentity === identity) { ui.composerSubmitting = false; syncComposer(); } }
  if (update) void updateAfterSubmit(update);
}
export function buffer() { return submitInput('buffer'); }
/** Enter buffers development/append work; Ctrl+Enter and Ctrl+Shift+Enter both emit. */
export function initComposer() {
  textEditor?.dispose(); disposeViewport?.(); runnerChoice?.dispose(); runnerChoice = null; textEditor = null;
  ui.composerIdentity = {}; ui.composerEditRevision = 0; ui.syncComposer = syncComposer;
  const identity = ui.composerIdentity, input = $('input'), editorTools = $('composer-editor-tools');
  editorTools.replaceChildren();
  ui.composerAppendTarget = null; ui.composerManagement = false; ui.composerManagementProfile = null;
  // 每次装配（含 boot 重跑）都从项目默认开始，不让上一条指令的运行设置跨会话残留。
  ui.composerProfile = null; ui.composerRunnerNodeId = undefined;
  const runnerReady = import('./runner-choice.js').then(({ createRunnerChoice }) => {
    if (ui.composerIdentity !== identity) return;
    runnerChoice = createRunnerChoice({ ownsPage: () => ui.composerIdentity === identity, online: () => !ui.offline,
      onChange: value => { ui.composerRunnerNodeId = value; ui.composerEditRevision++; syncComposer(); } });
    $('composer-runner-choice')?.replaceChildren(runnerChoice.node);
    input.onfocus = () => { if (!ui.composerManagement && !ui.composerAppendTarget) void runnerChoice?.load(); };
    syncComposer();
  }).catch(error => { if (ui.composerIdentity === identity) show(`执行环境选项加载失败：${error.message}`, 'error'); });
  runSettingsButton = button(runSettingsLabel(), () => openComposerRunSettings(), 'ghost composer-run-settings', { help: RUN_SETTINGS_HELP });
  runSettingsButton.id = 'composer-run-settings'; runSettingsButton.dataset.composerRunSettings = '';
  const anchor = $('input-buffer-help');
  const host = anchor?.parentNode ?? $('composer-shell') ?? null;
  // 重复 boot 时先移除上次装的按钮，避免入口重复。
  host?.querySelector?.('.composer-run-settings')?.remove?.();
  if (anchor?.parentNode) anchor.parentNode.insertBefore(runSettingsButton, anchor);
  else host?.append(runSettingsButton);
  host?.querySelector?.('.composer-management')?.remove?.();
  const managementButton = button('管理 Lush', () => {
    ui.composerManagement = !ui.composerManagement; ui.composerAppendTarget = null; ui.composerEditRevision++; syncComposer(); $('input').focus();
  }, 'ghost composer-management', { help: '切换为向当前项目管家提交管理指令；切换不调用 Agent，保留文字与引用。暂不支持暂存或引用附件，危险操作须用户确认。' });
  managementButton.id = 'composer-management'; host?.append(managementButton);
  host?.querySelector?.('.composer-management-result')?.remove?.();
  managementResultButton = button('查看最近管理记录', () => { if (Number.isSafeInteger(ui.composerManagementResult?.id)) return detail(ui.composerManagementResult.id); }, 'ghost composer-management-result');
  managementResultButton.hidden = true; host?.append(managementResultButton);
  const sendHelp = agentHelp('提交工作指令并可靠保存执行授权，安全准入后创建并开始新 Worker；不保证立即创建。');
  $('draft-commit').setAttribute('data-help', sendHelp);
  $('input-send-help')?.setAttribute('data-help', sendHelp);
  renderComposerReferences();
  $('composer-expand').onclick = () => toggleComposerDetails();
  $('composer-reset').onclick = resetComposerMode;
  if ($('input-buffer')) $('input-buffer').onclick = buffer;
  renderParentOptions();
  $('input-parent').onchange = syncComposer;
  $('input-form').onsubmit = event => { event.preventDefault(); return submitInput('create'); };
  $('input').oninput = () => { ui.composerEditRevision++; syncComposer(); };
  let composing = false;
  $('input').oncompositionstart = () => { composing = true; };
  $('input').oncompositionend = () => { composing = false; };
  $('input').onkeydown = event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (ui.composerAppendTarget && !event.repeat && !$('input').value.trim() && !composerReferences().length) {
        event.preventDefault(); resetComposerMode();
      }
      return;
    }
    if (event.key !== 'Enter') return;
    if (event.altKey) return;
    if (!event.metaKey && !event.ctrlKey && (event.shiftKey || usesTouchEnter() || ui.composerManagement)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (!event.metaKey && !event.ctrlKey) return ui.composerManagement ? undefined : buffer();
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
  disposeViewport = attachComposerViewport(input, $('composer-shell'));
  syncComposer();
  return Promise.all([loadComposerParents(), editorReady, runnerReady]);
}
