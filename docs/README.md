# LushCode 文档

这里是随代码发布的 Markdown 文档入口，按你要解决的问题选择章节，不要求顺序或递归通读。当前公开能力与旧数据兼容统一见[核心 API](engineering/core-api.md)。

## 使用与部署

1. [项目概览](../README.md)：Lush 是什么、如何启动。
2. [部署](deployment/README.md)：按场景成对提供用户说明与 Agent 配置指导，覆盖 macOS/Linux 本机 Web、用户配置的服务器 Host 和 Windows WSL2。先读原因与取舍，再委托配置与验收。
3. [一条指令输入如何交付](task-flow.md)：发送、子Worker、合并预约、多轮验收与归档；[历史输入与暂存](input-history.md)：先保存想法、随后发射，以及检索原始指令；[阅读工作树](engineering/task-graph.md#阅读工作树)：连线、合并箭头与展示排序。
4. [自动化与预约发射](hooks.md)：串行自动合并／验收／归档、冻结父分支上的完整参数预约、项目模板与安全取消；[接口参考](reference/rpc/hooks.md)。
5. [核心 API 收敛](engineering/core-api.md)：当前公开的 RPC / CLI / Web 能力与已下线边界。
6. [Agent 配置与运行设置](reference/agent-configuration.md)：Lush/Pi 双模式、来源和额度 CLI、模型缓存与插件/Skills 管理；[Agent 账号连接](reference/rpc/agents.md#托管账号连接)：多账号资源、密钥/OAuth登录、显式 Pi 连接选择和额度历史；[共享模型选择接口](engineering/managed-model-selection.md)说明兼容 API 与未来策略扩展边界。

7. [项目出站网络代理](engineering/outbound-network.md)：项目后台与 Agent 的代理范围、私有配置、三种模式和远端执行位置；不同于模型端点或 Host 入站代理。
8. [快速对话退役](engineering/project-quick-chat.md)：功能已删除，专用数据的安全清理与历史兼容边界。
9. [全部中断、重启与全部继续](project-maintenance.md)：当前项目持久维护暂停、安全重启窗口和父子 Worker 的恢复安排。
10. [终端观看入口移除说明](native-viewer.md)：持续阅读使用 Web 工作台，CLI 保留单次执行记录查询。
11. [Agent 能力开关与 Skills](agent-capabilities.md)：全局选择进度、委派、自动标题和上下文检索，薄入口与按需 CLI 指南。

## 理解与修改系统

- [核心架构](core-architecture.md) → [执行模型](engineering/execution-model.md) → [交付与验收](engineering/review-loop.md) → [工程架构索引](engineering/architecture.md)：首次了解主链的可选路线；具体修改从[模块地图](engineering/modules.md)定位。
- [Worker 图与固定输入规则](engineering/task-graph.md)：实现、可信代码风险与读面边界；[Worker 中心输入](engineering/task-centered-input-design.md)：当前指令的设计约束。
- [Worker Hooks](design/hooks.md)：触发、挂载与受控动作；[工程契约](engineering/hooks.md)、[自动链](engineering/completion-hooks.md)记录授权与恢复边界。
- [已合并 Worker 的持续迭代](engineering/task-iteration.md)：追加输入、多轮交付、验收与归档、安全父同步及历史显式恢复。
- [一次性整合设计](design/merge-convergence.md)：显式固定来源、由一个 Worker 自主适配与验证后一次合入；普通 serial 保留，持续归并设置退休，附实现与历史兼容边界。
- [用户工作台](design/user-workspace.md)：设备唯一设置、全局收件箱与自动化、项目工作页分离；[工程契约](engineering/user-workspace.md)固定当前接口。
- [工作台与开发环境](design/workbench.md)：主体启动、独立项目标签、用户管理的远程网络与后台开关；[工程接缝](engineering/workbench.md)记录接入范围与限制。
- [设备共享设置与迁移](device-settings.md)：用户编辑范围、迁移和中断恢复；[设计理念](design/device-settings.md)解释私有凭证边界；[工程契约](engineering/device-settings.md)保留旧继承方案的兼容与迁移记录。
- [模块设计理念](design/README.md)：修改相关模块前了解目标与取舍，不当作已实现功能清单。
- [接口参考](reference/README.md)：CLI / RPC / HTTP / Web；[贡献指南](contributing/README.md)说明开发及文档写法。
- [开发优化待办](todo.md)：近期 Worker 运行复盘的改进建议、优先级及验收方向，不代表已实现能力。

Web 文档视图读取随当前代码发布的 `README.md` 和 `docs/**/*.md`，不读取被 Lush 开发的目标项目。文档路径经扫描索引，请求只能按已知 ID 命中。
