# Worker 中心输入：当前约束

本文面向修改输入、Worker、Agent、Git 和 UI 的开发者，概括当前 say 路径的设计边界；具体接口与异常处理以[Worker RPC](../reference/rpc/tasks.md)、[Worker 图与固定输入规则](task-graph.md)和[模块地图](modules.md)为准。当前可调用面见[核心 API 收敛](core-api.md)。

## 输入与分支归属

- 用户可先在 Web 暂存想法，正文、引用与父 Worker 身份持久保存但不创建工作区或调用 Agent；发射单条暂存才进入 say，详见[历史输入接口](input-history.md)。
- `say TEXT` 一次提交一条 Input，直接创建拥有分支/worktree 的 say Worker；不创建 planner/scheduler，也不匹配旧 `input_routes`。引用作为输入附件保留，不混进正文。
- main 的持久根 Worker 平时静息；其它本地父分支需要显式绑定所有者。Worker从父分支已提交 tip 创建，不能带上未提交工作。普通 say 即使只回答问题也有 worktree。
- 每个新 Worker 与 Agent 一对一；子 Worker 有自己的分支与固定起点，父子关系始终表达委派。当前 version 2 交付由父 Worker 自有队列的 runtime 串行 Squash（含 main），不创建 merge Worker、不改 `parent_id`、不额外调用父 Agent 或要求 `worker.integrate`。

持久预约是交付事实，Message/Event 仅通知；真实安全点固定源提交并按入队顺序排队，代码依赖优先，取得父执行位后才固定尝试基线。分歧由原 Worker 源侧修复并保留父执行位，挂起释放，恢复重新排队并固定新父基线。合并后非终态待验收，可追加输入继续同一 Worker，用户验收与归档分开。完整协议与旧 version 2 merge 身份／重挂兼容见[分支合并](merge.md)，安全父同步与历史显式恢复见[持续迭代](task-iteration.md)。

## 调用与交付

- Worker 身份、收件箱与工作区跨 invocation 保留；等待子Worker/用户时释放并发槽。用户追加输入先落库，在已验证的安全点抢占（Pi 的 `turn_end`），否则轮末交付。硬中断的未知副作用不自动重放。一次性 Agent token 只对本轮有效。
## 历史 version 1 交付

以下固定提交人工批准的语义只适用于历史 version 1，不是当前父自有队列的准入：

- 合并预约仅在静息、后代已结算、工作区干净且能快进时发请求，固定源/父提交并锁父分支；请求不等于授权合并。
- 直接父 say Agent 可确认集成；main/owner 需要用户按固定 commit + baseline 批准。父分支自己前进或外部 Git 更改可能让请求失去快进前提，必须保留诊断、交由源侧解决或撤销请求。撤销不删除分支/历史。`completed` 不等于 `merged`。只想了解、没有代码改动的 say 不会自己结束（一次调用正常返回只进入 waiting）；用户用 `worker.resolve` 把它标记为「已解决」——与「取消」区分，保留答案并以 `completed`/`integration='none'` 结算，仅在没有提交、工作区干净且无在途交付时允许。
- 旧 Input、Plan、Candidate、路由事件保留在磁盘上，不迁移、不删除，但不再有公开入口，也不会自动重放；不能由旧记录的 role 或 Worker ID 猜测新协议身份。旧合并接口不能绕过当前队列准入或历史Worker的父确认/人工批准。
