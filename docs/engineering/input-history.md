# 历史输入与缓冲区接口

本文面向维护者，记录项目级原始输入检索、草稿版本与发射的接缝。理念见[历史输入与缓冲区](../design/input-history.md)，用户操作见[历史输入与暂存](../input-history.md)。公开接口以 `src/rpc/registry.js` 为权威。

## 读面

以下 RPC 均为用户专属，Host 只按项目身份转发：

| RPC | HTTP | 参数 |
|---|---|---|
| `input.history` | `GET /api/inputs` | `cursor?`、`limit?`、`q?`、`status?`、`integration?`、`view?:'history'|'drafts'`、`conditional?`、`modes?:('order'|'append'|'management')[]` |
| `input.get` | `GET /api/input/{kind}/{id}` | `kind:'draft'|'input'|'message'|'management'`、`id` |
| `input.parents` | `GET /api/input-parents` | 无 |

历史列表返回 `{items,next_cursor}`，默认每页 50 条、最多 100 条，正文预览最多 1000 字并带 `content_truncated`。搜索在服务端针对完整正文进行，不是搜索预览或首页 Worker 窗口。省略 `view` 且没有 `conditional` 时等价于 `view:'history'`，仅收录实际发送的三种去向：`order` 为全部真实原始 Input；`append` 为来源已证明的普通用户追加 Message；`management` 包含 `task_kind='management'` 且持久 `management.origin='input'` 的即时管理目标，以及原 V 的可信用户管理追加 Message，不含定时信号绑定自身的目标。历史不包含任何尚未发送的草稿；已发送追加以真实 Message 身份列出，不以草稿代替，不虚构 O/A。时间取实际 Input／Message 的 `created_at`，不取源草稿暂存时间。

`view:'drafts'` 仅收录尚未实际发送的工作／追加／管理草稿：未授权、撤销、条件或准入等待、投递中、失败及未知；已关联 Input、成功发射，或已通过明确追加收据关联真实可信 Message 的草稿不再列出。原始 Input 固定 `mode:'order'`，草稿 mode 取 `input_options`（旧草稿默认 order）。管理管家通过既有 `manager.call` 调用同一个 `input.history {view:'drafts'}` 查暂存，目录从统一 RPC 注册表获得 `view`，不新增权限或旁路。草稿／历史分流先于搜索、状态、模式及分页，在全库 SQL 执行，不在浏览器或单页结果中过滤。

`modes` 省略表示三种全含，空数组返回空列表；未知值、重复值、非数组和非字符串成员严格拒绝。HTTP 用 JSON 数组编码，例如 `/api/inputs?modes=%5B%22append%22%2C%22management%22%5D`，不接受逗号分隔形式或重复 query 参数。模式与正文／状态／合并筛选均在全库 SQL 分页前执行；cursor 绑定视图及完整筛选（含规范化的模式集合），模式顺序不同不影响续读，省略与显式三种全选等价，集合改变须重新查询。所有 kind 按 `(created_at,kind,id)` 稳定倒序分页，同时间和跨 kind 同整数 ID 不会互相覆盖。旧的未绑定视图 cursor 须刷新，不改写历史行；省略 view 与显式 history 等价，不能跨 history／drafts／conditional 视图续读。

Message 来源必须由持久 `append_number` 或明确的用户 message Event 证明，不能仅看 `sender_id IS NULL` 或正文 JSON 外观。新 message Event 保存 `user_append` 以区分无原始 Input 的用户追加与运行时消息；Event 证明须同 Worker、整数 `message_id`、显式 `sender:null`，并有持久追加编号或 `user_append:true`；明确 `user_append:false` 优先排除，即使存在冲突的编号或 true 收据。旧 `sender:null` message Event 单独不构成证明，`task.input_routed/input_buffered` 也不构成证明，因为旧 Hook／plan 与 runtime opt-out 同样可能写这些事件。缺少追加编号且没有明确用户标记的历史消息保守排除，包括编号字段缺失或为 null 的记录；新增标记只增强今后记录，不改投递／生命周期，不回填、迁移或猜测。Worker 通信、Notice 答复、系统信号与 runtime opt-out 不进入列表／详情；用户正文即使看似 Notice JSON 也不改变来源。缺失 Worker 的原始 Input 仍保留。

