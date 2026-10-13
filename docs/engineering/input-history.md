# 历史输入与缓冲区接口

本文面向维护者，记录项目级原始输入检索、草稿版本与发射的接缝。理念见[历史输入与缓冲区](../design/input-history.md)，用户操作见[历史输入与暂存](../input-history.md)。公开接口以 `src/rpc/registry.js` 为权威。

## 读面

以下 RPC 均为用户专属，Host 只按项目身份转发：

| RPC | HTTP | 参数 |
|---|---|---|
| `input.history` | `GET /api/inputs` | `cursor?`、`limit?`、`q?`、`status?`、`integration?`、`conditional?` |
| `input.get` | `GET /api/input/{kind}/{id}` | `kind:'draft'|'input'`、`id` |
| `input.parents` | `GET /api/input-parents` | 无 |

历史列表返回 `{items,next_cursor}`，默认每页 50 条、最多 100 条，正文预览最多 1000 字并带 `content_truncated`。搜索在服务端针对完整正文进行，不是搜索预览或首页 Worker 窗口。列表包含未发射 Draft 与全部 Input；已创建 order 的草稿通过 `input_id` 保留审计联系，不作为第二条历史记录列出；等待条件／准入与已发送 append 草稿仍展示，不虚构 Input。

条件发射功能使用可选 `conditional:'configured'|'mounted'` 窄读面：`configured` 查询有条件／独占的草稿及保留的条件发射收据，包含尚未发射条目；`mounted` 仅查询保存过条件信号的发射草稿，包含等待、投递中、成功、失败、未知与撤销。此视图保留已经关联真实 Input 的草稿身份与安全 `dispatch`，不将追加收据变成 Input；普通历史不传此参数，仍只列出实际创建后的 Input。过滤在数据库全库分页之前完成，cursor 绑定包括 `conditional` 在内的完整筛选条件，不能跨视图复用。收据是每条保留草稿的最近一次授权状态，不是所有历史修订的执行日志；撤销后再编辑可能改变草稿正文，已保留条件证明仍以 `dispatch.conditions` 为准。读面不提供私有运行参数、请求指纹或信号快照。

条目包含 `kind`、`id`、`content`、`content_truncated`、`created_at`、`task_id`、`parent_id`、`branch`、`status`、`integration`、`merge_status`、`revision`。详情另返回完整正文和 `references`，草稿还返回 `mode,target_id,target_worker_number,conditions,exclusive,dispatch` 和兼容 `hook_mount:{parent_id,hook_id,state}|null`；Input 原文只读。缺失 Worker 的旧输入保留，状态为 `unknown`。

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
- `src/ui/web/assets/render-inputs.js` / `styles-inputs.css`：`#inputs` 页面、显式查询与分页、暂存编辑、原文详情；`createInputBrowser` 提供同一编辑器的嵌入模式，不修改全局页面、地址或详情根。
- `src/ui/web/assets/automation-emission.js`：`renderEmissionAutomation({ownsPage,catalogue})` 返回功能正文 DOM，`ready` 为初始读取 Promise，`setSubpage('settings'|'history')` 切换正文（默认设置），`dispose()` 释放编辑器并使迟到响应失效；父页面负责标题、返回与标签。标签往返保留未保存编辑，写入沿用单条草稿版本、请求去重与独立授权。
- `src/ui/web/assets/composer.js`：主输入框快捷键、暂存与直接发送，独立完整父候选读面。

前端显式查询与刷新历史，不随 overview 重画编辑内容；所有异步响应核对页面身份，失败保留编辑，发射按钮单飞。CLI 不恢复旧 draft 命令，也不新增批量提交。

列表复用资源页的页头、筛选容器与卡片样式，条目等高，仅显示两行正文摘要、编号/时间和独立Worker/合并徽章。整条使用原生 button 进入详情，列表不内嵌 Worker 跳转、引用或草稿操作。`#inputs` 是列表；`#input-draft-<id>` / `#input-input-<id>` 是可直接打开的独立详情，仍归属 `ui.view.id='inputs'`。`openInputs({item?:{kind,id},push?:boolean})` 共用同一页面身份；同页往返保留列表查询、已加载分页、滚动位置和未保存编辑，切换条目仍检查编辑保护；详情不再提供单独重新读取按钮，版本冲突引导先复制本地修改再刷新页面。返回列表使在途详情响应失效，不会被迟到响应重新打开。

