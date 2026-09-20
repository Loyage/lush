# 输入和规划

本文件管一次输入如何落库、如何被规划，以及 `inputs.flow` 判定与改判。

`input.submit` 先把「提交这一刻的代码」锚下来（见下），再在一个事务中写 Input、根 planner Task、关联字段、`input.anchor` 事件，然后通过 microtask 启动调度。锚点是一次 Git 操作，所以这个入口会短暂排在 Git 串行队列里（可能等正在进行的合并），但仍然不等待任何 agent。

## 输入锚点

提交输入的那一刻，runtime 从当前检出的分支顶端拉出 `lush/<项目哈希>/input-<id>-anchor`，并在 `.lush/worktrees/input-<id>-anchor` 做一份检出，四个字段记在 `inputs` 行上：`anchor_branch` / `anchor_commit` / `anchor_workspace` / `anchor_target_branch`。它的含义只有一个：**这条输入看到的是哪份代码**，不取决于任务什么时候才开工。规划要花时间，用户在这期间还会继续在主树上提交；没有锚点时 worker 的基线会跟着漂到「它真正跑起来的那一刻」，有了锚点就是「你按下回车的那一刻」。

- 没有 `code` 依赖、也不是解冲突任务的 worker 以 `anchor_commit` 为 `base_commit`、以 `anchor_target_branch` 为目标分支，分支谱系的 `parent` 写锚点分支（见 [分支谱系](branch-genealogy.md)）。有 `code` 依赖时仍然栈叠在上游任务的分支上：锚点让位给显式依赖。
- 锚点属于**输入**而不是任务：没有 agent 在锚点检出里跑，planner 的 cwd 仍是主工作树，所以它不会进任务树、`task.diff` 或分支图（分支图只画会产出改动的任务）。
- 锚点失败（不是 Git 仓库、detached HEAD、分支名已被占用）就**整条输入不落库**：事务回滚、已建的锚点顺手回收、缓存的草稿留在缓存里。语义是「锚不住就不接受输入」。
- 提交时主树的未提交改动不进入锚点（`git worktree add` 只读已提交的 HEAD），这份分歧记在 `input.anchor` 事件的 `dirty_source` 里。
- `explain` 输入同样有锚点：判定流程要等 planner 跑起来才知道，而锚点必须在提交时就建。了解类输入因此不产生**任务** worktree、也不产生待合并改动，但会留一份只读快照；`task clear` 会把它回收掉。

每条输入有自己的 planner；不会复用长期被占用的单个根任务。调度器保留一个规划槽，执行任务使用另外 N 个槽。因此一个规划任务派活后等待，不会阻碍其他输入被规划。规划本身不是无限并发，以免大量输入造成不受控模型调用。

每条输入还带一个流程判定（`inputs.flow`，未判定按 develop 处理）：`develop` 照常拆解出 worker/coordinator/research；`explain` 只解答、不产出代码，根 planner 直接把结论写进 result，必要时只派 research。runtime 在 `Project.spawn` 层硬校验 `explain` 子树只允许 research，因此了解类输入不会产生待合并改动。判定与改判由根 planner / 用户经 `input.flow` 写入；改判只影响之后的 spawn，不追溯已建子任务。

相关：[意图层与拆解队列](intent-layer.md)、[计划审批闸门](plan-gate.md)。
