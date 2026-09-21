# 工作区与分支回收

本文件管工作区与分支回收的安全门：`update-ref` compare-and-delete、`keep-branch`，以及与安全回收不同的归档路径。

工作区清理不强制删除。任务分支只有在 tip 仍包含审阅过的 `head_commit`、且整个 tip 已进入其 recorded direct parent / `target_branch` 时才删；因此聚合进来的子分支提交不会被误判为篡改，也不会丢失。删除使用 compare-and-delete；拿不准就保留并说明 reason。`--keep-branch` 可只回收 worktree。

**输入分支**（`lush/<项目哈希>/input-<id>` 与它的检出）没有 task owner。未推进时可直接回收；若已聚合子分支，只有在 worktree 干净且当前 tip 已进入 recorded parent 后才 compare-and-delete。否则目录与分支一起保留并说明原因。只有 `task clear` 调 `reclaimAnchors`；字段/返回名继续用 anchor 以兼容旧库。

Plan 编译出的工作由 Integration Service 在私有 Intent 分支内自动叶子优先聚合；这不会改变 cleanup 的安全门——回收仍然要求 tip 已进入直接父分支，只是这种工作通常会自然满足该条件（因为它已经 auto-integrate 进了 Intent 分支）。目标分支仍未前进，所以 `Candidate accepted` 之前的输入分支依然会被 cleanup 保留。

分支真的被删掉时，谱系记录只把 `status` 标成 `deleted`，**不删行**：子分支的 parent 指针必须继续有效，所以 `[deleted]` 的节点仍出现在 `lush branch tree` 里，它的子分支照旧挂在下面。外部（用户自己 `git branch -D`）删掉的分支由读模型按 ref 现状显示，不写库。详见 [分支谱系](branch-genealogy.md)。

## 分支归档

`lush branch archive BRANCH [--discard]`（RPC `branch.archive {branch, discard?}`，用户专属）是**显式放弃一条分支的代码**的路径，与上面的安全回收是两件不同的事。**归档一条＝归档它整棵子树**：任务分支是从输入锚点长出来的，只删一半会留下一批「父分支已不在」的后代，所以传进来的那条是子树根，它的全部后代一起归档（已经归档 / 回收过的后代跳过）：

- cleanup / `task cleanup` / `task clear` 是**安全回收**：必须先证明分支的成果已经进入目标分支（tip 仍含审阅过的 `head_commit`，且 tip 是目标分支的祖先），证明不了就保留并说明 reason。
- 归档是**明知可能未合并也允许删**：用户明确表示不再要这棵子树的代码，runtime 不再做祖先检查——因此 `archiveBranch` 是 Git 边界里唯一一条这样的 compare-and-delete。

归档保留的东西：`branches` 谱系行（`status` 标成 `archived`，`deleted_at` 兼作归档时间，不为它另加列）、子树里每条分支上的任务行、消息、事件，以及不随 worktree 消失的 pi 会话文件（`<home>/sessions/`；位置写进 `branch.archived` 事件，任务行以后被 clear 掉也查得回）。被删掉的只有子树里每一条的 worktree 与本地 ref：任务行的 `workspace` 清成 `NULL`，`branch` 字段是历史、继续保留。

**归档的节点不再占分支树**（Web 分支图与 `branch tree` 都不画）：它们是记录，用 `branch show` / `branch.archive` 事件 / 任务详情查；见[分支谱系](branch-genealogy.md)。

安全门（任一不满足就报错且无副作用）：子树根必须已登记（`lush branch import`）、当前不是 `archived` / `deleted`、当前检出分支不在子树里，并且**整棵子树上都没有未终态任务**（`completed` / `failed` / `cancelled` 之外的状态）。默认不丢未提交改动：Git 边界先把整棵子树的 tip / worktree 收齐，`clean` 不过就直接报错，提示用 `--discard` 才能继续（任一脏 worktree 都会在动任何东西之前失败，不留「归档了一半」的子树）；只有显式 `--discard` 才会连着未提交改动一起删掉 worktree。ref 仍用 compare-and-delete，只删掉我们看过的那一个 tip。

归档不删行、不动后代与父分支的 `parent` 指针，所以谱系仍是历史；它与「删除」只在 `branches.status` 上分开（`active` / `archived` / `deleted`）。详见 [分支谱系](branch-genealogy.md)。

## 任务定向删除

`lush task delete ID`（RPC `task.delete {id}`，用户专属，Web 只在分支图末尾的兜底分组里给按钮）删的是**行**，不是代码：它把这条已结束任务与它的**全部已结束后代**从库里删掉，连同这些任务自己的 `messages` / `notices` / `events` / `agent_runs` / `artifacts` / 两端 `task_deps` 与它们这一批 planner 写的 `task_specs`。这是 `task clear` 之外唯一会丢任务历史的路径，所以安全门比 clear 更细（任一不满足就报错，一行都不删）：

- 子树里任何一条还在 `queued` / `running` / `waiting` / `awaiting`，或它的 invocation 还在收尾、cleanup 正在走它的 worktree：拒绝；
- 子树里的 planner 还留着未编排的 `pending` spec：拒绝（删掉那些条目等于替用户丢掉还没处理的拆解）；
- 集合外还有 verifier / resolver / 验收候选用外键指着它（`verifies_task_id` / `resolves_task_id` / `review_candidates.report_task_id`）：拒绝并点名，先删引用方；
- 磁盘状态（worktree / 对照检出 / 任务分支）先跑与 `task cleanup` 相同的安全门。有一条收不回来就整体不删，把 `#id (reason)` 列出来——绝不为了删一行库而丢未合并的成果。

分支谱系行（`branches.task_id`）与输入行（`inputs.task_id`）刻意没有外键，不跟着清：id 不复用，所以这些历史指针仍指着曾存在的那条任务，读模型按「已清空」处理（见 `project/branches.js`）。删掉的只有行：磁盘上的 pi 会话文件（`.lush/sessions/`）与 `.lush/verify/*/report.html` 不受影响。删除会留一条 `task_id` 为空的 `task.deleted` 项目级事件，把被删的 id / 角色 / 状态与各表行数记在 `data` 里（这条事件没有任务可挂，要查用 SQL）。返回 `{deleted: {root, ids, tasks, messages, notices, events, agent_runs, artifacts, task_deps, task_specs}, reclaimed: {worktrees, branches}, next_task_id}`。

相关：[批准合并](merge.md)、[检验与对照检出](verification.md)、[分支谱系](branch-genealogy.md)、[磁盘回收与清空](../reference/rpc/maintenance.md)。