### 原始目标与追加的提交者来源

`worker.inspect.goal_input_source` 与 Message／reading Event 的 `input_source` 共用安全对象 `{kind:'user'|'valet'|'worker'|'system'|'unknown',worker_id:正整数|null,worker_number:真实持久编号|null}`；reading message Event 顶层与 `data.input_source` 一致。仅 `user` 可显示当前登录名；Valet／Worker 优先真实编号，缺号回退 `#内部ID`，不得从 ID 推算编号。来源只说明谁提交了该目标／追加，不改变输入编号、投递时间或权限。

可信 Dispatcher 用户入口与已授权管理 bridge 从真实 actor 派生来源，公共 params 不接收来源字段。密码提权的原生 Valet 业务转发同样通过独立内部上下文保留真实 Valet 来源，不因调用用户级业务处理器而变成 user；该上下文只携带来源，不授予或扩大业务权限。挂载授权在既有 `drafts.emission` 和 `input.emitted` Event 保存来源，runtime 经条件、延迟或重启后原样传到 `input.anchor`／message Event；草稿的创建者不替代授权提交者。child 的目标由既有 `created` Event 保存实际提交者，不从开发父关系猜测；原始 Input 仍可继承，但不代表 child 的 goal 也是用户所写。普通 Valet `worker.message` 保留真实 sender；持久挂载的 Valet 追加不冒充用户追加、不分配 A 编号，空 Worker 的首条输入仍仅真实用户可授权。

旧记录不迁移或批量回填。缺少显式来源时，仅用精确成功管理收据、实际开始／完成 Event 与其间的唯一创建／挂载／发射身份只读恢复 Valet；重试返回旧挂载不能认领原作者。已有显式来源时不扫描管理收据；旧目标按索引 Event 身份先筛出最多100条相关成功调用，再精确读取这些 owner／receipt 的附属 JSON，不加载全项目管理私有状态，候选超预算保守为 `unknown`。收据不再保留、关联冲突或缺少证明时返回 `unknown`，不按正文、时间、空 sender 或父关系猜用户。旧挂载追加即使带 A 编号／`user_append:true`，也必须查原授权来源；普通非挂载追加沿用上文的明确用户证明。公开读面只输出安全来源，不输出管理私有 JSON 或请求参数。

`kind:'message'` 的 id 是真实 Message ID，`kind:'management'` 的 id 是真实 Valet task ID，均不是 O 编号。详情用与列表同一来源准入，只读返回完整 `content`、`references` 及公共状态／身份；两者目前没有引用附件，返回 `references:[]`。已发送追加的真实 Message 可按原身份读取，其来源准入不因草稿收据而放宽。`task_id/task_worker_number` 指向来源 Worker／Valet，Message 另带持久 `append_number`（旧缺号为 null，不造 A 编号）；不暴露 management 私有 JSON、模型运行配置、请求 key 或指纹，不新增写入口、表或权限。

条件发射功能在省略 `view` 时保留可选 `conditional:'configured'|'mounted'` 窄读面；显式 `view` 与 `conditional` 同传一律清晰拒绝（`view and conditional cannot be combined`），不推测优先级：`configured` 查询有条件／独占的草稿及保留的条件发射收据，包含尚未发射条目；`mounted` 仅查询保存过条件信号的发射草稿，包含等待、投递中、成功、失败、未知与撤销。此视图保留已经关联真实 Input 的草稿身份与安全 `dispatch`，不将追加收据变成 Input；普通历史不传此参数，已发送 order／append 仅按实际 Input／Message 展示，管理沿用上述来源范围；`modes` 可进一步筛选这些既有条件草稿，但不将 Message 或管理目标扩入条件视图。过滤在数据库全库分页之前完成，cursor 绑定包括 `conditional` 在内的完整筛选条件，不能跨视图复用。收据是每条保留草稿的最近一次授权状态，不是所有历史修订的执行日志；撤销后再编辑可能改变草稿正文，已保留条件证明仍以 `dispatch.conditions` 为准。读面不提供私有运行参数、请求指纹或信号快照。

