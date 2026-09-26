# 一条 say 输入如何交付

本文面向日常使用者，按当前默认的 `say` 路径说明从输入到代码落地的过程。旧 `input.submit` / `draft.commit` 的 Intent → Plan → Candidate 流程另见[历史流程](task-flow-1-planning.md)；不要把它当成新输入的前置步骤。

## 发送与执行

1. `lush say '目标'` 立即提交这一条输入；`lush say --draft ID` 只发送指定草稿。Web「发送」也只发送当前输入。输入保留原话和引用，直接创建拥有独立分支、worktree 的 say Task，**不先运行 planner、快速路由或 Plan Compiler**。
2. 默认以当前检出的本地分支为父分支；Web 可选父分支。main 有静息的根 Task，其他分支必须先显式绑定所有者（`lush branch bind BRANCH COMMIT`）。从父分支的已提交 tip 创建工作区；未提交改动不会被带入。
3. say Agent 可亲自完成，也可派子 Task。子 Task 各有自己的分支；完成消息只唤醒父 Task，**不会自动集成提交**。运行中的直接父 Agent 用 `lush task integrate CHILD_ID CHILD_HEAD_COMMIT` 确认固定子提交，且只能快进。若父分支已前进，应由父 Agent 发起子侧解分歧 Task，测试后再确认，不能改写原子分支。
4. Agent 每轮返回后，say Task 通常静息等待下一条消息或子任务结果；`waiting` 不占调用槽，也不表示失败或代码已合并。直接问问题也走 say worktree；对分支所有者另有用户专属的只读 `lush task analyze ID '问题'`，不创建代码分支。

## 展示与交付

say Task 可以预约**效果展示**或**合并请求**，二选一；同类预约可复查阻塞原因。点击预约展示即创建展示子 Task 并让它先做准备；say 真正完成且满足展示准入后，runtime 发信号让它按最终固定提交交付，say 在展示结算后才终结。展示结果不是检验通过或合并批准。展示交付会把原 say 结算为 `completed`，此时它不再有可等的 pending 阶段；在分支图或详情点「请求合并」会直接补发一次固定提交请求（撤销后可再次请求），之后仍由父 Agent 或用户批准。合并请求须等任务静息、子任务结清、工作区干净且能快进，才冻结源 commit 与父分支基线并通知父 Task。请求发出后源 Task 可以结算，但父分支不会自动前进。

父 Task 是运行中的 say Agent 时，由它确认固定子提交；父是 main/owner 时，只有用户能按请求中的 **commit + baseline** 批准（`lush task approve-merge ID COMMIT BASELINE`）。请求未解决时父分支受交付锁保护；用户可撤销请求但不会删除分支或提交。父分支自行提交或外部 Git 操作仍可能造成分歧，此时需复查诊断，在源侧解决，或由用户撤销请求。`completed` 只表示任务结算，**不表示已进入父分支或 main**。

审阅时从 `lush task inspect ID` 和分支图（RPC `task.diff` 提供只读改动视图）查看固定提交、未提交改动、消息与阻塞原因；失败工作区与历史按安全规则保留。[效果展示](showcase.md)与[RPC Task 参考](reference/rpc/tasks.md)列出详细准入和异常处理。

## 历史路径

旧客户端和存量任务仍可能使用 [提交与规划](task-flow-1-planning.md) → [私有集成与候选](task-flow-2-integration.md) → [验收与回收](task-flow-3-delivery.md)。这些章节只用于旧数据的安全收尾，不适用于上述 say 路径。
