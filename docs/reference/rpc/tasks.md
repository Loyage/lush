# 任务、Run 与 Artifact

本节管 Task 的创建、沟通与交付：`task.spawn` / `task.message` / `task.integrate` / `task.reserve` / `task.resolve*` / `task.cancel` / `task.retry` / `task.cleanup`，以及只读的 `task.list` / `task.tree` / `task.graph` / `task.activity` / `task.page`。当前公开白名单以[核心 API 收敛](../../engineering/core-api.md)与 `src/rpc/registry.js` 为准；Task 图与固定输入规则见[工程说明](../../engineering/task-graph.md)。

`task.graph {}` 是用户与 Agent 均可读的 Task 父子读面，Web GET `/api/task-graph` 对应：`{nodes,edges,truncated,total}`。最多 200 条节点，优先保留分支所有者与活动任务；节点含 `goal_preview`（最多 600 字）、`result_preview`（最多 320 字）、`waiting_reason`、`progress`（有界完成数和当前步骤；当前步骤可能是 runtime 生成的等待条目，等待不计入 Agent 工作用时也不占完成度）、`notice`（最新一条 open 待决，正文最多 1000 字）、`notice_count`、`children_total/active`、`reservation`、`has_result`、`branch` / `workspace`、`branch_info`（实时 ref、与分支图同源的 Git 诊断，以及合并运行投影：`subtree_say` 是这条分支下属还有多少条 say 子分支、`merge_run` 是这条分支上仍在跑的合并运行 `{mode,status,done,total,task_id}`，没有则 null）、`freeze`（写冻结原因）与 `resolves_task_id`（被修复的源 Task；父子边仍只表示负责集成的归属），以及 `has_rule`（仅表示存在固定输入规则），边是 `{from:parentId,to:childId}`。分支 fork/合并关系仍由 `graph.get` 提供；`task.graph` 全程只读，不写运行态或事件。

Task 中心路径是 Input → 直接拥有独立分支的 `agent` Task（`task_kind='say'`）→ 按需派出的子 `agent` Task。main 是 `task_kind='main'` 的静息根 Task，其他本地分支需 `branch.bind` 显式绑定 `owner`。`tasks.task_kind` 只加列，旧数据保留在磁盘上、不再产生新工作；旧 Intent / Plan / Candidate 与 planner / scheduler 的 `layer` 只用于读懂历史行，不参与新调度。

| CLI | RPC | 参数 |
|---|---|---|
| `task list [--after N] [--limit N] [--brief]` | `task.list` | `{after?: 0, limit?: 200}`，limit 最大 1000；CLI `--brief` 默认 30 条、最多 200 条短摘要及 `has_more/next_after` |
| `task tree [ID]` | `task.tree` | `{id?}` |
| —（Web 轮询） | `task.activity` | `{limit?: 50, scope?: 'work'|'all'}` |
| —（Web 分页） | `task.page` | `{before?: null, limit?: 50, scope?: 'work'|'all'}` |
| `task spawn 'goal' --parent ID [--name NAME]` | `task.spawn` | `{parent, goal, name?}`；父必须是 say/child Task |
| `task message ID 'body'` | `task.message` | `{id, body}` |
| `task integrate CHILD_ID CHILD_HEAD_COMMIT` | `task.integrate` | `{id, commit}`；agent-only |
| `task reserve ID merge` | `task.reserve` | `{id, kind:'merge'}`；用户专属 |
| `task unreserve ID` | `task.unreserve` | `{id}`；用户专属 |
| `task approve-merge ID COMMIT BASELINE` | `task.approve_merge` | `{id, commit, baseline}`；用户专属 |
| `task resolve ID` | `task.resolve` | `{id}`；用户专属 |
| `task resolve-divergence ID` | `task.resolve_divergence` | `{id}`；用户专属 |
| `task resolve-child-divergence CHILD_ID` | `task.resolve_child_divergence` | `{id}`；agent-only |
| `task cancel ID` | `task.cancel` | `{id}` |
| `task retry ID` | `task.retry` | `{id}` |
| `task cleanup ID [--keep-branch]` | `task.cleanup` | `{id, keep_branch?}`；见[维护](maintenance.md) |

