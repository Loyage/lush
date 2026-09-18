# CLI 与 RPC（0.2）

完整 CLI 帮助：`bun run help`。全局参数 `--project PATH`、`--json` 可放在命令前后。

## 入口

| CLI | RPC | 参数 |
|---|---|---|
| `lush say '原话'` | `input.submit` | `{content}` |
| `lush draft add '原话'` | `draft.add` | `{content}` |
| `lush draft list` | `draft.list` | `{}` |
| `lush draft rm ID` | `draft.remove` | `{id}` |
| `lush draft commit` | `draft.commit` | `{}` |
| `lush input list` | `input.list` | `{}` |
| `lush input flow [TASK_ID] develop/explain` | `input.flow` | `{id?, flow: 'develop'/'explain'}` |
| `lush status` | `system.status` | `{}` |
| `lush daemon stop` | `system.stop` | `{}` |

`daemon start/restart` 是客户端工作流，不是 RPC。`doctor` 检查本地项目配置与 daemon 身份。`web [port]` 启动本地 Web 进程。

`input.submit` 返回 `{id, content, task}`，其中 task 是根 planner。原话完整存库，列表展示最近 100 条摘要；根 task inspect 可读取完整 goal。

`draft.*` 是输入缓存：`draft.add` 只落 `drafts` 行（`input_id` 为空），`draft.commit` 把当前全部未提交草稿**在一个事务里**拼成一条 `inputs`、建一个 planner、并回写每条草稿的 `input_id`，返回 `{id, content, task, drafts:[...]}`。单条草稿提交时原话逐字不变；多条带编号列表头。`draft.remove` 只删未提交的草稿，已提交的输入永不删除（返回错误）。`input.list` 额外给出 `draft_count`。缓存上限 500 条。这四个方法与 `input.submit` 一样是**用户专属**，agent 调用会被拒绝。

`input.flow` 记录这条输入走哪条流程：`develop`（要新增功能或改代码）或 `explain`（只了解相关内容），其他取值报 `flow must be develop or explain`。`id` 是根 planner 的 task id：用户（不带 token）可以判定或改判任意根 task，省略 `id` 又没有 agent token 时报明确错误；agent（带 `_token`）省略 `id` 时判定自己那条输入，指定别人的 task 会被拒绝，而且只能判定 `parent_id` 为空的根 task（否则报 `only a root task can classify an input`）。`input.list` 每行带 `flow`，未判定为 `null`（视为 `develop`）。强制约束在 `task.spawn`：`explain` 输入的子树里只允许 `research`，请求 worker/coordinator 会得到 `input #N is classified as explain (了解)`；改判只影响之后的 spawn，不追溯取消已建子任务。

## 任务

| CLI | RPC | 参数 |
|---|---|---|
| `task list [--after N] [--limit N]` | `task.list` | `{after?: 0, limit?: 200}`，limit 最大 1000 |
| `task tree [ID]` | `task.tree` | `{id?}` |
| `task inspect ID` | `task.inspect` | `{id}` |
| `task history ID [--after N]` | `task.history` | `{id, after?: 0}` |
| `task transcript ID [--after N]` | `task.transcript` | `{id, after?: 0, limit?: 100}`，limit 最大 200 |
| `task usage ID` | `task.usage` | `{id}` |
| `task spawn 'goal' --parent ID --role worker [--name short-kebab-name] [--depends-on ID[:kind]]` | `task.spawn` | `{parent, goal, role?: 'worker', deps?: [{id, kind: 'code'|'order'}], name?}` |
| —（只读，Web UI 使用） | `task.diff` | `{id}` |
| `task message ID 'body'` | `task.message` | `{id, body}` |
| `task cancel ID` | `task.cancel` | `{id}` |
| `task retry ID` | `task.retry` | `{id}` |
| `task merge ID` | `task.merge` | `{id}` |
| `task cleanup ID [--keep-branch]` | `task.cleanup` | `{id, keep_branch?}` |
| `task clear` | `task.clear` | `{}` |

