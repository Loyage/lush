import { $, button } from './dom.js';
import { ui } from './state.js';
import { api } from './api.js';
import { refresh } from './navigate.js';
import { show } from './messages.js';
import { taskTitle, isHistoricalDelivery } from './format.js';
import { workerLabel } from './worker-label.js';
import { draftLabel } from './draft-label.js';
import { workerKind } from './worker-kind.js';
import { waitingFirstInput } from './worker-create.js';
import { iterationBlocker } from './render-iteration.js';
import { appendInputBlocker, valetAppendBlocker, inputQueueText, inputWaitReason } from './worker-input.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { agentHelp } from './help.js';
import { emissionAcknowledgement, emissionRequestId } from './emission-form.js';
import { elevationChoice, confirmProjectElevation, projectElevationDefinition, projectElevationReceipts, pendingProjectElevation, syncProjectElevationSecrets } from './administrator-project-input.js';
import { attachComposerViewport } from './composer-viewport.js';
import { attachComposerResize } from './composer-resize.js';
import { initComposerWorkspace, currentEdit, selectComposerMode, paintComposerWorkspace, finishComposerEdit, collapseComposer, rememberComposer, navigateComposerDraft, activateComposerDraft, newComposerEntry, openComposer, retargetComposerEntry, applyEntry } from './composer-workspace.js';

