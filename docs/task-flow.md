# 一条 say 输入如何交付

本文记录 Task 中心输入与交付的设计细节。当前可用命令及已下线功能以[核心 API 收敛](engineering/core-api.md)为准。

## 发送与执行

1. `lush say '目标'` 立即提交这一条输入；Web「发送」也只发送当前输入。输入保留原话和引用，直接创建拥有独立分支、worktree 的 say Task，**不先运行 planner、快速路由或 Plan Compiler**。
2. 默认以当前检出的本地分支为父分支；Web 可选父分支。main 有静息的根 Task，其他分支必须先显式绑定所有者（`lush branch bind BRANCH COMMIT`）。从父分支的已提交 tip 创建工作区；未提交改动不会被带入。
3. say Agent 可亲自完成，也可派子 Task。子 Task 各有自己的分支；新 child 默认预约合入直接父 Task。安全结束、后代收敛、工作区干净且有提交时，由 runtime 自动交给父 Task 的 merge 队列串行 Squash；无提交的干净 child 只交付结果，不产生合并提交。分歧回源 Task 合入固定父提交并测试，不允许 Agent 在父分支擅自解决或 rebase。
4. Agent 每轮返回后，say Task 通常静息等待下一条消息或子任务结果；`waiting` 不占调用槽，也不表示失败或代码已合并。直接问问题也走 say worktree。只想了解、没有代码改动的回答可用用户专属 `lush task resolve ID` 标记「已解决」：保留答案并以 `completed` 结算，区别于「取消」。

## 合并预约与交付

用户直接创建的 say 由用户 `lush task reserve ID merge` 决定何时交付；运行中先预约，安全结束后发固定请求，由父 Task 的 merge 队列串行 Squash（含 main）。请求冻结源 Task，发生分歧回源侧处理；失败保留分支与提交。历史 version 1 请求仍用 `task.integrate` / `task.approve_merge` 的固定提交确认，不批量迁移旧记录。

本轮落地后，原 Task 归还原父并进入非终态「待验收」（`awaiting_acceptance`），保留分支/worktree/会话。追加 `lush task message ID '新要求'` 继续当前 Task；新提交再次请求交付。用户 `lush task accept ID` 才验收完成（completed），不会调用 Agent 或归档。显式清理/归档仍是独立动作。`completed`、`integration='merged'`、归档三者不能互相代替，进入直接父分支也不代表已经进入 main。

父分支前进时，`lush task sync-parent ID` 在源侧安全吸收父提交：无冲突程序直接完成，冲突只返回诊断。另用 `lush task resolve-sync ID` 才调用 Agent 解决固定提交的冲突并测试；不会推进父分支。未归档且保留分支/worktree 的历史 completed/merged say/child 可显式 `lush task reopen ID` 恢复待验收，再追加输入；明确用户验收过的新任务不误重开，已归档任务不重建。详见[持续迭代](engineering/task-iteration.md)。

审阅时从 `lush task inspect ID` 和 Task 图（RPC `task.diff` 提供只读改动视图）查看固定提交、未提交改动、消息与阻塞原因；失败工作区与历史按安全规则保留。[RPC Task 参考](reference/rpc/tasks.md)列出详细准入和异常处理。