历史／详情中的 Input 和 Message 另带 `source_draft_id:正整数|null`，只返回唯一、明确的持久关联，供定位 `input.get {kind:'draft',id}` 的条件／独占收据：普通 Input 使用 order 草稿的 `input_id`；手动容器经 append 草稿提交首条 Input 时，须同时证明当前 Input/Worker 互相归属、草稿 `input_id`、整数目标与成功 `emission.input_id/worker_id` 一致，并有同 Worker 的首条用户输入 Event 及同 draft/dispatch 的成功发射 Event；不能退回普通 order 弱关联，也不按正文／时间猜测。缺失、篡改、类型不符或多个有效来源均返回 null。Message 使用 append 草稿的整数 `emission.message_id`、整数目标 `input_options.target_id`，若有 `emission.worker_id` 也须一致。关联歧义、类型或目标不符均保守 null，绝不按正文、时间或顺序猜测；其它 kind 此字段为 null。成功发射的 order／append 草稿仍可按原 draft ID 获取收据，已转换且没有发射收据的旧 order 草稿保持原先不可读取边界。冻结缓冲的可信用户 Message 已真实入箱，归历史而非草稿；这不表示 Agent 已收到或处理，投递状态仍由原消息／调用读面证明。

条目包含 `kind`、`id`、`mode`、`draft_number`（非草稿为 null）、`append_number`（非 Message 为 null）、`source_draft_id`、`content`、`content_truncated`、`created_at`、`task_id`、`parent_id`、`branch`、`status`、`integration`、`merge_status`、`revision`。详情另返回完整正文和 `references`，草稿还返回 `mode,target_id,target_worker_number,conditions,exclusive,dispatch` 和兼容 `hook_mount:{parent_id,hook_id,state}|null`；Input 原文只读。缺失 Worker 的旧输入保留，状态为 `unknown`。

`status` 是历史页的只读投影：`draft`、`created`、`queued`、`running`、`waiting`、`awaiting`、`paused`、`awaiting_acceptance`、`completed`、`failed`、`cancelled`、`unknown`，以及挂载草稿的 `waiting_conditions|emitted|sent|emission_failed|unknown_dispatch`。`created` 区分从未调用 Agent 的 paused Worker；同时检查本轮调用数、终身唤醒数与 Run 记录，避免重试清零 calls 后误报待开始。不会反写 Worker 状态。

原始 `integration` 与展示用 `merge_status` 分开，后者为 `merging`、`blocked`、`merged`、`none`。列表查询参数 `integration` **按 `merge_status` 筛选**。当前有效交付预约优先于旧落地记录，不把上一轮合并解释成本轮已交付。Worker状态与合并状态可同时筛选。

父候选返回 `{items:[{id,branch,goal,freeze}]}`，包括可预约的有效冻结父，`freeze` 为冻结投影或 null；，从完整项目查询而非 overview 取最近Worker。查询检查最多 2000 个候选父，超限明确报错而不是伪装成完整列表。读面不创建 Worker 或调用 Agent；最终可写性由发射路径再次校验。

## 写面与并发保护

| RPC | 参数与行为 |
|---|---|
| `draft.add` | `{content,references?,branch?,mode?,target_id?,conditions?,exclusive?,client_request_id?}`：保存并返回完整 draft；新建省略 branch 时解析 canonical 当前分支所有者，追加必须指定 target_id |
| `draft.update` | `{id,content,references?,branch?,mode?,target_id?,conditions?,exclusive?,expected_revision}`：只更新未挂载条目，省略选项保留原值 |
| `draft.remove` | `{id,expected_revision}`：只删除未挂载条目，不删除 Input |
| `input.emit` 草稿路径 | `{draft_id,expected_revision,profile?,client_request_id?}`：模式、正文、条件及去向取已保存版本，不接受覆盖 |
| `input.emission_cancel` / `input.exclusive_release` | `{draft_id,expected_revision}`：分别撤销未执行授权或释放已经持有的独占意愿，不取消已创建工作 |