`task wait ID` 在客户端轮询 inspect；只阻塞当前客户端，终态返回。failed/cancelled 设置非零退出码。Agent 不允许使用 wait，应结束 invocation 由调度器唤醒。

spawn 必须关联一个活动父 task；根任务只能由用户输入创建。角色可选 `worker` / `coordinator` / `research`，`planner` 只由入口生成。`name` 是任务自己的英文短名（kebab-case），写入只读的 `tasks.name`，决定分支与 worktree 名：`lush/<项目哈希>/<id>-<name>` 与 `.lush/worktrees/<id>-<name>`。省略时 runtime 从 goal 首行提取英文词回退，提不出可用词则任务没有 name（分支/目录回到 `task-<id>`）。`name` 给不出至少两个 ASCII 字母或数字时报 `name needs at least two ASCII letters or digits (kebab-case)`；名字不可改，已有 worktree 不会被改名。

`deps` 是依赖边（`task_deps` 表，`(task_id, depends_on, kind)`，创建后不可变）。`kind` 默认 `code`：本任务的 worktree 从上游分支拉出（stacked），`base_commit` 冻结为上游的 `head_commit`，审阅 diff 只含本任务自己的提交；`order` 只等上游终态，代码仍从 HEAD 开始。`kind` 缺省由 CLI 的 `--dep-kind` 决定。提交时做结构校验并拒绝：自依赖、依赖祖先任务（父任务在等子任务结算，双方会互等而死）、悬空 id、一个任务多于一条 `code` 边、`code` 边指向非 worker 或已 failed/cancelled 的上游。边只在创建时写入，所以环在结构上不可能；`assertDeps` 仍保留可达性校验，供未来加改边 API。

依赖未满足的 `queued` 任务不会被调度，`task.list` / `tree` 的每行都带 `deps: [{id, kind, status}]` 与 `blocked` 布尔值，`task.inspect` 额外给出 `deps` / `dependents`（带上游状态、角色、goal 摘要）。上游结算时 `finish` 唤醒每一个依赖它的任务。

`task.merge` 是**用户明确批准合并**的唯一入口（仍限用户）。三种返回值：干净合并成功 `merge: {status: 'merged'}`；落地一次解冲突结果 `merge: {status: 'resolved', resolved_task_id}`；内容冲突 `merge: {status: 'conflict', files, resolution_task_id, notice_id, superseded_task_id}`——冲突是正常返值，不是 RPC 错误。

冲突的处理：真跑一次 merge，失败时取未解决冲突的文件路径并 `merge --abort`，主树回到合并前（abort 不成功就直接报错，不进入冲突状态）。然后原任务进入 `integration=conflict`，runtime 同步开一个 `role=merger`、`resolves_task_id=<原任务>`、`target_branch` 相同的解冲突任务（`parent_id` 为空，与 verifier 一样用关联边）并预置成 `awaiting`，同时用 `notice.post` 发一条待决问题：冲突文件、git 输出、接下来会发生什么、以及「同一目标分支上的其它合并已被冻结」。**`merger` 不是一个可 spawn 的角色**：agent 调用 `task.spawn --role merger` 仍会被拒。

答复那条 notice 即批准开工：解冲突任务此时才建 worktree，基线是**目标分支当前顶端**（不是 HEAD，用户可能已经切走），agent 把原任务已审阅的 `head_commit` 并进来、解冲突、提交成合并提交。忽略那条 notice 则直接取消这个从未被唤醒过的解冲突任务，并把原任务放回 `pending`（`integration_error` 记下原因）。

解冲突任务完成后走同一条 `task.merge`：落地必须同时满足两道额外守卫——结果分支真的包含原任务的 `head_commit`（防止「解冲突」把对方改动整个丢掉）、且只能用 `git merge --ff-only` 落地（成功即证明目标分支没被推走，落地的树就是 agent 测过的那棵树）。成功后原任务一起标成 `merged`（事件 `merge.resolved`），冻结随之解除；快进失败则主树未被动过、原任务仍挂起，重试原任务的合并会开新一轮并把上一轮标成 `integration=superseded`（分支与目录保留，可以直接 `task.cleanup` 回收）。

