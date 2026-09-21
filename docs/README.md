# 文档

- [使用说明](../README.md)：安装、运行与常用命令。
- [行动任务处理流程](task-flow.md)：从输入、规划、执行、审阅到交付、解冲突与回收的完整使用流程。
- [核心架构（HTML）](core-architecture.html)：Intent-first、Work DAG、结构化 Artifact、Review Candidate 与从输入到最终验收的完整流程图。
- [总体架构](engineering/architecture.md)：现有模块、实体、不变量、调度与恢复的详细索引。
- [CLI / RPC 参考](reference/api.md)：公开接口。
- [Review Candidate](reference/rpc/candidates.md)：固定 commit 的验收与反馈闭环。

## 架构各章（`docs/engineering/`）

- [实体](engineering/entities.md)：Project / Input / Task / Agent / Message / Notice / Event。
- [数据流](engineering/data-flow.md)：入口到 Project 的结构与校验边界。
- [输入和规划](engineering/inputs-and-planning.md)：输入的落库、规划槽与 `inputs.flow`。
- [意图层与拆解队列](engineering/intent-layer.md)：`layer='intent'`、spec 批次与 `spec drop`。
- [计划审批闸门](engineering/plan-gate.md)：`plan.propose` / `approve` / `reject`。- [一次 invocation 与多级协作](engineering/invocation.md)：七步流程、角色、verifier 与上限。
- [生命周期不变量](engineering/invariants.md)：逐条不变量清单。
- [分支优先架构](engineering/branch-first.md)：输入聚合分支、direct-parent / ff-only 与子侧同步的不变量。
- [Git 边界](engineering/git-boundary.md)：worktree / 分支创建、原子推进与回收边界。
- [分支谱系](engineering/branch-genealogy.md)：显式记录的 branch 创建关系、`recorded` / `unknown` 与删除后的处理。
- [分支合并](engineering/merge.md)：流程图连线状态、fast-forward 与父分支进入子侧的分歧收敛。
- [检验与对照检出](engineering/verification.md)：只读对照检出与回收时机。
- [工作区与分支回收](engineering/cleanup.md)：清理与回收的安全门。
- [项目身份与恢复](engineering/identity-and-recovery.md)：身份、锁、socket 与重启恢复。
- [界面与传输](engineering/interface.md)：CLI、Web、RPC 信任边界与 `system.status`。
- [模块地图](engineering/modules.md)：`src/` 与 `test/` 的分区与导出签名。

Web UI 左栏的「文档」直接读这些文件（随代码发布，不随被开发项目变），目录页就在右栏；
文档里的相对链接可以直接点开，地址栏是 `#docs` / `#doc-<id>`。

文档只描述当前实现。实体是 Input / Task / Agent / Message / Notice / Event，作用域是单个项目目录 `<project>/.lush/`。