这些动作通过 `POST /api/action` 的窄白名单调用，不恢复 `input.submit` 或旧 `draft.commit`。`order.submit` 缺省及 `start:true` 同样是持久挂载；显式 `start:false` 保留旧仅创建路径。完整直接参数、条件上限及收据见[条件发射](conditional-emission.md)。

D705：草稿另有可空展示号 `draft_number`，草稿列表、详情、手动暂存／更新结果和发射收据均返回正整数或 null。只有主动 `draft.add` 暂存的新草稿从独立单调计数分配；直接 `input.emit`／`order.submit` 正文路径产生的内部发射草稿不占号。`drafts.draft_number` 为兼容新增 nullable INTEGER，`meta.draft_number_high` 在同一事务保存高水位，删除、发送、重启后均不复用号码；更新／发射原草稿保留原号。旧行保持 null，不回填、不改号；全部内部 ID、URL、RPC 参数、条件信号、源草稿关系和历史记录仍用原身份。Web 编号通过 `draft-label.js` 的 `draftLabel(record)` 统一显示：有号为「草稿 #N」，无号为「草稿记录 #内部ID」；仅有 `source_draft_id` 的链接称「提交草稿」，不把内部 ID 猜成展示号。计数分配区别仅在私有创建路径，不新增可让调用方控制编号的 RPC 参数。

新草稿 revision 从 1 递增。更新、删除与发射必须显式携带 `expected_revision`；旧草稿用显式 `null` 匹配尚无版本的历史行，不能省略字段绕过校验。旧草稿没有父身份时，先选择父 Worker 并保存，再发射。历史行不批量回填或改写。

发射先事务锁定草稿与精确授权，返回持久收据，再等待条件及父准入。实际创建仍沿用当前指令协议，在 Git 等待后复核父身份、冻结、草稿占用和独占门，成功才回写 `input_id`；追加成功仅关联 Message。重复请求不重复执行，参数改变或编辑／删除竞态明确拒绝。未知副作用不重放。

缓冲区不新增 Worker、不产生 Agent 调度信号；授权发射才挂载受保护条件 Hook。代码基线在实际创建时固定，不在暂存或挂载时冻结。

主输入框挂载成功后留在当前页面，不自动进入新 Worker 或预约父 Worker。`start:false` 真正创建成功时，`project/order.js` 在创建事务内记录 `task.start_pending` 并调用 `project/messages.js` 的 `notifyTaskLifecycle`，生成「待开始」纯告知；直接正文、草稿与 Hook 延迟创建共用此路径。Notice SQL 投影为 `lifecycle_type:'created'`，Web 复用告知条的查看 Worker／已知入口，并提供独立的页面与系统通知偏好。预约尚未创建、立即开始、用户暂停与重启恢复不产生此告知；不补发旧记录，不调用 Agent。

历史 `create_worker` 预约仍保存一次性创建 Hook，不创建 Input/Worker/worktree。挂载认领草稿版本并保护其正文与引用；占用中不可编辑、删除或重复发射。等待／明确失败挂载停用或移除可释放占用；unknown 须检查现场后移除，不自动重放。已结束父上的未执行自定义挂载仍可移除释放草稿。创建成功才回写 `input_id`。参数与恢复边界见 [Hooks](hooks.md)。

## 管理项目草稿与创建去重（D753／D754）

`mode:'management'` 由统一编辑器接线到同一草稿列表、详情和便携入口；服务器保存、普通授权与密码授权共用以下版本边界。

