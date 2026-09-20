# Git 边界

本文件管 runtime 的 Git 原语、worktree / 分支创建、主树脏的语义与 `diff` 的 `base_behind`。

所有 runtime 管理的 Git 操作使用 argv 数组、不经 shell 插值，共享异步串行队列。排队等待 Git 不阻塞事件循环、输入提交或已有 RPC。

worker 创建时先看**这条输入的锚点**（提交输入那一刻记下的 `anchor_commit` / `anchor_branch` / `anchor_target_branch`），锚点不存在时才退回当时的项目 HEAD。分支名与目录是 `.lush/worktrees/<id>-<name>` 与 `lush/<project-hash>/<id>-<name>`（`name` 是 spawn 时 planner 给的英文短名，见 `src/core/naming.js`）；`base_commit` 与 `target_branch` 随之被冻结，谱系的 `parent` 写锚点分支。有 `code` 依赖时基线是上游任务的 `head_commit`（stacked），解冲突任务的基线是目标分支顶端，两种情况都不看锚点。每个 worker 是独立修改集，不自动继承其他未合并任务成果。`git worktree add` 只读已提交的 commit、不碰用户现场，所以**建 worktree 不要求主工作树干净**：`spawn` 时 main tree 的未提交改动不传递给 worker，这份分歧记进 `workspace.created` 事件的 `dirty_source`（有锚点时真正重要的是 `input.anchor` 事件里提交那一刻的 `dirty_source`），`task.diff` 的 `base_behind` 报告基线落后目标分支的提交数。注意 planner / coordinator / research 的 cwd 就是主工作树，它们读到的是带未提交改动的现场，而 worker 读到的是干净 worktree。

## 输入锚点

提交输入时（`input.submit` / `draft.commit`）就从**当前检出分支的顶端**建出 `lush/<项目哈希>/input-<id>-anchor` 与 `.lush/worktrees/input-<id>-anchor`，把「这份代码」冻在那一刻：`anchor` 的三个字段先落库（`branches` 行也在这时写入），再跑 `git worktree add -b`；失败就回滚并拿掉磁盘上的残留（见 [输入和规划](inputs-and-planning.md)）。锚点检出是只读语义的快照：没有 agent 在里面跑，也没有任务往里提交，所以回收时只要求 `clean` + 分支顶端仍等于锚定 commit，然后 `update-ref -d` compare-and-delete；任一条不满足就整份（目录 + 分支）保留。只有 `task clear` 会回收它们。

合并见 [批准合并](merge.md)，检验对照检出见 [检验与对照检出](verification.md)，回收见 [工作区与分支回收](cleanup.md)，创建关系的记录见 [分支谱系](branch-genealogy.md)。

Lush 无法锁住用户的编辑器或外部 Git 进程；合并期间不要并发修改主工作树。Agent 工具也不是 OS 沙箱，目录/角色约束不能阻止恶意 shell 命令。