`task.activity` / `task.page` 的 `scope='work'|'all'` 省略时保留旧 work 口径；Web overview 与历史分页显式请求 `all`，继续有界读取，不改任务实体或存储层级。`GET /api/tasks` 透传 scope。

## 派子任务与集成

`task.spawn` 必须关联一个活动父 Task，且父只能是 `task_kind='say'` 或 `'child'` 的 Task；新子 Task 角色固定为 `agent`，不接受旧 `role` / `deps` / planner `spec` 参数，分支从父分支当前已提交 tip 创建独立 worktree。其完成/失败只给父 Task 发持久去重信号，不自动集成代码。

`name` 是任务自己的英文短名（kebab-case），写入只读的 `tasks.name`，决定分支与 worktree 名：`lush/<项目哈希>/<id>-<name>` 与 `.lush/worktrees/<id>-<name>`。省略时 runtime 从 goal 首行提取英文词回退，提不出可用词则任务没有 name（分支/目录回到 `task-<id>`）。`name` 给不出至少两个 ASCII 字母或数字时报 `name needs at least two ASCII letters or digits (kebab-case)`；名字不可改，已有 worktree 不会被改名。

父 Agent 可用 `task.integrate` 固定子提交；未完成、分支漂移、父非运行态、父工作区不干净、存在未集成后代或非快进均拒绝并保留现场。兄弟子任务先落地、或父分支自己提交后，已完子任务的固定提交就不再生效为快进：`task.resolve_child_divergence CHILD_ID` 由执行中的直接父 Agent 从该固定提交拉起一个解分歧子 Task（记 `task.divergence_resolution_requested`，固定当时的父分支顶端），它合入父分支新提交并测试后，由 runtime 在父 Agent 安全结束后核对两端固定提交、依次快进源 child 与父分支，并把被修复的子 Task 标成已集成；期间父/源及源的后代冻结，其余兄弟仍可独立工作。父分支有未集成的 say 请求时先处理那个请求；解分歧子任务自身失败/不合格时保留现场，需用户显式归档旧分支后才能重派。

## 合并预约与批准

`task.reserve` 持久化互斥意图（当前只支持 `kind='merge'`），同类重复不新增预约、只复查现有 pending/preparing/requested 的准入。`reservation.blocked_reason` / `blocked_code` 记录上次检查未满足的原因，包括调用尚未结束、用户答复/未读信号、活动子 Task、未提交改动、无有效提交或 Git 分歧；它是上次检查快照，不是实时 Git 诊断。修复外部工作区/分支后可重复执行 `task reserve ID merge`，Web 用「复查预约」调用同一入口；复查不越过消息投递与固定提交校验，也不自动合并。

`merge` 预约在 say 静息、子任务结算、工作区干净且源提交能快进到直接父分支时，冻结源 `commit` 和父 `baseline`，事务内发去重的 `merge.requested` 信号。请求**不等于批准**，父分支不因此前进。父为 say 时仅执行中的直接父 Agent 可用 `task.integrate` 确认；父为 main/owner 时须用户提供请求里的两个固定值调用 `task.approve_merge`。批准前在 Git 串行区复核源 ref、父 ref、工作区和后代，任何漂移拒绝旧批准；提交已落地而 DB 尚未记录时，相同固定值可幂等核对。

已发出的 `requested` 预约支持只读复查：`task reserve ID merge` 对它不重建、不推进任何 ref，只按当前 Git 事实重写诊断（`source_moved`：源分支顶端不再是固定提交；`contained`：固定提交已在父分支内，可由父 Agent 确认或用户批准幂等关闭；`parent_moved`：父分支已前进；仍可快进则清掉过期诊断），daemon 重启后也对每条 `requested` 预约跑一次同样的复查。Web 在已发出的请求上给「复查请求」按钮（不调用 Agent）。

