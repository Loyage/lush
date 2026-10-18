# 历史输入与缓冲区接口

本文面向维护者，记录项目级原始输入检索、草稿版本与发射的接缝。理念见[历史输入与缓冲区](../design/input-history.md)，用户操作见[历史输入与暂存](../input-history.md)。公开接口以 `src/rpc/registry.js` 为权威。

## 读面

以下 RPC 均为用户专属，Host 只按项目身份转发：

| RPC | HTTP | 参数 |
|---|---|---|
| `input.history` | `GET /api/inputs` | `cursor?`、`limit?`、`q?`、`status?`、`integration?`、`view?:'history'|'drafts'`、`conditional?`、`modes?:('order'|'append'|'management')[]` |
| `input.get` | `GET /api/input/{kind}/{id}` | `kind:'draft'|'input'|'message'|'management'`、`id` |
| `input.parents` | `GET /api/input-parents` | 无 |

历史列表返回 `{items,next_cursor}`，默认每页 50 条、最多 100 条，正文预览最多 1000 字并带 `content_truncated`。搜索在服务端针对完整正文进行，不是搜索预览或首页 Worker 窗口。省略 `view` 且没有 `conditional` 时等价于 `view:'history'`，仅收录实际发送的三种去向：`order` 为全部真实原始 Input；`append` 为来源已证明的普通用户追加 Message；`management` 仅包含 `task_kind='management'` 且持久 `management.origin='input'` 的即时主输入框管理目标，不含定时信号绑定。历史不包含任何尚未发送的草稿；已发送追加以真实 Message 身份列出，不以草稿代替，不虚构 O/A。时间取实际 Input／Message 的 `created_at`，不取源草稿暂存时间。

`view:'drafts'` 仅收录尚未实际发送的工作／追加草稿：未授权、撤销、条件或准入等待、投递中、失败及未知；已关联 Input、成功发射，或已通过明确追加收据关联真实可信 Message 的草稿不再列出。原始 Input 固定 `mode:'order'`，草稿 mode 取 `input_options`（旧草稿默认 order）。管理管家通过既有 `manager.call` 调用同一个 `input.history {view:'drafts'}` 查暂存，目录从统一 RPC 注册表获得 `view`，不新增权限或旁路。草稿／历史分流先于搜索、状态、模式及分页，在全库 SQL 执行，不在浏览器或单页结果中过滤。

`modes` 省略表示三种全含，空数组返回空列表；未知值、重复值、非数组和非字符串成员严格拒绝。HTTP 用 JSON 数组编码，例如 `/api/inputs?modes=%5B%22append%22%2C%22management%22%5D`，不接受逗号分隔形式或重复 query 参数。模式与正文／状态／合并筛选均在全库 SQL 分页前执行；cursor 绑定视图及完整筛选（含规范化的模式集合），模式顺序不同不影响续读，省略与显式三种全选等价，集合改变须重新查询。所有 kind 按 `(created_at,kind,id)` 稳定倒序分页，同时间和跨 kind 同整数 ID 不会互相覆盖。旧的未绑定视图 cursor 须刷新，不改写历史行；省略 view 与显式 history 等价，不能跨 history／drafts／conditional 视图续读。

Message 来源必须由持久 `append_number` 或明确的用户 message Event 证明，不能仅看 `sender_id IS NULL` 或正文 JSON 外观。新 message Event 保存 `user_append` 以区分无原始 Input 的用户追加与运行时消息；Event 证明须同 Worker、整数 `message_id`、显式 `sender:null`，并有持久追加编号或 `user_append:true`；明确 `user_append:false` 优先排除，即使存在冲突的编号或 true 收据。旧 `sender:null` message Event 单独不构成证明，`task.input_routed/input_buffered` 也不构成证明，因为旧 Hook／plan 与 runtime opt-out 同样可能写这些事件。缺少追加编号且没有明确用户标记的历史消息保守排除，包括编号字段缺失或为 null 的记录；新增标记只增强今后记录，不改投递／生命周期，不回填、迁移或猜测。Worker 通信、Notice 答复、系统信号与 runtime opt-out 不进入列表／详情；用户正文即使看似 Notice JSON 也不改变来源。缺失 Worker 的原始 Input 仍保留。

