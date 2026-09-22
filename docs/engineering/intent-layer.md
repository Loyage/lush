# Intent、Plan 编译与验收候选

本章描述控制面：用户原话如何成为结构化 Plan、runtime 如何编译 Work DAG，以及最终成果如何成为可验收候选。视觉总览与连续阅读入口见[核心架构](../core-architecture.md)。

## Intent-first

`inputs` 保存用户原话、flow、目标分支与私有 integration branch。根 planner 属于 `layer='intent'`，不进入执行任务树；它负责语义理解，不修改代码。

主流程：

```text
Intent
  → planner invocation
  → task_specs（结构化 Plan）
  → deterministic Plan Compiler
  → root work tasks + task_deps
  → agent_runs + artifacts
  → private Intent integration branch
  → review_candidates
```

## 没有 scheduler agent

planner 一轮写完时，`Project.compilePlans()` 选择已经停止执行且不受计划闸门阻挡的 spec。runtime 按依赖顺序直接调用 `materializeSpec()`：

1. 校验 spec 角色、flow 与依赖；
2. 将 spec 依赖翻译为 task id；
3. 在事务中创建 root work task；
4. 写入 `task_deps`；
5. 将 spec 标为 `planned`；
6. 写 `plan.materialized` / `plan.compiled` 事件。

不存在 scheduler invocation、全项目 batch 锁或额外模型调用。不同 Intent 的 Plan 可以在已有 worker 仍运行时继续编译。

旧数据库中 `role='scheduler'` 与 `task_specs.batch_id` 仍可读取，用于历史审计；新路径不再创建它们。

## 两条并发车道

- control lane：planner 等控制面调用，容量默认 `LUSH_CONTROL_CONCURRENCY`（2）；
- execution lane：worker / coordinator / research / verifier / merger，容量默认 `LUSH_CONCURRENCY`（4）。

两条车道的容量由项目级运行设置给出：上面两个环境变量只是默认值，被 `<home>/settings.json` 里显式覆盖的键取代。Web「设置 → 系统 → 并发额度」与 `lush config` 可以在运行时改写；写入内存并重新准入，下一次调度即按新生效值准入，不需要重启 daemon（调低并发不取消已经在跑的任务）。读取面见[agent 环境与权限](../reference/agent-environment.md)。

因此长时间 worker 不能占满 planner 的槽。依赖未满足、waiting、awaiting 都不占调用槽。

## 计划审批闸门

默认 Plan 直接编译。planner 只有在影响面大、与现状冲突或意图存在实质歧义时才 `plan.propose`：

- approve：planner 结算，runtime 编译 pending spec；
- reject：本轮 spec 标为 dropped，理由进入 planner 收件箱，下一轮重拆。

## 自动中间集成

由 Plan 编译产生的 worker 完成后，`IntegrationService` 自动在私有 Intent 分支内部收敛：

1. 从最深后代开始；
2. 可 fast-forward 的 child 自动进入 direct parent；
3. 父子分歧时自动创建 child-side merger；
4. merger 完成后继续逐层 fast-forward；
5. **Intent branch 不会自动进入用户 target branch。**

仍有活动工作、失败 worker 或未收拢分支时，不创建最终候选。

## Review Candidate

内部工作全部收敛后，runtime：

1. 固定 Intent integration branch 的 commit；
2. 固定 target branch 的 baseline commit；
3. 创建状态为 `pending` 的 `review_candidates` 版本，到这里不启动验收任务；
4. 用户显式调用 `candidate.verify` 后，派只读 verifier 在两边运行同一验收场景；
5. 保存自包含 HTML 报告和 version 1 结构化证据；
6. runtime 校验证据并绑定两侧 commit；只有结论 `pass` 且报告存在时将 Candidate 标记为 `ready`。

用户可：

- `candidate accept`：再次确认 branch tip 等于被审阅 commit，再合入 target；
- `candidate changes`：旧版本标为 `changes_requested`，在同一 Intent 下启动增量 planner；
- `candidate reject`：放弃该版本，历史仍保留。

Candidate 状态：

```text
pending → preparing → ready → accepted → integrated
                       └→ changes_requested → Candidate v2
                       └→ rejected
pending/preparing/ready/accepted → superseded
```

## Run 与 Artifact

每次 provider invocation 写一条 `agent_runs`，正常结束时写 version 2 `run.result` Artifact。Task 目前保留为兼容 WorkItem 投影；Run 负责一次调用的状态、结果与错误，Artifact 分开记录 invocation 完成和 verification 的 `pass` / `fail` / `partial` / `unverified`。旧 payload 不重写，缺证据的读模型为 `unknown`。
