# 检验、对照检出与 Review Candidate

本文件管两类只读检验、派生的对照检出及其回收时机。

## 单 worker 检验（兼容）

`lush task verify ID` 为一个已完成的 worker 派只读 verifier：它读该任务 goal 与 diff，判断「怎样最直观地演示这次改动成立」，在被测 worktree 与目标分支的 `git worktree add --detach` 只读对照里跑同一场景，最后写自包含 HTML 报告。verifier 用 `verifies_task_id` 关联被检验 worker，不是父子边（终态任务不能有活动后代）。

## Review Candidate 检验

Candidate 检验是用户显式动作：`candidate.prepare`（或自动中间集成完成）只创建 `pending` Candidate；只有用户调用 `candidate.verify`（Web 的“开始验收”）才会派 verifier，并用 `review_candidate_id` 关联。

与单 worker 检验的区别：

- 两侧都**固定 commit**：一侧是 Intent 集成分支被审阅的 commit，另一侧是创建 Candidate 时冻结的 target baseline commit；
- verifier 启动时会校验该 checkout 的 HEAD 仍等于被固定的 commit，漂移就拒绝，避免「审阅的不是报告里的那一版」；
- 新 Candidate 先停在 `pending`，不占执行槽；用户显式启动后进入 `preparing`；只有 Candidate 仍是 `preparing`、`report_task_id` 仍指向该 verifier、HTML 报告存在且结构化结论为 `pass` 时才进入 `ready`，`fail` / `partial` / `unverified`、报告缺失或 invocation 失败都进入 `failed`，之后可再次显式 `candidate.verify`；
- 用户在运行期间拒绝、要求修改或用新版替代 Candidate 时，不主动取消已经启动的 verifier。它可以继续形成 Task、Run、Artifact 与报告历史，但结算会写 `candidate.verification_ignored`，不能恢复旧 Candidate 或替换当前 verifier 的结果。

## 对照检出生命周期

对照检出是派生状态：

- 在第一次 invocation 准备 cwd 时创建，路径 `.lush/worktrees/<label>-base`；
- 方向是「替换现有对照」而不是共用（先落库再动 Git，崩溃后知道清理哪个目录）；
- invocation 结束（成功或失败）后立即回收，报告文件保留；
- 重启恢复时回收上次崩在中间的对照检出；
- 用户可用 `task cleanup` 再回收一次。

## 报告

- 路径：`.lush/verify/<verifier-id>/report.html`；
- 自包含：样式 / 脚本内联，图片内联为 `data:`，不引用外部文件或网络；
- 路由：`GET /api/task/<id>/report`，独立顶层文档，CSP 收紧到 `default-src 'none'`，且只有 verifier 任务的报告会被读出；
- Candidate 的 HTML 入口画在 Intent 工作台的候选行上。
- 同目录的 `evidence.json` 使用 version 1 schema；runtime 校验后复制进 version 2 `run.result` Artifact。commit 与报告引用由 runtime 绑定，证据记录命令/退出码、失败、未验证、基准失败与残余风险；旧 Artifact 缺证据时读作 `unknown`。

相关：[Intent 与 Plan 编译](intent-layer.md) · [Review Candidate RPC](../reference/rpc/candidates.md) · [工作区与分支回收](cleanup.md)。
