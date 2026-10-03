import { $, el } from './dom.js';
import { workerKind } from './worker-kind.js';
import { action, api } from './api.js';
import { taskTitle, isHistoricalDelivery, TERMINAL_STATUS } from './format.js';
import { iterationBlocker } from './render-iteration.js';
import { show } from './messages.js';
import { detail, refresh } from './navigate.js';
import { ui } from './state.js';
import { composerReferences, renderComposerReferences, setComposerReferences } from './context-references.js';
import { agentHelp } from './help.js';

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
/** Derive the destination from the current page, never from a stale overview selection. */
function destination() {
  if (ui.view?.id !== 'task') return { branch: $('input-parent')?.value.trim() || 'main' };
  const id = ui.selected;
  const task = ui.composerTask?.id === id ? ui.composerTask : null;
  if (!task) return { id, reason: ui.composerError || '正在读取 Worker；加载成功后才能输入。' };
  if (['main', 'owner'].includes(task.task_kind)) return { branch: task.branch, task, reason: iterationBlocker(task) };
  const reason = isHistoricalDelivery(task) || !['order', 'child'].includes(workerKind(task))
    ? '此 Worker 不支持追加输入。'
    : TERMINAL_STATUS.has(task.status)
      ? (task.status === 'completed' ? 'Worker 已完成；请先显式恢复开发。' : 'Worker 已结束；请先重试。')
      : iterationBlocker(task);
  return { id, task, reason };
}
function selectedParentLabel() {
  const select = $('input-parent');
  if (!select?.value) return null;
  const option = [...select.children].find(node => node.value === select.value);
  return option?.dataset.label ?? option?.textContent ?? select.value;
}
export function paintComposerDetails() {
  const open = Boolean(ui.composerExpanded) && ui.view?.id !== 'task';
  if ($('composer-details')) $('composer-details').hidden = !open;
  if ($('composer-shortcuts')) $('composer-shortcuts').hidden = !open;
  const toggle = $('composer-expand');
  if (!toggle) return;
  const parent = selectedParentLabel();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('data-help', open ? '收起：只留输入与操作按钮。' : `展开：可以选择父 Worker，并查看键盘快捷键${parent ? `（当前父 Worker：${parent}）` : ''}。`);
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
    const option = el('option', `#${task.id} ${taskTitle(task)} · ${task.branch}`);
    option.value = task.branch; option.dataset.label = `#${task.id} ${taskTitle(task)}`;
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
  const target = destination(), followup = target.id != null;
  const input = $('input');
  const label = followup ? `Worker #${target.id}` : target.task
    ? `Worker #${target.task.id} · ${target.branch}` : selectedParentLabel() || 'main';
  $('input-form').dataset.mode = followup ? 'append' : 'create';
  $('input-form').dataset.blocked = String(Boolean(target.reason));
  const modeText = {
    'composer-mode-icon': followup ? '↳' : '＋',
    'composer-mode-title': followup ? '继续当前 Worker' : '新建独立 Worker',
    'composer-mode-target': followup ? `追加到 ${label}${target.task ? ` · ${taskTitle(target.task)}` : ''}` : `父 Worker：${label}`,
    'composer-mode-behavior': target.reason || (followup
      ? `不创建新 Worker · Enter 追加${target.task.status === 'paused' ? ' · 暂停中，需开始 / 继续后处理' : ''}`
      : '独立工作区 · Enter 暂存 · 点击创建后待开始'),
  };
  // Keep mode/destination visible while typing, without repeating live announcements on every keystroke.
  for (const [id, text] of Object.entries(modeText)) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }
  input.placeholder = target.reason ? `${label}：${target.reason}` : followup
    ? `追加给 ${label} · Enter 发送 · Shift+Enter 换行${target.task.status === 'paused' ? ' · 暂停中，需开始 / 继续后处理' : ''}`
    : `在 ${label} 下创建子 Worker · Enter 暂存 · Ctrl/⌘+Enter 仅创建 · Shift+Enter 换行`;
  input.setAttribute('aria-label', input.placeholder);
  input.disabled = Boolean(target.reason);
  const disabled = Boolean(ui.composerSubmitting || target.reason) || !input.value.trim();
  $('draft-commit').disabled = disabled;
  $('draft-commit').textContent = followup ? '追加输入' : '创建 Worker';
  const help = agentHelp(target.reason || (followup
    ? `追加给 ${label}，不创建新 Worker；运行中会在安全边界处理，暂停中需显式开始 / 继续。`
    : `在 ${label} 下创建独立 Worker；默认待开始，Ctrl/⌘+Shift+Enter 直接开始。`));
  $('draft-commit').setAttribute('data-help', help);
  $('input-send-help')?.setAttribute('data-help', help);
  if ($('input-buffer')) { $('input-buffer').disabled = disabled; $('input-buffer').hidden = followup; }
  if ($('input-buffer-help')) $('input-buffer-help').hidden = followup;
  // Details are only for choosing the parent of a new Worker, not for changing an inbox destination.
  if (ui.view?.id === 'task') {
    $('composer-details').hidden = true; $('composer-shortcuts').hidden = true;
  }
  $('composer-expand').hidden = ui.view?.id === 'task';
}

