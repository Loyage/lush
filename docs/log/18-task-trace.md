# 18 · task 调用链：把一次协作排成一条时间线（task.trace）

> `task.tree` 看结构、`task.inbox` 只看入边；这一轮补上第三个视角——一个 task **整棵子树**里“谁在什么时候对谁做了什么”：派活（`task_construct`）、双向消息（`task_message`）、子结算报告。它是 `task_inbox` + `task_events.delegated` 的**派生**读模型（没有新表、没有新写入路径），并一次做进 Core / RPC / CLI / Web UI / 文档。

## Done

- [x] **先把语义定死（三个候选，取第一个）**：① 子树时间线（选中 task 的整棵子树，且“任一端在子树内”的 inbox 行都算）；② 只看这个 task 的出边；③ 只看它与直接父 / 子的双向通话记录。取 ① 的理由：只按接收方过滤会**恰好丢掉唯一的出边界外**——一个中间 task 发给它父 task 的消息——而它正是“这个 task 干了什么”的一部分；对根 task 来说 ① 就是“这活怎么协作做完的”。**命名**刻意避开 `call`：`agent_calls`（一次 invocation）与 `lush call`（建根 task）已经占了“调用”，wire 名用 `task.trace`，中文文档里才叫调用链。

- [x] **持久层：`task_inbox` 的 outbound 侧索引（schema v8）**。v7 建表时只有 `task_inbox_to(to_task_id, id)`，而调用链的第一件事就是问“这个 task 发出了什么”（`from_task_id`）——不补索引就是每次全表扫。`SCHEMA` 加 `task_inbox_from(from_task_id, id)` 并把版本盖到 8；`MIGRATION_V8` 只建索引 + 盖章；`connection.js` 的版本白名单扩到 8、迁移阶梯加一格（那串手写条件最易漏改，是最容易静默出错的一步）。新增两个仓储读法：`subtreeTaskMessages` / `countSubtreeTaskMessages`（两端任一端命中，OR 而非只看接收方）与 `subtreeDelegations` / `countSubtreeDelegations`（`kind='delegated' AND task_id IN (...)`）。

- [x] **Core 读模型 `core/tasks/trace.js`**。`trace(manager, taskId, limit = 200)`：取子树 ids → 两个来源各取**最新 limit 行** → 每个来源**各自反转成升序**（否则同毫秒内 stable sort 会把 id DESC 原样留下，链会倒着读）→ 合并 → 按 `(created_at, kind rank)` 稳定排序（同一毫秒里 delegated < message < child_settled，读起来才合因果）→ `slice(-limit)`。每条 entry 统一形状：`at / kind / from_task_id / from_sid / from_service / to_task_id / to_sid / to_service / delivered_at / body / goal / status / result / error`。service 名由一个 resolver 惰性缓存（父 task 会出现在子树每一步里，而出边端点可能在子树外），名字来自一次 `service list`，所以 sid 被删也不会把整个读抛掉；`delegated` 的 sid 取自事件自身，子 task 被删后这一步仍能显示成 `#5 grand[4]`。返回 `{ task_id, entries, total, truncated }`。

  手工验收时在这里挑出一个不对称：委派写在**父** task 的 `delegated` 事件上，所以只查 `task_id IN subtree` 会漏掉「子树根那次被委派」（`just trace 9` 少了一步，而 `#9 → #8` 的消息却在），与消息那边的「任一端」规则不一致。补法是 `delegationOf(parent, child)`（`task_events_task` 索引先圈出父的行，再用 `json_extract(data,'$.task_id')` 过滤）：子树根是唯一可能有子树外父 task 的节点，所以一次查找就够了，且它必然是链上最早的一步。`total` 同步 +1。

- [x] **RPC / CLI**。RPC 新增 `task.trace`（`task_id`, `limit?`，`dispatch.js` 的 `PARAMS` + `protocol.js` 的 `TASK_METHODS` + `service_manager/inbox.js` 的 `taskTrace`），`limit` 交给 Core 校验（1..1000，越界 -32602）。CLI 新增 `lush task trace TASK_ID [--limit N]`（`cli/tree/task.js`），文本渲染 `formatTaskTrace` 在 `cli/format/service/tasks.js`：先给一行 `task #N · 调用链 M 步（共 T 步，只显示最近的 M 步）`，随后一行一步 `时间  kind  #from service[sid] → #to service[sid]  goal/正文/结果`，未读输入带 `(未读)`。Justfile 加 `just trace TASK_ID`。

- [x] **Web UI 的 task 页**。HTTP adapter 新增 `GET /api/tasks/:id/trace`（严格解码：只接受 `limit`，默认 200；未知 / 重复参数 400，不存在的 task 走既有的 -32004 → 404 映射）；`UIClient` 加具名工作流 `taskTrace(taskId, { limit })` 与严格解码器 `taskTraceQuery(search)`。任务页在详情卡与「Task 树」之间插入可折叠的**调用链**区块（`open` 默认展开）：一行一步给时间（完整时间戳在 title 里）、kind 徽标、`#from service[sid] → #to service[sid]`、以及 goal / 正文 / 结果；**两个端点的 `#id` 都是按钮**，复用已有的 `selectTask(id)` 直接跳过去；截断时顶部写明总步数。刷新沿用 2.5 秒轮询，但用**整个 payload 当 signature**——一条消息从“未读”变“已投递”时步数不变，只看数量会永远显示旧状态（和服务视图同一套做法）。

- [x] **验收**：`bun test` 184 项通过（新增 5 条：`inbox.test.js` 的 `task trace (调用链)` 四条——子树时间线（含“另一棵树的流量不在里面”“发给父 task 的出边在里面”“子树根那次被委派也在里面”）、只保留最近 N 步并报 total / truncated、`limit` 越界与不存在的 task 被拒、删除子 task 后 delegated 步骤仍在而它发出的结算消失、CLI 声明与文本渲染；以及 RPC 往返；`web.test.js` 的 `task.trace` 工作流 / `taskTraceQuery` 解码 / `GET /api/tasks/:id/trace` 的真实 HTTP 形状与 400 / 404）。`core.test.js` 的迁移断言从 v7 改为 v8。

## 备注

- **它是派生视图，删除即消失**：不改 `deleteTaskRows` 的保留策略。`task delete` 删该 task 的事件、删两个方向的 inbox 行、把子 task 改成根；父 task 上的 `delegated` 事件会活下来（所以链上会留一步指向已删 task 的派活），但被删子 task 发出的 `child_settled` 会消失。这一条写进了 `concepts/service-model.md` 与 `rpc.md`：调用链是运行期观察视图，不是审计日志。
- **已知边界**：读法是 limit-only 的尾部（取最近 N 步，不分页游标）。链很长时看到的是结尾而不是开头——这是为运行中观察做的选择，`total` / `truncated` 已把代价说明白。另一个边界：从 v1 迁移上来的历史 task 只有 messages、没有 `delegated` 事件（那之前还没有 task 层），所以老数据的链缺派活步骤。
- 这一轮改了 `cli/tree/*.js`（fingerprint）与 `src/core`、`persistence`、`ui`：**要 `just daemon-restart`**，且 schema 升到 v8——旧 daemon 打不开新 home，先用新版把 daemon 重启掉。
