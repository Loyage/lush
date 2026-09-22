# 工程架构索引

面向产品与系统设计的核心文档是[《Lush 核心架构》](../core-architecture.md)。本目录补充源码边界、不变量和实现细节。

> 连续阅读：[架构总览](../core-architecture.md) → [执行模型](execution-model.md) → [验收闭环](review-loop.md) → **工程索引**

## 主链

```text
CLI / Web
  → Intent
  → Planner Run
  → Plan/spec
  → deterministic Plan Compiler
  → Work DAG
  → parallel Runs
  → Artifacts
  → Intent integration branch
  → Review Candidate @ exact commit
  → user acceptance
  → target branch
```

## 核心原则

1. **Intent-first**：产品围绕用户目标组织，不围绕内部任务或 Git 拓扑组织。
2. **Candidate-first review**：用户验收固定 commit、报告与证据，不批准可漂移的 branch 名。
3. **Branch-backed safety**：worktree、分支谱系、串行 Git 写入、compare-and-swap 与最终用户批准继续保留。
4. **模型做语义，代码做确定性工作**：planner 理解与拆解；runtime 编译、调度、资源控制和中间集成。
5. **Run 与 Work 分离**：Task 暂作 WorkItem 投影；每次 invocation 独立写 `agent_runs`。
6. **Artifact-first integration**：结果、测试、报告和风险形成结构化 Artifact；transcript 只用于追溯。
7. **控制面不被执行面饿死**：control lane 与 execution lane 分开。

## 实现入口

- [实体](entities.md)
- [执行模型：Task、Run 与 Artifact](execution-model.md)
- [验收闭环：Candidate、反馈与安全落地](review-loop.md)
- [数据流](data-flow.md)
- [Intent、Plan 编译与 Candidate](intent-layer.md)
- [invocation 与 Run](invocation.md)
- [生命周期不变量](invariants.md)
- [分支优先的 Git 子系统](branch-first.md)
- [Git 边界](git-boundary.md)
- [Candidate verifier 与对照检出](verification.md)
- [分支合并](merge.md)
- [清理与恢复](cleanup.md)
- [界面与传输](interface.md)
- [模块地图](modules.md)

Branch-first 文档现在只描述 Git 子系统的不变量；默认产品入口已经是 Intent 工作台，分支图是高级诊断视图。

---

[← 上一篇：验收闭环](review-loop.md) · [返回文档入口](../README.md)
