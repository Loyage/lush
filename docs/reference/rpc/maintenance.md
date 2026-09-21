# 磁盘回收与清空

本节管三个终态清理入口：`task.cleanup`（回收一个已结束任务占的磁盘状态）、`task.delete`（定向删掉一条已结束任务及其已结束后代）与 `task.clear`（用户专属的一键清空），包括它们的安全门、保留策略与 id 不复用。

| CLI | RPC | 参数 |
|---|---|---|
| `task cleanup ID [--keep-branch]` | `task.cleanup` | `{id, keep_branch?}` |
| `task delete ID` | `task.delete` | `{id}` |
| `task clear` | `task.clear` | `{}` |

这三个入口都是**安全回收**：只有能证明成果已进入目标分支的磁盘状态才会删。用户明确不再要某条分支的代码（允许未合并）时走归档 `branch.archive`：它删 worktree 与本地 ref，但保留谱系行、任务行、消息、事件与 pi 会话文件，见[分支谱系](branches.md)。

`task.cleanup` 回收一个已结束任务占的磁盘状态：worktree 目录、检验对照检出（如果有）与任务分支。只有 `integration` 为 `merged` / `none` / `superseded` 的任务可回收（`superseded` 是「这一轮解冲突已被下一轮取代」，分支仍当恢复点看待）。worktree 仍然不强制删除（干净检查 + commit 已进 HEAD 的检查不变）；分支额外要求**它的顶端就是审阅过的那次提交**，且那次提交已经是 `target_branch` 的祖先——任一条不满足就保留分支，并在返回的 `cleanup.branch` / `cleanup.reason` 里说明。删除用 `git update-ref -d <ref> <tip>` 的 compare-and-delete，不用 `--force`：检查之后分支被谁动过就拒绝，审阅过之外的提交一条也不会丢；`branch` 快照不再存在时库里也会清空。`keep_branch: true`（CLI `--keep-branch`）只回收 worktree，把分支留成恢复点。返回 `{...task, cleanup: {worktree: removed|absent, branch: removed|kept|absent, reason}}`。

`task.delete` 是用户专属的**定向删除**：只删一条已结束任务与它的全部已结束后代，范围是这一棵子树。它与 `task.clear` 共用「先回收、再清库」的门，但只删集合内的行：这些任务自己的 `messages`（含它们发给别人的）、`notices`、`events`、`agent_runs`、`artifacts`、两端 `task_deps`，以及它们这一批 planner 写的 `task_specs`；集合外的行一行不动。与 clear 的区别：

- **收不回来就整体不删**（clear 是保留下来照样清库）：磁盘状态先跑与 `task cleanup` 相同的安全门，任何 `worktree` / `branch` 判为 `kept` 就报 `#7 (unmerged work must be kept) cannot be reclaimed; finish or clean it up first (lush task cleanup ID)`，一行都不删。
- 子树里的 planner 还有 `pending` spec 时拒绝（`planner #68 still has pending specs; compile, approve or drop them before deleting it`）——clear 是连 spec 一起清，定向删除不能替用户丢掉还没处理的拆解。
- 集合外还有 `verifies_task_id` / `resolves_task_id` / `review_candidates.report_task_id` 指着它时拒绝（`#7 is still referenced by verifier #9; delete the referrer first`）：verifier、merger 与候选是独立记录，不跟任务一起走。
- `branches.task_id` / `inputs.task_id` / `task_specs.task_id` 与 `batch_id` 刻意没有外键，不跟着清（id 不复用，历史指针不会指错）；一条输入的根 planner 被删后，这条输入不再出现在 intent 列表（那个列表由 `inputs JOIN tasks` 派生）。

删除会留一条 `task_id` 为空的 `task.deleted` 事件作审计（`data` 里是被删任务的 id / 角色 / 状态与各表行数）；task id 与 clear 一样写进 `meta.task_id_high`，永不复用。返回 `{deleted: {root, ids, tasks, messages, notices, events, agent_runs, artifacts, task_deps, task_specs}, reclaimed: {worktrees, branches}, next_task_id}`。

`task.clear` 是用户专属的**一键清空**：把全部任务行及 `messages` / `notices` / `task_deps` / `events`，连同 `inputs` 与 `drafts` 一起删掉（这是 `draft.remove` 那条「已提交输入永不删除」的唯一例外，且只在这里）。前置条件是**当前没有活动任务**，并且没有 invocation 正在收尾、没有 worktree 清理在进行：有 `queued`/`running`/`waiting`/`awaiting` 时返回 `#3, #7 still active (2); cancel them or wait until they finish`，不做隐式取消（删掉正在调用中的 task 行会让 agent 收尾时读到不存在的 task）。

它**先回收再清库**：对每个已结束任务跑与 `task cleanup` 相同的安全门；每条输入也尝试回收 `input-<id>` 的检出与分支（未推进，或当前 tip 已进入直接父分支时才允许），返回 `reclaimed: {worktrees, branches, anchors}`。回收不掉的任务（`integration=pending/review/conflict` 的未合并成果、审阅后又被改过的分支、脏工作区）连同目录与分支一起保留，`retained.tasks` 列出 `{id, branch, workspace, baseline_workspace, reason}`；动手改过或被谁提交过的锚点整份保留，`retained.anchors` 列出 `{id, branch, status, reason}`。`.lush/sessions/*.jsonl` 与 `.lush/verify/*/report.html` 不受影响。因为目录名与分支名里带着 task id / input id，**两类 id 都不会被复用**：清空后 daemon 把用过的最大值记在 `meta.task_id_high` 与 `meta.input_id_high`，下一个任务与下一条输入继续往大走（`next_task_id` / `next_input_id` 是清空后将要使用的 id），因此新 worktree 不会撞上保留下来的旧目录。前置检查是同步的（调用时立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。返回 `{cleared: {tasks, inputs, drafts, notices, messages, events, task_deps}, reclaimed, retained, next_task_id, next_input_id}`。