`kind:'message'` 的 id 是真实 Message ID，`kind:'management'` 的 id 是真实 Valet task ID，均不是 O 编号。详情用与列表同一来源准入，只读返回完整 `content`、`references` 及公共状态／身份；两者目前没有引用附件，返回 `references:[]`。已发送追加的真实 Message 可按原身份读取，其来源准入不因草稿收据而放宽。`task_id/task_worker_number` 指向来源 Worker／Valet，Message 另带持久 `append_number`（旧缺号为 null，不造 A 编号）；不暴露 management 私有 JSON、模型运行配置、请求 key 或指纹，不新增写入口、表或权限。

条件发射功能在省略 `view` 时保留可选 `conditional:'configured'|'mounted'` 窄读面；显式 `view` 与 `conditional` 同传一律清晰拒绝（`view and conditional cannot be combined`），不推测优先级：`configured` 查询有条件／独占的草稿及保留的条件发射收据，包含尚未发射条目；`mounted` 仅查询保存过条件信号的发射草稿，包含等待、投递中、成功、失败、未知与撤销。此视图保留已经关联真实 Input 的草稿身份与安全 `dispatch`，不将追加收据变成 Input；普通历史不传此参数，已发送 order／append 仅按实际 Input／Message 展示，管理沿用上述来源范围；`modes` 可进一步筛选这些既有条件草稿，但不将 Message 或管理目标扩入条件视图。过滤在数据库全库分页之前完成，cursor 绑定包括 `conditional` 在内的完整筛选条件，不能跨视图复用。收据是每条保留草稿的最近一次授权状态，不是所有历史修订的执行日志；撤销后再编辑可能改变草稿正文，已保留条件证明仍以 `dispatch.conditions` 为准。读面不提供私有运行参数、请求指纹或信号快照。

历史／详情中的 Input 和 Message 另带 `source_draft_id:正整数|null`，只返回唯一、明确的持久关联，供定位 `input.get {kind:'draft',id}` 的条件／独占收据：Input 使用 order 草稿的 `input_id`；Message 使用 append 草稿的整数 `emission.message_id`、整数目标 `input_options.target_id`，若有 `emission.worker_id` 也须一致。关联歧义、类型或目标不符均保守 null，绝不按正文、时间或顺序猜测；其它 kind 此字段为 null。成功发射的 order／append 草稿仍可按原 draft ID 获取收据，已转换且没有发射收据的旧 order 草稿保持原先不可读取边界。冻结缓冲的可信用户 Message 已真实入箱，归历史而非草稿；这不表示 Agent 已收到或处理，投递状态仍由原消息／调用读面证明。

条目包含 `kind`、`id`、`mode`、`append_number`（非 Message 为 null）、`source_draft_id`、`content`、`content_truncated`、`created_at`、`task_id`、`parent_id`、`branch`、`status`、`integration`、`merge_status`、`revision`。详情另返回完整正文和 `references`，草稿还返回 `mode,target_id,target_worker_number,conditions,exclusive,dispatch` 和兼容 `hook_mount:{parent_id,hook_id,state}|null`；Input 原文只读。缺失 Worker 的旧输入保留，状态为 `unknown`。

`status` 是历史页的只读投影：`draft`、`created`、`queued`、`running`、`waiting`、`awaiting`、`paused`、`awaiting_acceptance`、`completed`、`failed`、`cancelled`、`unknown`，以及挂载草稿的 `waiting_conditions|emitted|sent|emission_failed|unknown_dispatch`。`created` 区分从未调用 Agent 的 paused Worker；同时检查本轮调用数、终身唤醒数与 Run 记录，避免重试清零 calls 后误报待开始。不会反写 Worker 状态。

