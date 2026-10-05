# Lush 文档

这里是随代码发布的 Markdown 文档入口。当前设计以 **Worker** 为中心：一次 `order` 直接创建一个拥有独立分支与 worktree 的 Worker。Intent / Plan / Candidate、草稿、快速路由、效果展示、介绍、托管模式与旧合并编排不再提供公开 API；可调用面以[核心 API 收敛](engineering/core-api.md)与 `src/rpc/registry.js` 为准。

## 使用与部署

1. [项目概览](../README.md)：Lush 是什么、如何启动。
2. [部署](deployment/README.md)：按场景成对提供用户说明与 Agent 配置指导，覆盖 macOS/Linux 本机、远程 Host、桌面 SSH 首次部署、远程桌面、Windows 客户端和 WSL2。先读原因与取舍，再委托配置与验收。
3. [一条指令输入如何交付](task-flow.md)：发送、子Worker、合并预约、多轮验收与归档；[历史输入与暂存](input-history.md)：先保存想法、随后发射，以及检索原始指令。
4. [核心 API 收敛](engineering/core-api.md)：当前公开的 RPC / CLI / Web 能力与已下线边界。
5. [Agent 账号连接](reference/rpc/agents.md#托管账号连接)：多账号资源、密钥/OAuth登录、显式 Pi 连接选择和额度历史；[共享模型选择接口](engineering/managed-model-selection.md)说明兼容 API 与未来策略扩展边界。

## 理解与修改系统

- [核心架构](core-architecture.md) → [执行模型](engineering/execution-model.md) → [交付与验收](engineering/review-loop.md) → [工程架构索引](engineering/architecture.md)：当前主链的连续阅读。
- [Worker 图与固定输入规则](engineering/task-graph.md)：实现、可信代码风险与读面边界；[Worker 中心输入](engineering/task-centered-input-design.md)：当前指令的设计约束。
- [已合并 Worker 的持续迭代](engineering/task-iteration.md)：追加输入、多轮交付、验收与归档、安全父同步及历史显式恢复。
- [工作台与开发环境](design/workbench.md)：主体启动、独立项目窗口、SSH 执行位置与后台开关；[工程接缝](engineering/workbench.md)记录接入范围与限制。
- [模块设计理念](design/README.md)：修改相关模块前了解目标与取舍，不当作已实现功能清单。
- [接口参考](reference/README.md)：CLI / RPC / HTTP / Web；[贡献指南](contributing/README.md)说明开发及文档写法。
- [改进候选清单](todo/README.md)：保留尚未完成的建议与验证方向，已完成文档移出待办；候选不代表批准实施。

旧 Intent / Plan / Candidate、草稿、效果展示、介绍、托管模式与旧合并编排的旧行、会话与工作区不迁移、不删除，但不再有公开入口，也不参与新指令的创建与交付；内部遗留实现与测试仍在清理中，不能把公开白名单当作已完成的物理删码证明。

Web 文档视图读取随当前代码发布的 `README.md` 和 `docs/**/*.md`，不读取被 Lush 开发的目标项目。文档路径经扫描索引，请求只能按已知 ID 命中。
