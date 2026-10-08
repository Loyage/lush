# 模块地图（并行开发的边界）

这份文件是**拆分的契约**：`src/` 与 `test/` 里每个文件的职责与导出签名。目标只有一个——
让两个并行 worker 尽量去改不同的文件。粒度细到这个程度不是审美，是为了让「谁动哪个文件」可预测。

改名、搬家、换签名都先改这里，再改代码。

## 设计方向与执行记录接缝

修改模块前必须阅读[模块设计理念](../design/README.md)中的对应主题；执行记录相关改动先读[Agent 执行过程](../design/agent-process.md)，引用、选区引用与引用卡片定位相关改动先读[上下文引用与定位](../design/references.md)。

公开面以[核心 API 收敛](core-api.md)与 `src/rpc/registry.js` 为唯一白名单。本节下面提到的 `explanation.*` / `intro.*` 历史实现已经没有公开入口（注册表里不存在），保留在源码中只为读懂旧记录与后续清理；当前可用的执行记录接口只有 `worker.transcript*`。

执行记录增量接口（具体约束见[阅读器](transcript-reader.md)）：
- 用户只读 `worker.transcript_page(id,seq?,offset?)` / `GET /api/worker/<id>/transcript-page`，从 `(seq,offset)` 连续读取未裁剪的步骤文字；每页最多 50 段、96,000 字符正文，单段最多 24,000 字符，返回 `next_seq/next_offset/has_more`。兼容只读接口保留，不启动 Pi 或 PTY，不执行终端控制序列；Web 使用全屏富文本详情与分段步骤原文，不再提供终端模式。
- `worker.transcript` 是主读面：步骤增量保留 `call_id` / `tool_name` / `is_error`；同一会话内按调用 ID 配对。
- 用户只读 `worker.transcript_latest(id,after?,before?,limit?)` / `GET /api/worker/<id>/transcript-latest`：对 Worker 全部会话做一次完整流式扫描，返回满足 `seq > after` 且 `seq < before`（默认 0 / 0 表示不设边界）的最新 `limit`（1..200，默认 100）步，按 `seq` 升序；每步的 4,000 字符裁剪与 `exact` / `batch` token 口径与 `worker.transcript` 完全一致。返回 `next` / `oldest` / `has_older` 供 `before` 往回翻页，`truncated` 在单行超 16 MiB 时置真而不冒充空结果。
- 用户只读 `worker.transcript_search(id,query?,kind?,tool?,errors?,after?,limit?)` 与 `worker.transcript_step(id,seq,offset?)`：前者跨完整 Worker 会话检索、分页摘要，后者按步骤读取分段原文及关联上下文；HTTP 用 `/api/worker/<id>/transcript-search`、`transcript-step`。
- 终端跟随不新增 RPC：`lush worker transcript ID [--after N] --follow` 先按 `worker.transcript` 分页打印已有记录，再用 `worker.transcript_latest` 以游标轮询新步骤，直到 Ctrl-C；仅用户可运行，`--json` 不适用。

## 工作台改造接缝

用户已确认：仅保留 Web UI，启动直接进入主体，每项目独立浏览器标签，关闭页面后后台继续；服务器部署与网络访问由用户管理，Lush 不管理 SSH 或远端产物。修改启动、环境与项目入口前阅读[工作台设计](../design/workbench.md)；文件分工与新增接口以[工作台接入契约](workbench.md)为准。该接缝优先于旧项目闸门描述；逐步交付不得宣称尚未验收能力。

## 设备共享设置接缝

用户 W116 / 待决 #261 确认同设备同系统用户共享设置，项目/Worker 可覆盖；当前项目作为显式首次迁移来源，成功后源项目改为继承，其他旧项目保留覆盖，新项目直接继承。范围内以[设备共享设置理念](../design/device-settings.md)与[工程契约](device-settings.md)为准，优先于下文旧的全项目私有设置描述。项目 home、DB、Worker、历史、Git 与调度绑定不变，不引入跨项目调度。

父分区负责 `src/core/device-config.js`（作用域/私有根/跨进程锁）、Host 独立设置服务、RPC/HTTP/CLI 接入、Project 转发与组合测试；配置基础分区负责 Config、RuntimeSettings、AgentSettings、网络/env、快捷解释配置及 Pi 资源存储的继承；连接/迁移分区负责有效来源并集、实际根凭证锁、作用域管理器和 `src/core/device-migration.js`；前端分区负责 assets 的作用域编辑、继承/覆盖、迁移 UI 和无项目入口。详细签名与测试隔离以工程契约为准。

## 快捷解释接缝

用户决定 #203 恢复项目级选区阅读辅助，但不恢复旧公开 `intro.*` / `explanation.*` 或解释 Agent。新增 `quick_explain.*` 用户专属接口、独立 `#quick-explain` 设置/历史页，来源复用现有 Chat Completions API Key 连接；契约与并行分工见[快捷解释](quick-explanation.md)。新调用不创建 Worker，附属历史复用 introductions，追问轮次存于 explanation_followups 并随原解释一起删除；旧行不迁移或改写。该增补优先于下文历史服务无公开入口的描述（旧名字仍关闭）。

## 项目出站网络接缝

用户决定 #147：增加项目级出站网络设置，覆盖后台账号登录/刷新/查询与后续 Agent 子进程。网络代理与模型端点、入站 Host 代理分开；私有配置、安全投影、RPC/Web/CLI 接口、热更新/在途快照和并行文件分工见[项目出站网络代理](outbound-network.md)。新增共享模块 `src/agent/network.js`，现有模型凭证隔离与启动边界不变。

## 三条规矩

1. **入口路径不变。** `src/core/project.js`、`src/core/workspaces.js`、`src/persistence/store.js`、
   `src/rpc/protocol.js`、`src/ui/web/assets/app.js`、`src/cli/main.js` 仍是各自的入口，必须继续
   导出与今天完全相同的名字（`Project` / `Workspaces` / `Store` / `Dispatcher` / `main` / `HELP`…），
   所以 `src/index.js`、`bin/`、`test/helpers.js` 与现有测试都不必跟着改。实现细节住进同名目录。
2. **组装方式是 mixin，不是继承链。** 每个职责模块导出**一个方法对象**，方法体里照旧用 `this`；
   入口文件把它们的原型属性合并进来，并在合并时查重名（重名＝拆分出错，立刻抛错，不静默覆盖）。
   这样搬家只是剪切粘贴，方法体一行都不用改，`this.store` / `this.running` 照旧。
3. **一个分区只改自己分区里的文件。** 分区见下；跨分区要改的东西，先在 `docs/engineering/modules.md`
   里加一条接口，而不是直接伸手。

## 指令命名接缝

