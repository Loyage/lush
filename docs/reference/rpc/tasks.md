# Worker、Run 与 Artifact

本节管 Worker 的创建、沟通与交付：`worker.spawn` / `worker.message` / `worker.integrate` / `worker.auto_merge` / `worker.reserve` / `worker.resolve*` / `worker.cancel` / `worker.retry` / `worker.interrupt` / `worker.resume` / `worker.configure` / `worker.clear_override` / `worker.cleanup`，以及只读的 `worker.list` / `worker.tree` / `worker.graph` / `worker.activity` / `worker.page`。当前公开白名单以[核心 API 收敛](../../engineering/core-api.md)与 `src/rpc/registry.js` 为准；Worker 图与固定输入规则见[工程说明](../../engineering/task-graph.md)。

`worker.graph {}` 是用户与 Agent 均可读的 Worker 父子读面，Web GET `/api/worker-graph` 对应：`{nodes,edges,truncated,total}`。最多 200 条节点，优先保留分支所有者与活动Worker；节点含 `goal_preview`（最多 600 字）、`result_preview`（最多 320 字）、`waiting_reason`、`progress`（有界完成数和当前步骤；当前步骤可能是 runtime 生成的等待条目，等待不计入 Agent 工作用时也不占完成度）、`notice`（最新一条 open 待决，正文最多 1000 字）、`notice_count`、`children_total/active`、`reservation`、`has_result`、`branch` / `workspace`、`branch_info`（实时 ref、与 `graph.get` 同源的 Git 诊断，以及合并运行投影：`subtree_order` 是这条分支下属还有多少条指令子分支、`merge_run` 是这条分支上仍在跑的合并运行 `{mode,status,done,total,task_id}`，没有则 null）、`freeze`（写冻结原因）与 `resolves_task_id`（被修复的源 Worker；父子边仍只表示负责集成的归属），以及 `has_rule`（仅表示存在固定输入规则），边是 `{from:parentId,to:childId}`。完整分支谱系仍由 `graph.get` 提供；`worker.graph` 不依赖它，全程只读，不写运行态或事件。

Worker 读面统一携带可空 `worker_number`（历史 Worker 与其历史父下新派生的后代为 `null`，此时展示回退到整数 `#id`）；`merge_queue.items`、Input 父候选对象的 `worker_number`、Input 历史的 `task_worker_number` / `parent_worker_number`、Notice 与消息投影的 `task_worker_number` / `sender_worker_number` 也按同一口径给出。编号是显示身份，不参与 `id`、引用 target、外键、排序、鉴权或合并凭据。

节点另带 `merge_queue:{counts,total,items,truncated,limit_per_status:3}`。只统计完整 tasks 表中真实直接子Worker的 `version=2,kind=merge,queue_protocol=1` 持久预约（预约 parent_id 必须等于 Worker parent_id）；`counts` 分别给 executing/resolving/requested/suspended/blocked 的精确数量，`total` 为总数，`items:[{id,status}]` 每阶段最多 3 条、ID 降序，未列完置 `truncated:true`。pending、仅开启自动合并、历史协议与 integrated 不算当前队列。无请求返回零计数和空 items；旧服务缺字段时不能以页面节点计数冒充完整摘要。不受节点截断/前端筛选影响，不写库、不改调度；展示顺序不表示 runtime 的队列执行次序。

节点的 `archived:boolean` 只读投影归档事实：自己的分支已归档，或无独立分支的历史 version 2 `task_kind='merge'` 队列的直接父 Worker 分支已归档。父 Worker 不在这页也能判断，兼容历史归档，不改写 Worker 状态、父子关系或事件；其它子 Worker 不继承父归档，`target_branch` 不作为归档依据。Web 默认隐藏这些节点，「显示已归档」可查看，内部队列标注「随父 Worker 归档」；没有分支的队列仍为 `branch_info:null`。

