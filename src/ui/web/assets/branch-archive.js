/** Explicit resource cleanup for failed/cancelled and historical special branches.
 * Successful Worker acceptance uses worker.accept instead, never this separate mutation.
 */
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';
import { ui } from './state.js';
import { projectBase, routeContext } from './route.js';

export const BRANCH_ARCHIVE_HELP = '清理这条分支及它下面的全部后代分支资源：删除 worktree 与本地 ref，'
  + '未提交改动会随 worktree 一起丢失；Worker、消息、事件与会话记录都保留。这不是成果验收，也不等于删除 Worker。'
  + '历史内部合并队列随父 Worker 一起归档；之后可在 Worker 树表头“显示已回收历史”里查看记录。';

export async function runBranchArchive(branch, { refresh } = {}) {
  const view = ui.view, scope = projectBase(), owner = globalThis.document;
  const owns = () => ui.view === view && projectBase() === scope && !routeContext().invalid && globalThis.document === owner;
  const descendants = Number(branch.subtreeBranches) || 0;
  const resourceScope = descendants
    ? `会删除这条分支与它下面 ${descendants} 条后代分支的 worktree 与本地 ref`
    : '会删除这条分支的 worktree 与本地 ref';
  const confirmed = await confirmDialog({
    title: `清理 ${branch.name} 的资源？`,
    message: `${resourceScope}，保留 Worker、会话与分支记录；历史内部合并队列随父 Worker 一起归档，未提交改动会被丢弃。这不是成果验收，原失败或取消结果不变。`,
    confirmLabel: '清理资源', cancelLabel: '保留', danger: true, confirmHelp: BRANCH_ARCHIVE_HELP,
  });
  if (!confirmed || !owns()) return;
  try {
    const result = await action('branch.archive', { branch: branch.name, discard: true }, { refresh: false });
    if (!owns()) return;
    if (result?.failed?.length || result?.remaining?.length) {
      show('资源清理未全部完成；已回收部分保留记录，请检查失败现场后处理，未完成成果验收。', 'error');
    } else {
      const count = Number(result?.count) || 1;
      const dropped = result?.discarded ? '，已丢弃未提交改动' : '';
      show(`${branch.name} 及其范围内 ${count} 条分支资源已清理${dropped}；Worker、结果与运行历史保留，这不是成果验收。`);
    }
    try { await refresh?.(); }
    catch (error) { if (owns()) show(`清理请求已处理，但刷新失败：${error.message}`, 'error'); }
  } catch (error) { if (owns()) show(error.message, 'error'); }
}
