# 执行模型：Task、Agent 与 Run

本章面向维护调度与 Agent 的开发者，说明当前 say 路径的一次工作如何跨多轮调用继续。

> 连续阅读：[架构总览](../core-architecture.md) → **执行模型** → [交付与验收](review-loop.md) → [工程索引](architecture.md)

## 稳定身份与单次调用

Task 持久保存目标、父子关系、状态、消息和工作区；Agent 与 Task 一对一，但不是常驻进程。每次 provider invocation 都有独立的 `agent_runs` 记录、临时凭证和结果。等待子任务或用户时 Task 释放执行槽；下一轮继续使用同一 Task/Agent 身份，但旧凭证不能复用。[一次 invocation](invocation.md)描述收件箱、恢复和安全抢占。

```mermaid
sequenceDiagram
    participant P as 父 Task / Agent
    participant R as Runtime
    participant C as 子 Task / Agent
    P->>R: 派独立子 Task
    R-->>P: 结束本轮，释放槽
    C->>R: 提交结果并结算
    R->>P: 投递持久信号，唤醒新 Run
    P->>R: 确认固定子提交（若需代码）
```

- 新 say 输入直接拥有 `agent` Task，不创建 planner/scheduler。父 Agent 可按需派子 Task；子 Task 结算只发送信号，不自动合并。
- 一轮正常返回后的 say Task 通常处于 `waiting`，保留分支与再次唤醒能力；`awaiting` 等用户答复。终态 Task 不允许活动后代。
- 用户追加输入先持久化，再尝试在可证明的安全点收尾：当前 Pi 可在 `turn_end` 抢占，记录 `preempted` Run；无安全点后端只在自然轮末交付，不把硬杀冒充安全中断。
- 未知外部副作用的中断不自动重放。Run 结束、Task 结算、代码集成互不等价。

## 历史数据边界

旧 Intent / Plan / Candidate 与 planner / scheduler 的记录、会话与工作区保留在磁盘上，不迁移、不删除，但不再有公开入口，也不会自动启动或重放。control / execution 两条容量车道仍是运行时的准入机制，普通 say 不调用规划模型。当前可调用面见[核心 API 收敛](core-api.md)。

---

[← 上一篇：架构总览](../core-architecture.md) · [下一篇：交付与验收 →](review-loop.md)