**合并冻结**：`integration=conflict` 就是一把按 `target_branch` 的合并锁。同目标分支上其它任务的 `task.merge` 会被拒（`merging into <branch> is frozen by the unresolved conflict on #N`），`system.status.merge_freeze` 给出 `[{task_id, resolves_task_id, target_branch}]` 供界面禁用按钮。锁从状态派生，不另建表，所以重启后仍然准确、也不会留下无人认领的锁。`task.merge` 对 stacked 任务仍多一道检查：上游的 `head_commit` 必须已经是当前目标的祖先（即上游先合并），否则拒绝，防止把未合并的改动一起带进目标分支。`integration=conflict` 的任务可以直接重试（这是冲突后唯一的出路）。

`task.cleanup` 回收一个已结束任务占的磁盘状态：worktree 目录、检验对照检出（如果有）与任务分支。只有 `integration` 为 `merged` / `none` / `superseded` 的任务可回收（`superseded` 是「这一轮解冲突已被下一轮取代」，分支仍当恢复点看待）。worktree 仍然不强制删除（干净检查 + commit 已进 HEAD 的检查不变）；分支额外要求**它的顶端就是审阅过的那次提交**，且那次提交已经是 `target_branch` 的祖先——任一条不满足就保留分支，并在返回的 `cleanup.branch` / `cleanup.reason` 里说明。删除用 `git update-ref -d <ref> <tip>` 的 compare-and-delete，不用 `--force`：检查之后分支被谁动过就拒绝，审阅过之外的提交一条也不会丢；`branch` 快照不再存在时库里也会清空。`keep_branch: true`（CLI `--keep-branch`）只回收 worktree，把分支留成恢复点。返回 `{...task, cleanup: {worktree: removed|absent, branch: removed|kept|absent, reason}}`。

`task.clear` 是用户专属的**一键清空**：把全部任务行及 `messages` / `notices` / `task_deps` / `events`，连同 `inputs` 与 `drafts` 一起删掉（这是 `draft.remove` 那条「已提交输入永不删除」的唯一例外，且只在这里）。前置条件是**当前没有活动任务**，并且没有 invocation 正在收尾、没有 worktree 清理在进行：有 `queued`/`running`/`waiting`/`awaiting` 时返回 `#3, #7 still active (2); cancel them or wait until they finish`，不做隐式取消（删掉正在调用中的 task 行会让 agent 收尾时读到不存在的 task）。

它**先回收再清库**：对每个已结束任务跑与 `task cleanup` 相同的安全门，能回收的连 `.lush/worktrees/<id>-<name>/`、派生对照检出与 `lush/<项目哈希>/<id>-<name>` 分支一起删，返回 `reclaimed: {worktrees, branches}`。回收不掉的任务（`integration=pending/review/conflict` 的未合并成果、审阅后又被改过的分支、脏工作区）连同目录与分支一起保留，`retained.tasks` 列出 `{id, branch, workspace, baseline_workspace, reason}` 供人工决定去留。`.lush/sessions/*.jsonl` 与 `.lush/verify/*/report.html` 不受影响。因为目录名与分支名里带着 task id，**id 不会被复用**：清空后 daemon 把用过的最大 id 记在 `meta.task_id_high`，下一个任务继续往大走（`next_task_id` 是清空后将要使用的 id），因此新 worktree 不会撞上保留下来的旧目录。前置检查是同步的（调用时立即拿到拒绝），磁盘回收在返回的 Promise 里串行执行。返回 `{cleared: {tasks, inputs, drafts, notices, messages, events, task_deps}, reclaimed, retained, next_task_id}`。

