# 22 · Intension：用户输入从「在任意 service 上开根 task」收口成一条被解析的输入

> 目标：改掉 **task 的引入机制**。此前用户输入就是 `lush call SID GOAL`——它在**任意** service 上开一个根 task，于是「谁来判断这句话该去哪、和现在开着的活冲不冲突」这件事没有地方承载：每个节点只能自己看着办，冲突表现为一句难懂的拒绝（`service X is already working on task N`），用户的需求就此消失。
>
> 本轮把**用户输入**做成一等记录 **intension**（原话 + 可选的指定 service + 处理到哪一步），入口收口到顶层：只有 intension 队列能创建根 task，解析发生在 SID 0 上，串行、可观察、冲突变成给用户的问题。

## 先说清四条约束（决定了形状）

- **需要一个全局视野的判断者，且只有一个**。判断「这条输入该给谁、会不会撞上已开的活」需要看到整个模板树与服务树——只有 SID 0 是这种节点（它也是唯一在每次启动时从加载的模板刷新自己 prompt 的节点）。所以解析器就是 SID 0 本体，不新开节点。
- **串行必须是白送的**，不能新造一把锁。已有规则是「一个 service 同时只有一个活动 task」；把解析 task 挂在 SID 0 上，串行就是它的推论——队列不需要额外的调度器。
- **agent 之间的委托（`task_construct`）不能动**。那是 task 树唯一的生长方式；收口只针对"用户输入"这条路。
- **用户说的话不能丢**。解析会失败（模型、超时、重启、被人 kill），所以解析 task 的死必须变成"这条输入回到队列重试"，而不是"这条输入没了"。

## Done