`branch_info` 另提供精简 Git 关系诊断：
- `parent` 保留 `branches.parent` 的历史登记值，不按 Worker 父子边或 `target_branch` 猜测，也不跳过已归档父分支。
- `current:boolean` 表示 canonical 项目目录当前检出的分支，不是「某个 worktree 检出了它」。detached HEAD 或读取失败为 false。
- `relation:{status,ahead,behind}` 比较本分支实时 tip 与登记父分支实时 tip；`ahead` 是只有本分支有的提交数，`behind` 是只有父分支有的提交数。`status` 为 `equal`（一致，0/0）、`ahead`（领先，>0/0）、`behind`（落后，0/>0）、`diverged`（分歧，均 >0）、`missing`（已成功读取 refs，但任一侧 ref 缺失）、`parent_archived`（登记父分支已归档）或 `unknown`（无明确登记父关系、父关系仅 inferred/unknown，或 Git 读取失败/计数无效）；后三种计数均为 null。自身已归档时 `relation:null`，以既有 `archived:true` 表达正常历史状态，不误报缺失。没有分支的 Worker 仍为 `branch_info:null`。

关系按当前有界 Worker 集合去重，批量读取 refs / 登记谱系，并缓存同一固定提交对的 `rev-list --left-right --count` 结果，不逐 Worker 重读 Git。它只回答真实 Git 祖先关系，不表示是否交付：Squash 已落地的分支仍可能是 `diverged`，`integration:'merged'` 独立记录交付成功；Worker 图边仍只表示 Worker 父子归属。

