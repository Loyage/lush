# 工作区与分支回收

本文件管工作区与分支回收的安全门：`update-ref` compare-and-delete、`keep-branch`，以及与安全回收不同的归档路径。

工作区清理不强制删除。任务分支只有在 tip 仍包含审阅过的 `head_commit`、且整个 tip 已进入其 recorded direct parent / `target_branch` 时才删；因此聚合进来的子分支提交不会被误判为篡改，也不会丢失。删除使用 compare-and-delete；拿不准就保留并说明 reason。`--keep-branch` 可只回收 worktree。

**输入分支**（`lush/<项目哈希>/input-<id>` 与它的检出）没有 task owner。未推进时可直接回收；若已聚合子分支，只有在 worktree 干净且当前 tip 已进入 recorded parent 后才 compare-and-delete。否则目录与分支一起保留并说明原因。只有 `task clear` 调 `reclaimAnchors`；字段/返回名继续用 anchor 以兼容旧库。

分支真的被删掉时，谱系记录只把 `status` 标成 `deleted`，**不删行**：子分支的 parent 指针必须继续有效，所以 `[deleted]` 的节点仍出现在 `lush branch tree` 里，它的子分支照旧挂在下面。外部（用户自己 `git branch -D`）删掉的分支由读模型按 ref 现状显示，不写库。详见 [分支谱系](branch-genealogy.md)。

## 分支归档

`lush branch archive BRANCH [--discard]`（RPC `branch.archive {branch, discard?}`，用户专属）是**显式放弃一条分支代码**的路径，与上面的安全回收是两件不同的事：

- cleanup / `task cleanup` / `task clear` 是**安全回收**：必须先证明分支的成果已经进入目标分支（tip 仍含审阅过的 `head_commit`，且 tip 是目标分支的祖先），证明不了就保留并说明 reason。
- 归档是**明知可能未合并也允许删**：用户明确表示不再要这条分支的代码，runtime 不再做祖先检查——因此 `archiveBranch` 是 Git 边界里唯一一条这样的 compare-and-delete。

归档保留的东西：`branches` 谱系行（`status` 标成 `archived`，`deleted_at` 兼作归档时间，不为它另加列）、该分支上的任务行、消息、事件，以及不随 worktree 消失的 pi 会话文件（`<home>/sessions/`；位置写进 `branch.archived` 事件，任务行以后被 clear 掉也查得回）。被删掉的只有 worktree 与本地 ref：任务行的 `workspace` 清成 `NULL`，`branch` 字段是历史、继续保留，所以归档分支的任务仍留在分支图上。

安全门（任一不满足就报错且无副作用）：分支必须已登记（`lush branch import`）、当前不是 `archived` / `deleted`、不是当前检出分支，并且**这条分支自己与全部后代分支上都没有未终态任务**（`completed` / `failed` / `cancelled` 之外的状态）。默认不丢未提交改动：worktree 脏时 `clean` 直接报错，提示用 `--discard` 才能继续；只有显式 `--discard` 才会连着未提交改动一起删掉 worktree。ref 仍用 compare-and-delete，只删掉我们看过的那一个 tip。

归档不删行、不动子分支的 `parent` 指针，所以子分支照旧挂在下面；它与「删除」只在 `branches.status` 上分开（`active` / `archived` / `deleted`）。详见 [分支谱系](branch-genealogy.md)。

相关：[批准合并](merge.md)、[检验与对照检出](verification.md)、[分支谱系](branch-genealogy.md)。
