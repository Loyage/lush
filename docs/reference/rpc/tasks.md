# 任务与拆解

本节管任务树与拆解：`task.list` / `task.tree` / `task.spawn`（含 `name` 与 `deps` 的规则）/ `task.message` / `task.cancel` / `task.retry`。

旧协议分四层：意图（`inputs` + 根 planner）→ 结构化 Plan（`task_specs`）→ 工作（`tasks`，兼容的 WorkItem 投影）→ Run（`agent_runs` 每次真实调用）。新 say 则是 Input → 直接拥有独立分支的 `agent` Task → 按需派出的子 `agent` Task；旧数据仍按旧层次安全收尾。`tasks.layer` 区分：`intent`（planner，以及旧数据里的 scheduler）与 `work`（其余角色）。**`task.list` / `task.tree` / `task.timeline` 只返回 work 层**（`system.status.tasks` 也只数 work 层，另给 `layers` 计数）；planner 的进度由 `input.list` 下发，需要细节时用 `task.inspect ID` 按 id 直接读。规划闸门与确定性编译见 [输入、规划与缓存](inputs.md)，读模型与分页见 [审阅与过程读模型](inspect.md)。

| CLI | RPC | 参数 |
|---|---|---|
| `task list [--after N] [--limit N] [--brief]` | `task.list` | `{after?: 0, limit?: 200}`，limit 最大 1000，只含 work 层；CLI `--brief` 默认 30 条、最多 200 条短摘要及 `has_more/next_after`，RPC 本身不变 |
| `task tree [ID]` | `task.tree` | `{id?}` |
| `task spawn 'goal' --parent ID --role worker [--name short-kebab-name] [--depends-on ID[:kind]]` | `task.spawn` | `{parent, goal, role?: 'worker', deps?: [{id, kind: 'code'|'order'}], name?}` |
| `task message ID 'body'` | `task.message` | `{id, body}` |
| `task integrate CHILD_ID CHILD_HEAD_COMMIT` | `task.integrate` | `{id, commit}`；仅执行中的直接父 `agent` 调用，固定 HEAD 快进到父 Task 分支，不允许推进 main；也支持已请求合并的直接 say 子 Task |
| `task reserve ID merge\|showcase` | `task.reserve` | `{id, kind}`；用户专属，新 say Task 上一次只保留一种预约 |
| `task resolve-divergence ID` | `task.resolve_divergence` | `{id}`；用户专属，仅 pending merge 的 say 与直接父分支分歧且静息时派独立源侧 child，不移动原分支 |
| `task resolve-child-divergence CHILD_ID` | `task.resolve_child_divergence` | `{id}`；仅执行中的直接父 Agent：已完子任务的固定提交与父分支分歧时，派一个以该固定提交为基线吸收父分支新提交的子 Task（不重写原子分支、不在父分支上造 merge commit） |
| `task analyze ID '问题'` | `task.analyze` | `{id, question}`；用户专属，只对 main/owner：建一个只读分析子 Task（分离检出、无分支、无待合并改动），答案成为它的 `result` 并另落一条 info 提醒 |
| `task unreserve ID` | `task.unreserve` | `{id}`；用户专属，撤销 pending/preparing 预约，或撤销已发出但未集成的 merge 请求（解除父分支交付锁） |
| `task approve-merge ID COMMIT BASELINE` | `task.approve_merge` | `{id, commit, baseline}`；用户专属，按源 say Task 的请求固定提交和父分支基线批准 main/owner 的快进 |
| `task cancel ID` | `task.cancel` | `{id}` |
| `task retry ID` | `task.retry` | `{id}` |

