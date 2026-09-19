# 输入和规划

本文件管一次输入如何落库、如何被规划，以及 `inputs.flow` 判定与改判。

`input.submit` 在一个事务中写 Input、根 planner Task、关联字段和创建事件，然后通过 microtask 启动调度。

每条输入有自己的 planner；不会复用长期被占用的单个根任务。调度器保留一个规划槽，执行任务使用另外 N 个槽。因此一个规划任务派活后等待，不会阻碍其他输入被规划。规划本身不是无限并发，以免大量输入造成不受控模型调用。

每条输入还带一个流程判定（`inputs.flow`，未判定按 develop 处理）：`develop` 照常拆解出 worker/coordinator/research；`explain` 只解答、不产出代码，根 planner 直接把结论写进 result，必要时只派 research。runtime 在 `Project.spawn` 层硬校验 `explain` 子树只允许 research，因此了解类输入不会创建 worktree、不会产生待合并改动。判定与改判由根 planner / 用户经 `input.flow` 写入；改判只影响之后的 spawn，不追溯已建子任务。

相关：[意图层与拆解队列](intent-layer.md)、[计划审批闸门](plan-gate.md)。
