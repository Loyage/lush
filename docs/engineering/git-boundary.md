# Git 边界

本文件管 runtime 的 Git 原语、worktree / 分支创建、主树脏的语义与 `diff` 的 `base_behind`。

所有 runtime 管理的 Git 操作使用 argv 数组、不经 shell 插值，共享异步串行队列。排队等待 Git 不阻塞事件循环、输入提交或已有 RPC。

worker 创建时记录项目 HEAD 与目标分支，创建 `.lush/worktrees/<id>-<name>` 和 `lush/<project-hash>/<id>-<name>` 分支（`name` 是 spawn 时 planner 给的英文短名，见 `src/core/naming.js`）。每个 worker 是独立修改集，不自动继承其他未合并任务成果。`git worktree add` 只读已提交的 HEAD、不碰用户现场，所以**建 worktree 不要求主工作树干净**：spawn 时 main tree 的未提交改动不传递给 worker，这份分歧记进 `workspace.created` 事件，`task.diff` 的 `base_behind` 报告基线落后目标分支的提交数。注意 planner / coordinator / research 的 cwd 就是主工作树，它们读到的是带未提交改动的现场，而 worker 读到的是干净 worktree。

合并见 [批准合并](merge.md)，检验对照检出见 [检验与对照检出](verification.md)，回收见 [工作区与分支回收](cleanup.md)。

Lush 无法锁住用户的编辑器或外部 Git 进程；合并期间不要并发修改主工作树。Agent 工具也不是 OS 沙箱，目录/角色约束不能阻止恶意 shell 命令。
