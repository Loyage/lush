# Run、invocation 与多级协作

## WorkItem 与 Run

`tasks` 暂时是兼容的 WorkItem 投影；每次真实 provider 调用都会先写 `agent_runs`：

```text
WorkItem #42
├── Run #80（failed）
├── Run #81（completed，等待用户答复）
└── Run #85（completed，最终结果）
```

Task 的累计 calls / wakes 继续用于兼容读模型，Run 保存每次调用自己的 attempt、provider、时间、result 与 error。成功输出同时形成 `run.result` Artifact。

## 一次 invocation

1. Dispatcher 按依赖与两条 lane 的容量选择 queued WorkItem。
2. `running` Map 占位，签发本次 invocation token，创建 `agent_runs` 行。
3. 准备 cwd：planner 使用 Intent worktree；worker 使用隔离 worktree；Candidate verifier 使用固定 integration commit 与 baseline commit。
4. 读取启动时未消费消息、相关工作与 Artifact 上下文；若是 planner，再读取 Input 的引用快照并按稳定目标解析本轮最新状态，组成 `referenced_context` 后启动 provider。
5. 成功返回后消费启动时消息，保存 Task 兼容 result、结束 Run、写 Artifact。
6. 判定未读消息、Decision、活动子任务与工作区提交，进入 queued / awaiting / waiting / completed。
7. 释放 token 和槽，再检查一次收件箱避免 lost wake-up。

失败或取消会结束对应 Run；崩溃恢复不重放未知副作用。

## 两条 admission lane

- control：planner 和兼容历史 scheduler，容量默认 `LUSH_CONTROL_CONCURRENCY`（2）；
- execution：worker / coordinator / research / verifier / merger，容量默认 `LUSH_CONCURRENCY`（4）。

两条 lane 独立计数。容量是可在运行时改写的项目级设置（`<home>/settings.json` 覆盖环境默认值，Web「设置 → 系统」与 `lush config` 可改）；写盘后同步内存并重新 pump，下一次调度立即按新生效值准入，不需要重启 daemon。waiting / awaiting / 依赖未满足的 queued 不占槽。

## Plan 编译

planner 只写结构化 spec。它结束一轮后，runtime 直接创建 root work tasks 和依赖；新路径不会启动 scheduler invocation。不同 Intent 的 Plan 不等待前一批 worker 完成。

## 协作与集成

coordinator 仍可动态派生子任务；Plan compiler 创建的根 worker 完成后由 Integration Service 在私有 Intent branch 内自动叶子优先聚合。分歧时创建 child-side merger，target branch 始终留给最终 Candidate approval。

verifier 有两种来源：

- `task.verify`：兼容的单 worker 对照；
- Review Candidate：对照固定 integration commit 与固定 target baseline，报告完成后 Candidate 进入 `ready`。
