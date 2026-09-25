# 输入、规划与缓存

本节管输入的提交与缓存：新 `say.submit` / `input.list`，以及为旧任务保留的 `input.submit`、`draft.commit` 和规划闸门。

| CLI | RPC | 参数 |
|---|---|---|
| `lush say '原话' [--branch NAME]` | `say.submit` | `{content, branch?, references?}` |
| `lush say --draft ID [--branch NAME]` | `say.submit` | `{draft_id, branch?}`（不得与 content / references 并用） |
| `lush intent list` | `input.list` | `{}`（每行带 planner 状态/闸门、Plan 计数与最新候选） |
| `lush plan propose '标题' [--body '…']` | `plan.propose` | `{title, body?}`（planner 专用） |
| `lush plan approve ID\|NOTICE_ID` | `plan.approve` | `{id, answer?}`（用户专属） |
| `lush plan reject ID\|NOTICE_ID '理由'` | `plan.reject` | `{id, reason}`（用户专属） |
| `lush draft add '原话'` | `draft.add` | `{content, references?}` |
| `lush draft list` | `draft.list` | `{}` |
| `lush draft rm ID` | `draft.remove` | `{id}` |
| `lush draft commit [--branch NAME]` | `draft.commit` | `{ids?, branch?}` |
| `lush input list` | `input.list` | `{}` |
| `lush candidate list [--input ID]` | `candidate.list` | `{input?}` |
| `lush candidate prepare INPUT [--summary '…']` | `candidate.prepare` | `{input, summary?}`（用户专属） |

CLI/Web 的直接发送走新 `say.submit {content,...}`，指定草稿走 `say.submit {draft_id,...}`；后者只提交一条，其他草稿仍在缓存，返回值额外带 `draft`。Web 的「存草稿」只缓存，「发送」不再暗中提交全部草稿。`say.submit` 在本地 `main` 上按需建立一个静息 `main` Task，或要求其它分支已有显式绑定的非终态 Task；旧/外部分支可由用户 `branch.bind BRANCH COMMIT` 创建新的静息 owner（旧记录不改）；再创建一个直接拥有输入分支/worktree 的 `agent` Task，`inputs.task_id` 指向它。不经过 planner、快速路由或旧自动集成。say Agent 一轮正常返回后变为 waiting 静息态，保留分支所有权与后续唤醒能力，不等于已完成或已合并；daemon 启动时若已有本地 main ref，则建立或恢复同一个静息 main 根 Task（无 ref 不自动创建）；分支绑定与合并预约已实现，操作细节见[Task](tasks.md)与[分支](branches.md)。旧 `input.submit` 仍可供历史调用方运行，它返回 `{id, content, references, task, anchor}`；命中快速路由前缀时额外返回 `{route:{prefix,target}, worker|research}`，planner 为零调用的 completed 占位，不运行规划模型。`input.list` 的 `route` 标记由既有事件派生，无新表或历史数据迁移。Web 可以额外提交结构化 `references`，正文不会被插入隐藏标记。`branch` 必须是本地分支；省略时使用当前检出分支。runtime 从它创建 `lush/<项目哈希>/input-<id>` 与 `.lush/worktrees/input-<id>`，旧 planner 在该 worktree 中运行；新 say Agent 则直接在自己的输入分支 worktree 中运行。旧输入分支兼作任务聚合父分支并通过 `branch.merge` 合回用户分支；新协议不自动合并。

字段为兼容已有数据库仍叫 `anchor_branch` / `anchor_commit` / `anchor_workspace` / `anchor_target_branch`。失败时整条输入不落库，草稿不动；input id 永不复用。详见 [输入和规划](../../engineering/inputs-and-planning.md)。

`draft.*` 是输入缓存：`draft.add` 只落 `drafts` 行（`input_id` 为空），可带最多 12 条结构化引用；`draft.update` 的 `{references?}` 省略时保留原引用，给出时整体替换。`draft.commit` 把选中的草稿按 id 升序**逐条提交**：每条正文原样成为一条独立 `inputs`、各自复制引用（segment 1）、各建一个旧 planner（命中快速路由前缀则短路为 worker / research 根任务）并回写该草稿的 `input_id`，返回 `{inputs:[{id, content, references, task, anchor, draft, route?, worker?/research?}], drafts:[...]}`（锚点语义与 `input.submit` 完全一致）。任一条 Git / 创建失败即抛出：已提交的前几条保留，失败的及之后的草稿仍未提交，不是整批回滚。`draft.remove` 只删未提交的草稿，已提交的输入永不删除（返回错误）。`input.list` 额外给出 `draft_count`。缓存上限 500 条。这四个方法与 `say.submit` / `input.submit` 一样是**用户专属**，agent 调用会被拒绝。

引用格式为 `{version:1, kind, target, label, quote, location, captured_at}`。支持任务、任务子树、分支、Intent、Spec、Notice、Diff、消息、结果、执行步骤、事件、检验和普通文字。单条快照最多 8192 字符，一条输入最多 12 项且总计不超过 48 KiB；实时解析结果每项最多 64 KiB、合计最多 256 KiB，超出带 `truncated=true`。planner 每次 invocation 都收到 `referenced_context`：`reference` 是引用时快照，`current` 是本轮解析的当前状态，目标已消失时 `stale=true`。

## 规划闸门

`plan.propose` 把 planner 的 `plan_gate` 置为 `proposed` 并开一条 `kind='plan'` 的 notice，`readySpecPlanners()` 跳过它，直到 `plan.approve`（闸门放行、planner 本轮结束、runtime 直接编译 Work DAG）或 `plan.reject`（本轮 pending spec 全标 `dropped`、理由送进 planner 收件箱并唤醒它重拆）。plan notice 不能用 `notice.answer` 回答。回复 notice 的语义见 [待决问题](notices.md)。

## Review Candidate

由 Plan 编译出的工作时，runtime 自动在私有 Intent 分支内叶子优先聚合；完成后冻结 integration commit 与 target baseline commit，创建状态为 `pending` 的 `review_candidates` 版本，但不自动派验收任务。只有用户显式调用 `candidate.verify` 后才会启动只读 verifier 生成前后对照 HTML 报告。用户接受的是固定 commit，不是可移动 branch。
