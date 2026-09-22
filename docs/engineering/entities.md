# 核心实体

视觉总览与连续阅读入口见[核心架构](../core-architecture.md)。当前实现采用渐进迁移：`Task` 仍是兼容的 WorkItem 投影，同时新增 Run、Artifact 与 Review Candidate。

- **Project**：daemon 的不可变作用域：canonical 目录 + `.lush/project.json` + SQLite 项目绑定。
- **Intent / Input**：用户原话、flow、目标分支和私有 integration branch。可附带结构化上下文引用；引用是 Input / Draft 的元数据，不是新的顶层实体。每条引用保留用户当时所见快照和稳定目标，planner invocation 再解析目标当前状态。所有 Plan、Work、Artifact、反馈与 Candidate 都归属同一 Intent。
- **Plan / Spec**：planner 写下的结构化工作条目、角色、依赖与短名。planner 结束后由 runtime 确定性编译，不经过 scheduler agent。
- **WorkItem / Task**：稳定工作目标、角色、依赖、执行状态与工作区。现阶段数据库和兼容 API 仍使用 `tasks` 名称。
- **Run**：一次 provider invocation。`agent_runs` 保存 attempt、角色、provider、开始/结束时间、结果和错误；一次 WorkItem 可以有多次 Run。
- **Artifact**：Run 的结构化产出，例如结果摘要、commit、测试证据、报告、发现、风险和后续事项。当前 provider 文本会形成 `run.result` Artifact。
- **Review Candidate**：面向用户的交付单位。它固定 Intent integration branch 的精确 commit 与 target baseline commit，绑定 verifier HTML 报告和验收状态。
- **Decision / Notice**：真正需要用户拍板的计划、问题、冲突或最终验收。现阶段计划与问题仍通过 `notices` 兼容实现。
- **Message**：持久化收件箱，在 invocation 边界投递补充、反馈和子任务结果。
- **Event**：创建、调用、状态转换、Plan 编译、Artifact、Candidate 与 Git 生命周期审计。

## Branch 的位置

Branch 是 Git 子系统的核心资源，但不是最高层产品实体：

- Intent 回答“用户要什么”；
- WorkItem / Run 回答“谁做了什么”；
- Artifact 回答“产生了什么证据”；
- Review Candidate 回答“用户实际验收哪一版”；
- Branch / Commit 回答“代码如何隔离、聚合、恢复和安全落地”。

用户接受的是 Candidate 固定的 commit，而不是可继续移动的 branch 名。