`task.reserve` 持久化互斥意图，同类重复不新增预约、只复查现有 pending/preparing 的准入（展示在准备完成后符合条件时补发信号）。选另一类必须先 `task.unreserve`。`reservation.blocked_reason` 记录上次检查未满足的原因，包括调用尚未结束、用户答复/未读信号、活动子 Task、未提交改动、无有效提交或 Git 分歧；它是上次检查快照，不是实时 Git 诊断。修复外部工作区/分支后可重复执行 `task reserve ID merge|showcase`，Web 用「复查预约」调用同一入口；复查不越过消息投递与固定提交校验，也不自动合并。`blocked_code='diverged'` 时，可用 `task resolve-divergence ID` 派单个源侧子 Task：它固定源 tip 为工作区基线、固定直接父 tip 为要吸收的提交；活动子任务重复调用返回同一个任务；已完成但未集成、或失败/取消且仍有活动分支的子任务返回 `needs_review`（包含原 Task 和原因），不悄悄新派。完成后只有运行中的直接父 say Agent 用 `task.integrate` 确认固定子提交，且该提交必须同时包含原源 tip 和固定父 tip，之后还需按**当前**父 tip 复查原预约。解分歧从不直接推进父分支。若产物不合格或失败，先检查原子 Task/工作区；显式 `branch archive BRANCH`（Web 分支图「归档」）旧分支后，原 say 静息且已处理子信号时才能重新 `task resolve-divergence ID` 派新子任务。归档删掉旧 ref/worktree、保留 Task/固定提交事件/会话；脏工作区默认拒绝，只有用户明确 `--discard` 才丢弃未提交文件。该类子 Task 不支持 `task retry` 重放未知文件副作用。没有创建分支的失败任务无需归档，重派仍需通过静息检查。若 Task 已失败/取消，不能对终态预约直接复查：先检查 Agent/工作区副作用，再显式 `task retry ID`（已结算展示父子树不得分别重试）。`showcase` 预约在点击时立即创建展示子 Task 并让它先进入 `preparing` 准备阶段；say 真正静息、代码有实际变化、全部后代结算且既有展示准入通过后，runtime 发一次信号，展示子 Task 重新固定源/对照提交并进入交付。原 say 此时仍是 `waiting`，预约阶段为 `started`，不能另发说话或在原分支派 say。`preparing` 阶段仍可 `task.unreserve`，会一并取消尚未交付的展示子 Task。展示成功、失败、取消后子 Task 先结算，原 say 再结算并保留结果/工作区；展示不等于合并或验收。已结算的展示子 Task 与原 say 不允许分别重试，需提交新的 say。`merge` 预约在 say 静息、子任务结算、工作区干净且源提交能快进到直接父分支时，冻结源 `commit` 和父 `baseline`，事务内发去重的 `merge.requested` 信号并结束源 say Task；没有提交、仍在运行或存在分歧则保持 pending。请求**不等于批准**，父分支不因此前进。父为 say 时仅执行中的直接父 Agent 可用 `task.integrate` 确认；父为 main/owner 时须用户提供请求里的两个固定值调用 `task.approve_merge`。批准前在 Git 串行区复核源 ref、父 ref、工作区和后代，任何漂移拒绝旧批准；提交已落地而 DB 尚未记录时，相同固定值可幂等核对。已发出的请求也有只读复查：`task reserve ID merge` 对 `requested` 预约不重建、不推进任何 ref，只按当前 Git 事实重写诊断（`source_moved`：源分支顶端不再是固定提交；`contained`：固定提交已在父分支内，可由父 Agent 确认或你批准幂等关闭；`parent_moved`：父分支已前进；仍可快进则清掉过期诊断），daemon 重启后也对每条 `requested` 预约跑一次同样的复查。Web 在已发出的请求上给「复查请求」按钮（不调用 Agent）。

`task.inspect`、`task.list` 提供结构化 `reservation`（旧任务为 null，异常行显示 `status:'invalid'`）。旧 Task 不接受该预约。

**交付锁（用户确认的语义）**：请求一旦发出，父分支的基线就被固定；在它解决前 `target_branch` 进入分支写冻结（`status.branch_freeze` / `graph.get` 的 branch 节点 `freeze`，`kind='delivery'`），不再接受任何 Lush 侧写入——新建 say、`task.retry`、`branch.archive`、旧合并入口等一律被拒，另一个 say 的同类请求保持 pending 并记 `blocked_code='parent_locked'`，父为 say 时只有锁持有者自己的 `task.integrate` 能写这条分支。解除只有集成或用户显式撤销两条路：`task.unreserve` 允许撤销尚未集成的请求（另记 `task.request_withdrawn`），分支、提交与任务都保留，但这次交付不会自动合入。daemon 挡不住父分支自己的 say Agent 提交，也不挡外部 git：那种情况下请求会失去快进前提，`noteBranchAdvance` / `task.integrate` / `task.approve_merge` 会把同一份诊断写进 `reservation.blocked_code='parent_moved'` 与 `blocked_reason`，此时（一）可撤销请求，（二）可先把该固定提交合入父分支——已在父分支内时 `task.approve_merge` 退化为幂等记账（不再要求旧 baseline），父为 say 时直接父 Agent 的 `task.integrate` 同样幂等关闭。同一父分支同时只有一个未集成请求。锁住的是父分支，但源分支也不能被归档：`branch.archive` 拒绝源分支带未集成请求的子树（删了它，父分支的交付锁就永远没有落地对象）。

