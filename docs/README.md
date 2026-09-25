# Lush 文档

这里是随 Lush 代码发布的文档入口。仓库文档统一使用 Markdown，流程图使用 Mermaid；同一份源文件可以由 Agent、GitHub 和 Lush Web 阅读。

文档分成两种：**连续阅读的短章**负责建立心智模型，**主题参考**负责回答具体实现与接口问题。每条连续阅读线都在页首标出当前位置、页尾提供上一篇与下一篇。

## 第一次使用：按流程阅读

1. [使用说明](../README.md)：项目定位、设计理念与部署方式概览。
2. [部署](deployment/README.md)：把 Lush 装起来、跑起来并验证；Agent 部署指导文件见[部署指导](deployment/agent-guide.md)。
3. [流程总览](task-flow.md)：先看一张从 Intent 到验收的全景图。
4. [提交 Intent 与编译 Plan](task-flow-1-planning.md)：理解冻结基线与 Work DAG。
5. [私有集成与 Review Candidate](task-flow-2-integration.md)：理解并行成果如何收敛。
6. [验收、诊断与安全回收](task-flow-3-delivery.md)：接受、修改、证据、分支诊断和清理。

用户侧的手动验收主入口现已替换为[分支效果展示](showcase.md)：专用 agent 分析、设计并执行展示；上述 Candidate / verifier 章节描述仍保留的底层兼容机制。展示不自动放行检验或批准合并。

## 理解系统：按架构阅读

1. [核心架构](core-architecture.md)：四个中心、主链与实体边界。
2. [执行模型](engineering/execution-model.md)：Task、Agent、Run、Plan Compiler 与 Artifact。
3. [验收闭环](engineering/review-loop.md)：产品轴、Git 轴、Candidate 与反馈。
4. [工程架构索引](engineering/architecture.md)：按源码主题继续深入。

下一代输入与 Task 的目标方案见[Task 中心输入架构（待实施）](engineering/task-centered-input-design.md)和[实施与验收](engineering/task-centered-input-rollout.md)；它们不是当前功能说明。

## 设计理念：修改模块前阅读

[模块设计理念](design/README.md)解释长期目标与设计取舍，首篇是[Agent 执行过程](design/agent-process.md)。它不是功能完成清单；具体能力仍看工程与接口文档。

## 按需查阅

- [托管模式](sleep-mode.md)：授权管家自动处理 Notice、项目 token 预算、关闭与选择留档。
- [部署](deployment/README.md)：安装、启动、远程访问、Agent 配置与安全边界。
- [工程文档](engineering/README.md)：源码边界、生命周期不变量、调度、Git 和恢复机制。
- [接口参考](reference/README.md)：CLI、RPC、HTTP、Agent 环境与 Web 路由。
- [贡献指南](contributing/README.md)：开发入口和文档写作约定。
- [改进候选清单](todo/README.md)：并行审查发现、证据与建议优先级；供评审，不代表已批准或已实现。
- [模块地图](engineering/modules.md)：并行开发边界；细表拆为 Runtime、Web、CLI / RPC / 测试三章。

Web UI 读取随当前代码发布的 `README.md` 与 `docs/**/*.md`，不读取正在被 Lush 开发的目标项目。文档路径先经过扫描索引，请求只能按已知 ID 命中，不会拼接任意文件路径。

工程与接口文档描述当前实现；设计理念章节描述长期方向，不能用来声称功能已实现。运行时业务实体仍为 Input / Task / Agent / Message / Notice / Event；Run、Artifact 与 Review Candidate 是围绕执行和验收持久化的结构化事实。
