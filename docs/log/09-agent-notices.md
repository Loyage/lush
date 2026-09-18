# 09 · Notice：task 向用户汇报并等待答复的渠道

> 到这一轮为止，task 解决不了的事只有两条出路：向下游 `task_spawn`，或者放弃并把失败写进 result。缺少的是第三条——**找用户**。一个 task 的 agent 可能卡在只有人能决定的分叉上（选方案、批准破坏性操作），也可能刚做完一件用户必须知道的结果。这一轮加上 notice：agent 通过它上报「谁在汇报、汇报什么、需要填什么」，默认阻塞等人回答，用户的答复作为工具调用的结果回到 agent 手里。

## Done

- [x] **数据模型：`notices` 表（schema v6）**。一条 notice 记录汇报者身份（`sid` + `task_id`）、`kind`（`report` / `decision` / `blocked`）、`title` / `body`、声明给用户填的 `fields`（JSON）、是否阻塞（`wait`），以及用户侧的结果：`status`（`open` → `answered` / `dismissed`）、`answer`（JSON）、`note`（忽略原因）。`PRAGMA user_version` 从 5 升到 6；`MIGRATION_V6` 只新建一张表，老 home 走一遍 DDL 即可，不需要重建任何既有表。持久化分层按既有约定拆为 `persistence/repository_notices.js`（SQL）与 `persistence/repository/notices.js`（方法组），并入 `Repository`。

- [x] **Core 规则：`src/core/notices.js`**。`post` 从 task 读 `sid`（汇报者身份由 task 派生，调用方不能伪造）；`fields` 逐项校验并规范化（name 必须是 `[A-Za-z_][A-Za-z0-9_]*`、type ∈ text / textarea / choice / boolean、choice 必须有非空 options、default 按 type 校验）；`answer` 严格对着声明的表单校验：必填不能空、choice 必须命中 options、boolean 接受 `true`/`false`（CLI 的 `--set` 都是字符串）、未声明的字段被拒绝；没有声明表单时接受任意标量对象的自由文本答复。可选字段的 `default` 在答复时补齐，reporter 看到的 key 集合稳定。

- [x] **等待与唤醒：内存 waiter**。`notice` 工具默认把上报的 task 置为 `waiting` 并暂停调用超时（和 `task_wait` 完全一致，`runtime.pauseTimer` / `resumeTimer`），`waitForNotice` 挂进 `ServiceManager.noticeWaiters`；用户 `answer` / `dismiss` 都会唤醒它，把 `{ status, answer }` 作为工具结果交回 agent。`wait: false` 只登记、立即返回。任务终态时（`failed` / `cancelled`）`core/tasks/rules.js` 的 `finish` 会调 `terminateNotices` 把未决 notice 记为 `dismissed`（note 写明是哪个 task、什么状态），既清掉了没人能回答的悬空项，也顺带唤醒了停在那条 notice 上的 agent；`completed` 的 task 的 notice 保留，因为那是留给人读的结果。notice 不做超时，只能人工处理。

- [x] **RPC 与 CLI**。新增 `notice.list` / `notice.inspect` / `notice.answer` / `notice.dismiss`（`core/dispatch.js` 的 `PARAMS`、`rpc/protocol.js` 的 `NOTICE_METHODS`），`system.status` 增加 `notices_open`。CLI 新增顶层命令组 `notice`（`src/cli/tree/notice.js`，`list` / `show` / `answer` / `dismiss`），`answer` 支持可重复的 `--set K=V`、自由文本 `--text`、整对象 `--answer JSON` 三种写法（互斥校验在 `check` 里，参数在结果里组好、内部键删干净）；文本渲染在 `src/cli/format/notice.js`，逐字段打印 `name <type>`、options、必填与默认值，并给出下一条该敲的命令。

- [x] **Agent 工具与提示词**。`TOOL_DEFINITIONS` 新增 `notice`（JSON schema 里带完整的 field 定义：name / label / type / required / options / default），`AgentTools.notice` 走上面那套阻塞语义；`src/agent/guide.js` 的共享规则、tools howto 与 CLI howto 都补上 notice 的使用时机（无法处理 / 需要决策 / 交付结果）与「`wait=false` 只登记」的区别。

- [x] **Web UI**。侧边栏新增第三个标签「Notice」（带未处理条数 badge），可按状态筛选；`ui/client.js` 增加 `noticeList` / `noticeInspect` / `answerNotice` / `dismissNotice` 具名工作流，HTTP adapter 增加 `GET /api/notices`、`GET /api/notices/:id`、`POST /api/notices/:id/answer`、`POST /api/notices/:id/dismiss`（沿用 `taskListQuery` 那套严格 query / body 解码）；页面用声明的 fields 动态生成表单（text / textarea / choice / boolean），`open` 的才能填，已结算的只读展示 answer 或忽略原因。表单只在 notice 的 `id:status:answered_at` 变化时重建，2.5 秒轮询不会擦掉正在输入的内容。

- [x] **删除语义与状态一致性**：硬删一个 service 时它的 notice 一并删除（`sid` 是 NOT NULL 外键，notice 属于上报它的节点）；`task delete` 保留 notice 但把 `task_id` 置 NULL（和 agent_calls / messages 一样），列表里回落成只显示 service。

- [x] **验收**：`bun test` 165 项通过（新增 `test/notices.test.js` 15 条：表单与答复校验、阻塞与唤醒、`wait=false`、取消上报者时忽略未决项、列表过滤与排序、跨 task 等待被拒、删除语义、RPC 四个方法、Web 四个路由与错误码、CLI 声明与工具 schema；`test/core.test.js` 的迁移用例改为断言 v6）。另用真 daemon 手工验证：`lush call 0 '/tool notice {...}' --detach` 后 `lush notice list` 显示 `[decision/open] · 阻塞中`、`task result` 报 `waiting`，`notice answer 1 --set plan=C` 以退出码 2 引述 `not one of A, B`，`--set plan=A` 后 task 立即 `completed` 且 result 带上 answer；`lush-web` 的列表 / 详情 / 忽略（`--noproxy` 绕过本机代理）与 `?bogus=1` → 400 均符合预期。

## 备注

- 这一轮改了 `src/agent/guide.js`、`src/cli/tree/*`、`templates/**` 之外的 schema 与运行期代码，所以 fingerprint 会变；改完照例 `just daemon-restart`。
- notice 不做超时是刻意的：需要人做的事不该被机器超时掉。未决 notice 会一直 `open`（并计入 `notices_open`），要收场就 `answer` / `dismiss`，或取消上报它的 task。
