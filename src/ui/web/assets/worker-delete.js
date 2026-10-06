import { api } from './api.js';
import { $, button, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { isHistoricalDelivery, TERMINAL_STATUS } from './format.js';
import { show } from './messages.js';
import { refresh as refreshOverview, resource } from './navigate.js';
import { mergeSelection, transcriptCache, transcriptOpen, ui } from './state.js';
import { releaseTranscriptReader } from './transcript-reader.js';
import { closeTranscriptView } from './transcript-view.js';
import { inputNumber } from './format.js';
import { workerLabel, forgetWorkerLabel } from './worker-label.js';

export const WORKER_DELETE_HELP = '预检这条 Worker 及全部后代的资源，确认后彻底删除专属历史、原始输入、会话、worktree 与本地分支；未提交和未合并代码会丢弃，无法恢复。不会撤销已合并代码或改写 Git 历史。';
const pending = new Set();
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function validatePreview(preview, taskId) {
  if (preview?.id !== taskId || typeof preview.revision !== 'string' || !preview.revision
    || typeof preview.can_delete !== 'boolean' || !strings(preview.blockers) || !strings(preview.warnings)
    || !Array.isArray(preview.workers) || !preview.workers.length
    || !preview.workers.every(row => Number.isSafeInteger(row.id) && row.id > 0 && typeof row.goal === 'string' && typeof row.status === 'string')
    || !preview.workers.some(row => row.id === taskId)
    || new Set(preview.workers.map(row => row.id)).size !== preview.workers.length
    || !Array.isArray(preview.inputs) || !preview.inputs.every(row => Number.isSafeInteger(row.id) && row.id > 0)
    || !['worktrees', 'branches', 'files'].every(key => strings(preview.resources?.[key])) || preview.truncated) {
    throw new Error('删除预检不完整或格式不支持；未删除任何资源，请刷新后重试。');
  }
}

function previewDetail(preview) {
  const list = (title, rows) => `${title}（${rows.length}）：\n${rows.length ? rows.join('\n') : '无'}`;
  return [
    list('将彻底删除的 Worker（包含全部后代）', preview.workers.map(row => `${workerLabel(row)} [${row.status}] ${row.goal}`)),
    list('将删除的原始输入及已发射暂存记录', preview.inputs.map(row => `Input ${inputNumber(row.id)}`)),
    list('将清理的 worktree', preview.resources.worktrees),
    list('将删除的本地分支', preview.resources.branches),
    list('将删除的专属文件（会话、规则、报告等）', preview.resources.files),
    ...(preview.warnings.length ? [list('资源预检提示', preview.warnings)] : []),
  ].join('\n\n');
}

/** Remove known deleted identities before any refresh; late responses must not revive them. */
function forgetWorkers(preview) {
  const ids = new Set(preview.workers.map(row => row.id));
  const inputIds = new Set(preview.inputs.map(row => row.id));
  const notices = [...ui.noticeIndex.values(), ...(ui.noticeRecords?.rows || []), ...(ui.lastSnapshot?.notices || [])]
    .filter(row => ids.has(row.task_id));
  for (const notice of notices) {
    ui.noticeIndex.delete(notice.id);
    if (ui.noticeFocus === notice.id) ui.noticeFocus = null;
    const key = `lush.decision:${ui.lastSnapshot?.status?.project || location.pathname}:${notice.id}:${notice.created_at}`;
    ui.questionDrafts.delete(key);
    try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  for (const [key, row] of ui.noticeReadRows) if (ids.has(row.task_id)) ui.noticeReadRows.delete(key);
  if (ui.noticeRecords) {
    const state = ui.noticeRecords;
    state.rows = state.rows.filter(row => !ids.has(row.task_id));
    if (ids.has(state.task?.id) || notices.some(row => row.id === state.selected)) {
      state.selected = null; state.task = null;
    }
    state.signature = null; state.page = null; state.request++; state.pending = false;
  }
  if (ids.has(ui.transcriptView?.taskId)) closeTranscriptView();
  if (ids.has(Number($('detail').dataset.taskId))) {
    $('detail').replaceChildren(); delete $('detail').dataset.taskId;
    ui.detailTask = null; ui.selectedRevision = null;
  }
  for (const id of ids) {
    ui.deletedWorkerIds.add(id); forgetWorkerLabel(id);
    transcriptCache.delete(id); transcriptOpen.delete(id); mergeSelection.delete(id);
    releaseTranscriptReader(id); ui.taskGraphIds.delete(id); ui.taskGraphFilesExpanded.delete(id);
  }
  for (const key of ui.stepToggle.keys()) if (ids.has(Number(String(key).split(':')[0]))) ui.stepToggle.delete(key);
  ui.taskHistory = ui.taskHistory.filter(row => !ids.has(row.id));
  ui.taskHistoryPage = null;
  if (ui.lastSnapshot) {
    ui.lastSnapshot.tasks = ui.lastSnapshot.tasks.filter(row => !ids.has(row.id));
    if (ui.lastSnapshot.notices) ui.lastSnapshot.notices = ui.lastSnapshot.notices.filter(row => !ids.has(row.task_id));
    if (ui.lastSnapshot.inputs) ui.lastSnapshot.inputs = ui.lastSnapshot.inputs.filter(row => !inputIds.has(row.id));
    // Force a full read rather than accepting an unchanged response for the deleted snapshot.
    delete ui.lastSnapshot.revision;
  }
  // Invalidate a cached, unmounted input page, but never discard an unrelated editor
  // the user opened while the delete request was in flight.
  if (ui.inputsPage?.view !== ui.view) ui.inputsPage = null;
  else for (const [key, row] of ui.inputsPage?.items || []) {
    if (row.kind === 'input' && inputIds.has(row.id)) ui.inputsPage.items.delete(key);
  }
  ui.overviewKey = null; ui.taskGraphFetchedAt = 0;
}

/** Shared detail/graph action; final confirmation alone authorizes discarding code. */
export async function runWorkerDelete(task, { refresh = () => {} } = {}) {
  if (pending.has(task.id) || ui.deletedWorkerIds.has(task.id)) return false;
  if (['main', 'owner'].includes(task.task_kind) || isHistoricalDelivery(task)) return false;
  if (!TERMINAL_STATUS.has(task.status) || task.agent?.active) {
    show('请先手动取消这条 Worker 及活动后代，并等待 Agent 完全停止后再删除。', 'error');
    return false;
  }
  const view = ui.view;
  const project = location.pathname;
  const current = () => ui.view === view && location.pathname === project;
  pending.add(task.id);
  try {
    const preview = await api(`/api/worker/${task.id}/delete-preview`);
    if (!current()) return false;
    validatePreview(preview, task.id);
    if (!preview.can_delete || preview.blockers.length) {
      show(`暂不能删除 Worker ${workerLabel(task)}：${preview.blockers.join('\n') || '未通过资源安全检查。'}`, 'error');
      return false;
    }
    const confirmed = await confirmDialog({
      title: `彻底删除 Worker ${workerLabel(task)} 及全部后代？`,
      message: '这不是归档：Worker、消息、Notice、事件、执行记录及专属会话将永久删除；列出的原始输入也会从历史输入中消失。确认即授权丢弃这些资源中的全部未提交和未合并代码，无法恢复。已合并代码、Git 提交历史和其他记录中的引用快照不会被抹除。',
      detail: previewDetail(preview), confirmLabel: '彻底删除', cancelLabel: '保留', danger: true,
      confirmHelp: WORKER_DELETE_HELP,
    });
    if (!confirmed || !current()) return false;
    // action() refreshes before returning; delete must evict caches/navigate away FIRST.
    await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.delete', params: { id: task.id, revision: preview.revision, confirm: true } }) });
    forgetWorkers(preview);
    show(`已彻底删除 ${preview.workers.length} 条 Worker 及其专属资源。`);
    if (!current()) return true;
    const deletedDetail = view?.id === 'task' && ui.deletedWorkerIds.has(ui.selected);
    if (deletedDetail) resource('tasks');
    // Refresh failures cannot turn a successful irreversible deletion into a retry.
    try { await refreshOverview(); if (current() && !deletedDetail) await refresh(); }
    catch (error) { show(`删除已完成，刷新失败：${error.message}；请手动刷新。`, 'error'); }
    return true;
  } catch (error) {
    if (current()) show(`删除未完成：${error.message}；请重新预检后再确认。`, 'error');
    return false;
  } finally { pending.delete(task.id); }
}

/** Active records retain a disabled, focusable help host explaining manual cancellation. */
export function workerDeleteControl(task, options = {}) {
  if (['main', 'owner'].includes(task.task_kind) || isHistoricalDelivery(task)) return null;
  const reason = !TERMINAL_STATUS.has(task.status) || task.agent?.active
    ? '请先手动取消这条 Worker 及活动后代，并等待 Agent 完全停止后再删除。' : null;
  const node = button('删除', () => {}, 'danger', { help: WORKER_DELETE_HELP });
  // button() normally restores disabled=false; an irreversible success must stay disabled.
  node.onclick = async () => {
    if (node.disabled) return;
    node.disabled = true;
    try { await runWorkerDelete(task, options); }
    finally { node.disabled = ui.deletedWorkerIds.has(task.id); }
  };
  if (!reason) return node;
  node.disabled = true;
  const host = el('span', undefined, 'help-host'); host.tabIndex = 0;
  host.setAttribute('data-help', `${reason} ${WORKER_DELETE_HELP}`);
  host.append(node); return host;
}
