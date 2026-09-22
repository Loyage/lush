# 输入、规划与缓存

本节管输入的提交、缓存与分流：`input.submit` / `input.list` / `input.flow`、`draft.*` 的缓存语义，以及 `plan.propose` / `plan.approve` / `plan.reject` 这道规划闸门。

| CLI | RPC | 参数 |
|---|---|---|
| `lush say '原话' [--branch NAME]` | `input.submit` | `{content, branch?, references?}` |
| `lush intent list` | `input.list` | `{}`（每行带 planner 状态/闸门、Plan 计数与最新候选） |
| `lush plan propose '标题' [--body '…']` | `plan.propose` | `{title, body?}`（planner 专用） |
| `lush plan approve ID\|NOTICE_ID` | `plan.approve` | `{id, answer?}`（用户专属） |
| `lush plan reject ID\|NOTICE_ID '理由'` | `plan.reject` | `{id, reason}`（用户专属） |
| `lush draft add '原话'` | `draft.add` | `{content, references?}` |
| `lush draft list` | `draft.list` | `{}` |
| `lush draft rm ID` | `draft.remove` | `{id}` |
| `lush draft commit [--branch NAME]` | `draft.commit` | `{ids?, branch?}` |
| `lush input list` | `input.list` | `{}` |
| `lush input flow [TASK_ID] develop/explain` | `input.flow` | `{id?, flow: 'develop'/'explain'}` |
| `lush candidate list [--input ID]` | `candidate.list` | `{input?}` |
| `lush candidate prepare INPUT [--summary '…']` | `candidate.prepare` | `{input, summary?}`（用户专属） |

`input.submit` 返回 `{id, content, references, task, anchor}`。Web 可以额外提交结构化 `references`，正文不会被插入隐藏标记。`branch` 必须是本地分支；省略时使用当前检出分支。runtime 从它创建 `lush/<项目哈希>/input-<id>` 与 `.lush/worktrees/input-<id>`，planner 在该 worktree 中运行。输入分支既冻结解析上下文，也是任务分支的聚合父分支，最后通过 `branch.merge` 合回用户分支。

字段为兼容已有数据库仍叫 `anchor_branch` / `anchor_commit` / `anchor_workspace` / `anchor_target_branch`。失败时整条输入不落库，草稿不动；input id 永不复用。详见 [输入和规划](../../engineering/inputs-and-planning.md)。

`draft.*` 是输入缓存：`draft.add` 只落 `drafts` 行（`input_id` 为空），可带最多 12 条结构化引用；`draft.update` 的 `{references?}` 省略时保留原引用，给出时整体替换。`draft.commit` 把当前全部未提交草稿**在一个事务里**拼成一条 `inputs`、按原草稿段落复制引用、建一个 planner、并回写每条草稿的 `input_id`，返回 `{id, content, references, task, anchor, drafts:[...]}`（锚点语义与 `input.submit` 完全一致，失败时草稿一条不动）。单条草稿提交时原话逐字不变；多条带编号列表头。`draft.remove` 只删未提交的草稿，已提交的输入永不删除（返回错误）。`input.list` 额外给出 `draft_count`。缓存上限 500 条。这四个方法与 `input.submit` 一样是**用户专属**，agent 调用会被拒绝。

引用格式为 `{version:1, kind, target, label, quote, location, captured_at}`。支持任务、任务子树、分支、Intent、Spec、Notice、Diff、消息、结果、执行步骤、事件、检验和普通文字。单条快照最多 8192 字符，一条输入最多 12 项且总计不超过 48 KiB；实时解析结果每项最多 64 KiB、合计最多 256 KiB，超出带 `truncated=true`。planner 每次 invocation 都收到 `referenced_context`：`reference` 是引用时快照，`current` 是本轮解析的当前状态，目标已消失时 `stale=true`。

`input.flow` 记录这条输入走哪条流程：`develop`（要新增功能或改代码）或 `explain`（只了解相关内容），其他取值报 `flow must be develop or explain`。`id` 是根 planner 的 task id：用户（不带 token）可以判定或改判任意根 task，省略 `id` 又没有 agent token 时报明确错误；agent（带 `_token`）省略 `id` 时判定自己那条输入，指定别人的 task 会被拒绝，而且只能判定 `parent_id` 为空的根 task（否则报 `only a root task can classify an input`）。`input.list` 每行带 `flow`，未判定为 `null`（视为 `develop`）。强制约束在 `task.spawn`：`explain` 输入的子树里只允许 `research`，请求 worker/coordinator 会得到 `input #N is classified as explain (了解)`；改判只影响之后的 spawn，不追溯取消已建子任务。

## 规划闸门

`plan.propose` 把 planner 的 `plan_gate` 置为 `proposed` 并开一条 `kind='plan'` 的 notice，`readySpecPlanners()` 跳过它，直到 `plan.approve`（闸门放行、planner 本轮结束、runtime 直接编译 Work DAG）或 `plan.reject`（本轮 pending spec 全标 `dropped`、理由送进 planner 收件箱并唤醒它重拆）。plan notice 不能用 `notice.answer` 回答。回复 notice 的语义见 [待决问题](notices.md)。

## Review Candidate

由 Plan 编译出的工作时，runtime 自动在私有 Intent 分支内叶子优先聚合；完成后冻结 integration commit 与 target baseline commit，创建状态为 `pending` 的 `review_candidates` 版本，但不自动派验收任务。只有用户显式调用 `candidate.verify` 后才会启动只读 verifier 生成前后对照 HTML 报告。用户接受的是固定 commit，不是可移动 branch。
