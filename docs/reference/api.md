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
| `task spawn 'goal' --parent ID --role worker [--depends-on ID[:kind]]` | `task.spawn` | `{parent, goal, role?: 'worker', deps?: [{id, kind: 'code'|'order'}]}` |
| —（只读，Web UI 使用） | `task.diff` | `{id}` |
| `task message ID 'body'` | `task.message` | `{id, body}` |
| `task cancel ID` | `task.cancel` | `{id}` |
| `task retry ID` | `task.retry` | `{id}` |
| `task merge ID` | `task.merge` | `{id}` |
| `task cleanup ID` | `task.cleanup` | `{id}` |

`task wait ID` 在客户端轮询 inspect；只阻塞当前客户端，终态返回。failed/cancelled 设置非零退出码。Agent 不允许使用 wait，应结束 invocation 由调度器唤醒。

spawn 必须关联一个活动父 task；根任务只能由用户输入创建。角色可选 `worker` / `coordinator` / `research`，`planner` 只由入口生成。

`deps` 是依赖边（`task_deps` 表，`(task_id, depends_on, kind)`，创建后不可变）。`kind` 默认 `code`：本任务的 worktree 从上游分支拉出（stacked），`base_commit` 冻结为上游的 `head_commit`，审阅 diff 只含本任务自己的提交；`order` 只等上游终态，代码仍从 HEAD 开始。`kind` 缺省由 CLI 的 `--dep-kind` 决定。提交时做结构校验并拒绝：自依赖、依赖祖先任务（父任务在等子任务结算，双方会互等而死）、悬空 id、一个任务多于一条 `code` 边、`code` 边指向非 worker 或已 failed/cancelled 的上游。边只在创建时写入，所以环在结构上不可能；`assertDeps` 仍保留可达性校验，供未来加改边 API。

依赖未满足的 `queued` 任务不会被调度，`task.list` / `tree` 的每行都带 `deps: [{id, kind, status}]` 与 `blocked` 布尔值，`task.inspect` 额外给出 `deps` / `dependents`（带上游状态、角色、goal 摘要）。上游结算时 `finish` 唤醒每一个依赖它的任务。

`task.merge` 对 stacked 任务多一道检查：上游的 `head_commit` 必须已经是当前目标的祖先（即上游先合并），否则拒绝，防止把未合并的改动一起带进目标分支。

`task.list` 和 tree 返回摘要，不复制每个 task 的结果与收件箱。完整 result 在 inspect 中；inspect 的子任务、消息、notice 集合受字节预算限制，完整记录仍在 SQLite。摘要与 inspect 都带 agent 字段：摘要含 `agent_wakes` / `agent_last_seen_at`，inspect 额外给出 `agent.id`（`<role>#<task-id>`）、`agent.active` 与 `agent.pid`。history 每页最多 100 个事件且有字节预算，以最后一条 event.id 作为下一页 after。大型任务森林超过 1 MiB frame 时应改用 task list 分页和指定根 ID 的 task tree。

`task.diff` 是只读审阅视图：不写库、不改仓库，因此不进入 Git 串行队列。返回 `{branch, target_branch, base_commit, head_commit, committed, files, files_total, pending, pending_total, commits}`；`files` 是 base..head 的已提交改动，`pending` 是相对 HEAD 的未提交改动（含未跟踪文件，`code` 为 git porcelain 状态、新增删除行数为 null）。无工作区时返回 `null`。该 RPC 暂无 CLI 命令。

## Web 读取路由

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理：

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | status + input.list + notice.list + 分页 task.list |
| `GET /api/task/ID` | `task.inspect` |
| `GET /api/task/ID/history?after=N` | `task.history` |
| `GET /api/task/ID/diff` | `task.diff` |
| `POST /api/action` | 仅限上方 `MUTATIONS` 中的用户动作 |

## 待决问题

| CLI | RPC | 参数 |
|---|---|---|
| `notice list` | `notice.list` | `{}` |
| `notice post 'title' --task ID --body 'body'` | `notice.post` | `{task, title, body?: ''}` |
| `notice answer ID 'answer'` | `notice.answer` | `{id, answer}` |
| `notice dismiss ID` | `notice.dismiss` | `{id}` |

当前统一使用自由文本答复，不保留旧 Service notice 的动态字段表单。notice 是需要用户回复的决策请求；普通结果汇报直接使用 task result。列表优先返回未决项，同组按新到旧排列；最多 200 条并受 RPC 字节预算限制。

## Agent 环境与权限

pi 从 daemon 启动时获得：

- `LUSH_PROJECT` / `LUSH_HOME`：固定所属项目，即使 cwd 是隔离 worktree。
- `LUSH_TASK_ID`：自己的任务。
- `LUSH_AGENT_TOKEN`：当前 invocation 的临时 capability。同一 task 每次唤醒重新签发，daemon 只存 SHA-256，invocation 结束或 daemon 重启后即失效；泄漏的旧 token 不能被下一轮使用。
- `PATH` 前置 daemon 所属 checkout 的 `bin/`。

CLI 会把 token 放入 RPC params 的 `_token`；daemon 按 hash 反查所属 task，并要求该 task 仍是活动 invocation（在 `running` 中且未被 abort），否则报 invalid or expired agent token。agent spawn 的 parent / notice 的 task 缺省为自己的 task，不能伪造其他父任务；message 只能沿直接父子边。

`system.status` 里 `agents` 只列运行中的 agent，另有 `agents_total`（每个活动 task 一个 agent）与 `agents_idle`（已 park、未在跑的，含尚未首次唤醒的）。agent 身份本身（id / 唤醒次数 / 上次动手时间）可以跨唤醒读取，但它不是可寻址的执行句柄：用户操作一律按 task ID 进行。

以下操作限用户：system.stop、input.submit、task.cancel/retry/merge/cleanup、notice.answer/dismiss。CLI 另禁止 agent 启动 daemon、Web 或阻塞等待。

本地用户可以不带 token 调用 RPC，这是明确的信任边界，不是多用户 ACL。能执行任意本机命令的恶意 agent 也能绕过环境约定；需要真正沙箱时应另加 OS 隔离。

## HTTP

- `GET /`、`/app.js`、`/styles.css`：Web 资源。
- `GET /api/snapshot`：项目状态、任务摘要、输入与 notice。
- `GET /api/task/<id>`：任务详情。
- `POST /api/action`：JSON `{method, params}`，只允许用户输入、任务 message/cancel/retry/merge/cleanup 和 notice answer/dismiss。

仅回环监听；拒绝非本地 Host、跨 Origin、跨站请求和非 JSON 修改请求。不能将它作为公网多用户服务暴露。
