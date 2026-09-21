# 意图层与拆解队列

本文件管 `layer='intent'` 的 planner / scheduler、spec 的批次边界与 `spec drop`。

用户输入存 `inputs`（意图），它对应一个根 planner task。**planner 与 scheduler 属于 `layer='intent'`，不进任务树/任务列表/时间轴**：`task.list` / `task.tree` / `task.timeline` 只读 `layer='work'`，planner/scheduler 的进度跟着 `input.list` 下发（每条意图带 planner 状态与闸门、拆解计数、scheduler id 与状态）。按 id 仍可 `task.inspect` / `task.tree` 一个 planner 或 scheduler——Web 的意图卡片就是从这跳进去的。它们虽然不进任务树 / 列表 / 时间轴，但会作为任务节点出现在分支图里，挂在对应输入的锚点分支下；planner 待批的 plan notice 也直接画在那条任务行里，用户就地批准 / 驳回（`plan.approve` / `plan.reject`），不必先开意图面板。work 任务的 `parent_id` 仍是它所属的 scheduler（消息、结算、唤醒都靠这条边），只是在树上被“提上来”当根。

planner 不直接派活：它把每条可独立完成的工作写成一条 spec（`task_specs`，状态 `pending`），scheduler 再把它变成真实 task。一个 planner 的**一轮拆解**（这一次 invocation 里写下的全部 spec）在它停止执行后作为**同一批**交给同一个 scheduler：批次边界是「谁写的」，不是「哪一刻写的」。

- planner 还在跑（`queued` / `running`）时，它写的 spec 一条都不会被取走，所以不会出现只包含前几条的半成品批次；写完一轮直接结束本轮即可。停止执行包括停在 `awaiting`（发 notice 等用户答复）：这一轮已写好的条目不会被别人的答复卡住；答复后醒来补写的 spec 算新的一轮、新的一批。
- 同一批内没有依赖边的 spec 会同时开工（受并发上限限制）：用户一次提交里的两条独立需求不会被拆成前后两轮。
- 批次之间串行：同一项目同时只有一个未终态 scheduler，前一批收尾（子任务全部终态）后下一批才出生。`Project.spawn` 校验 scheduler 只能 spawn 自己批里的 spec。
- planner 或持有该批的 scheduler 可以 `spec drop`；scheduler 结束时未处理的 spec 标为 `dropped`，被取消则退回队列等下一批。

相关：[计划审批闸门](plan-gate.md)、[一次 invocation](invocation.md)。
