# Lush 文档

这里是随代码发布的 Markdown 文档入口。Lush 的中心对象正式命名为 **agent-process**（一个拥有独立分支与 worktree 的执行单元，下称 **AP**）；本文档集此后一律以 AP 指代它。当前设计以 **AP** 为中心：一次 `say` 直接创建一个 AP。Intent / Plan / Candidate、草稿、快速路由、效果展示、介绍、托管模式与旧合并编排不再提供公开 API；可调用面以[核心 API 收敛](engineering/core-api.md)与 `src/rpc/registry.js` 为准。

## 使用与部署

1. [项目概览](../README.md)：Lush 是什么、如何启动。
2. [部署](deployment/README.md)：安装、配置与验证；可直接交给 Agent 的[部署指导](deployment/agent-guide.md)。
3. [一条 say 输入如何交付](ap-flow.md)：发送、子 AP、合并预约与人工批准。
4. [核心 API 收敛](engineering/core-api.md)：当前公开的 RPC / CLI / Web 能力与已下线边界。

## 理解与修改系统

- [核心架构](core-architecture.md) → [执行模型](engineering/execution-model.md) → [交付与验收](engineering/review-loop.md) → [工程架构索引](engineering/architecture.md)：当前主链的连续阅读。
- [AP 图与固定输入规则](engineering/ap-graph.md)：实现、可信代码风险与读面边界；[AP 中心输入](engineering/ap-centered-input-design.md)：当前 say 的设计约束。
- [模块设计理念](design/README.md)：修改相关模块前了解目标与取舍，不当作已实现功能清单。
- [接口参考](reference/README.md)：CLI / RPC / HTTP / Web；[贡献指南](contributing/README.md)说明开发及文档写法。
- [改进候选清单](todo/README.md)：待评审建议，按旧基线审查，不代表批准实施。

旧 Intent / Plan / Candidate、草稿、效果展示、介绍、托管模式与旧合并编排的旧行、会话与工作区不迁移、不删除，但不再有公开入口，也不参与新 say 的创建与交付；内部遗留实现与测试仍在清理中，不能把公开白名单当作已完成的物理删码证明。

Web 文档视图读取随当前代码发布的 `README.md` 和 `docs/**/*.md`，不读取被 Lush 开发的目标项目。文档路径经扫描索引，请求只能按已知 ID 命中。