主输入框不提供条件发射入口，Ctrl/⌘+Enter 与 Ctrl/⌘+Shift+Enter 同样直接发射。草稿详情（含条件输入功能的嵌入编辑器）默认收起条件与独占表单，显式点击「条件发射设置」才展开，收起保留本地设置；入口简要标注已有条件／独占，唯一发射动作按当前配置显示「发射」或「按条件发射」，调用 `input.emit`，不以 ACK 冒充创建完成。保存按钮比较正文、目标、引用、条件和独占，恢复原值、保存成功后变灰；仅运行参数变动不启用保存。Ctrl/⌘+S 在活动可编辑详情内调用同一保存路径，IME、请求单飞、干净状态和页面身份均受保护；正文撤销／重做也同步保存状态，不新增发射快捷键。

挂载 ACK 后消费编辑器并呈现只读发射收据，不等待全局刷新。实际获得 `input_id` 后才可转换为 Order 原文，独占草稿保留可定位的释放入口；append 保持 Message/A 收据。后读失败不恢复已消费编辑器、不猜测 Input 关联或扫描全库。返回列表刷新草稿版本；所有迟到响应服从页面身份保护，不伪造 O 编号。

## 验证入口与边界

- `test/project/input-history.test.js`：状态、全库搜索分页、父身份、重开持久化、乐观锁和发射/编辑/删除竞态。
- `test/web/input-history.test.js`：HTTP 路由与参数白名单。
- `test/project/conditional-input-history.test.js` / `test/web/dom-automation-emission.test.js`：条件输入全库分页、成功后收据、安全投影与嵌入编辑、分页、标签保留、跨项目／离页迟到保护。
- `test/web/dom-input-buffer.test.js` / `dom-inputs.test.js`：键盘、输入法、单飞、编辑与迟到响应保护。
- `test/web/dom-inputs-api.test.js`：真实临时 HTTP/RPC/SQLite/Git 串联暂存、搜索、修订保存、挂载后实际创建及原始引用回看，不连接用户项目。
- `bun scripts/check-input-history-ui.js`：Firefox/geckodriver 临时 fixture，验证双主题 1440/900/500px 实际视口的等高列表/详情布局、浏览器后退与键盘交互；Firefox 将请求的 390px 窗口限制为 500px 视口，不据此声称验证了 390px。
- `bun run scripts/check-composer-layout.js`：实际 `/p/<id>/` 项目页和 fixture API；Firefox 验证只有 textarea 区分新建实线／追加虚线，表单／图标／目标条无外框，整个输入区域统一项目色染色、聚焦不叠加描边且保留线型、常驻加粗目标、两种模式均沿用六种项目配色、双主题、聚焦／失焦、长标题、冻结／阻塞目标保留、Enter 真实投递、追加 ACK 自动恢复新建及导航退出。用真实 iframe 浏览上下文绕过 Firefox 顶层最小窗口限制，实际测试 1440/900/390px 视口；不连接 daemon 或模型，运行后清理服务与浏览器进程。

- `bun run test/web/check-mobile-composer-browser.js`：隔离 Firefox fixture，以真实 iframe 验证 320/390/760px 手机与 1440px 桌面、双主题、项目配色下的常驻单行页头、两列 44px 等高导航、事项／Worker 跳转后收起、矮屏全局菜单独立滚动、默认常用按钮单行且无条件发射入口、冻结发射按钮不溢出、展开次要入口及手机回车／撤销／追加／创建语义。软键盘通过 VisualViewport 模拟，不等同于 iOS／Android 真机验收。

缓冲区上限 500 条。无已绑定父 Worker 或 detached HEAD 时，暂存需先明确选择有效父Worker；失败保留输入，不自动新建任意 owner。当前不提供批量发射、任意 Worker 消息的全局全文检索或原始 Input 改写；仅统一流程的追加草稿可在历史中检索。
