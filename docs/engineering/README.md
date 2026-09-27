# 工程文档

本层面向修改 Lush runtime、持久化、Git 边界和 Web UI 的开发者。先沿短章建立整体模型，再按改动范围进入主题参考。

## 推荐阅读顺序

1. [核心架构](../core-architecture.md)：当前 say 主链。
2. [执行模型](execution-model.md)：AP、Agent、Run 与唤醒。
3. [交付与验收](review-loop.md)：父确认、合并预约与人工批准。
4. [工程架构索引](architecture.md)：源码主题入口。
5. [生命周期不变量](invariants.md)：实现必须守住的状态约束。

## 运行时与数据

- [核心 API 收敛](core-api.md)：当前公开能力与已下线功能边界。
- [数据流](data-flow.md)
- [AP 中心输入](ap-centered-input-design.md)：当前 say 的设计约束。
- [AP 图与固定输入规则](ap-graph.md)：AP 视角、可信规则执行与读面边界。
- [一次 invocation 与多级协作](invocation.md)
- [Token 效率与用量归因](token-efficiency.md)：有界上下文、快速收尾与可选软预算。
- [项目身份与恢复](identity-and-recovery.md)

## Git 子系统

- [分支优先架构](branch-first.md)
- [Git 边界](git-boundary.md)
- [分支谱系](branch-genealogy.md)
- [分支合并](merge.md)
- [工作区与分支回收](cleanup.md)

## 接口与开发边界

- [模块设计理念](../design/README.md)：修改前先理解长期目标与取舍。
- [界面与传输](interface.md)
- [执行记录阅读器](transcript-reader.md)：摘要、调用配对、完整翻找与无工具解释 Agent。
- [模块地图总览](modules.md)
- [Runtime 与持久化模块](modules-runtime.md)
- [Web 前端模块](modules-web.md)
- [CLI、RPC 与测试模块](modules-interfaces.md)