公开提交只使用 CLI `order` / RPC `order.submit` / `bun run order`，新 Worker 的 `task_kind='order'`。历史 `say` 仅在读/类型判定边界兼容，不迁移持久行、分支或工作区；Input / 历史输入 / 暂存名称不变。完整规则见[指令更名边界](core-api.md#指令更名与历史读取边界)。Runtime 主模块路径为 `project/order.js`（`order` / `sendOrder` / `resolveOrderDivergence`）；共享模块 `src/core/order-kind.js` 的纯函数 `normalizeOrderRecord(row)` 在 Store `get` / `all` 的只读行投影中统一历史类型，SQL 类型筛选仍兼容旧值；前端纯兼容模块为 `worker-kind.js`；浏览器发送只走 `order.submit`，类型标签统一为「指令」。

## Worker Hooks 实施接缝

用户决定 #197：以 Worker 挂载 Hook 统一预约和自动合并；项目模板集中在独立「自动化」页面（沿用 `#hooks`），首个可创建安全边界执行预约发射，自定义仅组合受控动作。[设计理念](../design/hooks.md)与[工程接口/并行职责](hooks.md)是本次实施权威接缝。Runtime、接口和前端分别遵循该契约；现有 auto_merge / reservation 保持兼容，不新增核心实体或 Host 调度。

### 通用命令 Hook 与 main 推送示例（W133 / 决定 #319）

用户明确选择通用命令而非专用推送动作，示例仅执行 `git push`，remote/认证由用户命令和 Git 配置决定。新增节点 `worker.merge_received`（成功合入所挂载父 Worker），动作 `command`（`{type,command}`，不调用 Agent）。默认关闭的持续示例在项目初始化时一次性保存为模板与 main 挂载；读取不安装，删除/停用后不自动重装。`hooks.list` 增加 `command_example:{template_id,worker_id,hook_id,hooks}`（无 main 时 null；已删除身份保留用于说明）。Worker 更新增加可选完整 `hook`，与 `enabled` 互斥：`updateTaskHook(id,hookId,enabled,expectedRevision,hook=null)`，保持原启停签名兼容。编辑保留原挂载身份，模板编辑不改变实例；复制产生新的停用配置。

命令在挂载 Worker 的真实工作目录以用户 daemon 身份运行，不是沙箱；有界超时、非交互输入、输出限制，不把凭证/原始输出写入公开读面。通过既有项目写门和 Workspaces 串行执行，复核冻结/同步/归档与真实 invocation；没有永久 Agent 凭证。领取和执行结果持久化，成功合并事件去重，连续合并不丢触发，未知副作用不自动重放。用户需在启用/挂载命令前看到明确的任意命令执行授权提示。

Runtime 子 Worker 负责 core Hooks、初始化、merge-queue、Workspaces 命令执行及 runtime 测试；UI 子 Worker 负责 hook-form/render-hooks/样式与 DOM 测试；父 W133 负责 RPC/HTTP 接缝、文档、集成测试及收口。默认示例命令与动作不是 Agent 入口，不染 Agent 紫色。

### 新指令结束后默认流程（W137 / 用户决定 #325）

自动化页面保存当前项目专属的 enabled 与最高默认环节，仅之后实际创建的新指令复制授权，已有 Worker、child 和管理 Worker 不变。`hooks.list.completion_defaults` 独立版本、用户专属 `hooks.completion_defaults` mutation；字段及 `Project.completionDefaults/setCompletionDefaults/newOrderCompletionConfig` 接缝见[自动链契约](completion-hooks.md#项目新指令默认值w137--用户决定-325)。Runtime 负责 completion/hooks/order 及项目测试，Web 负责 render-hooks/必要 assets 与 DOM，父负责 RPC/HTTP、文档及真实临时项目联调。

### 定时 Hooks（用户决定 #266）

在既有 Worker 附属 Hook 中增加 `time.scheduled`，一次性日期与每日显式时区；停机错过跳过，到点持久提交非阻塞待执行项，安全点尽早准入而非保证 Agent 准点开始。失败重试与暂停继续为显式受控动作，未知副作用不重放。定义、目录模式覆盖、pending/next 时间读面和失败 Worker 的窄挂载准入见 [Hooks 工程接缝](hooks.md#定时-hook-增补用户决定-266)。Runtime 负责 core/project 与纯时间模块和对应测试；前端负责 assets Hooks 编辑/读面与 DOM 测试；父维护文档与跨区接口/组合验证。无 Host 调度或新公开 RPC。

### 时间信号与管理 Agent（用户决定 #270）

自动化页面提供具名时间信号与独立管理指令，不改变开发输入框。管理 Worker 使用 `role='manager', task_kind='management'`、无 Input／Git 的专属目录、独立提示词及受限工具。只允许查询当前项目、开始 paused／重试 failed 的开发 Worker；Dispatcher 与 Project 双重核验 invocation、绑定、occurrence 和原安全门。信号、绑定、持久请求与读面权威契约见[时间信号与管理](hook-signals-management.md)，实际文件与导出在 Runtime／Web／接口分章。不是 Host 调度、OS 沙箱或额度恢复证明。

## daemon 自动选择 Hook 接缝（W118 / 决定 #267）

当前项目 daemon 的内置持续 Hook `auto-select`，触发 `notice.received`，不是 Worker 挂载或 Host 全局配置。默认关闭，项目 meta 持久保存；显式开启同时处理已有 open 的 `questionnaire` / `question`，不答复 plan/info，不重放 invocation。单选选择第一项（不依赖推荐标签）；多选每题自定义答复、文字问题答复均为「请由 Agent 自行判断并继续。」。自动答复仍走原问卷暂停/真实退出/收件箱唤醒安全边界，不能并发调用或丢唤醒。

- `hooks.list` 增加 `daemon_hooks:{version:1,revision,mounts:[{id:'auto-select',name,trigger:'notice.received',mode:'persistent',enabled,builtin:true,...}]}`；daemon revision 独立于模板 revision。`Project.daemonHooks()` 返回此对象，`Project.setDaemonAutoSelect(enabled,expectedRevision)` 保存开关、处理积压后返回完整 `hooksList()`。
- 用户专属 RPC `hooks.auto_select {enabled:boolean,expected_revision:string}`；Web POST action 同名；CLI `hooks auto-select on|off --revision REV` 使用 daemon revision，Agent 禁止设置。自动化页面展示 daemon 独立区、持久开关和费用说明，开启按钮带 agent-call / agentHelp。
- Notice 读面统一增加 `answer_source:'user'|'lush'|null`（历史 answered/dismissed 视为 user，未答 null）；自动来源同事务写入 Notice、`notice.answered` Event 和收件箱消息，消息不可让 Agent 误当成用户决断。页面历史/详情显示「Lush 自动选择」或「用户答复」。不得允许公开 answer 参数伪造来源。
- Runtime 子分区：core/project/auto-select.js（新增）、project.js 装配、project/hooks.js 目录读面、messages.js、questionnaire.js、persistence schema / notice-projection、test/project/auto-select.test.js 及必要调度测试。
- 接口子分区：rpc registry/handlers、cli hooks/help、Web server 路由及 API 测试；按上述方法/字段调用，不修改 runtime/assets。
- UI 子分区：assets/render-hooks.js、render-notices.js、render-questionnaire.js、必要样式与 DOM 测试；不改 runtime/接口。
- 父 Worker：设计/工程/使用文档、地图更新、集成及全量验证。

## Worker 用户编号接缝

用户决定 #190：保留整数内部身份，为升级后新建的指令 Worker 增加不可变、可空的 `tasks.worker_number`（如 `W5`）；Agent 在已编号父 Worker 下派生的 child 使用同父创建次序（`W5-1`、`W5-1-1`）。原始 Input 展示 `O<id>`，沿用项目现有 Input 序列，允许失败或删除留下空号；暂存与追加消息不占 O 编号。在已有指令分支上提交新的 O8 仍产生 W8，不使用父的 child 序号。历史 Worker 不回填，历史未编号父节点的新派生后代继续使用旧整数编号；main/owner 保留原标识。

- Runtime / Store 分区负责 nullable 列与唯一约束、事务内分配，以及按父整数 ID 保留的持久子序号高水位（删除、重启后不复用）。创建时固定编号，不从当前树或存活子节点数量重算；外键、权限、排序、分页、合并凭据、环境变量、分支/worktree/会话路径继续使用整数 ID。
- 读取完整 Worker 与摘要对象时携带 `worker_number:string|null`；Input 历史的关联字段为 `task_worker_number`、父候选为 `worker_number`；Notice 关联字段为 `task_worker_number`。关联 Worker 缺失时编号未知，不凭数字猜测。
- CLI 通过新增只读 `worker.lookup {number}` 得到 `{id,worker_number}`，将严格匹配的 `Wn(-n)*` 解析为整数后调用原接口；旧整数参数照常可用。原 RPC/HTTP 的 `id` 字段、链接和引用 target 不变；不能给通用 `id()` 增加字符串身份，不能将 `worker.artifact` 的产物 ID 当成 Worker 编号。
- Web / CLI 显示优先使用持久编号，没有编号时保留历史标识；新引用的标签可用新编号，但 target/location 仍保存整数，旧快照不回写。编号不是排序键，也不能据其推导真实父子权限或合并顺序。
- 用户决定 #278：新生成的用户报告、异常告知（标题与正文）、错误及相关 Worker 提示统一使用显式持久编号；历史未编号或关联缺失时回退 `#内部ID`，不得把整数 ID 加上 W 前缀或靠父子关系推算。Agent 内置提示遵守同一口径；已有报告、Notice 正文与原始日志不回写，机器身份、blocker key、信号和 Git 协议不改动。

报告关联读面：冻结信息、实际连接消费者与既有用量归因的关联字段为 `task_worker_number`；历史检验/解分歧列表为 `worker_number`，verifier 被检验目标为 `verifies_task_worker_number`，历史 Spec 关联为 `task_worker_number`。缺失关联返回 NULL，不恢复已退役 API。回归入口为 `test/project/worker-number-{reports,projections}.test.js`、`test/web/dom-worker-report-number.test.js`、`test/worker-number-cli.test.js` 与 `test/agent-worker-report-number.test.js`。

实现分工：编号校验、唯一约束与只读 `worker.lookup` 在 `src/core/worker-number.js` 与 `src/persistence/store/`、`src/rpc/`；CLI 解析与展示在 `src/cli/worker-number.js`；Web 展示接缝在 `src/ui/web/assets/worker-label.js` 与 `format.js`。字段与接口见 [Runtime 地图](modules-runtime.md) 与 [Web 前端](modules-web.md)。

## 选择快照已停用（W138）

用户要求暂停选择快照，待产品方向明确后再开发。新问卷不保存代码／上下文快照，RPC、CLI、HTTP 与 Web 不提供快照查看或重选。正常选择、答复、自动选择 Hook 和历史问卷回放不变。已有附属资源与已创建路线只保留历史恢复、调度和删除保护，不迁移或擅自清理；边界见[选择快照停用说明](choice-snapshots.md)。

## 当前公开面

Worker 更名中的公开入口与保留字段、事件、内部路径边界见[核心 API 收敛](core-api.md#worker-更名与兼容边界)。精简后的 RPC / CLI / Web 白名单以[核心 API 收敛](core-api.md)和 `src/rpc/registry.js` 为准：`system.*`、`agent.*`、`order.submit`、`worker.*`（含 `spawn` / `integrate` / `auto_merge` / `reserve` / `resolve*` / `unreserve` / `approve_merge` / `message` / `cancel` / `retry` / `interrupt` / `resume` / `configure` / `cleanup` 与只读读面）、`progress.*`、`notice.*`、`branch.tree/show/bind/archive`、`graph.get`。用户专属输入缓冲与检索另开放 `input.history/get/parents`、`draft.add/update/remove`，`order.submit` 支持带版本的单条草稿发射，见[历史输入接口](input-history.md)。CLI 只注册 `daemon` / `status` / `doctor` / `log` / `web*` / `order` / `worker` / `progress` / `notice` / `branch` / `agent` / `config`；其余命令模块（draft / intent / spec / plan / candidate / sleep）不再挂载，handlers 中未列入白名单的方法一律返回 `unknown method`。

以下仍是可调用的公共面：

- CLI 命令与 `lush help` 的语义。`lush config [show]` 打印运行设置的生效值 / 环境默认值 / 是否被覆盖与设置文件路径，`lush config set concurrency|control-concurrency|call-timeout|worker-call-limit|max-depth N` 写回，`lush config reset [concurrency|control-concurrency|call-timeout|worker-call-limit|max-depth|all]` 清除覆盖；`--json` 输出与 `system.status.settings` 同一份结构化读模型。两端都是用户专属，agent 调用被拒。命令面用连字符（`control-concurrency`），设置文件与 RPC 里是下划线（`control_concurrency`）。
- SQLite schema、表名、列名与 `meta.task_id_high` / `meta.input_id_high` / `meta.overview_revision` / `meta.worker_child_high:<parent_id>` 的行为。`tasks.worker_number` 是可空、不可改写的用户编号，只由创建事务分配并按部分唯一索引约束；子序号高水位存 `meta`，不随删除或 `purge` 清除。`overview_revision` 由读模型相关表的触发器单调推进，技术聚合表 `overview_task_counts` 由 Worker 触发器维护精确 layer/status 计数，首页用两者做 O(1) 失效与统计（它不是业务实体）。`tasks.progress_plan` 附属 JSON 保存 versioned 计划，读模型统一投影为 `progress`（有 `agent_runs` 时按调用区间重算工作用时，并把非 running 的等待投影成一条 `kind:'wait'` 条目；不改写存储的 `progress_plan`）。`agents` 之外的新核心表（`agent_runs` / `artifacts`）承载每次调用与结果；`artifacts.payload` 使用同一 JSON 文本列，`run.result` 是 version 2 envelope，分开记录 invocation 完成与 `pass` / `fail` / `partial` / `unverified` 验收结论；`pass` 必须没有 `failures` / `unverified`，但可以保留 `baseline_failures` / `residual_risks`；旧 payload 不重写，读取时缺失或自相矛盾的证据明确投影为 `unknown`。历史表（`inputs` / `drafts` / `task_specs` / `review_candidates` / `introductions`）与列（`branches.showcase_reservation` / `branches.merge_run` / `tasks.review_candidate_id` / `tasks.retry_profile`）只加不改、不重写已有行，其中仅 `inputs` / `drafts` 由当前指令与新缓冲区路径继续写入，其他历史链无新的公开写入口。
- `src/index.js` 的导出、`bin/*` 的行为。
- Web 路由与 asset 路径：`server.js` 只按 basename 服务 `assets/` 下的 `.js` / `.css`，
  所以**新增前端模块不需要改 server.js**。带 `--project` 的单项目 Web 继续用无前缀的 `/api/**`；无 `--project` 的全局工作台改为**每项目一条稳定身份路由**：`/p/<project-id>/**` 下的页面、GET 与 `POST /api/action` 都按请求自带的项目身份解析（ID 由 canonical 路径派生，只在已登记集合里反查，不把 URL 片段当路径），`GET /api/snapshot` 因此不再有可被别的标签页切换的「当前项目」。宿主级路由留在无前缀：`GET /api/host`（模式、已登记列表、上次打开）、`GET /api/host/projects`（仅探测已登记目录的 lushd，返回 `running` 与有界摘要；不启动项目）、`POST /api/host/select`（登记并连接，返回路由 ID，不设全局当前项目）、`POST /api/host/remove`（只删入口并断开 Web 连接），以及「文档」视图的 `/api/docs`、`/api/docs/search-index` 与 `/api/docs/<id>`——数据源是 `src/ui/web/docs.js`，只读随代码发布的 `docs/**/*.md` 与 `README.md`，与当前项目目录无关，只按扫出来的 id 查表命中。项目读取与写动作的完整白名单见[Web 路由](../reference/web-routes.md)（`CORE_READS` / `CORE_WORKER_READ` / `CORE_DOC_READ` / `MUTATIONS`）。认证边界也在 `server.js`：项目绑定模式读取 `.lush/web.json`，全局启动器读取用户配置目录的 `web.json`；无对应配置时只监听本机，有配置时监听公网，并用 `/login`、`/logout` 与 HttpOnly 会话 Cookie 保护全部页面、资源和 API。全局公网配置必须额外提供 `projects` 绝对路径白名单，且项目注册表不允许把白名单外的路径解析成可访问身份；本地无认证启动器仍可输入任意现存绝对目录。
- 前端项目身份在 `src/ui/web/assets/route.js`：从 `location.pathname` 读 `/p/<id>/`（读不到就是单项目模式或全局根），`api.js` 用它给项目 API 加前缀，启动器与文档等宿主级资源不加；折叠 / 筛选 / 排序与 Worker 图偏好按项目隔离在 `prefs.js` / `state.js`，主题等外观偏好共享。项目列表与切换在 `project-picker.js`：已在一个项目页时用新标签打开别的项目，切换项目不会清空当前标签的输入。
- 服务重启接缝：设置页保留项目后台与当前界面服务独立重启，并提供「全部重启」按钮；一次确认后复用现有接口先重启当前项目后台，成功后再重启当前界面服务，后台拒绝时不动界面，部分成功明确提示，不重启其他项目后台。`POST /api/service/restart`（全局模式须带 `/p/<project-id>` 前缀）只处理已解析的当前项目，不接受路径或 Agent token；Host 调用用户专属 `system.stop_if_idle`，daemon 同步检查活动 invocation / 模型调用和 Git 工作后封闭新调度，再停止，由 Host 等待退出并启动。忙碌时拒绝，不把运行中Worker标为失败。`POST /api/host/restart` 只重启接收请求的 Host（不停止任何项目 daemon）；`GET /api/host` 增加 `restart_supported`，不支持的嵌入模式禁用按钮并说明原因。两个 POST 都复用登录、Origin、JSON 类型校验；Host 重启会清空登录会话，页面有界探测恢复或提示重新登录。`bin/lush-host` 通过 `src/host/supervisor.js` 持有 `bin/lush-host-worker`，worker 请求重启时退出 75，supervisor 等退出后在同端口启动新进程；普通退出不重放。`src/host/service-control.js` 提供 `restartProjectDaemon(config)`，按项目 single-flight 并等待 daemon 锁释放；`Workspaces.pending` 跟踪全部排队及执行中的串行 Git 工作，为 idle 准入提供同步证据。
- Web 按钮帮助走 `data-help`：含义不直观的按钮都带提示，会调用 Agent 的按钮另带 `agent-call` 类与 `agentHelp()` 生成的文案，禁用按钮由外层 `.help-host` 承载；前端实现与三种输入方式见[按钮帮助与 Agent 触发标识](../design/ui-guidance.md)。
- Host 的项目连接与按需启动在 `src/host/project-host.js`；全局项目登记状态在 `src/host/registry.js`：用户配置目录中的 `launcher.json` 是 v2，存 `last_project` 与已登记的 `projects` 路径列表（读 v1 时把 `last_project` 提升为登记项），只把上次打开当作**新窗口首次落点**，不再决定任何页面的请求目标；同目录的可选 `web.json` 独立保存全局启动器认证、可信 Origin 与项目白名单；两者都不是业务事实也不是 `LUSH_HOME`。`projectRouteId(path)` 由 canonical 路径派生 16 位十六进制 ID，同一路径稳定、不同路径不可混同；服务端只用它在已登记集合里反查路径。macOS / Linux / Windows 分别遵循各自用户配置目录。浏览器直接访问各 Host，网络由用户自行配置；宿主职责见 [Web 宿主](modules-web.md#web-宿主)。
- Web 进程的生命周期在 `src/host/control.js`：`webListenerPids(port)` 认出端口上的监听者，
  `webOwners(config, port)` 把端口与 `.lush/host.state.json`（后台 Web 自己写的 pid / 端口 / 代码指纹）
  合起来给出「谁在听、命令行是不是 Lush Web」，`stopStaleWeb(port)` 只停命令行确实是 Lush Web 的进程
  （`bin/lush-host` / `ops.js host start`，先 SIGTERM、超时才 SIGKILL），`busyPortHint(port)`
  在端口被别人占着时把命令行原样报出来。`bun run lush host start`就是「后台 spawn `bin/lush-host` + 等它占住端口」
  （`waitForWebState`），`lush host restart` 就是「停下旧的 + 后台起一个新的」，`lush host stop` 停止 Web；Web 进程不会跟着代码换版本，
  这是换版的正路。`doctor` / `lush host status` 只读这些状态，把当前磁盘、daemon、Web 的代码目录 / 版本 / 指纹
  分开报告；不一致只产生带项目与端口的更新提示，不触发重启。
- 环境变量与 agent capability 语义（`LUSH_PROJECT` / `LUSH_HOME` / `LUSH_TASK_ID` / `LUSH_AGENT_TOKEN`）。`LUSH_TASK_ID` 是与当前 agent 直接绑定的 Worker，不是 Worker 树上的 `tasks.parent_id`；进度 RPC 仍以一次性 token 解析出的 actor 为准，不信任环境变量中的 ID。项目级 Agent 配置固定写在 `<project>/.lush/agent.json`：默认配置 + planner / coordinator / worker / research / verifier / merger / explainer / butler 八类角色覆盖（专用角色不再有公开创建入口，但配置读取与历史调用仍可用）；写入原子替换，运行中的 invocation 不打断，下一次调用动态读取并生效。每份 profile 分 `default_prompt` 与 `append_prompt`：前者非空时替换该角色的内置组合（UI 明确警告能力、权限与交付协议可能失效），后者追加在共享/本机文件补充之后；旧 `prompt` 字段按 `append_prompt` 兼容读取。内置规则由 `PROMPT_PARTS` 按角色组合；再叠加可提交的 `.lush-agent/{common,ROLE}.md` 与本机 `.lush/agent/{common,ROLE}.md`。Agent 子进程环境在 daemon 环境之上热加载 `.lush/agent/agent.env` 和角色 env，`LUSH_*` 不可覆盖；Web 键值编辑器把文件规范化为 owner-only 的 `NAME="value"`，空表删除对应文件。profile 另存 `extensions` / `skills` 路径列表，只给普通 Pi invocation 以显式参数加载，Codex 与无工具 explainer / butler 保留配置但不使用。
- 项目级运行设置固定写在 `<home>/settings.json`（version 1，权限 `600`），唯一读写入口是 `src/core/settings.js` 的 `RuntimeSettings`；目前有数字键 `concurrency`（1..64）、`control_concurrency`（1..16）、`call_timeout`（1..86400）、`task_call_limit`（1..1000）、`max_depth`（1..64），`null` / 缺键表示回退默认。`LUSH_CONCURRENCY` / `LUSH_CONTROL_CONCURRENCY` / `LUSH_CALL_TIMEOUT` / `LUSH_TASK_CALLS` / `LUSH_MAX_DEPTH` 只提供各自的默认值；daemon 启动时读出生效值，运行时写盘后同步内存并重新准入，不需要重启。历史设置键 `input_routes` 与旧提交路径一起保留在文件中，但不再有公开写入口，也不影响新指令。
- `src/core/genealogy.js`（分支谱系的纯逻辑：`buildForest` / `pruneHidden` / `parentOf` / `childrenOf` / `ancestorsOf` /
  `descendantsOf` / `rootOf` / `chainOf`）与 `types.js` / `naming.js` 一样是共享纯模块：不碰 git、不写盘、
  不渲染，只被 `project/branches.js` 与 `test/branch-tree.test.js` 使用。`naming.js` 导出 `slugify` /
  `taskSlug` / `taskLabel` 与 `inputLabel(id)`（历史输入聚合分支的 `input-<id>` 名）。

当前接缝（尚未完成全类型统一）：新式 指令/child 的 Git 基线在创建时固定，指令以输入时选定的父 ref 建 worktree，child 派生时在 Git 串行队列里立即从父分支 tip 建 worktree；analysis 创建时固定只读 detached worktree。其它专用 Worker、旧 Worker 与额外绑定的 owner 根 Worker 尚未迁入统一 fork 创建路径。`commit_contexts` 是项目本地的提交→Pi session/entry 附属索引；Agent 的 `git commit` 成功后记录当时可复用的上下文指针，外部提交没有指针时子 Pi 从空会话起步。子 Pi 首次运行用固定 entry 截出的 checkpoint 调 `--fork`，后续 invocation 继续自己的会话。旧 Worker/commit 不回填。

## 执行详情代码阅读器接缝

用户已批准执行详情内「执行记录 / 代码与改动」平级视图；只读代码、全项目文件树和逐行 diff 的接口契约见[代码阅读器](code-reader.md)。新增用户专属 `worker.code_state` / `worker.code_tree` / `worker.code_file`，对应 `code-state` / `code-tree` / `code-file` GET 后缀；Project 解析 Worker 身份、Workspaces 读取可信工作区/固定 Git 对象，Host 仅转发，前端按需加载。首期排除 ignored 与内部文件、不新增快照/实体、不修改归档行为。实现按该契约分后端与前端推进，旧 `worker.diff` 保持兼容。

## 用户确认的 Worker 彻底删除接缝

新增用户专属 `worker.delete_preview {id}` / `GET /api/worker/<id>/delete-preview` 与 `worker.delete {id,revision,confirm:true}`。预检只读返回 `{id,revision,can_delete,blockers:string[],workers:[{id,goal,status}],inputs:[{id}],resources:{worktrees:string[],branches:string[],files:string[]},warnings:string[]}`；列表必须覆盖真实删除范围，过大可明确拒绝而不能静默截断。`revision` 固定本次数据库范围及磁盘资源状态；删除在串行 Git 边界内重检，不一致拒绝并要求重新确认。确认本身授权丢弃范围内未提交/未合并代码，不另设 discard 选项。

范围是 Worker 与全部真实后代，清除专属消息/Notice/事件/Run/Artifact/会话/规则/上下文索引/报告等，无剩余使用者的 Input 与已发射 Draft 一并删除；整棵树须已终态且 invocation 已实际退出，不隐式取消，main/owner 不可删除。外部依赖、共享资源、交付冻结、未知路径归属应拒绝并说明，绝不操作 canonical 检出或其他 Worker 资源。资源检索覆盖登记元数据及 Git worktree 现状；文件删除限制在项目 home 的可信专属路径。清理完成后才事务删库，失败保留可诊断、可继续的 Worker，不冒充彻底成功；不撤销已合并代码，不改写 Git 历史或其他记录中的引用快照，ID 不复用。

职责分工：Runtime/Git/Store 实现预检与清理、相关回归和 `modules-runtime.md`；CLI/RPC/Host 只接窄参数接口（本 Worker），CLI `worker delete ID` 为预检，`worker delete ID --confirm --revision REV` 为显式确认；前端共享 `worker-delete.js`（子 Worker）提供详情/Worker图删除入口、只读预检、应用内最终确认及失败保护，维护 `modules-web.md`；确认前展示范围、资源、不可逆后果，不调用 Agent。

## 历史输入与输入缓冲区

修改输入框、暂存与原始指令检索前先读[历史输入与缓冲区理念](../design/input-history.md)；用户操作见[历史输入与暂存](../input-history.md)。缓冲区只持久保存想法，不创建Worker或调用 Agent；发射必须走当前指令协议，不恢复旧 planner 或批量 `draft.commit`。历史检索覆盖原始 Input 与未提交 Draft，不含 Worker 追加消息；Worker状态与合并状态独立投影。公共 API、状态枚举、版本校验与文件职责见[历史输入接口](input-history.md)；`#inputs` 由 `render-inputs.js` / `styles-inputs.css` 实现，`openInputs()` 为页面入口，主输入框父候选读面不再依赖 overview。

## Worker 图与固定输入规则

`worker.graph` / `/api/worker-graph` 是以 Worker 父子关系为边的有界读面；Web 的 `#worker-graph` 为主视角，旧 `#graph` 分支视图及 `/api/graph` HTTP 路由已移除；精简 Git 父分支、当前检出与关系诊断移入 Worker 卡片，完整谱系与未绑定分支绑定只保留 CLI / RPC。Worker 卡片按真实状态配色，读面投影 `archived`（内部 merge 队列随直接父 Worker 归档，详见 [Worker 图](task-graph.md)）及 `branch_info.subtree_order` / `branch_info.merge_run` 作为交付诊断；旧 `branch.orchestrate_plan` / `branch.orchestrate` 一键编排入口已下线。新指令从已提交 fork 读取 `.lush-task/input.mjs` 并冻结在项目 `.lush/task-rules/`；用户后续消息由固定规则返回 `message` 或安全点软抢占的 `interrupt`，失败回退并留事件。子 Worker 继承直接父的规则快照。可信代码风险与读面边界见 [Worker 图与固定输入规则](task-graph.md)。

### Worker 树资源消耗读面

`worker.graph` 每个节点新增 `resources:{own,subtree}`（读取失败为 null）；两个摘要均为 `{input,output,cost,run_ms,unknown_tokens,unknown_cost,incomplete,running}`。input 包含缓存读取与写入，output 不重复加 reasoning，cost 是会话报告的美元估算，run_ms 是各轮 `agent_runs` 的累计工作时长（未结束的 run 算到本次读取时刻，不含等待）；无请求为零，缺失费用/token 或不完整记录必须明示未知。完整会话扫描复用 `core/usage-statistics.js` 的签名缓存与单飞，不用 transcript 的 8 MiB 窗口或 attribution 的 100 组截断；显式属于其它 Worker 的 fork 上下文不重复计费。subtree 按完整 tasks 的真实 parent_id 累加（含归档、筛选及图外后代），running 为其范围内是否有 running Worker；Codex 只有线程元数据且无用量行时不可假造消耗。

两种展示模式均由 `task-graph-usage.js` 渲染：展开显示 own，收拢有子树的节点显示加粗 subtree；顺序为运行时间、输入绿、输出红、费用主题正文色；运行时间不带“运行”前缀，从最高非零单位到秒全量显示，省略前导零单位，数字与 `d` / `h` / `m` / `s` 之间留空格（`1 d 2 h 3 m 4 s` / `3 h 0 m 5 s` / `5 m 6 s`，不足一分钟为 `7 s`，零时长为 `0 s`），整组排在合并状态标签之前（极简模式在第二行）。范围内 running 才闪烁，静息、排队、暂停、停止不闪烁，遵循系统与应用减少动效设置。无新 RPC、持久化或 Agent 调用。

### Worker 图合并关系读面接缝

`worker.graph` 每个返回节点新增 `merge_queue:{counts,total,items,truncated,limit_per_status:3}`：仅统计完整 tasks 表中真实直接子Worker的 `reservation.version=2,kind=merge,queue_protocol=1,parent_id=tasks.parent_id`，阶段为 executing/resolving/requested/suspended/blocked；pending、历史协议、integrated 不计入当前队列。`counts` 给五种阶段的精确计数，`items:[{id,status}]` 每阶段最多 3 条（ID 降序，仅供展示），`truncated` 明确关联条目未列全；无活动请求时返回零计数空列表。查询只读、SQL 聚合/窗口有界返回，不读取目标/正文，不新增表或调度行为。摘要对客户端筛选、折叠及 200 节点截断独立；旧服务缺字段时显示摘要不可用，不按局部节点伪造全量。

前端 `task-graph-merge.js` 统一新协议阶段/排序及关系 DOM，子卡片目标只用真实 `parent_id` 与 `target_branch`，不把布局祖先当交付目标。`taskForest` 保留根 ID 降序，只在同一真实父的兄弟槽位按 executing/resolving、requested、其它分组，组内 ID 降序；该顺序不是 runtime 执行次序。`task-graph-motion.js` 为整树刷新记录可见卡片位置，仅同一视图结构下真实兄弟换序播放 250ms FLIP（不移动连线），保留阅读锚点、滚动和焦点；首次加载、筛选、折叠、模式/窗口尺寸变化不播放，编辑、选区、弹层、未结束动效期间暂缓刷新，遵循系统/应用减少动效设置。无后台计时器或全局监听。

## 可选进度汇报

项目级运行设置 `progress_reporting` 为布尔值，默认 `true`，由系统设置经用户专属 `system.configure` 保存，`null` 恢复默认。`Config.progressReporting` 随启动与热更新同步；概览 revision 纳入开关，确保其他页面/客户端及时刷新。关闭时 Runtime 的 `progressView` 投影 `progress:null`，不删除已有计划；后续 invocation 与 Agent 配置预览不再包含内置进度片段或 CLI 示例（包括 analysis 与 Pi 默认模式）。自定义 Prompt / 项目补充和既有会话原文不改写，正在运行的调用不打断，进度 RPC 保留以兼容在途调用。

`builtInPrompt(role,{progressReporting=true}={})` 按开关组合内置片段。Web `render-progress.js` 新增 `progressReportingEnabled()`，从项目快照读取开关，统一隐藏详情、紧凑摘要与完整图进度（含未汇报占位）；极简图也不再显示计划摘要或等待汇报文案。

## 进展漏报的计时接缝

`progress plan` / `complete` 命令与 RPC 不增加入口。version 1 计划条目可附加 `unconfirmed:true`（被越序跳过、仍 pending，不占完成数也不作为当前执行步骤）与 `timing_unknown:true`（无法分配真实耗时，`duration_ms/work_ms` 为 null，不挂 live tick）。越序完成推进到后续未跳过待办；补报旧步骤只更新完成度，不打断当前计时。Runtime 投影、两种图摘要与 Web 详情必须采用一致的当前步骤选择，旧记录不迁移。具体行为见[Agent 环境](../reference/agent-environment.md)。

## Agent 管理与状态查询接缝

用户决定 #186 将「模型来源」升级为全宽多连接总览、逐行侧边编辑与勾选批量刷新 / 启用停用，取代下文旧双栏布局。页面保存 / 登录后会独立查询该连接额度，底层保存接口仍不隐式联网；默认模型与思考深度必须完整保留在后端公开投影及全量保存中。设计与边界以[模型来源](../design/agent-model-settings.md#模型来源)、[连接 Web 契约](agent-connections.md#web)和[Web 文件表](modules-web.md)为准。

用户决定 #152 的两页拆分优先于下文旧「Agent 管理」布局，理念见[Agent 配置与模型来源](../design/agent-model-settings.md)。此次仅重组既有前端能力，不增补认证/模型路由后端：

- `render-agent-status.js` 保留 `openAgentStatus()` / `renderAgentStatus(data)` 导出及 `#agent-status` 地址，页面改为「Agent 配置」，默认加载配置，诊断按需显式查询；不再承载托管来源管理。
- 新 `render-model-sources.js` 导出 `openModelSources({connectionId?}={})`，独立页面身份 `model-sources` / 地址 `#model-sources`（可选来源定位 `#model-source-<id>`）；组装 `createAgentConnections`，其 API 保持兼容，可增补选择来源参数/方法。
- `render-agent-connections.js` / `styles-agent-connections.css` 负责来源列表、筛选、选择详情、编辑/登录、额度/历史与采样；不修改 Agent 配置或导航装配。
- `render-settings.js` 负责 Agent 配置分区及将项目出站网络放入系统设置；`agent-connection-picker.js` 统一后端→来源→模型选择，保留现有导出接口、用户草稿与能力校验。
- `app.js` / `sidebar-ui.js` / `index.html` 接入两页独立导航及来源深链接；`navigate.js` 仍是跨面板跳转接缝。
- `retry-dialog.js` 增补轻量 Worker 来源编辑，`render-detail.js` / `render-agent.js` 接入入口/只读配置摘要，仍走 `worker.configure` 和既有状态准入，完整 Profile 与其他覆盖不得丢失。
- 各前端变更配套 DOM 回归；父 Worker 维护设计/模块/使用文档与组合、全量测试。

用户决定 #154 增补上述范围：

- 所有 `PiProvider.run` 必须绑定 Lush 连接。新项目配置模块（`src/agent/pi-config.js`）管理 `<home>/pi/` 的独立基础设置；`connection-runtime.js` 只从该配置和本次连接生成私有调用快照，用 `PI_CODING_AGENT_DIR` 指向快照，不复制用户默认 Pi 的设置/模型覆盖/全局 Prompt/凭证。显式所选扩展/Skills 与项目上下文仍保留，项目 `.pi` 设置不能覆盖受管端点。`models.js` / `resources.js` 的工作配置发现收敛到独立目录；#255 将 `status` 收窄为软件诊断，不再读取任何认证或运行配置。旧历史不迁移、不删除。
- `worker.configure` 增补互斥的 `model_selection:{connection_id,model}` 输入（与 `profile` 不得同时存在）；窄更新仅允许 Pi 托管来源，不切换执行后端。服务端从完整既有覆盖或有效角色默认取基线，仅替换这两个字段；验证配置、连接启用/认证及模型范围，沿用既有状态、分支冻结与用户专属边界，不启动 Agent。
- `worker.inspect` 增补安全 `model_selection:{agent,connection_id,model,thinking,explicit}`，仅表示下一次调用的配置，不含 env/Prompt/资源/秘密。当前调用的实际绑定另从运行时绑定证据展示，不能用该摘要冒充。窄更新返回安全摘要，不把完整 retry_profile 返回客户端。
- Runtime 隔离分区负责 `src/agent/pi-config.js`、provider/connection-runtime/models/resources/status相关实现及测试；安全更新分区负责 project/scheduling/tasks/internal、RPC registry/handlers、对应项目/RPC/HTTP测试。Worker 前端沿用上述新契约；父维护文档与集成，不允许子分区互改文件。

共享 API、自定义 OpenAI 兼容端点、单 Worker 显式选择和默认关闭的受信调用前策略接口，新增分工与接口见[共享模型选择](managed-model-selection.md)（用户决定 #142）。未注入策略时不做自动选择；#142 原先的未绑定 Pi 兼容已由 #154 独立配置/显式来源要求取代，未绑定的后续 Pi 调用明确失败，不回退外部认证。

托管多账号的字段/凭证/API/显式 Pi 绑定契约见[账号资源连接器](agent-connections.md)，设计取舍见[账号资源理念](../design/account-resources.md)。`agent.connections.*` 全部用户专属；独立连接页读本地列表，显式刷新/可选采样，保留旧状态与历史，不迁移外部凭证。Pi profile 可选 `connection_id`，固定物理模型、隔离 invocation 认证目录；正常 Codex 套餐头在进程退出时吸收，不自动路由。

Codex 托管登录的默认设备码与备用回调入口见[设备码登录契约](codex-device-login.md)：新增用户专属 `agent.connections.device.start/poll/cancel`，Manager/Service 同名方法，Project 使用 `startConnectionDeviceLogin/pollConnectionDeviceLogin/cancelConnectionDeviceLogin`。只在当前登录页面按服务端间隔检查授权，不启动模型或修改外部 Pi 凭证。

托管来源的自动模型目录、缓存隔离、后台低频刷新与 `agent sources` / `agent resources` 命令面见[模型目录与来源 CLI](agent-model-catalog.md)：用户专属 `agent.connections.models(.refresh)`（`SELECT` 读本地缓存，刷新仅 POST action），`agent.selection.resources` 每连接附带只读 `model_catalog`；CLI 子模块 `cli/commands/agent-sources.js` 导出 `runSources` / `runResources`，由 `agent.js` 分派。目录不代表额度或请求必然成功，`connection.models` 仍是手动限制。

用户决定 #255 收窄诊断并退役旧查询，当前契约见 [旧余额历史只读存档](agent-usage.md)，操作说明见 [Agent 配置与模型来源](../reference/rpc/agents.md)。

「Agent 配置」`#agent-status` 默认读取工作配置，保留 Prompt、环境变量及扩展/Skills 安装启用；高级诊断仅按需检查执行机器上安装的 Pi、Codex 软件，不读取任何账号、认证、模型或运行配置，不联网。安装路径可以是全局目录，不是 Worker 当前调用快照。打开配置、概览轮询不执行诊断，页签保留草稿，失败与迟到响应不能覆盖配置。

`agent.status` / GET `/api/agent/status` 返回 version 2：`{version:2,checked_at,scope:{project,note},software,warnings}`。`software` 固定包含 Pi、Codex，两项分别为 `{agent,command,executable,real_path,version,status,warning}`，`status` 为 `available|unavailable`，未知路径/版本为 null。按 daemon 的 `LUSH_PI_COMMAND` / `LUSH_CODEX_COMMAND` 或 PATH 发现，只执行有界 `--version`，不加载 SDK/扩展、不启动登录或模型；不返回原始 stdout/stderr，失败用固定安全说明。同配置并发单飞，下一次显式刷新重新检查。前端拒绝旧 version 1 响应并提示更新服务，不回退显示账号诊断。

「模型来源」`#model-sources` 与 `#model-source-UUID` 继续管理正式连接的认证、余额、采样和逐连接历史。旧余额历史仅作为额外的按需只读存档，保留匿名账号/指标隔离，不按服务商名猜测 connection ID，不导入正式曲线；页面进入不自动请求旧历史或旧配置。旧查询及采样停用，旧 enabled 配置不在重启后恢复，不写配置、不删除凭证、不清理存档；`agent.usage.configure` 明确退役，`agent.usage.config` 只读兼容，`agent.usage.history` 只读旧 SQLite 投影。正式连接采样仍按其既有配置运行。

软件诊断由 `src/agent/status-software.js`、`status-command.js` 与 Project 接缝负责；`src/core/agent-usage.js` 只保留旧存档读服务，内部旧适配不再由项目查询入口调用。Web `render-agent-status.js` 负责配置及软件诊断；`render-model-sources.js` 组装正式管理台和旧存档；`render-agent-usage.js` 导出只读存档与正式历史共用的曲线原语。细表见 Runtime、Web 与 CLI/RPC 分章。

## main 版本迭代

用户已确认的[版本迭代契约](version-history.md)规定只读 `branch.history(cursor?,limit?)` / `GET /api/versions` 与工作分组的 `#versions` 页面：第一父链有界分页，固定 tip，以精确交付证据关联 Worker / 原始指令，不凭标题猜测，不新增提交级 diff 或 Git 写操作。Git、Project/RPC 与前端分别遵循该文档的字段和职责边界。

## 页面导航与全类型 Worker 列表

- Web 采用平级页面，分组只组织导航：工作（项目概览、Worker树、待我处理、Worker 列表）、其他（Agent 配置、模型来源、系统设置、帮助文档）。Worker 详情归属 Worker 列表，文档正文归属帮助文档。
- `sidebar-ui.js` 统一页面切换、路由地址、唯一选中项、视图栏、移动端收起与加载占位；`ui.view` 为当前页面身份，异步读面用身份检查阻止迟到响应覆盖新页面。概览导航先画缓存，不依赖 revision 变化或轮询空闲。
- Worker 列表平铺展示，不补祖先、不显示缩进或兄弟链，排序直接作用于所有命中Worker（智能排序只看Worker自身的状态与更新）；Worker 树页面独立负责父子关系。状态与类型筛选为常展开的即时复选框，同组取并集、跨组取交集，空选与「全部」均表示不限制；偏好兼容旧单值与新数组，轮询保留选项焦点和历史类型选择。
- `worker.activity(limit?,scope?)` / `worker.page(before?,limit?,scope?)` 增加 `scope='work'|'all'`，省略保留旧 work 口径；Web overview 与历史分页显式请求 all，覆盖 intent/work 两层，继续有界读取，不改 Worker 实体或存储层级。`GET /api/workers` 透传 scope；类型筛选固定提供全部现行角色，兼容历史 scheduler 与未知角色，筛选与搜索范围明确为已加载 Worker，历史分页加载的旧类型不会在后续轮询中被丢弃。

## 分支诊断增量读面

- `graph.get` 的 branch 节点增量提供 `diagnostics`：`changes` 以登记的 `created_from_commit` → 当前固定 tip 统计已提交净改动（文件总数、文本增删行、二进制文件数及有界文件列表），`latest_commit` 给出 tip 的提交时间与摘要，`working_tree` 单独统计实际检出该分支的工作区未提交文件数（暂存 / 未暂存 / 未跟踪 / 冲突，分类可能重叠）。无起点、无 ref、未检出与读取失败不能冒充零。
- Git 边界 `workspaces/diff.js` 新增 `branchDiagnostics(branches)` 批量读面：只读 Git、禁用外部 diff/textconv，固定提交结果有界缓存；文件列表每分支最多 50 项且 JSON 不超过 2 KiB，截断不影响汇总。无新表、无新 RPC 方法；Web 用 Worker 图轮询，并保留文件列表展开状态。

## 已合并 Worker 的多轮交付接缝

[持续迭代](task-iteration.md)规定新式 指令/child 合并后的非终态 `awaiting_acceptance`、显式验收与归档分离、安全父同步及历史显式恢复。`worker.accept` 调用 `Project.acceptTask(taskId, actor=null)`：用户验收指令；运行中的直接父 Agent 可确认已交付的 child，不能验收自己、兄弟或用户创建的指令，审计 `task.accepted` 区分 `accepted_by:'user'|'parent'` 与 `parent_id`。用户仍可显式确认 child，但不再要求逐个点击；父 Worker 的后代须已结算，不能用父验收隐式掩盖未确认成果。USER_ONLY `worker.reopen/sync_parent/resolve_sync` 分别调用 `Project.reopenTask/syncTaskParent/resolveTaskSync`；验收、恢复、同步不调用 Agent，只有 resolve_sync 显式启动当前 Worker Agent。Worker 详情/图共用 `render-iteration.js`；读模型 `accepted:boolean` 防止已验收记录误重开，`parent_sync_conflict` 提供固定提交诊断。保留原始 `base_commit`，本轮用可空 `iteration_base_commit`，不批量迁移旧行。

## 展示功能已移除

预约展示、效果展示 Agent、报告页与持续预览实现均已删除；`worker.reserve` 仅接受 `kind='merge'`。普通合并预约不受影响，已完成 Worker 须显式恢复后继续工作，不再提供展示完成后的特殊合并路径。历史展示列、记录和报告文件不迁移、不删除；旧展示 Worker 不调度或重试，尚存 detached worktree 不由普通归档/清理回收。

## 父 Worker 自有交付队列（version 2，queue_protocol=1）

新请求不创建 merge Worker，也不改源 Worker 的 parent_id。`tasks.reservation` 是持久事实，Message/Event 只通知：真实源安全点固定 `delivery_id`（请求 Event ID）、`enqueue_seq`、`commit`、`parent_id`；拿到父分支逻辑执行位后才固定 `attempt_id`、`baseline` 与 `original_commit`。状态为 pending → requested → executing/resolving → integrated；suspended 显式释放执行位，恢复重新排队并生成新尝试；blocked 保留未知父侧现场，不让下一项写入。请求按 enqueue_seq、代码依赖优先；逻辑执行位跨源侧修复持久化，不持有全项目 Git 锁跨 Agent 调用。

Project 的 `scheduleTaskMerge(parentId)` 用内存 pending-wake 集合保留 busy 期间的信号，`driveTaskMerge(parentId)` 释放 busy 后重新准入，避免挂起/取消丢唤醒；持久预约仍是唯一交付事实。`finalizeTaskMerge(taskId,attemptId,landedCommit,parentHead=landedCommit)` 分开记录交付提交与经 Git 核验的实时父 tip，恢复到已前进父分支不能回写旧 head_commit。`message` 的 sender/目标权限检查全部通过后，才在消息事务内挂起/恢复尝试、消费修复信号。`driveTaskMerge(parentId)` 每次只处理一项，父 invocation 实际退出后准入；`suspendTaskMerge(taskId,reason)` / `resumeQueuedTaskMerge(taskId)` 管理尝试暂停与重排；`recoverTaskDeliveries()` 核对准确 Git 凭据，兼容旧 v2 在途重挂仅使用 reservation/audit 的明确原父，保留历史 merge 身份。调度、同步、向上交付与兄弟落地共享父分支写冻结；仅当前 attempt 的源侧修复可绕过自己的源冻结。落地前复核源/目标 ref、取消、新输入、清洁度与祖先保留。Git 成功 DB 未写时只按预先持久化的 `landing_receipt.commit` 精确恢复，未知副作用不重放。Web 共用交付控件只给静息 suspended 显示「恢复交付」、静息 blocked 显示「受检复查落地」，复用 worker.reserve 且标注可能唤醒源 Agent；failed/paused/awaiting 仍先处理已有检查/继续/待决，不绕过安全点。

Git 接缝新增 `prepareTaskSquashUnsafe(child,source,baseline,message)` 返回未落地的 `{commit,source,baseline,tree,parent,workspace}`；`applyTaskSquashUnsafe(receipt,guard)` 最后复核固定 refs/清洁度并在写入前调用同步 guard，受检推进父工作区/ref；`verifyTaskSquashUnsafe(receipt)` 精确核验提交/父/树与目标祖先、工作区。Store 仍使用 reservation JSON 与 Event ID，无新业务实体。旧 version 1 原语义不变；旧 v2 凭据以精确父/树/完整标题核对，不能以标题前缀猜测。

## 新式 Worker 的自动合并（version 2）

自动合并设置接缝：`worker.auto_merge {id,enabled}` 是用户专属开关接口，与一次性交付的 `worker.reserve {kind:'merge'}` 分开；Worker 详情与 Worker 图投影 `auto_merge:{enabled,locked,editable,reason}`（不支持的 Worker 为 null）。设置持久化在可空 `tasks.auto_merge` JSON（`{version:1,enabled,locked}`），自动产生的 pending 意图带 `reservation.auto_merge:true`，跨 invocation、daemon 重启与后续开发轮次保留，不以合并请求的生命周期代替设置。新指令默认关闭，新派生 child 默认开启并锁定，合并—验收—归档流程 Hook 整体对用户只读，最高级别与旧开关入口均拒绝设置（含同值写入），不能通过 `worker.unreserve` 绕过；历史 Worker 不批量回填或改写已有撤销决定。`editable` 只允许尚未交付就绪且没有已发请求的活动Worker调整；`reason` 解释不可操作原因。CLI 使用 `worker auto-merge ID on|off`。开启只安装 runtime hook，不新增父 Agent 或用户审批：安全点满足交付条件后复用现有 version 2 请求与父队列准入。显式「合并」继续走 `worker.reserve`，不改变持久开关。Web 详情/Worker 图共用复选框；后端 `merge_readiness.ready` 为真时只显示「合并」，请求已发出或已合并时展示对应进度/结果，不重复发起。禁用子Worker复选框须说明由父Worker派生、自动合并不可关闭。

交付按钮的只读接缝：`project/order.js` 的 `mergeReadiness(task)` 在 `worker.inspect` 与 `worker.graph` 投影 `merge_readiness:{ready,reason}`（仅 指令/child）。复用 `reservationWaitReason` 检查调用收尾、子 Worker 结算、待决与未处理消息，并检查登记的待交付提交；`waiting` 本身不代表本轮交付就绪。该字段只表示可以尝试发起请求，Git 清洁度、ref 和后代分支仍由预约准入最终复核，不是合并授权。`render-delivery.js` 以此字段选择开发阶段的「自动合并」复选框或就绪后的「合并」按钮；缺少设置投影时保守只读，已有请求只展示进度与受检复查。

用户创建的指令由持久 hook 或显式 `worker.reserve` 授权；新 child 默认开启且锁定 hook，旧 child 不回填。运行中只保存 pending 意图。真实源安全点检查调用实际退出、消息/待决/后代结算、源 ref 与工作区后，用请求 Event ID 保存交付标识及入队顺序；无代码 child 只交结果，进入待父确认。新请求不创建 merge Worker、不重挂，目标始终是直接父分支。父 runtime 在写执行位上固定基线、串行 Squash 为一条提交；源侧修复保留执行位，失败/问卷挂起释放，恢复重新排队。不额外启动父 Agent，main/owner 静息；普通消息在每项落地边界优先调度。精确预制 SHA 和 landing_receipt 在父侧写入前保存，重启仅核对凭据，不重放未知 apply。

正常落地保持委派关系与 worktree，进入 `awaiting_acceptance/integration=merged`；指令用户验收、child 直接父确认、显式归档分开。`Workspaces#squashedLanded` 让保留的已落地分支不阻塞父交付；归档仍严格核验树、源 ref、清洁度。旧 v2 merge 身份、重挂事件与历史记录保留，兼容恢复仅用明确 parent_id/匹配 audit 归位；旧落地窗只按精确单父、树、完整标题核对，未知保留错误。旧 version 1 手动审批不改。

### 历史 v2 重挂兼容与中断恢复

`project/merge-queue.js` 的 `restoreUnrequestedTaskParent(taskId)` 仅凭 version 2 预约或重挂事件，并复核内部队列与分支谱系，将已撤销／旧版丢失预约的 Worker 归还原父；`retry`、显式重新预约与 `recover` 共用此 DB-only 修复，不执行 Git 或重放 Agent。新协议失败保留 suspended 意图；显式 retry/恢复丢弃旧 attempt/baseline，安全点重新排队。旧失败撤销记录的 `retry_status` 只恢复 pending 意图，不复用旧分歧基线；用户取消／撤销不隐式恢复旧尝试。恢复队列身份不等于批准合并，丢失的旧预约仍需用户重新申请。

## 交付锁与合并编排（历史 version 1）

- 新的 Worker 中心交付只走固定提交：合并预约（`tasks.reservation`，`kind='merge'`）在静息、后代结算、工作区干净且可快进时冻结源 `commit` 与父 `baseline`，向父 Worker 发去重请求；父为指令时由运行中的直接父 Agent `worker.integrate` 确认，父为 main/owner 时由用户 `worker.approve_merge` 批准。请求未解决时父分支受交付锁保护。
- `src/core/branch-freeze.js` 从已有事实现算分支写冻结：任何未结束的解分歧 Worker 冻结其目标分支 + 全部后代 + 其直接父分支；已发出但尚未集成的指令合并请求（`reservation` 里 `kind=merge`、`status=requested`）冻结其 `target_branch` **本身**（不冻结请求者与兄弟指令自己的分支）——请求已经把父分支基线固定成那个 commit，父分支再前进就只能作废重做。交付锁同时保证同一个父分支一次只接受一个未集成请求：`settleReservedMerge` 见到别人的交付锁就保持 pending 并记 `parent_locked`，`integrateChild` / `approveReservedMerge` 只允许锁持有者自己落地。冻结拦截新建指令、`worker.retry` / `worker.cleanup` / `branch.archive`；`worker.cancel` 保持可用（释放路径）；源分支带着未集成请求时 `branch.archive` 也拒绝（删了它父分支的交付锁就永远没有落地对象）。冻结经 `status.branch_freeze` / `status.merge_runs` 与 `graph.get` 的 branch 节点 `freeze` / `merge_run` 下发。
- 旧的一键合并（`branch.merge_all`）与合并编排（`branch.orchestrate*`）不再有公开入口；`project/merge-all.js` 与 `project/orchestrate.js` 的内部实现及 `branches.merge_run` 列保留，只为读懂历史行与后续清理。

## Notice 提醒与历史接缝

修改通知、告知设置与已读消除前，先读[通知与告知理念](../design/notices.md)。分类/渠道偏好与逐条已知的权威契约见[待决问题与告知](../reference/rpc/notices.md#页面告知条与分类设置)。

### 用户创建 Worker 的告知型生命周期 hook

- 内置 runtime hook（不执行仓库程序、不调用 Agent）仅为用户直接创建的 `order` / `analysis` Worker 生成生命周期告知。工作收尾且无待决、未处理消息或未结算子Worker时告知本轮静息；异常停止（超时、调用失败、daemon 中断恢复）告知失败原因。等待子Worker、待决、用户主动暂停/取消和安全抢占不产生额外告知。静息不是验收完成，也不承诺已合并。
- 复用 Notice 的 `kind='info' / status='sent'`，新增可空 `source_event_id`（唯一的来源生命周期 Event ID）与 `read_at`（成功打开 Worker 或显式「已知」后的已读时间）；旧 Notice 不回填、不作为新增未读告知。状态/来源事件/告知同事务保存，以来源 ID 幂等；历史终态提醒兼容保留，用户创建 Worker 不重复生成旧结算提醒。
- 跨分区契约：用户专属 `notice.read {id}` 幂等标记 info Notice 已读，不答复、不唤醒 Worker；`notice.page {status:'unread'}` 仅返回 `kind=info,status=sent,source_event_id IS NOT NULL,read_at IS NULL`。`notice.list` 的有界快照优先包含待决与未读告知，返回完整新字段。Web `POST /api/action` 开放 `notice.read`。
- Notice 读面以同 Worker 的来源 Event 投影 `lifecycle_type`（idle / analysis / failed / NULL），不按标题或当前状态猜测，不增列或重写历史。
- UI 将待决与未读告知区分展示；点击生命周期告知成功加载对应 Worker 后调用 `notice.read`，加载失败不标已读；告知条可显式「已知」或手机横滑，仅标记当前一条且不导航。客户端分类与渠道开关只控制提醒，不影响记录或待决事项。系统通知沿用客户端开关/首屏不补发/项目隔离，新增 info 生命周期告知的增量提醒；浏览器通知点击使用受限的 Worker/Notice 数字 ID 路由，不允许任意 URL。告知不进入调度、合并、验收的 open 决策口径。

- 保留 `notice.list` 兼容读面，新增 `notice.page(status?,before?,limit?)` 与 `GET /api/notices`：按 ID 降序分页，status 为 `all|open|answered|dismissed|sent|unread`，返回 `{notices,cursor,has_more,limit}`。不删除或重写既有 Notice。
- 「待我处理」按需查询全部类型的 Notice，未处理项可直接答复／审批，历史只读；首页仍用有界快照。通知针对新增的 open 决策事项与未读生命周期告知，首次加载不补发历史。
- `notice-notifications.js` 负责浏览器 Notification，默认关闭；授权只由用户开启时触发，失败不影响轮询和留档。开关按浏览器站点保存；页面关闭后不提醒，不引入 daemon 后台推送。

## 可撤销中断与非阻塞继续接缝

用户已确认：中断只在安全点停止，不再用 30 秒宽限期强杀。新增可空 `tasks.interrupt_state TEXT`，旧行不回填；读面（详情、列表、Worker 图）提供 `interrupt_state: 'requested'|'resuming'|null`。`requested` 表示用户希望暂停，当前 invocation 仍可安全执行工具与 RPC，真实状态保持 running；静息 Worker 直接 paused。`worker.resume` 接受 requested/paused/resuming：未认领请求则撤销暂停（仍有用户消息抢占时保留），已认领或旧调用收尾则记 queued/resuming，由内部等待真实退出后再次准入，绝不重叠调用。重复中断/继续幂等。运行设置仍在暂停意愿期间可保存，下一次 invocation 生效，不暗中改当前调用。

Pi 的 request→stop 原子 rename 是安全点认领；daemon 通过 unlink request 撤销，两者竞态由文件系统原子操作判定。stop 一经认领不撤回。只匹配当前 task/run，不让旧标记影响新调用；Provider 关闭后读取 stop（不要求 request 仍存在）。没有可验证安全点的后端等 invocation 自然结束。普通调用总超时和显式取消保留；重启不自动重放未知调用。调度收尾将未撤销暂停投影成 paused，resuming 在真实释放执行位后回 queued，用户中断不产生虚假的交付完成/失败告知。

前端保留「中断 / 继续」入口：requested 显示等待安全点与可继续撤销，resuming 显示已接受继续、内部等待收尾；请求成功不冒称进程已停止或已重新启动。继续可能触发新 Agent，沿用紫色标识与 agentHelp。实现边界：Runtime 负责 Store、Project、Pi 通道与运行回归；Web 负责动作、状态文案和 DOM 回归。RPC 方法与参数不新增。

## Token 效率接缝

实现约束与历史归因口径见 [Token 效率与用量归因](token-efficiency.md)。

- `project/context.js` 的 `invocationContext(task,run)` 只投影直接父子、依赖、用户引用与专用角色上下文；不注入全局最近 Worker。关联摘要有界且明确截断，完整内容通过既有 `lush worker inspect` 读取。`provider.js` 启动 JSON 使用多行格式，剔除凭证 hash 与重复 prompt 配置。
- 安全抢占（`scheduling.requestPreempt`）：由用户追加输入（`worker.message` 且 `sender===null`）或用户主动 `worker.interrupt` 触发，且只在有可验证安全边界的后端生效（目前只有 Pi）。它在 `<home>/preempt/` 写一次性 request；`agent/pi-runtime.js` 在 `turn_end` 原子 rename 为 stop 后用 `ctx.abort()` 阻止后续轮次。`provider.js` 关进程后只认本 task/run 的 stop 并抛 `AgentPreempted`；可选 `onPreempt` 回调在清理文件前锁存认领事实，避免退出与继续竞态。`invoke` 据此把本 run 记成 `preempted`，追加输入写回 `queued`/`waiting`；用户暂停意愿在真实释放执行位时写 `paused`，已接受继续则回 `queued`。写 `invocation.preempted` 事件，**不**调 `cancel()`。`worker.interrupt` 只停当前 Worker、不级联子Worker，也不再因等待中断安全点超时强杀；普通超时与 `worker.cancel` 保留硬杀路径并如实标成失败/取消。
- [调用期目标分支移动检测](target-branch-guard.md)（`scheduling.invoke` / `workspaces/ref-guard.js`）：每次调用按具体 ref 观测精确 before→after 转移，接受成功 daemon 写入与所属 Worker 调用期观测，父先结束的记录仍可解释子调用的目标变化。无关分支、失败命令、对象／快照创建与 running Map 条目不能豁免；无法连接基线与现状时写 `invocation.target_branch_moved` 的未归因诊断、调用失败并保留现场。观测不是 OS 写入者证明，不接管用户手动 Git，也不自动回滚提交。
- 普通子 Worker 成功结算只在全部子 Worker 终态后唤醒；失败、取消、显式消息仍及时处理。延迟消息保留未读，所有收尾/恢复路径共用 `hasActionableMessages(taskId)`，避免空转和 lost-wakeup。
- Agent profile 增加可选 `soft_budget:{responses?,tokens?}`：正整数，空对象/缺省关闭。仅普通 Pi 支持；Codex 和 explainer 明确拒绝启用。内置 `agent/pi-runtime.js` 扩展记录 invocation 身份，按本次响应累计用量，在达到阈值后下一次自然模型调用前仅提醒一次收尾；不强制停止、不额外启动模型轮次。
- CLI `worker list --brief` 返回短目标与分页提示；`progress` 默认只回简短确认，`--json` 保留完整读模型；`doctor` 默认省略完整 daemon 配置，`--verbose` 恢复详细输出。

## 分区总览

| 分区 | 入口 | 细粒度模块 | 独立可并行 |
|---|---|---|---|
| Worker 编排 | `src/core/project.js` | `src/core/project/`（含指令、预约、集成、生命周期） | ✅ |
| Git 边界 | `src/core/workspaces.js` | `src/core/workspaces/`（5 个） | ✅ |
| 持久化 | `src/persistence/store.js` | `src/persistence/store/`（含分支、run 与引用元数据） | ✅ |
| 前端 | `src/ui/web/assets/app.js` | `src/ui/web/assets/`（见下表） | ✅ |
| CLI | `src/cli/main.js` | `src/cli/`（含 Agent 配置命令） | ✅ |
| RPC | `src/rpc/protocol.js` | `src/rpc/`（7 个） | ✅ |
| 测试 | `test/*.test.js` | `test/<分区>/*.test.js` | 依赖上面六个落定后 |

前六个分区 **互不共享文件**，可以同时开工。测试分区要等它们落地，否则测的是半成品。

历史 version 1 的预约是 `tasks.reservation` 可空 versioned JSON 附属状态：仅指令 Worker 可设置 `merge` 的一个 pending 意图，同类重复幂等；User-only `worker.reserve` / `worker.unreserve` 与 Event 同事务。`merge` 预约只在指令静息、工作区可检验且子 Worker 已结算时冻结提交与直接父基线，在结算事务内写一次父 Worker 信号并结束源 Worker；用户另用固定 commit + baseline 批准 main/owner 的快进，Git 串行区内复核双方 ref。同类重复 `worker.reserve` 不重建预约，而是显式重查 pending 状态：执行屏障、未读消息和子 Worker 等待原因也记在 `blocked_reason`，成功后由结算事务清掉；Web 的「复查预约」与 CLI 原命令共享此路径，不自动轮询外部 Git 变化。User-only `worker.resolve` 现仅保留为指令验收的兼容入口，委托 `acceptTask`；无改动回答与代码成果共用安全校验、审计与 Hook，不走独立结算。完整语义见[持续迭代](task-iteration.md)。

daemon 启动在 project identity/Store 建立后、RPC 开放前幂等执行 `Project.bootstrapMain()`：只有本地 main ref 存在才确立唯一静息 main Worker；无 main 时保持 daemon 可用、首次新指令给明确错误，不自动造 ref，也不触发 provider。恢复仍保留未知副作用不重放。

显式分支绑定：用户选定本地 `BRANCH` 与当时的 `HEAD COMMIT` 后，`branch.bind` 为非 main 且尚无新 Worker 所有者的分支创建独立、永不执行不受限 provider 的静息 `task_kind='owner'` 根 Worker。旧分支记录和旧 Worker 不回写；`branch.tree/show` 派生的新 owner 投影覆盖旧 task_id 的当前所有者显示，历史仍可按旧 Worker id 查看。无绑定的新指令继续拒绝，不猜祖先。

新指令入口增量：`order.submit(content?,branch?,references?)` 与旧 `input.submit` 分开，后者不再有公开入口；新 Input 直连 `role='agent'`、`task_kind='order'` 的 Worker，main 是 `task_kind='main'` 的静息根 Worker。`tasks.task_kind` 只加列不重写历史；新提交必须先校验父分支有明确的 Worker 所有者。实现职责放 `src/core/project/order.js`、现有 Git 边界与 Store，不新增全局调度器。

历史 Worker 中心路径的子代码只允许执行中的直接父 Agent 经 `worker.integrate {id,commit}` 确认固定 child HEAD（当前 v2 交付由父 runtime 队列推进，拒绝绕过） 并在 Git 串行锁下 ff-only 快进至父分支。新指令的 pending merge 请求若与直接父分支分歧，用户可 `worker.resolve_divergence {id}` 创建一个独立 child（基线固定为源 tip，目标固定为源指令分支，Worker 目标要求合入当时固定的父 tip 并测试）；活动指令的 child 挂在其子树下，由 `worker.integrate` 确认。父指令 Agent 收到子 Worker 完成信号后用 `worker.integrate` 确认固定 child commit；该确认额外校验 child commit 同时含最初源/父 tip，之后用户复查预约或自然轮末重新按最新父 tip 准入。兄弟子 Worker 先落地或父分支自己提交后，已完普通子 Worker 的固定提交同样不再能快进：执行中的直接父 Agent 用 `worker.resolve_child_divergence {id}` 从该固定提交拉起同构的解分歧子 Worker，解分歧后仍由 `worker.integrate` 确认。`worker.integrate` 不能推进 main；父分支不干净、HEAD 漂移、子 Worker 未结算或有未集成后代时保留现场并拒绝。实现放 `src/core/project/order.js`，Git 写入复用 `workspaces.mergeBranchUnsafe`。

Worker 中心输入的持久信号增量：`messages` 增加可空 `signal_type` / `signal_key`（旧自由文本消息不变），`(task_id,sender_id,signal_key)` 部分唯一索引保证子→父同一次信号只写一条；`Store.signal()` 与 `Project.sendTaskSignal()` 只供 runtime 内部使用，事务同写 Event/Message，先落库后唤醒。边界见[Worker 中心输入](task-centered-input-design.md)和[一次 invocation](invocation.md)。

问卷决策沿用 Notice，不新增表或实体：`src/core/questionnaire.js` 负责严格校验与答案规范化，`Project.notice` 保存 `kind='questionnaire'`，调度器通过 `questionPending` / `parkForQuestion` 暂停并恢复 invocation；Web 端由 `render-questionnaire.js` 渲染，预览路由使用 `notice-preview.js` 的独立 CSP 清洗 HTML。

## 分章地图

模块清单仍以本页为唯一入口，细表拆成三篇短章：

1. [Runtime 与持久化](modules-runtime.md)：Agent provider、Project、Workspaces 与 Store。
2. [Web 前端](modules-web.md)：浏览器模块、渲染职责与导出。
3. [CLI、RPC 与测试](modules-interfaces.md)：命令、协议与测试分区。

跨分区改动先从这里确认边界，再进入对应细表；新增或移动文件时必须同步更新所属章节。

---

[下一篇：Runtime 与持久化 →](modules-runtime.md)
