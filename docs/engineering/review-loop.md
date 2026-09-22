# 验收闭环：Candidate、反馈与安全落地

本章说明成果如何从私有 Intent 分支成为绑定精确 commit 的 Review Candidate，以及用户要求修改后如何形成下一版。

> 连续阅读：[架构总览](../core-architecture.md) → [执行模型](execution-model.md) → **验收闭环** → [工程索引](architecture.md)

## 产品轴与 Git 轴

```mermaid
flowchart LR
    subgraph product[产品轴]
        I("Intent") --> P("Plan revision")
        P --> T("Task DAG")
        T --> A("Artifacts")
        A --> C("Review Candidate v1 / v2")
        C --> D("Decision")
    end
    subgraph git[Git 轴]
        B("Target Branch") --> IB("Intent Integration Branch")
        IB --> WA("Worker Branch A")
        IB --> WB("Worker Branch B")
        IB --> WC("Worker Branch C")
    end
    A -.聚合.-> IB
    IB -.精确 commit.-> C
    D -.接受.-> B
```

产品界面围绕 Intent、成果与验收组织；分支图保留为 Git 诊断视图。用户不需要通过提交拓扑理解目标，但底层仍依靠 worktree、分支谱系与 fast-forward 规则保证安全和恢复能力。

## Review Candidate 生命周期

```mermaid
stateDiagram-v2
    [*] --> pending: integration commit 已冻结
    pending --> preparing: 用户启动验收
    preparing --> ready: 当前 verifier 报告存在且结构化结论 pass
    preparing --> failed: fail / partial / unverified / 缺报告 / 执行失败
    preparing --> changes_requested: 用户要求修改
    preparing --> rejected: 用户放弃
    preparing --> superseded: 新版本替代
    failed --> preparing: 重新验收
    ready --> accepted: 用户接受
    accepted --> integrated: 固定 commit 已落地或已集成
    accepted --> ready: 落地失败并记录原因
    ready --> changes_requested: 用户要求修改
    changes_requested --> pending: 增量 Plan 产出 v2
    ready --> rejected: 用户放弃
    ready --> superseded: 新版本替代
```

Candidate 创建时同时固定 integration commit 与 baseline commit。Verifier 在两边运行同一验收场景，生成自包含 HTML 报告和 version 1 结构化证据；runtime 把固定 commit、命令/退出码、失败、未验证、基准失败、残余风险与报告引用写入 version 2 `run.result`。Invocation 正常返回与 verification 结论是两个字段；`pass` 必须没有 Candidate 侧的 `failures` 或 `unverified`，但可以如实保留基线失败与已知 `residual_risks`，只有这类一致的 `pass` 加报告才放行 `ready`。Verifier 结算用事务内的条件更新同时核验 Candidate 仍为 `preparing` 且 `report_task_id` 仍属于自己；用户已经拒绝、要求修改、准备替代版本或启动更新的 verifier 时，迟到结果只记录 `candidate.verification_ignored`，不能恢复旧状态。当前实现不主动取消已经启动的 verifier，其 Task、Run、Artifact 与报告仍可追溯。

接受前 runtime 再次校验分支 tip 仍等于候选 commit；如果在这次校验前已经移动，旧批准不得复用，必须生成新版本。通过校验并进入 `accepted` 后，接受决定不可取消：并发的 reject、changes 或新 Candidate prepare/supersede 都会被集中状态机确定性拒绝。固定 commit 会继续传到 Git 串行边界：边界在同一串行区间内判断该提交已集成或把目标分支 fast-forward 到它，实际命令不再读取可变的 child tip。落地失败时 Candidate 回到 `ready`，并记录 `candidate.accept_failed` 事件；只有固定提交落地或已在目标分支中才进入 `integrated`。

## 反馈闭环

要求修改不会覆盖旧候选：反馈形成同一 Intent 下的新输入，增量 planner 产出新的 Task DAG 与 Candidate v2。旧 commit、旧报告和旧决策继续保留，因而每次验收都有明确对象和审计链。

```mermaid
flowchart TD
    V1("Candidate v1 ready") --> decision{用户决定}
    decision -->|接受| land(["精确 commit 落地"])
    decision -->|要求修改| feedback("Feedback Artifact")
    feedback --> planner("Incremental Planner")
    planner --> dag("New Task DAG")
    dag --> V2("Candidate v2")
    decision -->|放弃| rejected(["Rejected，历史保留"])
```

## 安全与恢复原则

- **项目级作用域**：一个 daemon 绑定一个 canonical 项目目录，状态固定在项目的 `.lush/`。
- **短期凭证**：Agent token 只在当前 invocation 有效，数据库只保存 SHA-256。
- **未知副作用不重放**：崩溃后的 running Run 标记失败，由用户检查现场并明确重试。
- **Git 写操作串行**：不做 shell 插值；compare-and-swap 与每次重新校验避免静默覆盖。
- **验收绑定 commit**：用户接受不可变的树；校验前的 branch 漂移拒绝旧批准，校验后的并发前进也只能落地固定 commit。
- **历史与磁盘分离**：Run、Artifact、Event 可长期保留；worktree 与 branch 按安全门独立回收。

## 界面信息架构

| 视图 | 回答的问题 |
|---|---|
| Intent 工作台 | 我提出的目标现在怎样？有什么成果需要验收？ |
| Execution DAG / 任务树 | 哪些工作并行、依赖谁、为什么被阻塞？ |
| Candidate Review | 实际结果是什么？我接受的是哪个 commit？ |
| Decision Queue | 现在真正需要我决定什么？ |
| Branch Diagnostics | 底层 Git 为什么分歧、缺失、落后或不能集成？ |

默认产品入口是 Intent 工作台。Branch 和 worktree 继续承担代码隔离、集成与恢复，但退回基础设施层。

## 当前实现与演进边界

现有 SQLite、项目 daemon、Task / Agent 身份、worktree 隔离、事件审计、短期 token、恢复策略和最终用户批准继续保留。迁移采用加表、加列与兼容 RPC；旧 Task、spec 与 branch 历史仍可读取。

架构判断标准不是“层数越少越好”，而是：

- 语义判断交给模型，确定性工作交给 runtime；
- 用户围绕目标和结果行动，Git 围绕安全和恢复行动；
- 关键事实可持久化、可验证、可追溯；
- 最终只落地用户实际验收过的 commit。


---

[← 上一篇：执行模型](execution-model.md) · [下一篇：工程架构索引 →](architecture.md)
