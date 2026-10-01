/**
 * 「归档分支」这条用户动作的唯一实现：Task 图 / Task 详情两个入口共用。
 * 归档一条＝归档它整棵子树（删每条的 worktree 与本地 ref），但 Task、消息、事件、pi 会话记录都保留，
 * 所以它是「放弃这条分支代码」的记录状态，不是删除 Task。归档后分支、它名下的 Task 与历史内部合并队列不再占 Task 图主视图，
 * 可用表头「显示已归档」开关临时查看。
 *
 * 确认走应用内弹窗（dialog.js）——原生 confirm 会被浏览器静默吃掉，按钮会变成什么都不做。
 * 真正的安全门在 daemon 侧的 `branch.archive`（冻结 / 未集成请求 / 活动任务 / running invocation），
 * 这里只负责把代价说清楚、发请求、把结果写进顶部提示。
 */
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { show } from './messages.js';

/** 「归档」的统一含义说明：两个入口共用同一句代价，改文案只改这一份。 */
export const BRANCH_ARCHIVE_HELP = '归档这条分支及它下面的全部后代分支：删除 worktree 与本地 ref，'
  + '未提交改动会随 worktree 一起丢失；Task、消息、事件与会话记录都保留。归档是放弃这条分支代码的记录状态，'
  + '历史内部合并队列随父 Task 一起归档；不等于删除 Task——之后可在任务树表头「显示已归档」里看到它。';

/** 归档一子树分支；`refresh` 由调用方决定重拉哪个视图（Task 图 / Task 详情），默认什么也不做。 */
export async function runBranchArchive(branch, { refresh } = {}) {
  const descendants = Number(branch.subtreeBranches) || 0;
  const scope = descendants
    ? `会删除这条分支与它下面 ${descendants} 条后代分支的 worktree 与本地 ref`
    : '会删除这条分支的 worktree 与本地 ref';
  const confirmed = await confirmDialog({
    title: `归档 ${branch.name}？`,
    message: `${scope}，保留任务、会话与分支记录（记录仍可在「分支详情」与任务详情里查）；历史内部合并队列随父 Task 一起归档，未提交改动会被丢弃。`,
    confirmLabel: '归档',
    cancelLabel: '保留',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await action('branch.archive', { branch: branch.name, discard: true });
    const count = Number(result?.count) || 1;
    const dropped = result?.discarded ? '，已丢弃未提交改动' : '';
    show(count > 1
      ? `已归档 ${branch.name} 及它下面 ${count - 1} 条后代分支（共 ${count} 条）：worktree 与本地 ref 已删${dropped}，任务、会话与分支记录都保留`
      : `${branch.name} 已归档（worktree ${result?.worktree ?? 'absent'}、分支 ${result?.ref ?? 'absent'}${dropped}）；任务与会话已保留`);
    await refresh?.();
  } catch (error) { show(error.message, 'error'); }
}
