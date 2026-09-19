# 磁盘回收与清空

本节管两个终态清理入口：`task.cleanup`（回收一个已结束任务占的磁盘状态）与 `task.clear`（用户专属的一键清空），包括它们的安全门、保留策略与 id 不复用。

| CLI | RPC | 参数 |
|---|---|---|
| `task cleanup ID [--keep-branch]` | `task.cleanup` | `{id, keep_branch?}` |
| `task clear` | `task.clear` | `{}` |

`task.cleanup` 回收一个已结束任务占的磁盘状态：worktree 目录、检验对照检出（如果有）与任务分支。只有 `integration` 为 `merged` / `none` / `superseded` 的任务可回收（`superseded` 是「这一轮解冲突已被下一轮取代」，分支仍当恢复点看待）。worktree 仍然不强制删除（干净检查 + commit 已进 HEAD 的检查不变）；分支额外要求**它的顶端就是审阅过的那次提交**，且那次提交已经是 `target_branch` 的祖先——任一条不满足就保留分支，并在返回的 `cleanup.branch` / `cleanup.reason` 里说明。删除用 `git update-ref -d <ref> <tip>` 的 compare-and-delete，不用 `--force`：检查之后分支被谁动过就拒绝，审阅过之外的提交一条也不会丢；`branch` 快照不再存在时库里也会清空。`keep_branch: true`（CLI `--keep-branch`）只回收 worktree，把分支留成恢复点。返回 `{...task, cleanup: {worktree: removed|absent, branch: removed|kept|absent, reason}}`。

`task.clear` 是用户专属的**一键清空**：把全部任务行及 `messages` / `notices` / `task_deps` / `events`，连同 `inputs` 与 `drafts` 一起删掉（这是 `draft.remove` 那条「已提交输入永不删除」的唯一例外，且只在这里）。前置条件是**当前没有活动任务**，并且没有 invocation 正在收尾、没有 worktree 清理在进行：有 `queued`/`running`/`waiting`/`awaiting` 时返回 `#3, #7 still active (2); cancel them or wait until they finish`，不做隐式取消（删掉正在调用中的 task 行会让 agent 收尾时读到不存在的 task）。

它**先回收再清库**：对每个已结束任务跑与 `task cleanup` 相同的安全门，能回收的连 `.lush/worktrees/<id>-<name>/`、派生对照检出与 `lush/<项目哈希>/<id>-<name>` 分支一起删，返回 `reclaimed: {worktrees, branches}`。回收不掉的任务（`integration=pending/review/conflict` 的未合并成果、审阅后又被改过的分支、脏工作区）连同目录与分支一起保留，`retained.tasks` 列出 `{id, branch, workspace, baseline_workspace, reason}` 供人工决定去留。`.lush/sessions/*.jsonl` 与 `.lush/verify/*/report.html` 不受影响。因为目录名与分支名里带着 task id，**id 不会被复用**：清空后 daemon 把用过的最大 id 记在 `meta.task_id_high`，下一个任务继续往大走（`next_task_id` 是清空后将要使用的 id），因此新 worktree 不会撞上保留下来的旧目录。前置检查是同步的（调用时立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。返回 `{cleared: {tasks, inputs, drafts, notices, messages, events, task_deps}, reclaimed, retained, next_task_id}`。
