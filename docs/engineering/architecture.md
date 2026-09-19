# 架构：一个项目，一棵棵任务树

这份文件是索引：实体与生命周期不变量在这里一览，各章正文在各自文件。模块地图见 [modules.md](modules.md)。

## 实体

实体逐条原文见 [entities.md](entities.md)。

| 实体 | 详述 |
|---|---|
| Project | [entities.md#project](entities.md#project) |
| Input | [entities.md#input](entities.md#input) |
| Task | [entities.md#task](entities.md#task) |
| Agent | [entities.md#agent](entities.md#agent) |
| Message | [entities.md#message](entities.md#message) |
| Notice | [entities.md#notice](entities.md#notice) |
| Event | [entities.md#event](entities.md#event) |

## 生命周期不变量

逐条原文见 [invariants.md](invariants.md)。

- 状态集合 → [invariants.md#status](invariants.md#status)
- 单 invocation / 凭证时效 → [invariants.md#credential](invariants.md#credential)
- 终态无活动子 task → [invariants.md#terminal](invariants.md#terminal)
- 父子边只由创建建立 → [invariants.md#parent-edge](invariants.md#parent-edge)
- 消息消费时机 → [invariants.md#message-consumption](invariants.md#message-consumption)
- 核心变更在同步短事务 → [invariants.md#transaction](invariants.md#transaction)
- 重试是用户显式动作 → [invariants.md#retry](invariants.md#retry)
- 不删任务历史 → [invariants.md#history](invariants.md#history)
- explain 子树只允许 research → [invariants.md#explain](invariants.md#explain)
- 内容冲突进入合并冻结 → [invariants.md#conflict](invariants.md#conflict)

## 各章

- 数据流：[从入口到 Project 的组件结构与校验归属](data-flow.md)。
- 输入和规划：[一次输入如何落库与规划、`inputs.flow` 判定与改判](inputs-and-planning.md)。
- 意图层与拆解队列：[`layer='intent'` 的 planner / scheduler、批次边界与 `spec drop`](intent-layer.md)。
- 计划审批闸门：[`plan.propose` / `plan.approve` / `plan.reject` 的规则与权限](plan-gate.md)。
- 一次 invocation 与多级协作：[七步流程、派活权限、verifier 与上限](invocation.md)。
- Git 边界：[Git 原语、worktree / 分支创建、`base_behind`](git-boundary.md)。
- 批准合并：[批准、快进优先、内容冲突与合并冻结、`superseded`](merge.md)。
- 检验与对照检出：[不写 Git 状态、只读对照检出与回收时机](verification.md)。
- 工作区与分支回收：[compare-and-delete 与 `keep-branch` 安全门](cleanup.md)。
- 项目身份与恢复：[项目身份、锁与 socket、启动 / 退出 / 重启恢复](identity-and-recovery.md)。
- 界面与传输：[CLI 分页、Web 轮询与 CSP、RPC 信任边界](interface.md)。
- 模块地图：[`src/` 与 `test/` 的分区与导出签名](modules.md)。

## 源码布局

每个文件负责什么、导出什么，只有一处权威清单：[模块地图](modules.md)。

维护时优先保持这些小模块，不引入通用服务管理或电脑级能力体系。