**交付锁（用户确认的语义）**：请求一旦发出，父分支的基线就被固定；在它解决前 `target_branch` 进入分支写冻结（`status.branch_freeze` / `graph.get` 的 branch 节点 `freeze`，`kind='delivery'`），不再接受任何 Lush 侧写入——新建 say、`task.retry`、`branch.archive` 等一律被拒，另一个 say 的同类请求保持 pending 并记 `blocked_code='parent_locked'`，父为 say 时只有锁持有者自己的 `task.integrate` 能写这条分支。解除只有集成或用户显式撤销两条路：`task.unreserve` 允许撤销尚未集成的请求（另记 `task.request_withdrawn`），分支、提交与任务都保留，但这次交付不会自动合入。daemon 挡不住父分支自己的 say Agent 提交，也不挡外部 git：那种情况下请求会失去快进前提，`noteBranchAdvance` / `task.approve_merge` 会把同一份诊断写进 `reservation.blocked_code='parent_moved'` 与 `blocked_reason`，此时（一）可撤销请求，（二）可先把该固定提交合入父分支——已在父分支内时 `task.approve_merge` 退化为幂等记账（不再要求旧 baseline）。同一父分支同时只有一个未集成请求。锁住的是父分支，但源分支也不能被归档：`branch.archive` 拒绝源分支带未集成请求的子树（删了它，父分支的交付锁就永远没有落地对象）。

## 解分歧与已解决

say 的 pending merge 请求若与直接父分支分歧（`blocked_code='diverged'`），用户可 `task.resolve_divergence ID` 派一个源侧解分歧子 Task：它固定源 tip 为工作区基线、固定直接父 tip 为要吸收的提交，不移动任何 ref。已完成但未集成、或失败/取消且仍有活动分支的子任务返回 `needs_review`（包含原 Task 和原因），不悄悄新派。完成后由 runtime 校验产物同时包含原源 tip 和固定父 tip，快进源分支并自动发出固定请求（main/owner 仍须用户批准最终合并），不再要求被冻结的源 say Agent 重新运行。若产物不合格或失败，先检查原子 Task/工作区；显式 `branch archive BRANCH`（Web 分支图「归档」）旧分支后，原 say 静息且已处理子信号时才能重新 `task resolve-divergence ID` 派新子任务。归档删掉旧 ref/worktree、保留 Task/固定提交事件/会话；脏工作区默认拒绝，只有用户明确 `--discard` 才丢弃未提交文件。该类子 Task 不支持 `task retry` 重放未知文件副作用。没有创建分支的失败任务无需归档，重派仍需通过静息检查。若 Task 已失败/取消，不能对终态预约直接复查：先检查 Agent/工作区副作用，再显式 `task retry ID`。

`task.resolve` 是「已解决」与「取消任务树」的语义区分：前者表示这次输入只是想了解/确认、用户已经没有别的需求，任务以 `completed` 结算并保留 Agent 的 `result`，`integration='none'`，另落一条信息提醒；后者是放弃正在进行的工作。它只在分支没有新提交（`head_commit` 为空或等于 `base_commit`）、工作区干净、没有正在调用的 Agent 且没有发出的合并请求时允许；有提交的 say 仍走 `task.reserve merge` 交付或 `task.cancel` 放弃。它不创建/删除分支与 worktree，也不推进任何 ref；需要继续追问时应在标记前给该 Task 发消息（标记后请另发新的 say）。

`task.inspect`、`task.list` 提供结构化 `reservation`（旧任务为 null，异常行显示 `status:'invalid'`）。旧 Task 不接受该预约。

## Run 与 Artifact

每次 provider invocation 先写一条 `agent_runs` 行（attempt / role / provider / started_at / ended_at / result / error），正常结束时写 version 2 `run.result` Artifact。Envelope 保留 outcome / summary / changes / evidence / decisions / risks / artifacts / followups，并用独立的 `invocation.status` 与 `verification.status` 区分“调用正常返回”和 `pass` / `fail` / `partial` / `unverified`。`pass` 必须没有 `failures` / `unverified`，但允许记录 `baseline_failures` / `residual_risks`；旧 payload 不重写，缺少或包含矛盾结构化证据时读作 `unknown`。`task.inspect` 返回该任务的 `runs` 与 `artifacts`。Task 的 `calls` / `agent_wakes` 仍用于兼容读模型。

`task.cancel` 取消整棵子树；`task.retry` 是用户显式重试。

相关：[审阅与过程读模型](inspect.md) · [分支合并](../../engineering/merge.md) · [维护与回收](maintenance.md) · [Task 中心输入](../../engineering/task-centered-input-design.md)
