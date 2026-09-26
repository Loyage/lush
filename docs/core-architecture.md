# Lush 核心架构

本文面向初次理解系统的开发者；使用顺序见[一条 say 输入如何交付](task-flow.md)，实现入口见[工程架构索引](engineering/architecture.md)。

> 连续阅读：**架构总览** → [执行模型](engineering/execution-model.md) → [交付与验收](engineering/review-loop.md) → [工程索引](engineering/architecture.md)

## 为什么以 Task 为中心

Lush 的中心对象是 **Task**。用户写下的是目标，而不是任务清单；这条目标立即成为一个 Task，而不是 planner 临时编译出来的 worker。理解这一选择，后面的输入、Agent、Git 与交付设计才讲得通。

- **目标是持久的，模型调用是短暂的**：Task 保存目标、父子关系、状态、消息、工作区与分支；Agent 与 Task 一对一，但只在被唤醒时占用一次模型调用（Run）。等待用户或子任务时 Task 释放执行槽，下一轮仍以同一身份继续。一次调用返回不等于 Task 终结。
- **每个 Task 有独立的代码边界**：Task 从父分支的已提交 tip 创建自己的分支与 worktree，并行工作互不覆盖。代码事实留在 Git，业务与调度事实留在 SQLite，二者不互相冒充。
- **Task 可以递归分解，但子任务不是等待式调用**：Agent 判断亲自完成还是派独立子 Task；子 Task 有自己的 Task 身份与 worktree。它完成后只发持久信号，是否把它的固定提交集成进父分支由父 Agent 或用户决定。
- **交付以 Task 为单位，人类把关**：合并请求冻结精确 commit 与父分支基线，父分支在请求未决时受保护；结算一个 Task 与把它的代码推进父分支是两件事，默认必须由人或父 Agent 明确确认，不自动推进父分支。

因此 Task 同时是身份、目标、协作单元与交付单元；Plan、Candidate 等结构只是历史协议的产物，不是新 say 必经的前置对象。Task 的字段与状态约束见[核心实体](engineering/entities.md)与[生命周期不变量](engineering/invariants.md)，一次工作如何跨轮继续见[执行模型](engineering/execution-model.md)。

## 项目、输入与任务

一个 daemon 绑定一个 canonical 项目，数据库状态在 `<project>/.lush/`。业务实体是 Input、Task、Agent、Message、Notice、Event；Git 分支与 worktree 承载代码隔离。一次新 `say` 保存 Input（原话、引用）并创建与它直接关联的 Task；Task 拥有自己的分支和工作区。main 或显式绑定的分支所有者 Task 是它的父节点。Task 可以再派独立子 Task，也可以不改代码直接回答。

```mermaid
flowchart LR
    input("Input / say") --> task("Task + Agent")
    task --> child("按需创建子 Task")
    child --> confirm{"父 Agent 确认固定提交"}
    confirm --> task
    task --> request("展示或合并预约")
    request --> approve{"父 Agent / 用户批准"}
    approve --> target(["父分支"])
```

每个 Task 的 Agent 身份跨唤醒保持，真正的模型调用记录为独立 Run。消息和子任务结算先持久化；等待用户或子任务时释放 invocation 槽。Event 保存审计事实，Notice 承载必须由用户决定的问题。提交、测试和结果可记录为 Artifact；Run、Artifact 是执行事实，不是新的顶层调度对象。

## 交付边界

子任务完成不推进父分支；直接父 Agent 只有在分支与工作区符合条件时才能确认固定子提交并快进。say 的展示预约点击即创建展示子 Task 并先做准备，原 say 完成并发信号后展示按最终提交交付。say 的合并预约会冻结源提交与父分支基线，请求不等于批准。main/owner 的交付需要用户批准固定提交与基线；分支分歧在子侧处理，不能靠覆盖父工作区蒙混过关。Task `completed`、已集成到直接父分支、已进入 main 是三件不同的事。

旧 `input.submit` / 批量 `draft.commit` 的 Intent → Plan → 私有集成 → Review Candidate 链仍用于历史任务的兼容收尾；它不是新 say 的主链，Candidate 也不是新 say 的必经交付对象。细节见[历史流程](task-flow-1-planning.md)和[旧协议参考](reference/rpc/inputs.md)。

---

[下一篇：执行模型 →](engineering/execution-model.md)