Worker 中心路径是 Input → 直接拥有独立分支的 `agent` Worker（`task_kind='order'`）→ 按需派出的子 `agent` Worker。main 是 `task_kind='main'` 的静息根 Worker，其他本地分支需 `branch.bind` 显式绑定 `owner`。历史 `task_kind='say'` 在读取与类型判定边界兼容为指令，已有行、分支和工作区不迁移；新提交只写 `order`、只接受 `order.submit`，见[更名边界](../../engineering/core-api.md#指令更名与历史读取边界)。旧 Intent / Plan / Candidate 与 planner / scheduler 的 `layer` 只用于读懂历史行，不参与新调度。

| CLI | RPC | 参数 |
|---|---|---|
| `worker list [--after N] [--limit N] [--brief]` | `worker.list` | `{after?: 0, limit?: 200}`，limit 最大 1000；CLI `--brief` 默认 30 条、最多 200 条短摘要及 `has_more/next_after` |
| `worker tree [ID]` | `worker.tree` | `{id?}` |
| `worker lookup NUMBER` | `worker.lookup` | `{number}`；只读 `{id,worker_number}`，把 `W5` / `W5-1` 严格解析成整数身份；用户与 Agent 均可调用。各段必须是正安全整数，`W0`/`W01`/小写/超长一律拒绝；找不到报 not found，不改任何状态，也不让原 `id` 参数接受编号 |
| —（Web 轮询） | `worker.activity` | `{limit?: 50, scope?: 'work'|'all'}` |
| —（Web 分页） | `worker.page` | `{before?: null, limit?: 50, scope?: 'work'|'all'}` |
| `worker spawn 'goal' --parent ID [--name NAME]` | `worker.spawn` | `{parent, goal, name?}`；父必须是 指令/child Worker |
| `worker message ID 'body'` | `worker.message` | `{id, body}` |
| `worker integrate CHILD_ID CHILD_HEAD_COMMIT` | `worker.integrate` | `{id, commit}`；agent-only |
| `worker auto-merge ID on\|off` | `worker.auto_merge` | `{id, enabled:boolean}`；用户专属；设置跨轮保留的自动合并 hook，返回 `{task_id,changed,auto_merge}` |
| `worker completion ID off\|merge\|accept\|archive --revision REV` | `worker.completion` | `{id,level,expected_revision}`；用户专属，串行最高级别与安全投影见 [Hooks 接口](hooks.md#最高自动级别) |
| `worker reserve ID merge` | `worker.reserve` | `{id, kind:'merge'}`；用户专属；显式请求本轮合并，不修改自动合并设置 |
| `worker reserve-all BRANCH`（Web「合并所有」） | `worker.reserve_all` | `{branch}`；用户专属；把该分支下所有已静息、待合并的 指令/child 逐条走同一套预约准入并交给父 Worker 自有交付队列的 runtime 串行处理 |
| `worker unreserve ID` | `worker.unreserve` | `{id}`；用户专属 |
| `worker approve-merge ID COMMIT BASELINE` | `worker.approve_merge` | `{id, commit, baseline}`；用户专属 |
| `worker accept ID` | `worker.accept` | `{id}`；用户验收指令成果（含静息无改动回答，无需先合并）/ 运行中的直接父 Agent 确认已交付 child；返回 Worker，不归档 |
| `worker reopen ID` | `worker.reopen` | `{id}`；用户专属；历史已合并Worker显式恢复待验收，返回 Worker，不调用 Agent |
| `worker sync-parent ID` | `worker.sync_parent` | `{id}`；用户专属；返回 `{task,synced,conflict,source_commit,parent_commit,reason?}`；不调用 Agent |
| `worker resolve-sync ID` | `worker.resolve_sync` | `{id}`；用户专属；返回 Worker，显式调用 Agent 解决已记录同步冲突 |
| `worker resolve ID` | `worker.resolve` | `{id}`；用户专属，仅指令；委托 `worker.accept` 的兼容入口，不归档 |
| `worker resolve-divergence ID` | `worker.resolve_divergence` | `{id}`；用户专属 |
| `worker resolve-child-divergence CHILD_ID` | `worker.resolve_child_divergence` | `{id}`；agent-only |
| `worker cancel ID` | `worker.cancel` | `{id}` |
| `worker retry ID` | `worker.retry` | `{id}` |
| `worker clear-override ID` | `worker.clear_override` | `{id}`；用户专属；清除本 Worker 的 task-local 运行覆盖（配置模式、来源、模型、Prompt、扩展、预算、环境变量），下一次调用回到项目/角色默认；不启动 Agent |
| `worker interrupt ID` | `worker.interrupt` | `{id}`；用户专属，请求安全点暂停（静息时直接 `paused`） |
| `worker resume ID` | `worker.resume` | `{id, profile?}`；用户专属，撤销尚未触发的暂停，或立即接受排队继续 |
| —（Web 调整设置 / 切换模型来源） | `worker.configure` | `{id, profile}` 或 `{id, model_selection:{connection_id,model}}`，两者互斥；用户专属，`paused` 或暂停请求期间保存下一次配置，窄更新保留其他覆盖 |
| `worker cleanup ID [--keep-branch]` | `worker.cleanup` | `{id, keep_branch?}`；见[维护](maintenance.md) |

`worker.activity` / `worker.page` 的 `scope='work'|'all'` 省略时保留旧 work 口径；Web overview 与历史分页显式请求 `all`，继续有界读取，不改Worker实体或存储层级。`GET /api/workers` 透传 scope。

## 目标与追加输入的投递时间

`worker.inspect.goal_input_delivery` 与 `worker.history` / `worker.history_page` 中用户 `message` 事件的 `input_delivery` 均为 `{status:'delivered'|'pending'|'unknown',at:string|null}`。`delivered` 的 `at` 是首次将该输入交给 Agent 的时间，不是用户提交、排队、调用准入或消费完成时间。真实后端完成准备并启动携带输入的进程时确认；这不代表模型已经理解或执行了输入。调用失败/抢占不撤销已投递事实，重试不覆盖首次时间；运行中到达的追加输入在下一轮投递前为 `pending`。

新消息事件与收件箱同事务记录 `message_id`；投递事件 `invocation.inputs_delivered {run_id,message_ids}` 按精确身份关联，重复正文不合并。历史页的投递投影覆盖完整事件历史，不受分页窗口限制；投递事件另附 `input_deliveries:[{message_id,status,at}]`，供前端刷新已加载但已不在最新页中的待输入记录，重试仍投影首次确认时间。旧记录缺少精确消息身份或投递证据时为 `unknown`，不回填、不以旧提交时间猜测；旧服务未提供字段时前端也显示时间未知。

Worker 详情的原始目标直接展示；追加输入只需展开一层即可阅读已加载的全文，更早历史仍通过有界分页读取。

## 追加消息的准入与失败处理

`worker.message {id,body}` 是追加工作入口，不是冻结期间的只读通知通道。Agent 仅可给直接父子 Worker 发送消息；main/owner 不接收普通消息，即使是直接父 Worker。指令 Agent 的完成报告写本轮结果，交付由 runtime 按已有协议处理。

发送前可用 `worker.inspect` 核对目标的 `task_kind`、`status`、`reservation` 及归档/同步状态，但读取只是快照，实际准入仍以发送时检查为准：

- version 2 的 `reservation.status='requested'|'executing'|'blocked'` 拒绝普通消息，报 `Worker is frozen for merge; wait for integration or divergence repair before messaging it`。消息**未入箱**，不会自动在解冻后重投。
- `pending` 或仅开启自动合并不等于已冻结，也不保证其它准入条件满足；新 child 完成后可能自动从 pending 进入 requested，发送前检查无法消除这段竞态。
- 终态、祖先已结束、分支已归档、同步中、非直接父子等也可能拒绝。Agent 不得自行 reopen/retry、撤销预约、关闭自动合并或绕过检查。

遇到冻结，Agent 必须把目标、未发送正文与后续动作留在当前 Worker 的可续读记录或本轮结果中，不确认仍需修改的 child；结束本轮等交付/修复事件，下轮重新检查后再决定是否发送，不轮询、不后台重试，也不承诺 runtime 会自动重投。收到当前尝试的修复通知仍须遵守固定提交/尝试边界，不借追加消息推进旧尝试。其它拒绝按相应生命周期边界处理，不无条件重发。

独立消息必须分别调用并逐条确认，不用 `&&` 连发：中途拒绝会使后续命令根本未执行。改成 `;` 也不能只看最后一个退出码来认定全部成功。消息发送与测试、提交命令分开执行；区分“发送成功”“被拒绝”“未执行”，不能因为后续测试失败就把已经成功的消息重发。

## 执行详情代码只读接口

`worker.code_state {id,scope?,after?,limit?}`、`worker.code_tree {id,scope?,path?,query?,changed?,after?,limit?,revision?}`、`worker.code_file {id,scope?,path,view?,side?,offset?,limit?,context?,revision?}` 均为用户专属；不接受 Agent 凭证、任意 cwd 或 ref，不执行 Git 写入/仓库程序，也不新增快照。完整字段和基线语义见[代码阅读器契约](../../engineering/code-reader.md)。

- `scope=task|iteration|working`；默认Worker创建基线到实际工作区，累计净变化与暂存/未暂存状态独立。文件范围为 Git 跟踪和未忽略的未跟踪文件，排除所有 `.git`/`.lush` 组件及其大小写变体（兼容 macOS 常见的不区分大小写卷），不跟随链接或进入子模块。
- 每次扫描最多 20,000 个文件、Git 单次标准输出 4 MiB、整个读取期限 15 秒；每个 Workspaces 至多 4 个并发读取，超限明确不可用。响应 JSON 最多 512 KiB；state/tree 的行数组预算为 480 KiB，包含路径、旧路径和 JSON 转义，剩余空间留给元信息。达到单页字节预算仍以 `next/has_more` 正常分页，不置底层 `truncated`；单行超预算则明确不可用并标超限。已知路径无法安全采样时整次读取明确失败，不静默漏文件。分页与底层超限不同；未知计数返回 null。
- 正文只读单侧最多 8 MiB UTF-8 数据，按最多 24,000 JS 字符分段；BOM、CR 与末尾无换行保留。`content.line_continued` 标明分段从同一行中途继续。超过读取预算明确说明，不冒充空文件。二进制/非 UTF-8 不进行文本解码。
- diff 输入两侧合计最多 2 MiB、patch 最多 512 KiB、结构化 hunk 最多 480 KiB；超限降级分段原文。无基线可读当前正文但不能算 diff；归档后只有原始提交仍在才可回看，不保证未提交内容和永久可读。
- 后端用临时隔离 Git 目录只读原对象与 index，不加载仓库自定义 filter/textconv/fsmonitor 等配置，不改变真正 index。现场读取沿用项目已有 `bun:ffi` / 系统 libc 路线，在 Linux/macOS 用 `openat` 与平台 `node:fs.constants` 的 `O_NOFOLLOW` 逐组件打开；链接只经 `readlinkat` 读取链接文本。FD 同步设置 close-on-exec，并由 `node:fs` 做 fstat/read/close，不依赖 `/proc`、第三方 native 包/编译器或 native stat 结构布局。系统接口加载失败则明确不可用，不回退到有竞态的路径内容读取。macOS/Linux 聚焦 workflow 覆盖真实平台，mock loader 仅验证符号选择，不能冒充 Darwin 实测。

## 派子Worker与集成

`worker.spawn` 必须关联一个活动父 Worker，且父只能是 `task_kind='order'` 或 `'child'` 的 Worker；新子 Worker 角色固定为 `agent`，不接受旧 `role` / `deps` / planner `spec` 参数，分支从父分支当前已提交 tip 创建独立 worktree。新 child 默认开启且锁定自动合并 hook，安全点通过交付校验后向父 Worker 发持久去重请求，由父 Worker 自有队列的 runtime 串行集成，不创建 merge Worker、不改父子关系；失败不会冒充已交付。

`name` 是Worker自己的英文短名（kebab-case），写入只读的 `tasks.name`，决定分支与 worktree 名：`lush/<项目哈希>/<id>-<name>` 与 `.lush/worktrees/<id>-<name>`。省略时 runtime 从 goal 首行提取英文词回退，提不出可用词则Worker没有 name（分支/目录回到 `task-<id>`）。`name` 给不出至少两个 ASCII 字母或数字时报 `name needs at least two ASCII letters or digits (kebab-case)`；名字不可改，已有 worktree 不会被改名。

历史手动集成路径中，父 Agent 可用 `worker.integrate` 固定子提交；未完成、分支漂移、父非运行态、父工作区不干净、存在未集成后代或非快进均拒绝并保留现场。兄弟子Worker先落地、或父分支自己提交后，已完子Worker的固定提交就不再生效为快进：`worker.resolve_child_divergence CHILD_ID` 由执行中的直接父 Agent 从该固定提交拉起一个解分歧子 Worker（记 `task.divergence_resolution_requested`，固定当时的父分支顶端），它合入父分支新提交并测试后，由 runtime 在父 Agent 安全结束后核对两端固定提交、依次快进源 child 与父分支，并把被修复的子 Worker 标成已集成；期间父/源及源的后代冻结，其余兄弟仍可独立工作。父分支有未集成的指令请求时先处理那个请求；解分歧子Worker自身失败/不合格时保留现场，需用户显式归档旧分支后才能重派。

## 自动合并开关与本轮合并

`worker.auto_merge {id,enabled}` 只接受布尔值，Agent 不得调用。新指令默认关闭，新派生 child 默认开启且锁定；锁定子Worker不能经 CLI/RPC 关闭，也不能用 `worker.unreserve` 绕过。开关跨 invocation、重启和追加开发轮次保留，历史 Worker 不批量回填或重置已有决定。

`worker.inspect` 与 `worker.graph` 提供 `auto_merge:{enabled,locked,editable,reason}`，不适用的 Worker 为 null。Web 在 Worker 详情的 Hooks 区用最高自动级别配置合并／验收／归档；旧服务回落到「本轮交付就绪」节点的原开关。Worker 图提供同源摘要入口，不另建一份状态。锁定或不可编辑时显示只读状态及原因。Worker已交付就绪、已发请求、已终结或待验收时不能调整开关。关闭开关只移除尚未发出的自动意图，不撤回已发请求，也不取消独立的显式合并意图。旧 version 2 pending 仍保留单次意图，开关不由它推断为开启；Web 明示其仍有效。`worker reserve` 将当前 pending 确认为独立单次意图，后续关闭 hook 不撤销它；非锁定Worker可用 `worker unreserve` 撤销单次意图。开启 hook 的自动意图不能借该命令绕过开关的就绪门禁。

开启 hook 后，runtime 仍等本轮安全结束、后代结算、待决与消息处理完成，并复核工作区和提交，再复用 version 2 请求与父自有交付队列。包含 main 在内均按现有队列自动准入，不增加父 Agent 或用户审批；分歧仍回原 Worker 处理。显式「合并」调用 `worker.reserve`，只请求本轮交付，不修改持久开关。

`merge_readiness:{ready,reason}` 是执行屏障与登记提交的只读投影，不承诺 Git 准入。ready 为真时 Web 提供显式「合并」，旧自动合并开关按原就绪门禁只读，最高自动级别另据 `completion.editable` 和 revision 授权；已有请求或已合并则显示进度或结果，不能重复发起。缺少设置投影时保守只读，不假装可编辑。历史 version 1 预约继续原审批口径，不改造成自动合并。

自定义受控规则与预约创建入口见 [Hooks 与预约接口](hooks.md)；内置自动合并与历史预约仍用本节原交付协议。

## 多轮交付、验收与父同步

当前 指令/child 的 version 2 预约由父 Worker 自有队列的 runtime 串行 Squash（含 main），不创建 merge Worker、不改 `parent_id`、不额外调用父 Agent；落地后保持原父子关系并进入非终态 `awaiting_acceptance`，不是 `completed`。追加 `worker.message` 继续同一 Worker；验收 `worker.accept` 才结算为 completed，归档仍须显式操作且待验收时不得直接归档；派生 child 的成果由其运行中的直接父 Agent 检查后 `worker.accept` 确认，无需用户逐个验收；父 Agent 不能验收指令、自己或兄弟。无代码改动的 child 也先交付结果、等父确认。验收父 Worker 不隐式确认后代，未决问题、未读输入、未交付改动与未结算后代仍阻止确认。原始 `base_commit` 保留，本轮基线用可空 `iteration_base_commit`。`accepted:boolean`（依据 `task.accepted` 事件，`accepted_by:'user'|'parent'` 区分用户验收与父确认）和 `parent_sync_conflict:{source_commit,parent_commit,reason}|null` 由 inspect/Worker 图投影。

`sync_parent` 只在源侧安全吸收父提交；无冲突由程序直接完成并记 `task.parent_synced`，冲突返回诊断并记 `task.parent_sync_conflict`，不自动调用 Agent。`resolve_sync` 才显式唤醒当前 Worker，固定两端提交已漂移时拒绝并要求重新同步。冻结、运行中、工作区不安全或后代未收敛由后端严格拒绝；不重置现场，不推进父分支。

`reopen` 仅面向未归档、分支/worktree 仍保留、未明确用户验收的历史 completed/merged 指令/child；只恢复待验收，不启动 Agent。已归档不重建，不批量迁移旧记录。完整生命周期见[持续迭代](../../engineering/task-iteration.md)。

## 当前 version 2 交付队列

真实源安全点固定交付标识与源提交，按持久入队顺序排队（代码依赖优先），不按 Worker ID。只有父 invocation 实际退出、取得父分支逻辑执行位后，才固定尝试标识与父基线；普通父开发、兄弟落地、向上交付和同步写入互斥。分歧由原 Worker 在源侧保留原源提交、合入固定父提交并测试，修复期间保留父执行位。挂起释放执行位；恢复重新排队并固定新基线，旧回复不能推进新尝试。父侧现场未知的失败保持阻塞，不让下一项覆盖。`reservation` 是持久事实，Message/Event 仅通知；完整状态与安全门见[分支合并](../../engineering/merge.md)。

旧 version 2 的 merge Worker 和在途重挂保留兼容：仅凭明确预约／审计恢复原父，不猜身份、不删历史；历史卡片与类型筛选仍可查看。旧 version 1 的固定提交审批语义不改。

## 历史 version 1 合并预约与批准

`worker.reserve` 持久化互斥意图（当前只支持 `kind='merge'`），同类重复不新增预约、只复查现有 pending/preparing/requested 的准入。`reservation.blocked_reason` / `blocked_code` 记录上次检查未满足的原因，包括调用尚未结束、用户答复/未读信号、活动子 Worker、未提交改动、无有效提交或 Git 分歧；它是上次检查快照，不是实时 Git 诊断。修复外部工作区/分支后可重复执行 `worker reserve ID merge`，Web 用「复查预约」调用同一入口；复查不越过消息投递与固定提交校验，也不自动合并。

`merge` 预约在指令静息、子Worker结算、工作区干净且源提交能快进到直接父分支时，冻结源 `commit` 和父 `baseline`，事务内发去重的 `merge.requested` 信号。请求**不等于批准**，父分支不因此前进。父为指令时仅执行中的直接父 Agent 可用 `worker.integrate` 确认；父为 main/owner 时须用户提供请求里的两个固定值调用 `worker.approve_merge`。批准前在 Git 串行区复核源 ref、父 ref、工作区和后代，任何漂移拒绝旧批准；提交已落地而 DB 尚未记录时，相同固定值可幂等核对。

已发出的 `requested` 预约支持只读复查：`worker reserve ID merge` 对它不重建、不推进任何 ref，只按当前 Git 事实重写诊断（`source_moved`：源分支顶端不再是固定提交；`contained`：固定提交已在父分支内，可由父 Agent 确认或用户批准幂等关闭；`parent_moved`：父分支已前进；仍可快进则清掉过期诊断），daemon 重启后也对每条 `requested` 预约跑一次同样的复查。Web 在已发出的请求上给「复查请求」按钮（不调用 Agent）。

**交付锁（用户确认的语义）**：请求一旦发出，父分支的基线就被固定；在它解决前 `target_branch` 进入分支写冻结（`status.branch_freeze` / `graph.get` 的 branch 节点 `freeze`，`kind='delivery'`），不再接受任何 Lush 侧写入——新建指令、`worker.retry`、`branch.archive` 等一律被拒，另一个指令的同类请求保持 pending 并记 `blocked_code='parent_locked'`，父为指令时只有锁持有者自己的 `worker.integrate` 能写这条分支。解除只有集成或用户显式撤销两条路：`worker.unreserve` 允许撤销尚未集成的请求（另记 `task.request_withdrawn`），分支、提交与Worker都保留，但这次交付不会自动合入。daemon 挡不住父分支自己的指令 Agent 提交，也不挡外部 git：那种情况下请求会失去快进前提，`noteBranchAdvance` / `worker.approve_merge` 会把同一份诊断写进 `reservation.blocked_code='parent_moved'` 与 `blocked_reason`，此时（一）可撤销请求，（二）可先把该固定提交合入父分支——已在父分支内时 `worker.approve_merge` 退化为幂等记账（不再要求旧 baseline）。同一父分支同时只有一个未集成请求。锁住的是父分支，但源分支也不能被归档：`branch.archive` 拒绝源分支带未集成请求的子树（删了它，父分支的交付锁就永远没有落地对象）。

## 历史 version 1 源侧解分歧

指令的 pending merge 请求若与直接父分支分歧（`blocked_code='diverged'`），用户可 `worker.resolve_divergence ID` 派一个源侧解分歧子 Worker：它固定源 tip 为工作区基线、固定直接父 tip 为要吸收的提交，不移动任何 ref。已完成但未集成、或失败/取消且仍有活动分支的子Worker返回 `needs_review`（包含原 Worker 和原因），不悄悄新派。完成后由 runtime 校验产物同时包含原源 tip 和固定父 tip，快进源分支并自动发出固定请求（main/owner 仍须用户批准最终合并），不再要求被冻结的源指令 Agent 重新运行。若产物不合格或失败，先检查原子 Worker/工作区；显式 `branch archive BRANCH`（Web Worker 图「归档」）旧分支后，原指令静息且已处理子信号时才能重新 `worker resolve-divergence ID` 派新子Worker。归档删掉旧 ref/worktree、保留 Worker/固定提交事件/会话；脏工作区默认拒绝，只有用户明确 `--discard` 才丢弃未提交文件。该类子 Worker 不支持 `worker retry` 重放未知文件副作用。没有创建分支的失败Worker无需归档，重派仍需通过静息检查。若 Worker 已失败/取消，不能对终态预约直接复查：先检查 Agent/工作区副作用，再显式 `worker retry ID`。

## 无改动回答也走验收

`worker.accept` 可直接验收静息、无未交付改动的指令回答，无需请求合并或创建空 Squash。保留 `result`，结算为 `completed`；无代码交付保持 `integration='none'`，已交付轮次保留真实交付状态。验收确认成果，不等同于放弃 Worker，也不删除分支/worktree。检查运行与清理、未读消息、待决问题、未结算后代、预约/冻结、工作区与真实 Git 交付事实；失败保留现场，不自动消除待决事项。继续追问应在验收前追加输入，验收后有新要求另发指令。

Web 详情与 Worker 图（含极简模式）对本轮有回答、已知顶端等于本轮基线的静息指令展示共用的「仅验收」「验收并归档」控件；未知基线/顶端、运行中、暂停或新增提交不能冒充无改动回答。控件只是候选提示，最终安全门由后端裁决，不自动把所有 waiting Worker 改成待验收。

原 `worker.resolve` 仅保留用户专属的指令验收兼容入口，直接委托同一个 `acceptTask`，包括已交付代码的验收；不再走独立 `finish` 收尾、不新增 `task.resolved`，统一写 `task.accepted` 并触发 `worker.accepted` Hook。重复验收幂等，旧历史事件与已完成记录不迁移。

`worker.inspect`、`worker.list` 提供结构化 `reservation`（旧Worker为 null）：version 1 与 version 2 的预约都原样读出，认不出的形态显示 `status:'invalid'` 供检查。旧 Worker 不接受该预约。

## Run 与 Artifact

每次 provider invocation 先写一条 `agent_runs` 行（attempt / role / provider / started_at / ended_at / result / error），正常结束时写 version 2 `run.result` Artifact。Envelope 保留 outcome / summary / changes / evidence / decisions / risks / artifacts / followups，并用独立的 `invocation.status` 与 `verification.status` 区分“调用正常返回”和 `pass` / `fail` / `partial` / `unverified`。`pass` 必须没有 `failures` / `unverified`，但允许记录 `baseline_failures` / `residual_risks`；旧 payload 不重写，缺少或包含矛盾结构化证据时读作 `unknown`。`worker.inspect` 返回该Worker的 `runs` 与 `artifacts`。Worker 的 `calls` / `agent_wakes` 仍用于兼容读模型。

首屏只给最新窗口：`worker.inspect` 的 `runs` / `artifacts` 是最新 50 条（升序），并附 `runs_page` / `artifacts_page:{has_more,cursor,limit,truncated}`；更早的记录用 `worker.runs_page {id,before?,limit?}` / `worker.artifacts_page {id,before?,limit?}` 继续读取（`limit` 1..200，默认 50，`before` 为上一页的 `cursor`，按 id 严格变早，不重复也不跳过）。`truncated` 表示这一页被字节预算进一步裁剪；`has_more` 表示仍有更早记录。这些只读方法仅用户可调用，旧全量调用读取路径不再返回无界历史，历史行原样保留在 SQLite。

Artifact 窗口为了有界响应只投影 `payload`：完整 payload 正常解析；超过 8192 字节的只给原始文本前缀（`payload_truncated:true` 与 `payload_bytes` 记录完整大小），不校验、不冒充完整结论。需要完整 payload 时用只读 `worker.artifact {id}`（既有写入上限 512000 字节不变）。窗口投影不是数据迁移：旧行、旧 payload 与已保存的验收证据都不重写，verifier / Candidate 的完整读取路径仍走原有接口。

`worker.cancel` 取消整棵子树（不可恢复的终态）；`worker.retry` 是用户显式重试。Worker 的 task-local 运行覆盖（`config_mode`、来源/模型/Prompt/扩展等）跨交付、验收、无参数重试与合并保留，只有用户显式 `worker.clear_override` 或重新保存完整覆盖才改变；持续语义见[项目 Agent 配置与双模式运行](../../engineering/agent-configuration-v2.md)。`worker.interrupt` 表达希望暂停的信号，只针对当前 Worker，不级联子Worker，保留工作区 / 提交 / Pi 会话 / 消息 / `calls`。运行中读面为 `interrupt_state='requested'`，实际状态仍是 `running`，当前 Agent 的工具与 RPC 可安全收尾；静息时直接进入非终态 `paused`。Pi 在本轮工具全部结束的 `turn_end` 原子认领并停止后续模型轮次；没有可验证安全点的后端等本次调用自然结束。不再因中断等待超时强杀，但调用总超时与显式放弃仍有效。

`worker.resume` 不要求旧调用已退出：未认领时撤销暂停，继续原调用；已认领或正在收尾时立即接受，读面为 `queued` / `interrupt_state='resuming'`，内部等旧 invocation 真正退出后重新准入，不会重叠调用。重复中断 / 继续幂等；继续不撤销独立的用户消息抢占。真实暂停或恢复准入后 `interrupt_state` 清为 null。暂停意愿期间也可追加说明或 `worker.configure` 保存下一次调用的设置；不会暗中改变当前调用。来源/模型窄更新仅限 Pi 托管连接，后台保留完整已有覆盖；`worker.inspect.model_selection` 为无秘密的下次选择摘要，不代表当前实际绑定。`worker.inspect.model_selection.explicit` 为 `true` 时，Web 提供「清除运行覆盖」入口回到项目/角色默认；运行中的调用被拒绝，必须等安全点。项目默认未绑定 Lush 来源时，Pi 调用在创建 Run/启动进程之前被拦截：Worker 回到 `paused`、写 `invocation.blocked` 与一条 info 提醒，输入保留，提示去「Agent 配置」选择来源。字段和隔离规则见[Agent 配置与模型来源](agents.md)。重启仍不自动重放未知副作用的调用。已发出的冻结合并请求仍拒绝暂停。

相关：[审阅与过程读模型](inspect.md) · [分支合并](../../engineering/merge.md) · [维护与回收](maintenance.md) · [Worker 中心输入](../../engineering/task-centered-input-design.md)