/** One flight across buffering, button submission and all keyboard shortcuts. */
async function submitInput(mode) {
  const input = $('input'), value = input.value, content = value.trim();
  if (ui.composerSubmitting || !content) return;
  const identity = ui.composerIdentity, editRevision = ui.composerEditRevision, view = ui.view;
  const referenceRevision = ui.composerReferenceRevision;
  const references = composerReferences(), signature = JSON.stringify(references);
  const target = destination(), branch = target.branch;
  if (target.reason) { show(target.reason, 'error'); return; }
  if (target.id != null && mode === 'buffer') return;
  ui.composerSubmitting = true; syncComposer();
  try {
    if (target.id != null && references.length) throw new Error('追加输入暂不支持引用附件；引用已保留，请先移除引用，或返回概览暂存 / 创建带引用的新 Worker。');
    if (branch && branch !== 'main' && !target.task && !ui.composerParents?.some(task => task.branch === branch)) throw new Error('所选父 Worker 已不可用，请展开输入区重新选择。');
    const params = { content, references, ...(branch ? { branch } : {}) };
    const result = target.id != null
      ? await action('worker.message', { id: target.id, body: content })
      : await action(mode === 'buffer' ? 'draft.add' : 'order.submit', mode === 'buffer' ? params : { ...params, start: mode === 'start' });
    if (ui.composerIdentity !== identity) return;
    // Never consume text or references authored while the request was in flight (even an edit-and-undo).
    const untouched = ui.view === view && ui.composerEditRevision === editRevision && input.value === value
      && ui.composerReferenceRevision === referenceRevision && JSON.stringify(composerReferences()) === signature;
    if (untouched) { input.value = ''; setComposerReferences([]); }
    if (target.id != null) {
      show(`已追加给 Worker #${target.id}${target.task.status === 'paused' ? '；开始 / 继续后处理' : ''}。`);
      if (ui.view === view) await detail(target.id);
    } else if (mode === 'buffer') {
      show(`已暂存输入 #${result.id}，可到「历史输入」编辑或发射；未创建 Worker、未调用 Agent。`);
      ui.inputsPage?.added?.();
    } else {
      show(mode === 'start' ? `已创建并开始 Worker #${result.task.id}` : `已创建 Worker #${result.task.id}（待开始），可配置后开始`);
      await refresh();
      if (ui.composerIdentity === identity && ui.view === view) await detail(result.task.id);
    }
  } catch (error) { if (ui.composerIdentity === identity) show(error.message, 'error'); }
  finally { if (ui.composerIdentity === identity) { ui.composerSubmitting = false; syncComposer(); } }
}
export function buffer() { return submitInput('buffer'); }

/** Enter buffers new work or appends in a Worker inbox; Shift+Enter always inserts a newline. */
export function initComposer() {
  ui.composerIdentity = {}; ui.composerEditRevision = 0; ui.syncComposer = syncComposer;
  const sendHelp = agentHelp('发送后创建独立 Worker；默认先停在「待开始」，可配置后开始。⌘ / Ctrl+Shift+Enter 直接开始。');
  $('draft-commit').setAttribute('data-help', sendHelp);
  $('input-send-help')?.setAttribute('data-help', sendHelp);
  renderComposerReferences();
  $('composer-expand').onclick = () => toggleComposerDetails();
  if ($('input-buffer')) $('input-buffer').onclick = buffer;
  renderParentOptions();
  $('input-parent').onchange = syncComposer;
  $('input-form').onsubmit = event => { event.preventDefault(); return submitInput(ui.composerStartNow ? 'start' : 'create'); };
  $('input').oninput = () => { ui.composerEditRevision++; syncComposer(); };
  let composing = false;
  $('input').oncompositionstart = () => { composing = true; };
  $('input').oncompositionend = () => { composing = false; };
  $('input').onkeydown = event => {
    if (event.key !== 'Enter' || composing || event.isComposing || event.keyCode === 229) return;
    if (event.altKey) return;
    if (!event.metaKey && !event.ctrlKey && event.shiftKey) return;
    event.preventDefault();
    if (event.repeat) return;
    if (!event.metaKey && !event.ctrlKey) return destination().id != null ? submitInput('create') : buffer();
    return submitInput(event.shiftKey ? 'start' : 'create');
  };
  syncComposer();
  return loadComposerParents();
}