let textEditor = null, disposeViewport = null, disposeResize = null, elevationControl = null;
let elevationReceipts = null, receiptKey = null, cacheScheduled = false;
export function paintDraftPanel() { $('draft-panel')?.classList.toggle('open', Boolean(ui.draftPanelOpen)); }
export function toggleDraftPanel(force) { ui.draftPanelOpen = force ?? !ui.draftPanelOpen; paintDraftPanel(); }
export function parentTasks(tasks = []) {
  return tasks.filter(task => task.execution_retired !== true && ['main', 'owner', 'order'].includes(workerKind(task)) && task.branch
    && ['queued', 'running', 'waiting', 'awaiting', 'awaiting_acceptance', 'paused'].includes(task.status)
    && !task.archived && !task.branch_archive?.archived && !task.branch_info?.archived && (!task.freeze || task.freeze.creation_commit)
    && !isHistoricalDelivery(task) && task.reservation?.status !== 'requested').sort((a, b) => a.id - b.id);
}
function destination() {
  const entry = currentEdit();
  if (!entry) return {};
  if (entry.target_id != null) {
    const task = ui.composerTask?.id === entry.target_id ? ui.composerTask : ui.composerAppendTarget?.task;
    if (!task) return { id: entry.target_id, reason: ui.composerAppendTarget?.error || '原目标正在读取；内容仍可编辑与保存，读取成功后才能提交。' };
    return { id: entry.target_id, task, reason: entry.request?.blocked || (ui.composerManagement ? valetAppendBlocker(task) : appendInputBlocker(task)),
      wait: inputWaitReason(task), queueText: inputQueueText(task) };
  }
  if (ui.composerManagement) return {};
  if (entry.mode === 'append') return { reason: '尚未选择追加目标；请选择草稿恢复原目标，或进入详细编辑选择 Worker。不会作为新建工作提交。' };
  const task = ui.composerParents?.find(parent => parent.branch === entry.branch);
  return { task, branch: entry.branch, freeze: task?.freeze,
    reason: !task ? '原父 Worker 尚未读取或已不可用；内容保留，请在详细编辑中显式选择。' : task.execution_retired ? '远端执行已退役，仅保留历史。' : (() => { const reason = iterationBlocker(task); return reason && !/冻结/.test(reason) ? reason : null; })() };
}
export function appendToWorker(task) {
  if (ui.view?.id !== 'task' || ui.selected !== task.id) {
    if (ui.view?.id !== 'task-graph' || !ui.taskGraphIds?.has(task.id)) return;
  }
  return selectComposerMode('append', task);
}
export function resetComposerMode() { return selectComposerMode('order'); }
export function paintComposerDetails() {
  const detail = Boolean(ui.inputEditor?.inDetail), entry = currentEdit();
  $('input-form').dataset.expanded = String(detail);
  $('composer-details').hidden = !detail || entry?.mode !== 'order';
  $('composer-editor-tools').hidden = false;
  $('composer-management-settings').hidden = !detail || !ui.composerManagement;
  $('composer-expand').textContent = '详细编辑'; $('composer-expand').hidden = detail;
  $('composer-expand').removeAttribute('aria-expanded'); $('composer-expand').removeAttribute('data-help');
}
export function renderParentOptions() {
  const select = $('input-parent'); if (!select) return;
  const parents = ui.composerParents || [], entry = currentEdit();
  const signature = JSON.stringify([parents, entry?.branch]);
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    const options = parents.map(task => {
      const option = document.createElement('option'); option.value = task.branch === 'main' ? '' : task.branch;
      option.textContent = `${workerLabel(task)} ${taskTitle(task)} · ${task.branch}${task.freeze?.creation_commit ? ' · 可从固定提交新建' : task.freeze ? ' · 冻结，可保存/提交等待' : ''}`; return option;
    });
    if (entry?.branch && !parents.some(task => task.branch === entry.branch)) {
      const missing = document.createElement('option'); missing.value = entry.branch === 'main' ? '' : entry.branch; missing.textContent = `${entry.branch}（待核验，不能静默改投）`; options.push(missing);
    }
    select.replaceChildren(...options); select.value = entry?.branch === 'main' ? '' : entry?.branch || '';
  }
  paintComposerDetails();
}
export function loadComposerParents() {
  const identity = ui.composerIdentity; if (!identity) return Promise.resolve();
  if (identity.parentsPending) return identity.parentsPending;
  return identity.parentsPending = (async () => {
    try {
      const result = await api('/api/input-parents'); if (ui.composerIdentity !== identity) return;
      if (!Array.isArray(result.items)) throw Error('父 Worker 列表格式不兼容');
      ui.composerParents = result.items; syncComposer();
    } catch (e) { if (ui.composerIdentity === identity) show(`父 Worker 读取失败：${e.message}`, 'error'); }
    finally { identity.parentsPending = null; }
  })();
}
export function toggleComposerDetails() { return ui.inputEditor?.detail(); }
function managementPending() { return pendingProjectElevation(ui.composerAppendTarget ? 'append' : 'submit', ui.composerAppendTarget?.id); }
function managementDefinition(instruction, client_request_id, saved) {
  const id = ui.composerAppendTarget?.id;
  return projectElevationDefinition({ kind: id != null ? 'append' : 'submit', instruction, client_request_id,
    ...(saved ? { draft_id: saved.id, expected_revision: saved.revision } : {}),
    ...(id != null ? { id } : ui.composerManagementProfile ? { profile: ui.composerManagementProfile } : {}) });
}
function paintManagementReceipts() {
  if (!ui.composerManagement) { if (elevationReceipts) elevationReceipts.root.hidden = true; return; }
  const edit = currentEdit(), identity = ui.composerIdentity, id = edit.target_id;
  const key = `${edit.key}:${ui.composerEditRevision}:${ui.composerReferenceRevision}`;
  if (receiptKey !== key) {
    elevationReceipts?.root.remove(); receiptKey = key;
    elevationReceipts = projectElevationReceipts({ kind: id != null ? 'append' : 'submit', id,
      current: () => ui.composerIdentity === identity && currentEdit() === edit && ui.composerManagement,
      resolved: receipt => {
        ui.composerManagementResult = receipt.task; ui.composerElevated = false;
        if (receipt.draft_id === edit.saved?.id) {
          // A proved consumed draft never owns newly typed local text.
          void acceptedDraft(receipt, receipt.instruction === $('input').value, edit.saved);
        }
        show('原提权输入已确认接受；不代表执行成功，不会重发。'); syncComposer();
      } });
    $('input-form').append(elevationReceipts.root);
  }
  elevationReceipts.refresh();
}
export function syncComposer() {
  if (!currentEdit()) return;
  renderParentOptions();
  ui.composerSubmitting = Boolean(ui.inputEditor?.busy);
  const entry = currentEdit(), management = entry.mode === 'management', target = destination(), followup = entry.mode === 'append' || target.id != null;
  const missingTarget = entry.mode === 'append' && entry.target_id == null;
  const input = $('input'), detailHost = Boolean(ui.inputEditor?.inDetail), conditional = entry.localOptions?.conditions?.length || entry.localOptions?.exclusive;
  if (!management) ui.composerElevated = false;
  if (!ui.composerElevated) elevationControl?.reset();
  syncProjectElevationSecrets(); paintManagementReceipts();
  const label = missingTarget ? '尚未选择 Worker' : followup ? workerLabel(target.task || target.id, entry.saved?.target_worker_number) : management ? '当前项目' : target.task ? `${workerLabel(target.task)} · ${target.branch}` : entry.branch;
  $('input-form').dataset.mode = management ? 'management' : followup ? 'append' : 'create';
  $('input-form').dataset.blocked = String(Boolean(target.reason));
  $('composer-mode-title').textContent = management ? '管理 Lush' : followup ? waitingFirstInput(target.task) ? '输入工作指令' : '追加输入' : '新建工作';
  $('composer-mode-icon').textContent = management ? '⚙' : followup ? '↳' : '＋';
  const destinationText = `${management ? followup ? '原管家 ' : '新管家 · ' : followup ? '' : '基于 '}${label}${followup && target.task ? ` · ${taskTitle(target.task)}` : ''}`;
  $('composer-mode-target').textContent = destinationText;
  $('composer-mode-target').setAttribute('data-help', `本条去向：${destinationText}。更改去向请进入详细编辑；不会随当前阅读页面改变。`);
  $('composer-mode-target').setAttribute('tabindex', '0');
  $('composer-mode-behavior').textContent = target.reason || 'Enter / Shift+Enter 换行 · Ctrl/⌘+S 保存 · Ctrl/⌘+Enter 提交；保存与切换不执行。';
  const status = target.reason || target.queueText || target.wait || (target.freeze?.creation_commit
    ? '可从 main 固定提交创建独立 Worker；不含正在解分歧的成果，后续合并仍须排队。' : target.freeze?.reason)
    || (followup && target.task?.status === 'paused' && !waitingFirstInput(target.task) ? '暂停中，需开始 / 继续后处理' : '');
  $('composer-target-status').hidden = !status; $('composer-target-status').textContent = status;
  input.disabled = missingTarget; input.placeholder = management ? '描述希望管家处理的事项…' : followup ? '补充要求或反馈…' : '描述希望完成的工作…';
  input.setAttribute('aria-label', management ? '管理指令正文' : followup ? '追加指令正文' : '工作指令正文');
  const busy = Boolean(entry.flight || entry.operation), empty = !input.value.trim();
  const profileIssue = ui.inputEditor?.profileIssue;
  $('draft-commit').disabled = busy || empty || Boolean(target.reason || profileIssue) || management && managementPending().length > 0;
  $('draft-commit').textContent = conditional ? '按条件提交' : management ? ui.composerElevated && detailHost ? '核对本条提权指令' : '提交管理指令' : followup ? '提交追加' : '提交新工作';
  const help = agentHelp(target.reason || profileIssue || (conditional ? '先保存，再授权此精确版本按条件提交；等待全部条件与安全准入，不保证立即执行。' : '先保存，再授权此精确版本提交；可靠接受不表示 Agent 已收到或执行完成。'));
  $('draft-commit').classList.add('agent-call'); $('draft-commit').setAttribute('data-help', help); $('input-send-help').setAttribute('data-help', help);
  $('input-buffer').hidden = $('input-buffer-help').hidden = false;
  $('input-buffer').disabled = busy || empty || missingTarget; $('input-buffer').textContent = '保存草稿';
  $('input-buffer-help').setAttribute('data-help', '保存到当前项目，不执行；首次创建、之后更新同一草稿，内容保留。');
  $('input-buffer').removeAttribute('data-help');
  $('composer-reset').hidden = !detailHost; $('input-history').hidden = $('input-drafts').hidden = !detailHost;
  if (elevationControl) elevationControl.root.hidden = !management || !detailHost;
  textEditor?.sync(); paintComposerWorkspace(); paintComposerDetails(); ui.inputEditor?.paint();
  const saved = entry.saved;
  $('composer-draft-status').hidden = false;
  const dirty = ui.inputEditor?.dirty;
  $('composer-draft-status').textContent = entry.error ? '保存/提交失败' : entry.conflict ? '版本冲突' : busy ? '保存/提交中…' : saved && !dirty ? '已保存 · 未提交' : '未保存';
  $('composer-draft-status').dataset.error = String(Boolean(entry.error || entry.conflict));
  $('composer-draft-status').setAttribute('data-help', entry.error ? `保存/提交失败：${entry.error}；本地编辑保留，请在下方恢复区处理。` : entry.conflict ? '服务器版本已变化；本地编辑保留，请在下方恢复区对照整理，不会静默覆盖。'
    : busy ? '正在保存或提交，请等待；不会重复请求。'
      : `${saved ? `${draftLabel(saved)} · 版本 ${saved.revision} · ${dirty ? '有未保存修改' : '已保存到项目，尚未提交'}` : '尚未保存到项目'}。离开整条编辑时自动保存；浏览器恢复仅作兜底，保存不执行。`);
  $('composer-references').hidden = !detailHost || !composerReferences().length;
  $('composer-editor-tools').dataset.references = String(composerReferences().length);
  $('composer-reference-count').textContent = `引用 ${composerReferences().length}`;
  if (!cacheScheduled) {
    cacheScheduled = true; const identity = ui.composerIdentity;
    queueMicrotask(() => { cacheScheduled = false; if (ui.composerIdentity === identity) rememberComposer(); });
  }
}
async function authorizeDraft(saved) {
  const target = destination(); if (target.reason) throw Error(target.reason);
  if (saved.mode === 'management' && managementPending().length) throw Error('原提权提交未知，请先只读核对收据，不重复发送。');
  if (saved.mode === 'management' && ui.composerElevated && ui.inputEditor.inDetail) {
    const edit = currentEdit(), value = $('input').value, profile = JSON.stringify(ui.composerManagementProfile), view = ui.view;
    const definition = managementDefinition(saved.content, emissionRequestId(), saved);
    return confirmProjectElevation(definition, { current: () => currentEdit() === edit && ui.view === view && $('input').value === value
      && JSON.stringify(ui.composerManagementProfile) === profile && ui.composerElevated });
  }
  const { emitDraft } = await import('./draft-editor.js');
  return emitDraft(saved, saved.target_id == null ? saved.mode === 'management' ? ui.composerManagementProfile : ui.composerProfile : null, currentEdit().request ||= {});
}
async function acceptedDraft(result, untouched, saved) {
  const inDetail = ui.inputEditor.inDetail, presentReceipt = ui.inputEditor.receiptPresenter, options = currentEdit().localOptions;
  ui.composerElevated = false; elevationControl?.reset();
  if (saved.mode === 'management') ui.composerManagementResult = result.task;
  ui.inputEditor.detach();
  if (untouched) {
    $('input').value = ''; setComposerReferences([]); textEditor?.reset();
    ui.composerProfile = ui.composerManagementProfile = null; finishComposerEdit({ consume: true });
  } else finishComposerEdit({ detached: true, options });
  rememberComposer();
  show(saved.mode === 'management' ? '管理输入已可靠接受；不代表 Agent 或管理操作执行成功。下一条默认普通权限。' : emissionAcknowledgement(result, saved.mode === 'append'));
  ui.draftsPage?.added?.(); ui.inputsPage?.added?.();
  ui.lastInputReceipt = { draft_id: saved.id, dispatch: result.dispatch };
  if (inDetail && untouched && presentReceipt) {
    await presentReceipt({ ...saved, revision: result.revision ?? saved.revision, dispatch: result.dispatch });
  } else if (inDetail && untouched) {
    if (ui.draftsPage) ui.draftsPage.editor = null;
    try { const { openInputs } = await import('./render-inputs.js'); await openInputs({ item: { kind: 'draft', id: saved.id }, push: false, reread: true }); }
    catch { show('输入已接受，但收据读取失败；请只读刷新，不要重发。', 'error'); }
  }
  else if (untouched && saved.target_id != null) void selectComposerMode('order', null, 'main', { open: Boolean(ui.composerWorkspace?.open), savedLeave: true });
  void refresh().catch(() => show('提交已接受，列表刷新失败；请只读刷新，不要重发。', 'error'));
}
export function buffer() { return ui.inputEditor?.save(); }
export async function initComposer() {
  ui.inputEditor?.dispose(); ui.inputEditor = null;
  textEditor?.dispose(); disposeViewport?.(); disposeResize?.();
  ui.composerIdentity = {}; ui.composerEditRevision = 0; ui.syncComposer = syncComposer; ui.composerSubmitting = false;
  ui.composerAppendTarget = null; ui.composerManagement = ui.composerElevated = false;
  ui.composerManagementProfile = ui.composerProfile = null;
  const identity = ui.composerIdentity, input = $('input');
  const [{ attachTextEditor }, { createUnifiedInputEditor }] = await Promise.all([import('./text-editor.js'), import('./unified-input-editor.js')]);
  if (ui.composerIdentity !== identity) return;
  textEditor = attachTextEditor(input, { onChange: () => { ui.composerEditRevision++; syncComposer(); } });
  for (const [selector, symbol, label] of [['.text-editor-undo', '↶', '撤销正文编辑'], ['.text-editor-redo', '↷', '重做正文编辑']]) {
    const control = textEditor.controls.querySelector(selector);
    control.textContent = symbol; control.setAttribute('aria-label', label);
  }
  const referenceCount = button('引用 0', async () => {
    const editing = currentEdit();
    if (!ui.inputEditor.inDetail) await ui.inputEditor.detail();
    if (ui.composerIdentity !== identity || currentEdit() !== editing || !ui.inputEditor.inDetail) return;
    const extras = $('input-form').querySelector('.unified-editor-references'); extras.open = true;
    (composerReferences().length ? $('composer-references') : extras).scrollIntoView?.({ block: 'nearest' });
  }, 'ghost composer-reference-count', { help: '在详细编辑中展开本条引用完整信息；不会提交或调用 Agent。' });
  referenceCount.id = 'composer-reference-count';
  $('composer-editor-tools').replaceChildren(textEditor.controls, referenceCount);
  elevationControl = elevationChoice(checked => { ui.composerElevated = checked; syncComposer(); });
  $('composer-management-settings').replaceChildren(elevationControl.root);
  elevationReceipts?.root.remove(); elevationReceipts = null; receiptKey = null;
  initComposerWorkspace({ resetEditor: entry => { textEditor.reset(); if (entry?.undo) textEditor.restore(entry.undo); } });
  createUnifiedInputEditor({ authorize: authorizeDraft, accepted: acceptedDraft, history: () => textEditor, sync: syncComposer,
    onCreated: saved => saved.mode === 'order' ? loadComposerParents() : null,
    workspace: { currentEdit, rememberComposer, finishComposerEdit, activateComposerDraft, newComposerEntry, paintComposerWorkspace, openComposer, retargetComposerEntry, applyEntry } });
  renderComposerReferences();
  $('composer-condition-summary').onclick = () => ui.inputEditor.detail();
  $('composer-shortcuts-toggle').onclick = () => {
    const shortcuts = $('composer-shortcuts'); shortcuts.hidden = !shortcuts.hidden;
    $('composer-shortcuts-toggle').setAttribute('aria-expanded', String(!shortcuts.hidden));
  };
  $('composer-reset').onclick = resetComposerMode;
  $('input-buffer').onclick = buffer;
  $('input-buffer').setAttribute('aria-keyshortcuts', 'Control+s Meta+s');
  $('draft-commit').setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter Control+Shift+Enter Meta+Shift+Enter');
  $('input-parent').onchange = async () => {
    const entry = currentEdit(), branch = $('input-parent').value || 'main';
    // Changing destination leaves the old definition first, then edits this same session explicitly.
    if (!await ui.inputEditor.leave()) { $('input-parent').value = entry.branch === 'main' ? '' : entry.branch; return; }
    if (currentEdit() !== entry) return;
    entry.branch = branch; retargetComposerEntry(entry); ui.inputEditor.capture(); rememberComposer(); syncComposer();
  };
  $('input-form').onsubmit = event => { event.preventDefault(); return ui.inputEditor.submit(); };
  input.oninput = () => { ui.composerEditRevision++; syncComposer(); };
  let composing = false;
  input.oncompositionstart = () => { composing = true; }; input.oncompositionend = () => { composing = false; };
  const keydown = event => {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); return collapseComposer(); }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const save = !event.shiftKey && event.key?.toLowerCase() === 's', submit = event.key === 'Enter';
      if (save || submit) { event.preventDefault(); if (!event.repeat) return save ? buffer() : ui.inputEditor.submit(); return; }
    }
    if (event.target && event.target !== input) return;
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const navigation = navigateComposerDraft(event.key === 'ArrowUp' ? 1 : -1); if (navigation) { event.preventDefault(); return navigation; }
    }
  };
  input.onkeydown = keydown;
  $('input-form').onkeydown = event => { if (event.target !== input) return keydown(event); };
  disposeResize = attachComposerResize(input, $('composer-resize'));
  disposeViewport = attachComposerViewport(input, $('composer-shell'));
  ui.composerKeydown = keydown;
  syncComposer(); await loadComposerParents();
}
