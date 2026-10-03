# 一条指令输入如何交付

本文记录 Worker 中心输入与交付的设计细节。当前可用命令及已下线功能以[核心 API 收敛](engineering/core-api.md)为准。

## 发送与执行

Web 中尚未决定执行的想法可先按 Enter 暂存，Shift+Enter 换行；暂存不创建 Worker、不调用 Agent。在「历史输入」中可搜索原始指令、编辑暂存并逐条发射，见[历史输入与暂存](input-history.md)。

1. `lush order '目标'` 立即提交并开始这一条输入；Web「发送」或 Ctrl/⌘+Enter 只发送当前输入并创建待开始 Worker，Ctrl/⌘+Shift+Enter 才立即开始。输入保留原话和引用，直接创建拥有独立分支、worktree 的指令 Worker，**不先运行 planner、快速路由或 Plan Compiler**。
2. 默认以当前检出的本地分支为父分支；Web 可选父分支。main 有静息的根 Worker，其他分支必须先显式绑定所有者（`lush branch bind BRANCH COMMIT`）。从父分支的已提交 tip 创建工作区；未提交改动不会被带入。
3. 指令 Agent 可亲自完成，也可派子 Worker。子 Worker 各有自己的分支；新 child 默认预约合入直接父 Worker。安全结束、后代收敛、工作区干净且有提交时，由父 Worker 自有队列的 runtime 串行 Squash，不额外调用父 Agent；无提交的干净 child 只交付结果，不产生合并提交。分歧回源 Worker 合入固定父提交并测试，不允许 Agent 在父分支擅自解决或 rebase。
4. Agent 每轮返回后，指令 Worker 通常静息等待下一条消息或子Worker结果；`waiting` 不占调用槽，也不表示失败或代码已合并。直接问问题也走指令 worktree。只想了解、没有代码改动的回答可用用户专属 `lush worker resolve ID` 标记「已解决」：保留答案并以 `completed` 结算，区别于「取消」。

## 合并预约与交付

用户直接创建的指令默认关闭自动合并：可在开发中用 `lush worker auto-merge ID on` 开启跨轮 hook，也可在就绪后用 `lush worker reserve ID merge` 显式请求本轮交付。真实安全点固定源提交，由父 Worker 自有队列的 runtime 串行 Squash（含 main），不创建 merge Worker、不改变父子关系。请求按入队顺序、代码依赖优先；取得父执行位后才固定父基线。分歧回原 Worker 在源侧修复，期间保留父执行位；挂起释放，恢复重新排队并固定新基线。失败保留分支与提交。完整协议见[分支合并](engineering/merge.md)。历史 version 1 固定提交人工确认及旧 version 2 merge 身份仅按兼容路径处理，不猜父身份、不删历史。

本轮落地后，原 Worker 保持原父子关系并进入非终态「待验收」（`awaiting_acceptance`），保留分支/worktree/会话。追加 `lush worker message ID '新要求'` 继续当前 Worker；新提交再次请求交付。用户用 `lush worker accept ID` 验收自己的指令；派生 child 由运行中的直接父 Agent 检查后使用同一命令确认完成（completed），无需用户逐个验收。无代码改动的 child 也先交付结果、等待父确认。确认不会调用 Agent 或归档，失败、未决问题与未交付改动不能自动视为成功。显式清理/归档仍是独立动作。`completed`、`integration='merged'`、归档三者不能互相代替，进入直接父分支也不代表已经进入 main。

父分支前进时，`lush worker sync-parent ID` 在源侧安全吸收父提交：无冲突程序直接完成，冲突只返回诊断。另用 `lush worker resolve-sync ID` 才调用 Agent 解决固定提交的冲突并测试；不会推进父分支。未归档且保留分支/worktree 的历史 completed/merged 指令/child 可显式 `lush worker reopen ID` 恢复待验收，再追加输入；明确用户验收或父确认过的新Worker不误重开，已归档Worker不重建。详见[持续迭代](engineering/task-iteration.md)。

审阅时从 `lush worker inspect ID` 和 Worker 图（RPC `worker.diff` 提供只读改动视图）查看固定提交、未提交改动、消息与阻塞原因；失败工作区与历史按安全规则保留。[RPC Worker 参考](reference/rpc/tasks.md)列出详细准入和异常处理。
