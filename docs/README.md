# Lush 文档

这里是随代码发布的 Markdown 文档入口。先读当前 say 流程，再按任务选择设计、实现或接口参考；**旧 Input → Plan → Candidate 流程只用于旧客户端和存量任务**。

## 使用与部署

1. [项目概览](../README.md)：Lush 是什么、如何启动。
2. [部署](deployment/README.md)：安装、配置与验证；可直接交给 Agent 的[部署指导](deployment/agent-guide.md)。
3. [一条 say 输入如何交付](task-flow.md)：发送、子任务、预约和人工批准。
4. [分支效果展示](showcase.md)：展示的准入、范围与限制。

## 理解与修改系统

- [核心架构](core-architecture.md) → [执行模型](engineering/execution-model.md) → [交付与验收](engineering/review-loop.md) → [工程架构索引](engineering/architecture.md)：当前主链的连续阅读。
- [Task 中心输入](engineering/task-centered-input-design.md)：新输入的设计约束；[工程文档](engineering/README.md)和[模块地图](engineering/modules.md)用于查实现入口。
- [模块设计理念](design/README.md)：修改相关模块前了解目标与取舍，不当作已实现功能清单。
- [接口参考](reference/README.md)：CLI / RPC / HTTP / Web；[贡献指南](contributing/README.md)说明开发及文档写法。
- [托管模式](sleep-mode.md)、[改进候选清单](todo/README.md)：独立主题；候选清单不代表批准实施。

## 历史协议

旧 `input.submit` / 批量 `draft.commit` 仍可走 [提交与规划](task-flow-1-planning.md) → [私有集成与候选](task-flow-2-integration.md) → [验收与回收](task-flow-3-delivery.md)。这些章节说明兼容收尾，**不是新 say 的步骤**。旧 RPC 的准确边界见[输入参考](reference/rpc/inputs.md)与[Candidate 参考](reference/rpc/candidates.md)。

Web 文档视图读取随当前代码发布的 `README.md` 和 `docs/**/*.md`，不读取被 Lush 开发的目标项目。文档路径经扫描索引，请求只能按已知 ID 命中。
