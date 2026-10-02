import { $, el } from './dom.js';
import { action, api } from './api.js';
import { taskTitle, isHistoricalDelivery } from './format.js';
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
  return tasks.filter(task => ['main', 'owner', 'say'].includes(task.task_kind) && task.branch
    && ['queued', 'running', 'waiting', 'awaiting', 'awaiting_acceptance', 'paused'].includes(task.status)
    && !task.archived && !task.branch_archive?.archived && !task.branch_info?.archived && !task.freeze
    && !isHistoricalDelivery(task) && task.reservation?.status !== 'requested').sort((a, b) => a.id - b.id);
}
function selectedParentLabel() {
  const select = $('input-parent');
  if (!select?.value) return null;
  const option = [...select.children].find(node => node.value === select.value);
  return option?.dataset.label ?? option?.textContent ?? select.value;
}
export function paintComposerDetails() {
  const open = Boolean(ui.composerExpanded);
  if ($('composer-details')) $('composer-details').hidden = !open;
  if ($('composer-shortcuts')) $('composer-shortcuts').hidden = !open;
  const toggle = $('composer-expand');
  if (!toggle) return;
  const parent = selectedParentLabel();
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('data-help', open ? '收起：只留输入与操作按钮。' : `展开：可以选择父 Task，并查看键盘快捷键${parent ? `（当前父 Task：${parent}）` : ''}。`);
  toggle.textContent = open ? '⌃ 收起' : (parent ? `⌃ 更多 · 父 Task：${parent}` : '⌃ 更多');
}
export function renderParentOptions() {
  const select = $('input-parent');
  if (!select) return;
  const tasks = ui.composerParents ?? [];
  const signature = JSON.stringify(tasks);
  if (select.dataset.signature === signature) { paintComposerDetails(); return; }
  select.dataset.signature = signature;
  const previous = select.value;
  const placeholder = el('option', '当前检出分支（默认）'); placeholder.value = '';
  const options = tasks.map(task => {
    const option = el('option', `#${task.id} ${taskTitle(task)} · ${task.branch}`);
    option.value = task.branch; option.dataset.label = `#${task.id} ${taskTitle(task)}`;
    return option;
  });
  if (previous && !tasks.some(task => task.branch === previous)) {
    const missing = el('option', `${previous}（父 Task 已不可选，请重选）`); missing.value = previous; options.push(missing);
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
      if (!Array.isArray(data.items)) throw new Error('父 Task 列表格式不兼容');
      ui.composerParents = data.items; renderParentOptions();
    } catch (error) { if (current()) show(`父 Task 列表读取失败：${error.message}`, 'error'); }
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
  const disabled = Boolean(ui.composerSubmitting) || !$('input').value.trim();
  $('draft-commit').disabled = disabled;
  if ($('input-buffer')) $('input-buffer').disabled = disabled;
}

/** One flight across buffering, button submission and all keyboard shortcuts. */
async function submitInput(mode) {
  const input = $('input'), value = input.value, content = value.trim();
  if (ui.composerSubmitting || !content) return;
  const identity = ui.composerIdentity, editRevision = ui.composerEditRevision, view = ui.view;
  const referenceRevision = ui.composerReferenceRevision;
  const references = composerReferences(), signature = JSON.stringify(references);
  const branch = $('input-parent').value.trim();
  ui.composerSubmitting = true; syncComposer();
  try {
    if (branch && !ui.composerParents?.some(task => task.branch === branch)) throw new Error('所选父 Task 已不可用，请展开输入区重新选择。');
    const params = { content, references, ...(branch ? { branch } : {}) };
    const result = await action(mode === 'buffer' ? 'draft.add' : 'say.submit', mode === 'buffer' ? params : { ...params, start: mode === 'start' });
    if (ui.composerIdentity !== identity) return;
    // Never consume text or references authored while the request was in flight (even an edit-and-undo).
    const untouched = ui.composerEditRevision === editRevision && input.value === value
      && ui.composerReferenceRevision === referenceRevision && JSON.stringify(composerReferences()) === signature;
    if (untouched) { input.value = ''; setComposerReferences([]); }
    if (mode === 'buffer') {
      show(`已暂存输入 #${result.id}，可到「历史输入」编辑或发射；未创建 Task、未调用 Agent。`);
      ui.inputsPage?.added?.();
    } else {
      show(mode === 'start' ? `已创建并开始 Task #${result.task.id}` : `已创建 Task #${result.task.id}（待开始），可配置后开始`);
      await refresh();
      if (ui.composerIdentity === identity && ui.view === view) await detail(result.task.id);
    }
  } catch (error) { if (ui.composerIdentity === identity) show(error.message, 'error'); }
  finally { if (ui.composerIdentity === identity) { ui.composerSubmitting = false; syncComposer(); } }
}
export function buffer() { return submitInput('buffer'); }

/** Enter buffers; Shift+Enter inserts a newline; Ctrl/Meta shortcuts retain their existing meanings. */
export function initComposer() {
  ui.composerIdentity = {}; ui.composerEditRevision = 0;
  const sendHelp = agentHelp('发送后创建独立 Task；默认先停在「待开始」，可配置后开始。⌘ / Ctrl+Shift+Enter 直接开始。');
  $('draft-commit').setAttribute('data-help', sendHelp);
  $('input-send-help')?.setAttribute('data-help', sendHelp);
  renderComposerReferences();
  $('composer-expand').onclick = () => toggleComposerDetails();
  if ($('input-buffer')) $('input-buffer').onclick = buffer;
  renderParentOptions();
  $('input-parent').onchange = paintComposerDetails;
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
    if (!event.metaKey && !event.ctrlKey) return buffer();
    return submitInput(event.shiftKey ? 'start' : 'create');
  };
  syncComposer();
  return loadComposerParents();
}
