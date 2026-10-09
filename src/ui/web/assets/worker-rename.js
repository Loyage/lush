import { button } from './dom.js';
import { action } from './api.js';
import { promptDialog } from './dialog.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { projectBase } from './route.js';
import { workerLabel } from './worker-label.js';
import { taskTitle } from './format.js';

/** Shared display-only operation for details and both Worker tree modes. */
export function workerRenameControl(task, { refresh = async () => {} } = {}) {
  let busy = false;
  const control = button('重命名', async () => {
    if (busy) return;
    busy = true;
    const view = ui.view, project = projectBase();
    const ownsPage = () => ui.view === view && projectBase() === project && !ui.deletedWorkerIds.has(task.id);
    let value = task.display_title ?? task.title ?? taskTitle(task), failure = null;
    try {
      while (ownsPage()) {
        const title = await promptDialog({ title: `重命名 Worker ${workerLabel(task)}`, label: '标题', value,
          message: failure || '只修改展示标题，不改变任务正文、编号、分支或执行过程，不调用 Agent。最多 200 个字符；清空后保存可恢复自动标题。',
          confirmLabel: '保存' });
        if (title === null || !ownsPage()) return;
        let result;
        try { result = await action('worker.rename', { id: task.id, title }, { refresh: false }); }
        catch (error) {
          value = title; failure = `保存失败：${error.message}；标题已保留，可修改后重试。`;
          if (ownsPage()) show(failure, 'error');
          continue;
        }
        if (!ownsPage()) return;
        task.display_title = result.display_title;
        show(result.display_title ? 'Worker 标题已保存。' : '已恢复 Worker 自动标题。');
        try { await refresh(); }
        catch (error) { if (ownsPage()) show(`标题已保存，但页面更新失败：${error.message}；请刷新，不要重复提交。`, 'error'); }
        return;
      }
    } finally { busy = false; }
  }, 'ghost', { help: '为这条 Worker 设置便于回忆的展示标题；不改变任务正文或执行过程，也不调用 Agent。' });
  control.classList.add('worker-rename');
  return control;
}