- `draft.add/update` 共用原 Draft ID、展示号、revision 和删除门。管理草稿 `parent_id/branch` 为 null，`target_id:null` 表示新建管家，正整数表示原生 V 管家；读面返回真实 `target_worker_number`。更新可显式传 null 清除管理目标，省略则保留。保存不创建 V、不占运行位，目标忙时可保存；不接受分支、非空引用、条件或独占，不保存运行权限／密码／可复用授权。切换回开发模式须显式选择父分支。
- 用户 `management.submit` 新增与 `instruction` 互斥的 `{draft_id,expected_revision,client_request_id?,profile?}` 路径。正文及新建／追加去向只取保存版本；`profile` 只允许新建 V，追加沿用原 V 模型。实际提交复用管家串行位与追加安全门，忙碌／退役／未收口时拒绝而不排队；失败不消费草稿。
- 成功返回 `{management:true,task,draft_id,draft_number,revision,dispatch}`。`dispatch` 为 `{kind:'management',state:'succeeded',worker_id,worker_number,occurrence_id,receipt_id,revision,authority:'ordinary'|'administrator',message_id?,created_at,finished_at,conditions:[],exclusive_active:false,...}`；succeeded 只证明该管理输入已接受，不证明模型或管理操作执行成功。管理输入与草稿消费在同一同步 SQLite 事务，保存／提交竞态复核精确 revision；落库任一步失败全部回滚。
- 消费后草稿只读，移出未发送列表，仍可用 `input.get {kind:'draft',id}` 查看；普通精确重试只返回原收据，不重启 occurrence。management 原文及管理追加 Message 提供可证明的 `source_draft_id`。管理追加历史保留 `kind:'message'`，`mode:'management'`，不造开发 Input/O/A；按 management 模式筛选，不再落入 append 模式。
- 密码提权完整定义可选绑定 `draft_id+expected_revision`，Host 签名与 daemon 均绑定原正文、保存版本、新建／原 V 目标；成功原子消费该草稿。`management.elevation_receipt` 的 found 响应同时带上述草稿收据字段。未知提权只读取精确原收据，不经普通提交补发；恢复草稿本身没有提权权限，下一次高权授权必须重新验密。详见[密码提权](administrator-valet.md)。
- 管理草稿写入／消费仅接受真实用户；普通开发 Agent、Valet `manager.call` 和项目管理员业务代理均不能创建、修改、删除或提交管理输入。既有 `input.emit`／`order.submit`（含 start:false）、旧内部开发提交均拒绝管理草稿，不因知道 draft ID 取得创建／续轮管理身份的能力。开发草稿的已有受控代理权限不变；CLI 的 draft submit 仍仅支持开发草稿。
- `draft.add.client_request_id` 可选，沿输入 key 的 1..128 字符、无外围空白／控制字符规则。同 key、同原始创建定义返回同一草稿当前版本，不同定义拒绝；事务内再次核验，跨并发／重启去重。同 key 的在途创建在异步父身份解析前合流，完成后仍以 SQLite 收据为权威。删除留下仅含哈希与整数关联的 tombstone，不重建已删除草稿；去重不会消费新的展示号。CLI `input draft create --client-request-id KEY` 使用同一接口。
- 精确请求哈希／关联保存在项目 meta，正文仍只属于原 Draft／Worker／Message。已消费管理草稿随用户精确确认删除的原 V 收据一起纳入数据库预检 revision 并删除；未发送草稿不因此消失。关联已删除或缺少完成证明时拒绝重放，不从正文／时间猜测身份，不回填旧数据。

## 实现职责

