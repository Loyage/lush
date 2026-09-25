# 工程架构索引

本章面向需要按源码职责深入的开发者；先读[核心架构](../core-architecture.md)，再按修改范围查下面的主题与[模块地图](modules.md)。

> 连续阅读：[架构总览](../core-architecture.md) → [执行模型](execution-model.md) → [交付与验收](review-loop.md) → **工程索引**

## 当前主链

```text
CLI / Web → say.submit → Input + 独立 say Task / worktree
  → Agent 自行执行或派独立子 Task → 持久信号 → 父 Agent 确认固定子提交
  → 展示预约，或合并请求 → 父 Agent 集成 / 用户批准 main(或 owner)
```

业务事实落 SQLite，代码事实落 Git；RPC 校验身份与权限，Project 管生命周期，Workspaces 串行 Git 写入。所有者 Task 负责接收请求，不持续占模型槽。分支提交和 Task 结果必须分别检查。旧 Input → planner → Plan Compiler → Work DAG → Candidate 链仍可安全收尾，但不参与新 say。设计约束见[Task 中心输入](task-centered-input-design.md)。

## 按主题阅读

- [核心实体](entities.md)、[数据流](data-flow.md)、[一次 invocation](invocation.md)、[生命周期不变量](invariants.md)、[Token 效率](token-efficiency.md)、[项目身份与恢复](identity-and-recovery.md)
- [输入和旧规划](inputs-and-planning.md)、[旧 Intent / Plan / Candidate](intent-layer.md)、[计划审批闸门](plan-gate.md)
- [分支优先](branch-first.md)、[Git 边界](git-boundary.md)、[分支谱系](branch-genealogy.md)、[合并](merge.md)、[检验](verification.md)、[清理](cleanup.md)
- [界面与传输](interface.md)、[执行记录阅读器](transcript-reader.md)、[模块地图](modules.md)

---

[← 上一篇：交付与验收](review-loop.md) · [返回文档入口](../README.md)
