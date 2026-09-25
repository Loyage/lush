# Run、invocation 与多级协作

本文说明每次 provider 调用与持久 Task 的边界。新 say 与旧 planner/worker 都使用同一套 Run 记录；旧 WorkItem 只是兼容读模型。

## Task 与 Run

每次真实 provider 调用都会先写 `agent_runs`：

```text
WorkItem #42
├── Run #80（failed）
├── Run #81（completed，等待用户答复）
└── Run #85（completed，最终结果）
```

Task 的累计 calls / wakes 继续用于兼容读模型，Run 保存每次调用自己的 attempt、provider、时间、result 与 error。成功输出同时形成 `run.result` Artifact。

## 一次 invocation

1. Dispatcher 按任务就绪状态与相应 lane 的容量选择 queued Task。
2. `running` Map 占位，签发本次 invocation token，创建 `agent_runs` 行。
3. 准备 cwd：say / child 使用独立 worktree；旧 planner 使用输入 worktree；旧 worker 使用隔离 worktree；Candidate verifier 使用固定提交的对照检出。
4. 读取启动时未消费消息、相关工作与 Artifact 上下文；对带 Input 的普通任务读取其引用快照并按稳定目标解析本轮最新状态，组成 `referenced_context`。provider 按 role 组合命名 Prompt 片段，叠加 `agent.json`、项目/本机补充并热加载公共/角色 env 后启动 Pi 或 Codex。
5. 成功返回后消费启动时消息，保存 Task 兼容 result、结束 Run、写 Artifact。
6. 判定未读消息、Decision、活动子任务与工作区提交，进入 queued / awaiting / waiting / completed。
7. 释放 token 和槽，再检查一次收件箱避免 lost wake-up。

失败或取消会结束对应 Run；崩溃恢复不重放未知副作用。

结构化问卷是正常返回之外的主动暂停路径：`notice.post` 带 `questions` 时，同一事务保存 notice、消费本轮已交付消息、记一条 `invocation.completed {suspended:true}` 并设置 awaiting；提交后中止进程组。本轮不执行 worker finish、不标失败。调度器的 `questionPending` 闸门阻止普通消息和子任务结果提前唤醒；答复/忽略落收件箱后，在旧 invocation 清理完毕时重新排队，防止 lost-wakeup。已暂停 task 在关闭/重启时保留 awaiting，而不是把主动暂停当异常失败。详见[待决问题](../reference/rpc/notices.md)。

waiting / awaiting 不占 agent 槽，也不运行 sleep/poll 子进程。最终输出是 task result；不提供可被 agent 提前调用的 complete 命令。

## 两条 admission lane

- control：planner 和兼容历史 scheduler，容量默认 `LUSH_CONTROL_CONCURRENCY`（2）；
- execution：worker / coordinator / research / verifier / merger，容量默认 `LUSH_CONCURRENCY`（4）。

两条 lane 独立计数。容量是可在运行时改写的项目级设置（`<home>/settings.json` 覆盖环境默认值，Web「设置 → 系统」与 `lush config` 可改）；写盘后同步内存并重新 pump，下一次调度立即按新生效值准入，不需要重启 daemon。waiting / awaiting / 依赖未满足的 queued 不占槽。

## 旧协议的 Plan 编译

旧 planner 只写结构化 spec；runtime 随后创建根工作 Task 和依赖，无 scheduler invocation。新 say 不调用 planner 或 Plan Compiler。

## 协作与集成

新 say / child Agent 可以派子任务；普通成功收据在本波直接子任务全部终态后合并唤醒，失败、取消和显式消息仍及时可调度，详见[合并唤醒](token-efficiency.md#父任务合并唤醒)。新子任务只发送信号，代码由运行中的直接父 Agent 显式确认固定提交并集成。旧 Plan Compiler 创建的根 worker 才走私有 Intent 分支聚合和 Candidate 批准。

verifier 有两种来源：

- `task.verify`：兼容的单 worker 对照；
- Review Candidate：对照固定 integration commit 与固定 target baseline；invocation 正常返回与 verification 结论分开记录，只有结构化 `pass` 且 HTML 报告存在时 Candidate 进入 `ready`。
