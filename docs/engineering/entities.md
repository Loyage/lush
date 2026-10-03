# 核心实体

本文面向维护存储与读模型的开发者；[核心架构](../core-architecture.md)先介绍当前主链，字段和接口见[模块地图](modules.md)与[RPC 参考](../reference/rpc/README.md)。

- **Project**：daemon 绑定的 canonical 目录与 `.lush/` 项目状态。
- **Input**：用户原话、引用、草稿来源。新指令的 `inputs.task_id` 指向拥有输入分支的 Worker；旧 Input 的指针仍指向 planner，不迁移历史。
- **Worker / Agent**：持久工作身份与一对一 Agent，保存目标、父子关系、状态、结果、工作区与分支。main/owner 是静息分支所有者；新指令 / child 拥有独立 worktree。一次返回不等于 Worker 终结。
- **Message / Notice / Event**：消息和去重信号进入Worker收件箱；Notice 承载用户决定；Event 是状态与操作的审计事实。
- **Run / Artifact**：`agent_runs` 记录每次 provider 调用，Artifact 保存结果或证据。它们是围绕 Worker 的结构化事实，不替代 Worker 生命周期。
- **Branch / Commit**：Git ref 与 worktree 是代码事实；谱系和固定提交用于可审阅的集成与恢复。Worker 结算不自动推进 Git。

旧 Intent / Plan / Candidate 等结构只用于读懂历史行；记录保留在磁盘上，但不再有公开 RPC / CLI / Web 入口，也不是新指令的前置实体。当前可调用面见[核心 API 收敛](core-api.md)。
