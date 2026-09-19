# 审阅与过程读模型

本节管读模型：`task.inspect` / `task.history` / `task.diff` / `task.transcript` / `task.usage`，以及客户端轮询用的 `task wait`；分页与字节预算都在这里。

| CLI | RPC | 参数 |
|---|---|---|
| `task inspect ID` | `task.inspect` | `{id}` |
| `task history ID [--after N]` | `task.history` | `{id, after?: 0}` |
| `task transcript ID [--after N]` | `task.transcript` | `{id, after?: 0, limit?: 100}`，limit 最大 200 |
| `task usage ID` | `task.usage` | `{id}` |
| —（只读，Web UI 使用） | `task.diff` | `{id}` |

`task wait ID` 在客户端轮询 inspect；只阻塞当前客户端，终态返回。failed/cancelled 设置非零退出码。Agent 不允许使用 wait，应结束 invocation 由调度器唤醒。

`task.list` 和 tree 返回摘要，不复制每个 task 的结果与收件箱。完整 result 在 inspect 中；inspect 的子任务、消息、notice 集合受字节预算限制，完整记录仍在 SQLite。摘要与 inspect 都带 agent 字段：摘要含 `agent_wakes` / `agent_last_seen_at`，inspect 额外给出 `agent.id`（`<role>#<task-id>`）、`agent.active` 与 `agent.pid`；worker 的 inspect 还带 `verifications`（检验记录）与 `resolutions`（合并冲突处理记录：`{id, status, integration, branch, head_commit, ...}`），解冲突任务自身带 `resolves_task_id`。history 每页最多 100 个事件且有字节预算，以最后一条 event.id 作为下一页 after。大型任务森林超过 1 MiB frame 时应改用 task list 分页和指定根 ID 的 task tree。

`task.diff` 是只读审阅视图：不写库、不改仓库，因此不进入 Git 串行队列。返回 `{branch, target_branch, base_commit, head_commit, committed, base_behind, files, files_total, pending, pending_total, commits}`；`files` 是 base..head 的已提交改动，`pending` 是相对 HEAD 的未提交改动（含未跟踪文件，`code` 为 git porcelain 状态、新增删除行数为 null）。`base_behind` 是 `base_commit..target_branch` 的提交数：主工作树允许有未提交改动，spawn 之后目标分支可能继续前进，这个数说明审阅是相对哪个 base；stacked 任务的 base 是上游分支，所以它也含上游尚未合并的差异。无工作区时返回 `null`。该 RPC 暂无 CLI 命令。

`task.transcript` 是 agent **执行过程**的只读投影。过程数据不在 SQLite：daemon 只把 invocation 的最后一次 stdout 存成 `tasks.result`，而思考、工具调用与工具输出由 pi 写在 `<home>/sessions/*_lush-task-ID.jsonl`。这个 RPC 是那些文件的唯一读取者，不写库、不改工作区、也不进入 Git 串行队列。每条 JSONL 记录投影成 0..n 个 `{seq, kind, title, at, body, file, line}`：`kind` 为 `meta`（模型、思考等级等）、`input`（注入的任务上下文）、`thinking`、`tool`（工具调用，body 是参数 JSON）、`result`（工具输出，失败时 title 带「（失败）」）或 `text`（回答）。单步正文截断到 4000 字符；一次最多返回 200 步且受 RPC 字节预算限制，用返回的 `next` 作为下一页 `after`，`has_more` 表示还有步骤。同一个 task 可能因重试或重启留下多个会话文件，按文件名（时间前缀）从旧到新拼接，`seq` 跨文件连续；半行 JSON（agent 被杀）跳过，未知记录类型降级为 `meta`，都不算错误。单次请求读取的会话字节上限为 8 MiB，超出时 `truncated` 为 true。`files` 列出本次涉及的会话文件名，便于人去磁盘上核对原文。

`task.usage` 是同一个 agent 的**用量**只读视图，读的还是那批会话文件，但不投影步骤、不做正文截断，所以详情面板每次刷新都可以取它。返回 `{task_id, files, model, thinking_level, requests, context_tokens, compacted, last_at, totals, truncated}`：`model` 是最近一次请求的 `{provider, model_id}`（模型中途被换掉时显示最后真正用到的），`requests` 是 assistant 回合并（＝模型请求次数），`context_tokens` 是**最近一次**请求的 `totalTokens`（＝输入 + 缓存读 + 缓存写 + 输出），也就是那一刻上下文里真的有多少 token；`totals` 是全部会话文件累计的 `{input, output, cache_read, cache_write, reasoning, tokens, cost}`，其中 `cost` 是 pi 按模型单价算出的每次请求花费之和。`compacted` 是上下文压缩次数，`last_at` 是最近一次带用量的请求时间，读取预算同样为 8 MiB（超出时 `truncated`）。没有会话文件时返回各项为零/空的统计，不报错。它不写库、不改工作区，也不进入 Git 串行队列。