- `src/core/project/input-history.js`：公共草稿动作、父身份校验、历史详情与列表接缝。
- `src/persistence/store/input-history.js`：数据库有界分页与状态投影。
- `src/core/project/input-emissions.js`：持久授权、条件信号、独占及异步准入；`order.js` 保留实际创建原语。
- `src/ui/web/assets/render-inputs.js` / `styles-inputs.css`：`#inputs` 已发送历史与 `#drafts` 暂缓输入的独立页面、显式查询分页、暂存编辑及原文详情；`createInputBrowser` 提供同一编辑器的嵌入模式，不修改全局页面、地址或详情根。
- `src/ui/web/assets/automation-emission.js`：`renderEmissionAutomation({ownsPage,catalogue})` 返回功能正文 DOM，`ready` 为初始读取 Promise，`setSubpage('settings'|'history')` 切换正文（默认设置），`dispose()` 释放编辑器并使迟到响应失效；父页面负责标题、返回与标签。标签往返保留未保存编辑，写入沿用单条草稿版本、请求去重与独立授权。
- `src/ui/web/assets/composer.js` / `composer-workspace.js`：主输入快捷键与授权、浮动入口、按模式／目标隔离的本页编辑及原位暂存恢复；父候选使用独立完整读面。
- `src/ui/web/assets/draft-editor.js`：共用可编辑性、版本更新及开发／管理精确版本授权接缝，不新增 RPC 或持久化实体。
- `input-session.js`：每条 workspace entry 唯一的保存／授权队列、原定义创建去重与冲突基线；`unified-input-editor.js`：唯一 form／textarea 的 portable／detail／embedded 挂载、离开自动保存和显式冲突整理。宿主不持有第二份正文或版本。

前端显式查询与刷新历史，不随 overview 重画编辑内容；所有异步响应核对页面身份，失败保留编辑，发射按钮单飞。CLI 不恢复旧 draft 命令，也不新增批量提交。

两个列表复用资源页的页头、筛选容器与卡片样式，原文使用原生链接、草稿使用原生 button 进入独立详情，不内嵌写操作。历史突出正文摘要、类型、编号与实际发送时间，默认三模式全选，Worker／合并筛选放在默认收起的高级筛选；草稿在工作暂存／追加输入暂存／管理暂存间单选，常显去向、条件摘要与授权状态，类别在全库分页前筛选。

`openInputs({section?:'history'|'drafts',item?:{kind,id},push?:boolean})` 复用编辑器但不混合页面身份：`#inputs` 属于 `ui.view.id='inputs'`，`#drafts` 和 `#input-draft-<id>` 属于 `drafts`；Input／Message／management 原文深链接归历史。旧条件提交 hash 转至草稿。同页往返保留查询、分页、滚动和本地编辑；追加深链接同步分类，分类变化使旧查询和分页失效；离开当前条目先经共享保存队列，失败阻止离开，迟到读响应不能重开旧详情。版本冲突展示服务器最新版，由用户明确选择整理，不要求复制。

主输入默认收起，菜单按模式投影同一批未完成条目；恢复精确 entry key，不跟随阅读页改投。`composer-cache.js`／`prefs.js` v2 快照按项目保存正文、引用、目标、条件、本条 profile、位置、草稿版本及原始创建请求；旧 v1 仅在本项目无 v2 时发现，不删除旧数据。缓存的 Worker 简介不证明目标可提交，恢复后用 `/api/worker/:id` 核验；失败保留编辑、禁用授权，不改投。浏览器恢复不包含密码／管理员选择，也不承诺崩溃前异步服务器保存。

同一条目只有一个 session、一个受控组件；挂载移动原 form，正文撤销栈随 entry 保留。`createUnifiedInputEditor` 提供 bind／mount／detail／continuePortable／save／submit／leave／detach／dispose，workspace 建立或恢复本地条目、真实草稿身份。离开整条编辑（互切、收起、换条目／去向、站内导航）调用 leave，与手动保存和授权共用队列；不监听普通 blur。`page-leave-guard.js` 只有一个协调器，以有界 input-session 与 page 槽顺序核验，页面保护不能覆盖输入保护。拒绝时恢复当前路由，不执行导航续体；项目、编辑身份与请求代次共同阻止迟到响应。

首次创建在发送前缓存稳定 key 和原定义；未知创建只重查同 key／同定义，收到当前版本后才保存后续编辑，不编辑后换 key 重建。保存保留内容和 ID，之后 `draft.update {expected_revision}`。冲突暂停更新、保留本地，显式读取服务器版本后选择基线整理；不可编辑的服务器版本可显式脱离为新本地条目。提交先保存再授权精确 revision；管理只走 management.submit／专用密码入口，绝不调用 input.emit。接受后消费原条目并显示真实收据；请求期间新编辑脱离已消费草稿，不被旧回调清空。

