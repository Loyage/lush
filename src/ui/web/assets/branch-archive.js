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
  + '未提交改动会随 worktree 一起丢失；Worker、消息、事件与会话记录都保留。归档是放弃这条分支代码的记录状态，'
  + '历史内部合并队列随父 Worker 一起归档；不等于删除 Worker——之后可在 Worker 树表头「显示已归档」里看到它。';

/** 归档一子树分支；组合动作在一次事前确认后先验收，验收失败则不归档。 */
export async function runBranchArchive(branch, { refresh, acceptBeforeArchive = null } = {}) {
  const descendants = Number(branch.subtreeBranches) || 0;
  const scope = descendants
    ? `会删除这条分支与它下面 ${descendants} 条后代分支的 worktree 与本地 ref`
    : '会删除这条分支的 worktree 与本地 ref';
  const confirmed = await confirmDialog({
    title: acceptBeforeArchive ? `验收并归档 ${branch.name}？` : `归档 ${branch.name}？`,
    message: `${acceptBeforeArchive ? '先完成验收，再归档：' : ''}${scope}，保留 Worker、会话与分支记录（记录仍可在「分支详情」与 Worker 详情里查）；历史内部合并队列随父 Worker 一起归档，未提交改动会被丢弃。${acceptBeforeArchive ? '验收失败不归档；归档失败不撤销验收，可稍后单独重试归档。' : ''}`,
    confirmLabel: acceptBeforeArchive ? '验收并归档' : '归档',
    cancelLabel: acceptBeforeArchive ? '取消' : '保留',
    danger: true,
    confirmHelp: `${acceptBeforeArchive ? '先确认成果，不调用 Agent；验收成功后执行归档。' : ''}${BRANCH_ARCHIVE_HELP}`,
  });
  if (!confirmed) return;
  try {
    if (acceptBeforeArchive && !await acceptBeforeArchive()) return;
    const result = await action('branch.archive', { branch: branch.name, discard: true });
    const count = Number(result?.count) || 1;
    const dropped = result?.discarded ? '，已丢弃未提交改动' : '';
    show(count > 1
      ? `已归档 ${branch.name} 及它下面 ${count - 1} 条后代分支（共 ${count} 条）：worktree 与本地 ref 已删${dropped}，Worker、会话与分支记录都保留`
      : `${branch.name} 已归档（worktree ${result?.worktree ?? 'absent'}、分支 ${result?.ref ?? 'absent'}${dropped}）；Worker 与会话已保留`);
    await refresh?.();
  } catch (error) { show(error.message, 'error'); }
}
