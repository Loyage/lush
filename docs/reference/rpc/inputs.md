# 输入、规划与缓存

本节管输入的提交、缓存与分流：`input.submit` / `input.list` / `input.flow`、`draft.*` 的缓存语义，以及 `plan.propose` / `plan.approve` / `plan.reject` 这道规划闸门。

| CLI | RPC | 参数 |
|---|---|---|
| `lush say '原话'` / `lush intent '原话'` | `input.submit` | `{content}` |
| `lush intent list` | `input.list` | `{}`（每行带 planner 状态/闸门与 scheduler 进度） |
| `lush plan propose '标题' [--body '…']` | `plan.propose` | `{title, body?}`（planner 专用） |
| `lush plan approve ID\|NOTICE_ID` | `plan.approve` | `{id, answer?}`（用户专属） |
| `lush plan reject ID\|NOTICE_ID '理由'` | `plan.reject` | `{id, reason}`（用户专属） |
| `lush draft add '原话'` | `draft.add` | `{content}` |
| `lush draft list` | `draft.list` | `{}` |
| `lush draft rm ID` | `draft.remove` | `{id}` |
| `lush draft commit` | `draft.commit` | `{}` |
| `lush input list` | `input.list` | `{}` |
| `lush input flow [TASK_ID] develop/explain` | `input.flow` | `{id?, flow: 'develop'/'explain'}` |

`input.submit` 返回 `{id, content, task, anchor}`，其中 task 是根 planner，`anchor` 是 `{branch, commit, workspace, target, dirty_source}`——提交那一刻锚下来的代码（分支 / commit / 检出目录 / 当时检出的分支）。原话完整存库，列表展示最近 100 条摘要；根 task inspect 可读取完整 goal。

**输入锚点**：提交先从当前分支顶端建 `lush/<项目哈希>/input-<id>-anchor` 与 `.lush/worktrees/input-<id>-anchor`，worker 的 `base_commit` / `target_branch` 与分支谱系 `parent` 都从它来，所以规划花多久、主树之后又提交了什么，都不改变这次输入看到的代码（`code` 依赖与解冲突任务例外，它们有更具体的基线）。锚点失败时**整条输入不落库**：`input.submit` / `draft.commit` 报错，缓存的草稿仍留在缓存里。因为分支名与目录名带着 input id，**input id 也不复用**（`meta.input_id_high`，同 `task_id_high`），`input.list` 的每行带 `anchor_branch` / `anchor_commit` / `anchor_workspace` / `anchor_target_branch`。详见 [输入和规划](../engineering/inputs-and-planning.md)。

`draft.*` 是输入缓存：`draft.add` 只落 `drafts` 行（`input_id` 为空），`draft.commit` 把当前全部未提交草稿**在一个事务里**拼成一条 `inputs`、建一个 planner、并回写每条草稿的 `input_id`，返回 `{id, content, task, anchor, drafts:[...]}`（锚点语义与 `input.submit` 完全一致，失败时草稿一条不动）。单条草稿提交时原话逐字不变；多条带编号列表头。`draft.remove` 只删未提交的草稿，已提交的输入永不删除（返回错误）。`input.list` 额外给出 `draft_count`。缓存上限 500 条。这四个方法与 `input.submit` 一样是**用户专属**，agent 调用会被拒绝。

`input.flow` 记录这条输入走哪条流程：`develop`（要新增功能或改代码）或 `explain`（只了解相关内容），其他取值报 `flow must be develop or explain`。`id` 是根 planner 的 task id：用户（不带 token）可以判定或改判任意根 task，省略 `id` 又没有 agent token 时报明确错误；agent（带 `_token`）省略 `id` 时判定自己那条输入，指定别人的 task 会被拒绝，而且只能判定 `parent_id` 为空的根 task（否则报 `only a root task can classify an input`）。`input.list` 每行带 `flow`，未判定为 `null`（视为 `develop`）。强制约束在 `task.spawn`：`explain` 输入的子树里只允许 `research`，请求 worker/coordinator 会得到 `input #N is classified as explain (了解)`；改判只影响之后的 spawn，不追溯取消已建子任务。

## 规划闸门

`plan.propose` 把 planner 的 `plan_gate` 置为 `proposed` 并开一条 `kind='plan'` 的 notice，`nextSpecPlanner()` 跳过它，直到 `plan.approve`（闸门放行、planner 本轮结束、下一次 pump 交给 scheduler）或 `plan.reject`（本轮 pending spec 全标 `dropped`、理由送进 planner 收件箱并唤醒它重拆）。plan notice 不能用 `notice.answer` 回答。回复 notice 的语义见 [待决问题](notices.md)。
