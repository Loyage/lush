# LushCode 文档导航

按你现在要做的事选择入口。不必顺序读完文档，更不必在第一次提交任务前理解调度与合并协议。这里的 Markdown 也会显示在 Lush Web「文档」页。

## 第一次使用：从这里开始

**推荐路线：[项目概览](../README.md) → [新手教程](getting-started.md) → [指令交付流程](task-flow.md)。**

| 你现在的问题 | 读什么 |
| --- | --- |
| Lush 是什么，适不适合我？ | [项目概览](../README.md)：用途、工作方式与安全边界 |
| Worker、Agent、指令分别是什么？怎么做第一个任务？ | [新手教程](getting-started.md)：用一个小目标走完浏览器操作与交付 |
| 还没安装，怎样打开页面？ | [部署索引](deployment/README.md)：按本机、远程服务器或 WSL2 选择；用户说明与 Agent 配置步骤配套提供 |
| 页面能用了，模型怎么接？ | [Agent 配置](reference/agent-configuration.md)：模型来源、认证入口、设备默认与 Worker 运行设置 |

## 已经在用：按操作查

| 想做的事 | 对应说明 |
| --- | --- |
| 创建任务、追加需求、审阅、合并、验收 | [指令交付流程](task-flow.md) |
| 先保存想法，找回草稿或已发送原话 | [历史输入与草稿](input-history.md) |
| 看懂项目树里的父子关系、连线与合并箭头 | [阅读工作树](engineering/task-graph.md#阅读工作树) |
| 设置自动合并／验收，或等条件满足再执行 | [自动化与预约发射](hooks.md)；详细参数见[Hook 参考](reference/rpc/hooks.md) |
| 了解问题与告知、已读和提醒的区别 | [通知理念](design/notices.md)；操作接口见[Notice 参考](reference/rpc/notices.md) |
| 管理账号来源、选择模型、查看额度 | [Agent 配置](reference/agent-configuration.md)与[账号连接参考](reference/rpc/agents.md#托管账号连接) |
| 选择进度、委派、自动标题等内置能力 | [Agent 能力与 Skills](agent-capabilities.md) |
| 共享或迁移设备设置 | [设备共享设置](device-settings.md)：已有项目只显式预检迁移，不自动覆盖 |
| 安全中断、重启、继续当前项目 | [项目维护](project-maintenance.md) |
| 配置后台访问模型服务的网络代理 | [出站网络](engineering/outbound-network.md)：区别于浏览器访问 Host 的入站网络 |
| 用终端或集成接口操作 Lush | [接口参考](reference/README.md)：CLI、RPC、HTTP 与 Web 路由 |

## 深入理解或参与开发

下面主要面向维护 Lush 本身的人，不是新手教程的前置知识。

- **整体结构：**[核心架构](core-architecture.md) → [执行模型](engineering/execution-model.md) → [交付与验收](engineering/review-loop.md)。修改代码前从[模块地图](engineering/modules.md)定位，再查[工程架构索引](engineering/architecture.md)。
- **产品取舍：**[设计索引](design/README.md)按模块解释目标；[用户工作台](design/user-workspace.md)与[工作台环境](design/workbench.md)说明全局配置、项目入口和运行位置，分别对应[用户工作台契约](engineering/user-workspace.md)与[接入契约](engineering/workbench.md)。
- **输入与关系：**[Worker 图](engineering/task-graph.md)、[Worker 中心输入](engineering/task-centered-input-design.md)以及[多轮迭代](engineering/task-iteration.md)，包括父同步和历史恢复边界。
- **自动化与交付：**[Hook 设计](design/hooks.md)、[Hook 契约](engineering/hooks.md)、[自动链](engineering/completion-hooks.md)；多份成果一次交付的设计见[一次性整合](design/merge-convergence.md)。
- **配置与模型：**[设备设置设计](design/device-settings.md)、[设备设置契约](engineering/device-settings.md)与[共享模型选择接口](engineering/managed-model-selection.md)。
- **开发规范：**[贡献指南](contributing/README.md)说明测试责任与覆盖取舍，[文档约定](contributing/documentation.md)说明写作、链接和检查；[开发优化待办](todo.md)是建议，不代表已实现能力。

## 查旧说明或兼容边界

当前公开能力和已下线边界以[核心 API](engineering/core-api.md)为准。旧版资料中的快速对话、终端观看等入口不要当作现行操作：分别见[快速对话退役](engineering/project-quick-chat.md)与[终端观看移除说明](native-viewer.md)。

Web 文档读取的是随当前 Lush 代码发布的根 `README.md` 与 `docs/**/*.md`，不是你正在开发的目标项目文档。文件按扫描索引提供，仓库内相对链接可用于继续阅读。
