# 磁盘回收

本节管终态Worker的磁盘回收入口 `worker.cleanup`，包括它的安全门、保留策略与返回字段；用户明确不再要某条分支的代码（允许未合并）时走归档 `branch.archive`，见[分支谱系](branches.md)。`task.delete` / `task.clear` 已下线，不再有公开 RPC / CLI / Web 入口。

| CLI | RPC | 参数 |
|---|---|---|
| `worker cleanup ID [--keep-branch]` | `worker.cleanup` | `{id, keep_branch?}` |

`worker.cleanup` 回收一个已结束Worker占的磁盘状态：worktree 目录、检验对照检出（如果有）与Worker分支。只有 `integration` 为 `merged` / `none` / `superseded` 的Worker可回收（`superseded` 是「这一轮解冲突已被下一轮取代」，分支仍当恢复点看待）。worktree 仍然不强制删除（干净检查 + commit 已进 HEAD 的检查不变）；分支额外要求**它的顶端就是审阅过的那次提交**，且那次提交已经是 `target_branch` 的祖先——任一条不满足就保留分支，并在返回的 `cleanup.branch` / `cleanup.reason` 里说明。删除用 `git update-ref -d <ref> <tip>` 的 compare-and-delete，不用 `--force`：检查之后分支被谁动过就拒绝，审阅过之外的提交一条也不会丢；`branch` 快照不再存在时库里也会清空。`keep_branch: true`（CLI `--keep-branch`）只回收 worktree，把分支留成恢复点。返回 `{...task, cleanup: {worktree: removed|absent, branch: removed|kept|absent, reason}}`。

验收完成不隐含磁盘回收：待验收 `awaiting_acceptance` 的 Worker 保留工作区供追加输入；派生 child 由其直接父 Agent 检查并确认，无需用户逐个验收；后代结算后，用户 `worker.accept` 验收自己的 say，随后才可显式清理或归档；验收不会隐式验收后代，现有回收终态门保持。新式 Squash 交付按固定源提交、已落地树及父提交受检；本轮 ref 漂移或新增未交付改动不能借上轮 merged 状态删除。已归档Worker不自动重建。见[持续迭代](../../engineering/task-iteration.md)。

旧输入分支（`lush/<项目哈希>/input-<id>` 与它的检出）与旧 planner 工作区仍可能留在磁盘上；它们不再由新的公开入口创建，daemon 也不会自动回收或重放。

相关：[工作区与分支回收](../../engineering/cleanup.md) · [分支谱系](branches.md) · [分支合并](../../engineering/merge.md)