spawn 必须关联一个活动父 task；新 say/child Task 的 `task.spawn` 默认 `agent`，只允许 `agent`、无旧 `deps` 或 planner `spec`，子 Task 从父分支当前已提交 tip 创建独立 worktree。其完成/失败只给父 Task 发持久去重信号，不自动集成代码。父 Agent 可用 `task.integrate` 固定子提交；未完成、分支漂移、父非运行态、父工作区不干净、存在未集成后代或非快进均拒绝并保留现场。兄弟子任务先落地、或父分支自己提交后，已完子任务的固定提交就不再生效为快进：`task.resolve_child_divergence CHILD_ID` 由执行中的直接父 Agent 从该固定提交拉起一个解分歧子 Task（记 `task.divergence_resolution_requested`，固定当时的父分支顶端），它合入父分支新提交并测试后，用 `task.integrate` 确认——确认额外要求它的提交同时包含固定子提交与固定父顶端，成功后一并把被修复的子任务标成已集成（`child.integrated_via_resolution`）。父分支有未集成的 say 请求时先处理那个请求；解分歧子任务自身失败/不合格时保留现场，需用户显式归档旧分支后才能重派。旧 `task.merge`/`branch.merge` 不处理新 Task 分支。旧协议的普通根任务由用户输入创建，专用展示与[解释](../../engineering/transcript-reader.md)根任务由用户专属接口创建；planner 只写结构化 Plan，编译后的根工作由 runtime 直接创建。角色可选 `worker` / `coordinator` / `research`，`planner` / `scheduler` 不能由 agent 创建。`name` 是任务自己的英文短名（kebab-case），写入只读的 `tasks.name`，决定分支与 worktree 名：`lush/<项目哈希>/<id>-<name>` 与 `.lush/worktrees/<id>-<name>`。省略时 runtime 从 goal 首行提取英文词回退，提不出可用词则任务没有 name（分支/目录回到 `task-<id>`）。`name` 给不出至少两个 ASCII 字母或数字时报 `name needs at least two ASCII letters or digits (kebab-case)`；名字不可改，已有 worktree 不会被改名。任务基线是输入提交时冻结的 commit；普通任务的 direct parent / target 是输入分支，`code` 下游则从上游 reviewed commit 创建并以该上游分支为 direct parent。branch-sync merger 从待同步 child tip 创建。见 [输入和规划](../../engineering/inputs-and-planning.md)。

`deps` 是依赖边（`task_deps` 表，`(task_id, depends_on, kind)`，创建后不可变）。`kind` 默认 `code`：本任务的 worktree 从上游分支拉出（stacked），`base_commit` 冻结为上游的 `head_commit`，审阅 diff 只含本任务自己的提交；`order` 只等上游终态，代码仍从输入提交时冻结的 commit 开始。`kind` 缺省由 CLI 的 `--dep-kind` 决定。提交时做结构校验并拒绝：自依赖、依赖祖先任务（父任务在等子任务结算，双方会互等而死）、悬空 id、一个任务多于一条 `code` 边、`code` 边指向非 worker 或已 failed/cancelled 的上游。边只在创建时写入，所以环在结构上不可能；`assertDeps` 仍保留可达性校验，供未来加改边 API。

依赖未满足的 `queued` 任务不会被调度，`task.list` / `tree` 的每行都带 `deps: [{id, kind, status}]` 与 `blocked` 布尔值，`task.inspect` 额外给出 `deps` / `dependents`（带上游状态、角色、goal 摘要）、`runs` 与 `artifacts`。上游结算时 `finish` 唤醒每一个依赖它的任务。

## Run 与 Artifact

每次 provider invocation 先写一条 `agent_runs` 行（attempt / role / provider / started_at / ended_at / result / error），正常结束时写 version 2 `run.result` Artifact。Envelope 保留 outcome / summary / changes / evidence / decisions / risks / artifacts / followups，并用独立的 `invocation.status` 与 `verification.status` 区分“调用正常返回”和 `pass` / `fail` / `partial` / `unverified`。`pass` 必须没有 `failures` / `unverified`，但允许记录 `baseline_failures` / `residual_risks`；旧 payload 不重写，缺少或包含矛盾结构化证据时读作 `unknown`。`task.inspect` 返回该任务的 `runs` 与 `artifacts`；`candidate.inspect` 返回该 Intent 的 Artifacts。Task 的 `calls` / `agent_wakes` 仍用于兼容读模型。

合并这批任务见 [合并](merge.md)。