- [x] **数据模型（schema v10）**：新增 `intensions` 表（`content` 逐字、可空的 `sid`、`source`、`status`、`parse_task_id`、`blocked_by_task_id`、`attempts`、`resolution`、`response`、时间戳；`status` CHECK 为 `queued / parsing / awaiting / settled / rejected`），并给 `notices` 加 `intension_id`（冲突裁决的问与答能回溯到那条输入）。`MIGRATION_V10` 只做三件事：建表、加列（SQLite 能原地 `ALTER TABLE ... ADD COLUMN`，不用像 v9 那样重建）、建索引；`SCHEMA` 与 `PRAGMA user_version` 同步到 10，`connection.js` 接上 `migrateV10`。
- [x] **持久化层**：`persistence/repository_intensions.js` 持有语句与行解码（含 `nextQueuedIntension`：最老的一条 `queued`，且它的 `blocked_by_task_id` 为空或已终态——这就是"排队等某个 task 结束"落地的地方），经 `persistence/repository/intensions.js` 挂到 `Repository`；`listNotices` 增加 `intensionId` 过滤；`deleteTaskRows` / `deleteRows` / `recover` 三处把外键收干净——删 task 时清掉指向它的两个指针（清 blocker 会让那条输入重新可解析，正是"等的东西没了"的正确行为），删 service 时把目标 SID 置空并把解析中的行放回队列，daemon 重启时把遗留的 `parsing` / `awaiting` 行放回队列。
- [x] **core 层（`core/intensions.js`）**：`submit`（校验 + 落行 + 推队列）、`drain`（**Lush 里唯一创建根 task 的地方**：SID 0 空着就把最老的一条交给它，`start: false` 建 task → 关联行 → 启动，避免 agent 看到"没人解析的自己的输入"）、`settle` / `defer` / `withdraw`、`afterTaskSettled`（parse task 终态时释放行 + 推进队列）、`attachNotice`（解析 task 上报的 notice 自动带上 `intension_id`，`wait` 的把它一起停在 `awaiting`）、`context`（派生读模型：这条输入 + `precheck` 机械体检 + 当前模板树 + 服务树与各自活动 task + 队列 + 未决 notice）、`waitForIntension`（`intent.wait`）。规则写在这一个文件里，RPC / CLI / 工具的签名在上一层。
- [x] **根 task 收口（硬约束，不是提示词）**：`core/tasks/rules.js` 的 `construct` 在 `parentTaskId === null` 时要求带 `intensionId` 且 `sid` 必须是解析节点；直接造根 task 的内部入口 `constructRoot` 单独一个函数并注明"只给测试与内嵌"。`task.construct` / CLI 的 `lush task construct` 于是**必须**有父 task（`$LUSH_TASK_ID` 或 `--parent-task-id`），缺了报用法错误并指向 `lush intent submit`。
- [x] **解析器的答案就是输入的结论**：`finish()` 是 task 层唯一的终态收尾，这里顺手处置 intension——`completed` 时把 task 的 result 记成 `response`（`resolution.task_ids` 由解析 task 的直接子 task 派生，解析器不用自己报），失败 / 取消时放回队列，`attempts` 到 3 才 `rejected`。解析器早期只 settle 了个空结论、收尾时才说话的，收尾的答案会**补进**空的 `response`（只补空，绝不覆盖已记录的结论）。
- [x] **RPC**：新方法 `intent.submit`（`content`，可选 `sid` / `source` / `wait` / `interactive`）/ `intent.list` / `intent.inspect` / `intent.context` / `intent.settle` / `intent.defer` / `intent.withdraw` / `intent.wait`；删掉 `call` 与 `call.describe`（用户不再直接建根 task，dry-run 随之消失）。`call.end` / `call.os_pid` 保留——它们服务的是**交互式交接**，只是入口从 `call` 变成 `intent submit --interactive`。`system.status` 增加 `intensions_open`。
- [x] **交互式交接换入口**：`--interactive` 的含义从"在某节点上开一个 task 交给终端"变成"**这条输入由我亲自解析**"：daemon 记下输入、在 SID 0 上建解析 task 但**不启动**，返回不带 `--print` 的交互式 argv；`interactiveSupport(sid)` 先检查这个节点能不能交接，所以内置运行时（mock / openai）会**在创建 task 之前**报错，不留半截 task。终端报成功时先走 `intensionHandedOver` 关掉那条输入——**人报的成功是结论，不是 agent 的沉默**，否则"没安排任何东西也没说话"的启发式会把这条输入重新排进队列，在人的背后再解析一遍。
- [x] **CLI**：新增 `intent` 命令组（submit / list / show / context / settle / defer / withdraw / wait），删掉顶层 `call`。解析器自己那条路是重点：`lush intent settle --status settled --response '…'` 可以**不带 id**（用 `$LUSH_TASK_ID` 找到它正在解析的那条）——`parse` 在选项还在 `args` 里的时候跑，所以可选的位置参数必须在遇到 `-` 时停下（`positionalId`），否则第一个选项会被当成 id 吃掉。`lush intent submit` 在 agent 环境里（`$LUSH_TASK_ID` 存在）直接拒绝：向上找人用 notice，向下派活用 task construct。`scripts/ops.js` + `package.json` 的 `call` / `enter` / `detach` 换成 `intent` / `intent-now` / `intent-enter` / `intents` / `intent-show` / `intent-context`。
- [x] **agent 工具**：`intent_context` / `intent_settle` / `intent_defer` 三条（只在解析 task 上有意义，其他 task 调用会明确报"没在解析任何输入"）。
- [x] **提示词**：`templates/lush-root/system_prompt.md` 从"入口 / 路由器"重写成**解析协议**（读 `intent_context` → 定目标 → 判冲突（机械的撞守卫报错、语义的读架构）→ 安排或问用户 → settle / defer / reject），`templates/lush-root.json` 的 description 同步；`src/agent/guide.js` 的 COMMON / 通用规则 / tools howto / CLI howto 都补上 intension 这一层（含"用户输入不由你提交"与"解析一条输入时你欠它一个结论"）。
- [x] **Web UI**：新增「输入」视图（队列 + 详情：原话 / 目标 / 解析 task / resolution / response / 相关 notice / 撤回），服务视图的「创建 Task」表单改成「说点什么」（目标 Service 变成可选提示，不再禁用提交），`POST /api/intents` 等四个路由与 `UIClient` 的具名工作流同步。
- [x] **文档**：新增 `docs/concepts/intensions.md`（入口的完整模型：串行、冲突两层、状态与不变量），`docs/concepts/service-model.md`、`docs/reference/{cli,rpc,ui,agents}.md`、`docs/engineering/architecture.md`、`docs/README.md`、`README.md`、`AGENTS.md` 全部改到新入口（`docs/log/` 的历史条目按约定不改）。
- [x] **验收**：`bun test` **207 项通过**。新增 `test/intension.test.js`（15 条：原话逐字进 goal、队列串行与 `awaiting` 阻塞、arranged 由子 task 派生、拒绝且终态不可改、defer 到 blocker 结算后重跑第二遍、解析 task 全灭时 `attempts` 到 3 才 rejected、queued 才能撤回、`intent.context` 的事实与 `precheck`、SID 不存在是用法错误而重复提交是给解析器的事实、根 task 只能由派发器创建、早期空结论被收尾答案补上、解析 task 之外的 settle/context 被拒，以及 CLI 那三条只带选项的调用形状）；迁移用例扩到 v10（v8 老 home 造出 `intensions` 表与 `notices.intension_id`，行与索引都在、状态 CHECK 与两条外键都被真正执行）；`cli.test.js` / `rpc.test.js` / `web.test.js` 的全部入口改走 intension。另用**真 daemon + 真 pi**（`bun run`）手工跑通：`bun run intent '你好'` → 解析 task 在 SID 0 上读 `intent context`、回答、settle（`intent show` 看得到结论）；`bun run intent '把 SID 0 的模板权限改宽一点' 0` → 解析器判断这是对 Lush 仓库的改动、委派给 project-manager（`_resolution.task_ids=[18]`）、并在 project → dev-task → worktree-service 上真的开了工（验证完即 `task cancel` 并清掉那个 worktree）；`--interactive` 在内置运行时下于建 task 前报错。

## 备注

- 改了 schema、`src/agent/guide.js`、`src/cli/tree/*`、`templates/**` 与运行期代码 → fingerprint 会变；照例 `bun run daemon-restart`。老 home 走 v10 迁移（只建表加列，不重建任何表），迁移前建议先备份 `$LUSH_HOME/lush.db`。
- **队列是串行的，所以一条输入停在你身上会挡住后面所有输入**。这是设计（用户要的就是串行），但意味着解析器不该把"等人"带进自己的 task：能派就派、该问就问、问完就停。`lush intent list --open` 一眼能看出卡在哪一条，`lush intent withdraw` 是队列的逃生门。
- `lush call` 与 `call.describe` 从 CLI / RPC 消失，但 `manager.callRoot` / `manager.callDescribe` 作为**内部 API** 保留（测试与内嵌调用用，不进声明树、不进 `PARAMS`）。`Service.call(goal)` 换成 `Service.say(content)`（提交一条 intension）。
- 手工 `lush service construct` / `stop` 仍然是用户命令：它调整**架构**，不引入工作。解析器因此可以假设"架构是有人管的"，自己只负责把输入变成工作。
- 冲突判断只有机械的那一半是硬保证（守卫会报错）；语义那一半靠解析器读 `intent.context`，所以那份读模型刻意把"事实"给全（模板树、服务树、活动 task、队列、未决 notice），而不是给一份摘要——人和解析器读同一份，事后可复核。
