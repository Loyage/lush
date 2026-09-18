# 11 · task 收件箱：父子持续通话，阻塞移到 task 层

> 到上一轮为止，父子之间只有一次性的 `goal` 和终态时的 `result`，而且 agent 用 `task_wait` **在工具调用里阻塞**——阻塞发生在 agent 内部，等待期间它既不能收新信息，也无法被别的输入唤醒。这一轮把「等待」搬到 task 层：新增持久收件箱 `task_inbox`，父子消息与「子 task 已结算」都进同一个队列，只在两次 invocation 之间交给 agent；`task_wait` 作为 agent 工具被删除。

## Done

- [x] **按语义定下的四条规则**：消息只走 task 树的**直接父子边**（与「只能向下游、直接子 service」同一条边界，不会成环）；**只保留一个 task 层阻塞点**（agent 工具里不再有等待原语）；生命周期仍是**一次性**（本轮结束、队列空、无活动子 task → 自动完成）；队列里的输入**合成一条 `role: user` 消息**（延续 `continuationPrompt` 的形态）。

- [x] **数据模型：`task_inbox` 表（schema v7）**。一行输入：`to_task_id` / `from_task_id`（可为空）/ `kind`（`message` 或 `child_settled`）/ `body` / `data`（JSON）/ `created_at` / `delivered_at`（NULL = 还没交给 agent）。`MIGRATION_V7` 只建表 + 盖章；持久化分层按约定拆成 `persistence/repository_task_inbox.js`（SQL）与 `persistence/repository/inbox.js`（方法组）。删 task 时两个方向的 inbox 行一起删（`deleteTaskRows` → `deleteTaskInbox`），因为行以 task 为两端锚点。

- [x] **Core 规则：`core/tasks/messages.js`**。`send` 校验「直接父 / 子」与「接收方未终态」，写行、记 `task_received` 类事件，并 `resumeTask`；`notifyChildSettled` 由 task 层在终态时调用，把子的 `status / result / error` 写进父的收件箱；`take` 取未读并标记已投递；`inputPrompt` 把一批行合成下一条 user 消息（`[Lush] 你有新的输入：…`，带发送者身份与子结算结果）。`core/tasks/internal.js` 的 `wake` 收窄到「用户侧 `task.wait` 的 waiter」，父被唤醒改走 inbox。

- [x] **runtime 改由 task 层驱动（`agent/runtime/task.js`）**。每次 invocation 结束后按序判断：`takeTaskInput` 有未读 → 合成 prompt 继续 invoke；无未读但有活动子 task → 置 `waiting`、`await waitForTaskInput`（注册后再复查，避免投递与 park 竞态）；都没 → 本次回答就是 result。`waitForTaskInput` / `resumeTask` 在 `service_manager/inbox.js`，用 `resumeWaiters`（`ServiceManager` 里替换掉原来的 `childWaiters`）。task 被取消/失败时 `finish` 会 `resumeTask` 自己，避免 park 的循环泄漏。

- [x] **agent 工具与提示词**。删除 `task_wait`，新增 `task_message`（`task_id` + `body`）；`task_complete` 在**工具层**增加「有未读消息就拒绝」的守卫（Core 的 `complete` 保持宽松，人手补完成不会被一条没人读的报告卡住）；`task_spawn` / `task_complete` 的说明同步。`src/agent/guide.js` 的共享规则、tools howto、cli howto 全部改写：不再教 agent 在工具里等，而是「结束本轮，task 会 park，有输入时以 user 消息唤醒」+ `task_message` 的用法。

- [x] **CLI / RPC**。RPC 新增 `task.message`（from/to/body）与 `task.inbox`（task_id, after, limit），`task.inspect` 增加 `recent_inbox`（最近 10 条，新的在前）；CLI 新增 `lush task message TASK_ID --body TEXT [--from TASK_ID]`（`--from` 缺省 `$LUSH_TASK_ID`，与 `notice post` 同一套约定）与 `lush task inbox TASK_ID`，文本渲染在 `formatTaskInbox` / `formatTaskMessage`，`task inspect` 多一段 inbox。Justfile 增加 `just task-message` / `just inbox`。用户侧的 `lush task wait` / `lush call` 仍是 CLI 阻塞（那是用户在看结果，不是 agent）。

- [x] **模板**：`lush-root` / `project-manager` / `project` / `dev-task` / `worktree-service` 里所有「派活后 `lush task wait` 拿结果」改成「结束本轮，子 task 结算时被唤醒并拿到结果」，`project` / `dev-task` 补上「中途给还在跑的子 task 用 `lush task message` 追加约束」。

- [x] **验收**：`bun test` 174 项通过（新增 `test/inbox.test.js` 8 条：入队/投递/已投递、非直接父子与自投被拒、终态接收被拒、空正文被拒、park→投递唤醒、消息在 invocation 中途到达时**不打断**而在下一次 invocation 被注入、子结算写进父收件箱、`task_complete` 因未读被拒、删 task 清空邮箱、CLI 声明与文本渲染、RPC 往返；`core.test.js` 的唤醒断言改为新的 `[Lush] 你有新的输入` 文本，迁移用例改断言 v7）。真 daemon 手工验证：`lush call 0 '把这活派给下游' --detach` 后 `lush task inbox 1` 显示 `child_settled task#2 · completed · 已投递`，`lush task message 1 --body hi`（缺 `--from`）以退出码 2 报用法、给已终态 task 发消息报 -32010、发给自己报 -32010。

## 备注

- 这一轮改了运行期、guide、CLI 声明树与模板 prompt，fingerprint 会变 → `just daemon-restart`。
- **已知边界**：`waiting` 只由「有活动子 task 或收到输入」触发。一个既没有子 task、也没有未读输入的任务会直接完成——所以「子 task 主动向父 task 提问并**原地等回信**」不成立（要等回信就保持一个未结束的子 task，或用面向用户的 `notice`）。也不做超时，靠 `task cancel` / `LUSH_TASK_CALLS` 上限兜底。
- `LUSH_TASK_CALLS`（默认 12）现在同时约束「首次 + 每次唤醒」；如果要做长对话，下一步应把它做成可配置或只对非消息唤醒计数。
- Web UI 还没有 inbox 面板；目前用 `lush task inbox` / `task inspect` 的 `recent_inbox` 看。
