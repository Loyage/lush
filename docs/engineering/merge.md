# 批准合并与交付队列

本文件管批准合并、按目标分支组织的交付队列、快进优先策略、内容冲突与合并冻结、解冲突任务的落地守卫及 `superseded`。

worker worktree 与分支的创建见 [Git 边界](git-boundary.md)。

## 任务与交付是两套视图

任务树回答“谁在做什么”；`task.ladder` 返回的交付队列回答“哪个提交将进入哪个目标分支”。队列按 `target_branch` 分组，并以原始 worker task 作为稳定条目：解冲突 task 只是该条目的当前 `source_task_id`，不会与原任务并列成两个可合并候选。

交付阶段从现有 task、resolver 与依赖边派生，不增加持久化实体：

- `awaiting_review`：结果完成，待审阅与批准；
- `review_required`：上次合并中断，需检查仓库后重新批准；
- `conflict_decision`：等待是否启动解冲突；
- `resolving`：resolver 正在等待/执行；
- `resolution_ready`：resolver 已完成，真正落地来源是它的分支；
- `resolution_stale`：目标分支已前进，resolver 无法再快进落地，需要明确废弃后重开。

每项另带 `ready`、`selectable` 与结构化 `blockers`。`ready` 表示单项现在即可落地；code 上游尚未落地时它为 false，但只要完整上游栈也在同一目标分支队列里，`selectable` 仍为 true，勾选下游会自动带上上游。错误目标分支、冲突冻结或 resolver 尚未完成属于硬 blocker，不能编入批次。`order` 只约束任务执行；只有 `code`（分支基线）进入交付拓扑。

## 一次批准

结果提交后进入 `integration=pending`。用户 `task.merge` 检查主工作树/worker 干净、当前分支等于原目标分支、已审阅的 commit 未变化，并检查 code 上游确实已经是目标分支祖先，再持久化批准事件和 `merging`，执行 merge。成功为 `merged`。

合并优先快进：目标分支顶端是该提交的祖先时用 `--ff-only`；只有目标分支已经前进、快进不了时才用 `--no-ff --no-edit`。`merge.approved` 事件里的 `fast_forward` 记录实际策略。

每次成功后运行时会检查同目标分支上其它 `pending/review` worker 的已审阅提交是否也已经成为目标分支祖先；若是，则标成 `merged` 并记录 `merge.included`。这样外部 Git 操作或另一条分支携带提交时，不会留下实际上已落地的“待合并”幽灵项。

## 内容冲突

内容冲突不是异常。`workspaces.merge` 真合并失败时先取未解决文件，再 `merge --abort`；只有主树确实回到合并前的干净状态时才把冲突结果交给上层。abort 不成功仍是硬错误，绝不把主树中间态交给 agent。

上层把原任务置为 `integration=conflict`，创建一个 `role=merger`、`resolves_task_id` 指向原任务的解冲突 task，并发 notice 请示。resolver 初始为 `awaiting`，不占槽；答复才开工，忽略则取消并让原任务回到 `pending`。

resolver 以目标分支顶端为基线，把原任务已审阅提交并进来、解冲突、提交并测试。落地同时要求：

1. resolver 结果确实包含原任务的 `head_commit`；
2. 只用 `--ff-only` 落地，证明目标分支没被推走，落地树就是测过的树。

原任务有活动 resolver 时，任何入口都不能从旁重试它。resolver 完成且目标分支仍是其祖先时，单任务与批量入口收到原任务 id 都会自动把实际来源映射到 resolver。若目标分支已经前进，映射不再成立，此时显式批准原任务表示“废弃过期 resolver 并开新一轮”；旧分支与 worktree 保留，状态改为 `superseded`。

`integration=conflict` 同时是按目标分支派生的合并锁。同一目标分支上的其它落地会被拒绝，直到 resolver 落地、被取消/失败，或原任务显式开始新一轮。锁不另建表，重启后不会残留内存锁。

## 批量交付

`task.merge_many` 一次最多 50 个稳定的原任务 id：

- 先做全批次只读预检；不合格条目、混合目标分支、脏主树/任务 worktree、审阅提交漂移、resolver 不完整、集合外未落地的 code 上游都会在写主树前拒绝；
- 单批只允许一个 `target_branch`；
- 只按选中集合内的 `code` 边拓扑排序，并列按 id；`order` 不参与交付排序；
- resolver 完成时把原任务映射到 resolver 作为 `source_task_id`；
- 真正执行仍逐个走同一个 `approveMerge`，遇到首个运行期冲突或错误停止，已成功的不会回滚，剩余项标为 `skipped`。

相关：[工作区与分支回收](cleanup.md)、[生命周期不变量](invariants.md)。