原始 `integration` 与展示用 `merge_status` 分开，后者为 `merging`、`blocked`、`merged`、`none`。列表查询参数 `integration` **按 `merge_status` 筛选**。当前有效交付预约优先于旧落地记录，不把上一轮合并解释成本轮已交付。Worker状态与合并状态可同时筛选。

父候选返回 `{items:[{id,branch,goal,freeze}]}`，包括可预约的有效冻结父，`freeze` 为冻结投影或 null；，从完整项目查询而非 overview 取最近Worker。查询检查最多 2000 个候选父，超限明确报错而不是伪装成完整列表。读面不创建 Worker 或调用 Agent；最终可写性由发射路径再次校验。

## 写面与并发保护

| RPC | 参数与行为 |
|---|---|
| `draft.add` | `{content,references?,branch?,mode?,target_id?,conditions?,exclusive?}`：保存并返回完整 draft；新建省略 branch 时解析 canonical 当前分支所有者，追加必须指定 target_id |
| `draft.update` | `{id,content,references?,branch?,mode?,target_id?,conditions?,exclusive?,expected_revision}`：只更新未挂载条目，省略选项保留原值 |
| `draft.remove` | `{id,expected_revision}`：只删除未挂载条目，不删除 Input |
| `input.emit` 草稿路径 | `{draft_id,expected_revision,profile?,client_request_id?}`：模式、正文、条件及去向取已保存版本，不接受覆盖 |
| `input.emission_cancel` / `input.exclusive_release` | `{draft_id,expected_revision}`：分别撤销未执行授权或释放已经持有的独占意愿，不取消已创建工作 |

这些动作通过 `POST /api/action` 的窄白名单调用，不恢复 `input.submit` 或旧 `draft.commit`。`order.submit` 缺省及 `start:true` 同样是持久挂载；显式 `start:false` 保留旧仅创建路径。完整直接参数、条件上限及收据见[条件发射](conditional-emission.md)。

新草稿 revision 从 1 递增。更新、删除与发射必须显式携带 `expected_revision`；旧草稿用显式 `null` 匹配尚无版本的历史行，不能省略字段绕过校验。旧草稿没有父身份时，先选择父 Worker 并保存，再发射。历史行不批量回填或改写。

发射先事务锁定草稿与精确授权，返回持久收据，再等待条件及父准入。实际创建仍沿用当前指令协议，在 Git 等待后复核父身份、冻结、草稿占用和独占门，成功才回写 `input_id`；追加成功仅关联 Message。重复请求不重复执行，参数改变或编辑／删除竞态明确拒绝。未知副作用不重放。

缓冲区不新增 Worker、不产生 Agent 调度信号；授权发射才挂载受保护条件 Hook。代码基线在实际创建时固定，不在暂存或挂载时冻结。

主输入框挂载成功后留在当前页面，不自动进入新 Worker 或预约父 Worker。`start:false` 真正创建成功时，`project/order.js` 在创建事务内记录 `task.start_pending` 并调用 `project/messages.js` 的 `notifyTaskLifecycle`，生成「待开始」纯告知；直接正文、草稿与 Hook 延迟创建共用此路径。Notice SQL 投影为 `lifecycle_type:'created'`，Web 复用告知条的查看 Worker／已知入口，并提供独立的页面与系统通知偏好。预约尚未创建、立即开始、用户暂停与重启恢复不产生此告知；不补发旧记录，不调用 Agent。

历史 `create_worker` 预约仍保存一次性创建 Hook，不创建 Input/Worker/worktree。挂载认领草稿版本并保护其正文与引用；占用中不可编辑、删除或重复发射。等待／明确失败挂载停用或移除可释放占用；unknown 须检查现场后移除，不自动重放。已结束父上的未执行自定义挂载仍可移除释放草稿。创建成功才回写 `input_id`。参数与恢复边界见 [Hooks](hooks.md)。