空框方向键和可见续写入口共用完整分页查找；新建匹配父，追加／管理匹配原目标。先读完整详情核验 id、mode、revision、引用和可编辑状态；等待、unknown、成功及旧 Hook 占用不作为普通草稿恢复。游标核验 entry、读取代次、正文与引用版本，编辑或切换即失效。

删除只在详情独立危险区，经确认调用 `draft.remove {id,expected_revision}`；确认／请求占用同一条目的操作锁，导航和提交不得绕过。成功清除对应浏览器恢复身份，确认／请求期间的新编辑脱离原草稿保留；失败与冲突不清空、不自动重试。同目标其它条目不受影响。

底部仅显示条件／独占摘要、基础工具和主要动作，不提供高级菜单。详情可编辑去向，工作／追加条件默认展开；嵌入条件自动化仍默认收起，收据留在嵌入宿主、不修改全局路由。运行设置与引用完整信息按需展开，已有设置有摘要。两处 Enter／Shift+Enter 换行、Ctrl/⌘+S 保存、Ctrl/⌘(+Shift)+Enter 先保存再授权，IME、重复按键和在途编辑受同一保护；管理也保存项目草稿，但无条件／附件。

挂载 ACK 后消费编辑器并呈现只读发射收据，不等待全局刷新。实际获得 `input_id` 后才可转到历史 Order 原文；追加收据通过「查看已入箱追加原文」打开真实 Message/A 原文，不造 O。历史 Input／Message 用明确 `source_draft_id` 提供条件／独占收据入口，服务端显式 null 不得被前端旧缓存推翻；独占草稿保留合法释放入口，成功源草稿从列表移除但仍可寻址。后读失败不恢复已消费编辑器、不猜测 Input 关联或扫描全库。返回列表刷新草稿版本；所有迟到响应服从页面身份保护，不伪造 O 编号。

## 验证入口与边界

当前保留 `test/project/input-history.test.js` 的草稿编辑／发射主流程，以及 `test/web/dom-inputs-api.test.js` 的真实临时 HTTP／RPC／SQLite／Git 链；不连接用户项目。键盘模式、条件历史、迟到响应和冻结等组合不再逐项回归；精确 Web 入口用 `bun run test:integration --list` 查询，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。
- `bun run scripts/check-input-modes-ui.js`：隔离 Firefox 真实项目页与 iframe，验证双主题 1440/900/390px 三色模式开关、默认全选、单模式／全不选、追加只读详情与无溢出，不连接 daemon／模型。
- `bun run scripts/check-input-history-ui.js`：共享 Firefox/app-shell fixture 与 iframe，双主题 1440/900/390/320px 验证原 DOM／草稿 ID 双向续写、自动保存、正式层级、三类草稿、管理精确版本授权及只读收据。
- `bun run scripts/check-composer-layout.js`：复用同一 Firefox 检查，1440/760/390/320px 验证便携／详情互切、可见基础工具、三模式线型、Agent 标识、44px 窄屏控件和无溢出。
- `bun run test/web/check-mobile-composer-browser.js`：同一来源的真实窄 iframe／双主题检查，加 VisualViewport 软键盘模拟；不等同于 iOS／Android 真机。三入口均不连接 daemon／模型，退出清理自己的浏览器和服务。
- `test/web/dom-inputs-api.test.js`：仅保留真实临时 HTTP／RPC／SQLite／Git 链上的追加输入与草稿恢复、修改、发射主流程，不调用模型。浏览器缓存、黄点、键盘、旧快照、失败／迟到隔离及组合矩阵不再独立自动回归。

缓冲区上限 500 条。无已绑定父 Worker 或 detached HEAD 时，暂存需先明确选择有效父Worker；失败保留输入，不自动新建任意 owner。当前不提供批量发射、任意 Worker 消息的全局全文检索或原始 Input 改写；普通用户追加仅在来源有持久证明时纳入历史检索；不将其它 Worker 消息或信号变成用户输入。