`task.list` 和 tree 返回摘要，不复制每个 task 的结果与收件箱。完整 result 在 inspect 中；inspect 的子任务、消息、notice 集合受字节预算限制，完整记录仍在 SQLite。摘要与 inspect 都带 agent 字段：摘要含 `agent_wakes` / `agent_last_seen_at`，inspect 额外给出 `agent.id`（`<role>#<task-id>`）、`agent.active` 与 `agent.pid`；worker 的 inspect 还带 `verifications`（检验记录）与 `resolutions`（合并冲突处理记录：`{id, status, integration, branch, head_commit, ...}`），解冲突任务自身带 `resolves_task_id`。history 每页最多 100 个事件且有字节预算，以最后一条 event.id 作为下一页 after。大型任务森林超过 1 MiB frame 时应改用 task list 分页和指定根 ID 的 task tree。

`task.diff` 是只读审阅视图：不写库、不改仓库，因此不进入 Git 串行队列。返回 `{branch, target_branch, base_commit, head_commit, committed, base_behind, files, files_total, pending, pending_total, commits}`；`files` 是 base..head 的已提交改动，`pending` 是相对 HEAD 的未提交改动（含未跟踪文件，`code` 为 git porcelain 状态、新增删除行数为 null）。`base_behind` 是 `base_commit..target_branch` 的提交数：主工作树允许有未提交改动，spawn 之后目标分支可能继续前进，这个数说明审阅是相对哪个 base；stacked 任务的 base 是上游分支，所以它也含上游尚未合并的差异。无工作区时返回 `null`。该 RPC 暂无 CLI 命令。

`task.transcript` 是 agent **执行过程**的只读投影。过程数据不在 SQLite：daemon 只把 invocation 的最后一次 stdout 存成 `tasks.result`，而思考、工具调用与工具输出由 pi 写在 `<home>/sessions/*_lush-task-ID.jsonl`。这个 RPC 是那些文件的唯一读取者，不写库、不改工作区、也不进入 Git 串行队列。每条 JSONL 记录投影成 0..n 个 `{seq, kind, title, at, body, file, line}`：`kind` 为 `meta`（模型、思考等级等）、`input`（注入的任务上下文）、`thinking`、`tool`（工具调用，body 是参数 JSON）、`result`（工具输出，失败时 title 带「（失败）」）或 `text`（回答）。单步正文截断到 4000 字符；一次最多返回 200 步且受 RPC 字节预算限制，用返回的 `next` 作为下一页 `after`，`has_more` 表示还有步骤。同一个 task 可能因重试或重启留下多个会话文件，按文件名（时间前缀）从旧到新拼接，`seq` 跨文件连续；半行 JSON（agent 被杀）跳过，未知记录类型降级为 `meta`，都不算错误。单次请求读取的会话字节上限为 8 MiB，超出时 `truncated` 为 true。`files` 列出本次涉及的会话文件名，便于人去磁盘上核对原文。

`task.usage` 是同一个 agent 的**用量**只读视图，读的还是那批会话文件，但不投影步骤、不做正文截断，所以详情面板每次刷新都可以取它。返回 `{task_id, files, model, thinking_level, requests, context_tokens, compacted, last_at, totals, truncated}`：`model` 是最近一次请求的 `{provider, model_id}`（模型中途被换掉时显示最后真正用到的），`requests` 是 assistant 回合并（＝模型请求次数），`context_tokens` 是**最近一次**请求的 `totalTokens`（＝输入 + 缓存读 + 缓存写 + 输出），也就是那一刻上下文里真的有多少 token；`totals` 是全部会话文件累计的 `{input, output, cache_read, cache_write, reasoning, tokens, cost}`，其中 `cost` 是 pi 按模型单价算出的每次请求花费之和。`compacted` 是上下文压缩次数，`last_at` 是最近一次带用量的请求时间，读取预算同样为 8 MiB（超出时 `truncated`）。没有会话文件时返回各项为零/空的统计，不报错。它不写库、不改工作区，也不进入 Git 串行队列。