## 实现职责

- `src/core/project/input-history.js`：公共草稿动作、父身份校验、历史详情与列表接缝。
- `src/persistence/store/input-history.js`：数据库有界分页与状态投影。
- `src/core/project/input-emissions.js`：持久授权、条件信号、独占及异步准入；`order.js` 保留实际创建原语。
- `src/ui/web/assets/render-inputs.js` / `styles-inputs.css`：`#inputs` 已发送历史与 `#drafts` 暂缓输入的独立页面、显式查询分页、暂存编辑及原文详情；`createInputBrowser` 提供同一编辑器的嵌入模式，不修改全局页面、地址或详情根。
- `src/ui/web/assets/automation-emission.js`：`renderEmissionAutomation({ownsPage,catalogue})` 返回功能正文 DOM，`ready` 为初始读取 Promise，`setSubpage('settings'|'history')` 切换正文（默认设置），`dispose()` 释放编辑器并使迟到响应失效；父页面负责标题、返回与标签。标签往返保留未保存编辑，写入沿用单条草稿版本、请求去重与独立授权。
- `src/ui/web/assets/composer.js` / `composer-workspace.js`：主输入快捷键与授权、浮动入口、按模式／目标隔离的本页编辑及原位暂存恢复；父候选使用独立完整读面。
- `src/ui/web/assets/draft-editor.js`：主输入与草稿页共用的可编辑性、版本更新及精确版本授权接缝，不新增 RPC 或持久化实体。

前端显式查询与刷新历史，不随 overview 重画编辑内容；所有异步响应核对页面身份，失败保留编辑，发射按钮单飞。CLI 不恢复旧 draft 命令，也不新增批量提交。

两个列表复用资源页的页头、筛选容器与卡片样式，原文使用原生链接、草稿使用原生 button 进入独立详情，不内嵌写操作。历史突出正文摘要、类型、编号与实际发送时间，默认三模式全选，Worker／合并筛选放在默认收起的高级筛选；草稿在工作暂存／追加输入暂存间单选，常显去向、条件摘要与授权状态，类别在全库分页前筛选。

`openInputs({section?:'history'|'drafts',item?:{kind,id},push?:boolean})` 复用编辑器但不混合页面身份：`#inputs` 属于 `ui.view.id='inputs'`，`#drafts` 和 `#input-draft-<id>` 属于 `drafts`；Input／Message／management 原文深链接归历史。旧条件提交 hash 转至草稿。同页往返保留查询、分页、滚动和本地编辑；追加深链接同步分类，分类变化使旧查询和分页失效；离页未保存编辑须确认，迟到读响应不能重开旧详情。版本冲突仍须先保留本地修改，再刷新读取。

主输入面板默认收起，导航只收起、不取消绑定的追加目标；详情页读取只可刷新同一目标，不能用另一 Worker 的状态替换编辑归属。模式、目标及恢复草稿的身份分别隔离本页内容，收起不是服务器暂存。续写通过既有 `input.history {view:'drafts'}` 查完所有分页，按模式与目标匹配可编辑记录，再读取完整详情核验；等待、结果未知、已发送或旧 Hook 占用记录不开放续写。恢复保留原 `id/revision`、去向、引用、条件与独占，保存调用 `draft.update`，授权调用 `input.emit {draft_id,expected_revision}`；版本冲突保留本地内容，不自动覆盖。迟到读取校验编辑身份、请求代次、正文与引用版本；在途新编辑不被旧提交清空，也不继续绑定已授权草稿。

