# 任务与拆解

本节管任务树与拆解：`task.list` / `task.tree` / `task.spawn`（含 `name` 与 `deps` 的规则）/ `task.message` / `task.cancel` / `task.retry`。

概念分四层：意图（`inputs` + 根 planner）→ 结构化 Plan（`task_specs`）→ 工作（`tasks`，兼容的 WorkItem 投影）→ Run（`agent_runs` 每次真实调用）。`tasks.layer` 区分：`intent`（planner，以及旧数据里的 scheduler）与 `work`（其余角色）。**`task.list` / `task.tree` / `task.timeline` 只返回 work 层**（`system.status.tasks` 也只数 work 层，另给 `layers` 计数）；planner 的进度由 `input.list` 下发，需要细节时用 `task.inspect ID` 按 id 直接读。规划闸门与确定性编译见 [输入、规划与缓存](inputs.md)，读模型与分页见 [审阅与过程读模型](inspect.md)。

| CLI | RPC | 参数 |
|---|---|---|
| `task list [--after N] [--limit N]` | `task.list` | `{after?: 0, limit?: 200}`，limit 最大 1000，只含 work 层 |
| `task tree [ID]` | `task.tree` | `{id?}` |
| `task spawn 'goal' --parent ID --role worker [--name short-kebab-name] [--depends-on ID[:kind]]` | `task.spawn` | `{parent, goal, role?: 'worker', deps?: [{id, kind: 'code'|'order'}], name?}` |
| `task message ID 'body'` | `task.message` | `{id, body}` |
| `task cancel ID` | `task.cancel` | `{id}` |
| `task retry ID` | `task.retry` | `{id}` |

spawn 必须关联一个活动父 task；根任务只能由用户输入创建，planner 只写结构化 Plan，编译后的根工作由 runtime 直接创建。角色可选 `worker` / `coordinator` / `research`，`planner` / `scheduler` 不能由 agent 创建。`name` 是任务自己的英文短名（kebab-case），写入只读的 `tasks.name`，决定分支与 worktree 名：`lush/<项目哈希>/<id>-<name>` 与 `.lush/worktrees/<id>-<name>`。省略时 runtime 从 goal 首行提取英文词回退，提不出可用词则任务没有 name（分支/目录回到 `task-<id>`）。`name` 给不出至少两个 ASCII 字母或数字时报 `name needs at least two ASCII letters or digits (kebab-case)`；名字不可改，已有 worktree 不会被改名。任务基线是输入提交时冻结的 commit；普通任务的 direct parent / target 是输入分支，`code` 下游则从上游 reviewed commit 创建并以该上游分支为 direct parent。branch-sync merger 从待同步 child tip 创建。见 [输入和规划](../../engineering/inputs-and-planning.md)。

`deps` 是依赖边（`task_deps` 表，`(task_id, depends_on, kind)`，创建后不可变）。`kind` 默认 `code`：本任务的 worktree 从上游分支拉出（stacked），`base_commit` 冻结为上游的 `head_commit`，审阅 diff 只含本任务自己的提交；`order` 只等上游终态，代码仍从输入提交时冻结的 commit 开始。`kind` 缺省由 CLI 的 `--dep-kind` 决定。提交时做结构校验并拒绝：自依赖、依赖祖先任务（父任务在等子任务结算，双方会互等而死）、悬空 id、一个任务多于一条 `code` 边、`code` 边指向非 worker 或已 failed/cancelled 的上游。边只在创建时写入，所以环在结构上不可能；`assertDeps` 仍保留可达性校验，供未来加改边 API。

依赖未满足的 `queued` 任务不会被调度，`task.list` / `tree` 的每行都带 `deps: [{id, kind, status}]` 与 `blocked` 布尔值，`task.inspect` 额外给出 `deps` / `dependents`（带上游状态、角色、goal 摘要）、`runs` 与 `artifacts`。上游结算时 `finish` 唤醒每一个依赖它的任务。

## Run 与 Artifact

每次 provider invocation 先写一条 `agent_runs` 行（attempt / role / provider / started_at / ended_at / result / error），正常结束时写 version 2 `run.result` Artifact。Envelope 保留 outcome / summary / changes / evidence / decisions / risks / artifacts / followups，并用独立的 `invocation.status` 与 `verification.status` 区分“调用正常返回”和 `pass` / `fail` / `partial` / `unverified`。`pass` 必须没有 `failures` / `unverified`，但允许记录 `baseline_failures` / `residual_risks`；旧 payload 不重写，缺少或包含矛盾结构化证据时读作 `unknown`。`task.inspect` 返回该任务的 `runs` 与 `artifacts`；`candidate.inspect` 返回该 Intent 的 Artifacts。Task 的 `calls` / `agent_wakes` 仍用于兼容读模型。

合并这批任务见 [合并](merge.md)。