## Web 读取路由

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理：

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | status + input.list + notice.list + 分页 task.list |
| `GET /api/task/ID` | `task.inspect` |
| `GET /api/task/ID/history?after=N` | `task.history` |
| `GET /api/task/ID/diff` | `task.diff` |
| `GET /api/task/ID/transcript?after=N` | `task.transcript` |
| `GET /api/task/ID/usage` | `task.usage` |
| `POST /api/action` | 仅限上方 `MUTATIONS` 中的用户动作（含 `task.clear`） |

## 待决问题

| CLI | RPC | 参数 |
|---|---|---|
| `notice list` | `notice.list` | `{}` |
| `notice post 'title' --task ID --body 'body'` | `notice.post` | `{task, title, body?: ''}` |
| `notice answer ID 'answer'` | `notice.answer` | `{id, answer}` |
| `notice dismiss ID` | `notice.dismiss` | `{id}` |

当前统一使用自由文本答复，不保留旧 Service notice 的动态字段表单。notice 是需要用户回复的决策请求；普通结果汇报直接使用 task result。列表优先返回未决项，同组按新到旧排列；最多 200 条并受 RPC 字节预算限制。合并冲突的那条 notice 由 runtime 自己发：它是「要不要开一个解冲突任务」的请示。

`notice.answer` 把答复作为消息送给 owner task 并唤醒它。`notice.dismiss` 在 owner 从未被唤醒过（`agent_wakes=0`，即 runtime 预置的解冲突任务）时会**直接取消该任务**，而不是唤醒 agent 去做用户刚拒绝的事。

## Agent 环境与权限

pi 从 daemon 启动时获得：

- `LUSH_PROJECT` / `LUSH_HOME`：固定所属项目，即使 cwd 是隔离 worktree。
- `LUSH_TASK_ID`：自己的任务。
- `LUSH_AGENT_TOKEN`：当前 invocation 的临时 capability。同一 task 每次唤醒重新签发，daemon 只存 SHA-256，invocation 结束或 daemon 重启后即失效；泄漏的旧 token 不能被下一轮使用。
- `PATH` 前置 daemon 所属 checkout 的 `bin/`。

CLI 会把 token 放入 RPC params 的 `_token`；daemon 按 hash 反查所属 task，并要求该 task 仍是活动 invocation（在 `running` 中且未被 abort），否则报 invalid or expired agent token。agent spawn 的 parent / notice 的 task 缺省为自己的 task，不能伪造其他父任务；message 只能沿直接父子边。

`system.status` 里 `agents` 只列运行中的 agent，另有 `agents_total`（每个活动 task 一个 agent）与 `agents_idle`（已 park、未在跑的，含尚未首次唤醒的）。`pending_merges` 把 `integration=pending/review/conflict` 都算作待处理的合并，`merge_freeze` 列出正被未解决冲突冻结的目标分支。agent 身份本身（id / 唤醒次数 / 上次动手时间）可以跨唤醒读取，但它不是可寻址的执行句柄：用户操作一律按 task ID 进行。

以下操作限用户：system.stop、input.submit、task.cancel/retry/merge/cleanup/clear、notice.answer/dismiss。CLI 另禁止 agent 启动 daemon、Web 或阻塞等待。

本地用户可以不带 token 调用 RPC，这是明确的信任边界，不是多用户 ACL。能执行任意本机命令的恶意 agent 也能绕过环境约定；需要真正沙箱时应另加 OS 隔离。

## HTTP

- `GET /`、`/app.js`、`/styles.css`：Web 资源。
- `GET /api/snapshot`：项目状态、任务摘要、输入与 notice。
- `GET /api/task/<id>`：任务详情。
- `GET /api/task/<id>/transcript`：agent 执行过程，只读，来自 pi 会话记录。
- `GET /api/task/<id>/usage`：同一个 agent 的模型、上下文占用与累计花费，只读。
- `POST /api/action`：JSON `{method, params}`，只允许用户输入、任务 message/cancel/retry/merge/cleanup/clear 和 notice answer/dismiss。

仅回环监听；拒绝非本地 Host、跨 Origin、跨站请求和非 JSON 修改请求。不能将它作为公网多用户服务暴露。