主输入框不提供条件配置入口，但恢复已有条件草稿时保留条件摘要与「按条件提交」；Ctrl/⌘+Enter 与 Ctrl/⌘+Shift+Enter 同样提交执行授权（内部仍为发射）。独立草稿详情默认展开执行条件，静息／独占高级项及运行参数按需展开；条件输入功能的嵌入编辑器仍默认收起条件表单。通过「执行条件设置」收起或展开，均保留本地设置；入口简要标注已有条件／独占，唯一发射动作按当前配置显示「提交指令／提交追加」或「按条件提交」，调用 `input.emit`，不以 ACK 冒充创建完成。保存按钮比较正文、目标、引用、条件和独占，恢复原值、保存成功后变灰；仅运行参数变动不启用保存。Ctrl/⌘+S 在活动可编辑详情内调用同一保存路径，IME、请求单飞、干净状态和页面身份均受保护；正文撤销／重做也同步保存状态，不新增发射快捷键。

挂载 ACK 后消费编辑器并呈现只读发射收据，不等待全局刷新。实际获得 `input_id` 后才可转到历史 Order 原文；追加收据通过「查看已入箱追加原文」打开真实 Message/A 原文，不造 O。历史 Input／Message 用明确 `source_draft_id` 提供条件／独占收据入口，服务端显式 null 不得被前端旧缓存推翻；独占草稿保留合法释放入口，成功源草稿从列表移除但仍可寻址。后读失败不恢复已消费编辑器、不猜测 Input 关联或扫描全库。返回列表刷新草稿版本；所有迟到响应服从页面身份保护，不伪造 O 编号。

## 验证入口与边界

当前保留 `test/project/input-history.test.js`、Web 输入历史 API 与编辑／发送主流程，以及 `test/web/dom-inputs-api.test.js` 的真实临时 HTTP／RPC／SQLite／Git 链；不连接用户项目。键盘模式、条件历史、迟到响应和冻结等组合不再逐项回归；精确 Web 入口用 `bun run test:integration --list` 查询，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。
- `bun run scripts/check-input-modes-ui.js`：隔离 Firefox 真实项目页与 iframe，验证双主题 1440/900/390px 三色模式开关、默认全选、单模式／全不选、追加只读详情与无溢出，不连接 daemon／模型。
- `bun run scripts/check-input-history-ui.js`：Firefox/geckodriver 真实 app shell 与 fixture API，用 iframe 浏览上下文实际验证双主题 1440/900/390px 的独立导航、发送边界、暂存分类／摘要、原文只读、条件默认展开与高级项收起、窄屏无溢出，以及后退、Ctrl+S、提交收据和历史原文往返；不连接 daemon／模型，不代替手机真机验收。
- `bun run scripts/check-composer-layout.js`：真实 `/p/<id>/` 项目页与 fixture API；Firefox iframe 验证三模式的字段线型与项目配色、双主题、1440/760/390/320px、长标题、冻结／阻塞目标、Enter 投递、追加 ACK 恢复新建，以及导航收起而不改投。不连接 daemon 或模型，运行后清理服务与浏览器进程。

- `bun run test/web/check-mobile-composer-browser.js`：隔离 Firefox iframe 验证 320/390/760/1440px、双主题、默认零表单占位、文字菜单、停靠不遮挡阅读、44px 控件、扩大／收起与一次恢复、阅读位置、原位草稿更新及版本授权，保留页头／导航和回车／撤销／追加／创建回归。软键盘通过 VisualViewport 模拟，不等同于 iOS／Android 真机验收。
- `test/web/dom-floating-composer.test.js` 与 `test/web/dom-inputs-api.test.js`：覆盖独立目标、本页编辑、全分页恢复、条件／版本、迟到响应与单飞；真实临时 HTTP／RPC／SQLite／Git 链验证新建与追加续写更新原草稿、重复授权不重复投递及权限拒绝，不调用模型。

缓冲区上限 500 条。无已绑定父 Worker 或 detached HEAD 时，暂存需先明确选择有效父Worker；失败保留输入，不自动新建任意 owner。当前不提供批量发射、任意 Worker 消息的全局全文检索或原始 Input 改写；普通用户追加仅在来源有持久证明时纳入历史检索；不将其它 Worker 消息或信号变成用户输入。
