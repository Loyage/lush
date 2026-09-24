# 工程文档

本层面向修改 Lush runtime、持久化、Git 边界和 Web UI 的开发者。先沿短章建立整体模型，再按改动范围进入主题参考。

## 推荐阅读顺序

1. [工程架构索引](architecture.md)：原则与实现入口。
2. [核心实体](entities.md)：Intent、Task、Run、Artifact 与 Candidate 的边界。
3. [执行模型](execution-model.md)：Task、Run、Plan Compiler 与 Artifact。
4. [验收闭环](review-loop.md)：Candidate、反馈与安全落地。
5. [生命周期不变量](invariants.md)：实现必须守住的状态约束。

## 运行时与数据

- [数据流](data-flow.md)
- [输入和规划](inputs-and-planning.md)
- [Intent、Plan 编译与验收候选](intent-layer.md)
- [一次 invocation 与多级协作](invocation.md)
- [Token 效率与用量归因](token-efficiency.md)：有界上下文、快速路由、合并唤醒与可选软预算。
- [项目身份与恢复](identity-and-recovery.md)

## Git 子系统

- [分支优先架构](branch-first.md)
- [Git 边界](git-boundary.md)
- [分支谱系](branch-genealogy.md)
- [分支合并](merge.md)
- [检验与对照检出](verification.md)
- [工作区与分支回收](cleanup.md)

## 接口与开发边界

- [模块设计理念](../design/README.md)：修改前先理解长期目标与取舍。
- [界面与传输](interface.md)
- [执行记录阅读器](transcript-reader.md)：摘要、调用配对、完整翻找与无工具解释 Agent。
- [模块地图总览](modules.md)
- [Runtime 与持久化模块](modules-runtime.md)
- [Web 前端模块](modules-web.md)
- [CLI、RPC 与测试模块](modules-interfaces.md)
