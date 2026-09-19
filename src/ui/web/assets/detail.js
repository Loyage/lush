import { $ } from './dom.js';
import { api, loadHistory } from './api.js';
import { renderDetail, renderDetailError } from './render-detail.js';
import { ui } from './state.js';

/** 拉取并渲染一个任务详情。 */
export async function loadDetail(taskId) {
  ui.selected = taskId;
  const scrolled = ui.detailTask === taskId ? $('detail').scrollTop : 0;
  // window.history: a local `history` binding here would shadow the global and throw a TDZ error on click.
  // pushState（而不是 replace）让浏览器后退能回到概览或上一个任务；hash 没变时不重复压栈。
  if (location.hash !== `#task-${taskId}`) window.history.pushState(null, '', `#task-${taskId}`);
  let task, timeline, diff, usage;
  try {
    [task, timeline, diff, usage] = await Promise.all([
      api(`/api/task/${taskId}`), loadHistory(taskId).catch(() => ({ events: [], truncated: false })),
      api(`/api/task/${taskId}/diff`).catch(() => null),
      // agent 用量（模型、上下文、花费）来自 pi 会话记录：读不到会话不影响详情其余部分。
      api(`/api/task/${taskId}/usage`).catch(() => null),
    ]);
  } catch (error) {
    if (ui.selected === taskId) renderDetailError(taskId, error.message);
    throw error;
  }
  if (ui.selected !== taskId) return;
  ui.selectedRevision = task.updated_at; ui.detailTask = taskId; ui.detailRenderedAt = Date.now(); ui.detailDirty = false;
  renderDetail(task, timeline, diff, usage);
  $('detail').scrollTop = scrolled;
  const tree = $('tasks').querySelector(`[data-id="${taskId}"]`);
  if (tree) for (const node of $('tasks').children) node.classList.toggle('selected', node === tree);
}
