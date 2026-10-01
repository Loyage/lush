# Run、invocation 与多级协作

本文说明每次 provider 调用与持久 Task 的边界。新 say 与历史遗留 Task 共用同一套 Run 记录；旧 WorkItem 只是兼容读模型。

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
3. 准备 cwd：say / child 使用独立 worktree；解分歧 Task 使用从固定提交拉起的独立 worktree；旧记录里可能还有输入 worktree 或对照检出。
4. 读取启动时未消费消息、相关工作与 Artifact 上下文；对带 Input 的普通任务读取其引用快照并按稳定目标解析本轮最新状态，组成 `referenced_context`。provider 按 role 组合命名 Prompt 片段，叠加 `agent.json`、项目/本机补充并热加载公共/角色 env 后启动 Pi 或 Codex。
5. 成功返回后消费启动时消息，保存 Task 兼容 result、结束 Run、写 Artifact。
6. 判定未读消息、Decision、活动子任务与工作区提交，进入 queued / awaiting / waiting / completed。
7. 释放 token 和槽，再检查一次收件箱避免 lost wake-up。

失败或取消会结束对应 Run；崩溃恢复不重放未知副作用。

结构化问卷是正常返回之外的主动暂停路径：`notice.post` 带 `questions` 时，同一事务保存 notice、消费本轮已交付消息、记一条 `invocation.completed {suspended:true}` 并设置 awaiting；提交后中止进程组。本轮不执行 worker finish、不标失败。调度器的 `questionPending` 闸门阻止普通消息和子任务结果提前唤醒；答复/忽略落收件箱后，在旧 invocation 清理完毕时重新排队，防止 lost-wakeup。已暂停 task 在关闭/重启时保留 awaiting，而不是把主动暂停当异常失败。详见[待决问题](../reference/rpc/notices.md)。

waiting / awaiting / paused 不占 agent 槽，也不运行 sleep/poll 子进程。最终输出是 task result；不提供可被 agent 提前调用的 complete 命令。

## 两条 admission lane

- control：planner 和兼容历史 scheduler，容量默认 `LUSH_CONTROL_CONCURRENCY`（2）；
- execution：worker / coordinator / research / verifier / merger，容量默认 `LUSH_CONCURRENCY`（8）。

两条 lane 独立计数。容量是可在运行时改写的项目级设置（`<home>/settings.json` 覆盖环境默认值，Web「设置 → 系统」与 `lush config` 可改）；写盘后同步内存并重新 pump，下一次调度立即按新生效值准入，不需要重启 daemon。waiting / awaiting / paused / 依赖未满足的 queued 不占槽。

## 协作与集成

新 say / child Agent 可以派子任务；普通成功收据在本波直接子任务全部终态后合并唤醒，失败、取消和显式消息仍及时可调度，详见[合并唤醒](token-efficiency.md#父任务合并唤醒)。Agent 派出的 child 在创建时默认预约合入直接父 Task；轮末安全结束、消息已处理、后代已结算且工作区干净后，runtime 固定提交并由父 Task 下的 merge 队列串行 Squash，无需用户逐个预约或父 Agent 手动集成。干净且无新提交的 child 直接结算并交付结果。成功收据等本波子任务全部结算再唤醒父 Agent，避免父 Agent 与队列争用分支。用户直接创建的 say 仍由用户决定何时预约合并（含进入 main/owner）；分歧退回原 Task 合入固定父提交并测试，再自动重新排队。旧 version 1 请求继续保留原来的手动确认边界。
