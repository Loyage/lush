# 一条 say 输入如何交付

本文记录 AP 中心输入与交付的设计细节。当前可用命令及已下线功能以[核心 API 收敛](engineering/core-api.md)为准。

## 发送与执行

1. `lush say '目标'` 立即提交这一条输入；Web「发送」也只发送当前输入。输入保留原话和引用，直接创建拥有独立分支、worktree 的 say AP，**不先运行 planner、快速路由或 Plan Compiler**。
2. 默认以当前检出的本地分支为父分支；Web 可选父分支。main 有静息的根 AP，其他分支必须先显式绑定所有者（`lush branch bind BRANCH COMMIT`）。从父分支的已提交 tip 创建工作区；未提交改动不会被带入。
3. say Agent 可亲自完成，也可派子 AP。子 AP 各有自己的分支；完成消息只唤醒父 AP，**不会自动集成提交**。运行中的直接父 Agent 用 `lush ap integrate CHILD_ID CHILD_HEAD_COMMIT` 确认固定子提交，且只能快进。若父分支已前进，父 Agent 可发起子侧解分歧 AP；它在独立 worktree 测试两端固定提交，父 Agent 到安全点后由 runtime 校验并快进源与父分支，不改写原提交。期间受影响 AP 冻结，其他兄弟分支仍可独立工作。
4. Agent 每轮返回后，say AP 通常静息等待下一条消息或子 AP 结果；`waiting` 不占调用槽，也不表示失败或代码已合并。直接问问题也走 say worktree。只想了解、没有代码改动的回答可用用户专属 `lush ap resolve ID` 标记「已解决」：保留答案并以 `completed` 结算，区别于「取消」。

## 合并预约与交付

say AP 可以预约**合并请求**；再次发送同类预约不会新增意图，只按当前 Git 事实复查阻塞条件。合并请求须等 AP 静息、子 AP 结清、工作区干净且能快进，才冻结源 commit 与父分支基线并向父 AP 投递一次请求。请求发出后源 AP 可以结算，但父分支不会自动前进。

父 AP 是运行中的 say Agent 时，由它确认固定子提交；父是 main/owner 时，只有用户能按请求中的 **commit + baseline** 批准（`lush ap approve-merge ID COMMIT BASELINE`）。请求未解决时父分支受交付锁保护；用户可撤销请求但不会删除分支或提交。父分支自行提交或外部 Git 操作仍可能造成分歧，此时需复查诊断，在源侧解决，或由用户撤销请求。`completed` 只表示 AP 结算，**不表示已进入父分支或 main**。

审阅时从 `lush ap inspect ID` 和分支图（RPC `ap.diff` 提供只读改动视图）查看固定提交、未提交改动、消息与阻塞原因；失败工作区与历史按安全规则保留。[RPC AP 参考](reference/rpc/ap.md)列出详细准入和异常处理。
