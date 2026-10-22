# 总览面板与设备共享卡片

W234／D552 恢复根 `#projects` 的原项目聚合卡片、统一额度窗口与项目辨识色／字体／边框，保留固定占位、紧凑动态信息、逐条已知和可配置常用导航。此决定替代 D547 的五种独立卡片与 TailAdmin 外观，但保留其 v4 存储兼容。弹窗设置、设备共享和显式保存沿用 W204／D481、D500。用户目标见[用户工作台理念](../design/user-workspace.md)；目录登记与后台维护仍在 `#project-management`。

## 页面与职责

- `project-picker.js` 负责页面身份、懒加载和原生来源链接，总览不重复显示大标题、眉题或功能介绍。
- `dashboard-panel.js` 持有唯一配置 revision，协调卡片添加／移除、来源与内容设置、布局保存及显式刷新。全局与每卡设置通过独立 `#modal` 打开，不改变卡片占位；项目管理不挂载面板配置。
- `dashboard-widget-aggregate-model.js` 将 legacy/null 与 v4 原始成员只读聚合为每项目一张卡和一个 `accounts` 窗口；项目 ID 与账户来源的集合／内容并集不改写原始配置。全局导航在工具栏，项目导航在所属卡片。
- `dashboard-widget-aggregate-render.js` 渲染原项目指标、消息和 Worker 组合，按几何分配固定槽位；宽卡直接显示所选导航，窄卡／编辑模式以详情或入口弹窗兜底，纯导航项目在正文分页。`dashboard-widget-render.js`／`dashboard-widget-pagination.js` 保留来源隔离的消息、Worker 和固定分页接缝，`dashboard-widget-model.js` 保留 v4 成员校验／兼容接口。`project-dashboard-content.js` 复用语义；`dashboard-cards.js` 读取连接缓存、渲染有界指标与独立详情；`dashboard-accounts-group.js` 负责统一额度来源窗口。
- `project-board.js` 消费布局，负责网格吸附、避让、响应式投影、拖动、边角缩放和键盘操作。保留调用方原始 `li` 及其属性；`renderCard(row,{geometry})` 与 `row.geometry` 接收显示投影，`onGeometryChange(row,geometry,item)` 仅在几何变化时回调，`getLayout()` 保持规范 12 列坐标。来源配色使用 `project_id`，不把 widget ID 当项目路径。

W253／D587：页面「编辑模式」统一编辑配置与布局，每卡设置常显，查看模式仍隐藏并禁用布局手柄。原空白处长按 650ms／Shift+F10 保留为设置捷径，打开设置也进入同一编辑模式；移动、滚动和交互控件不触发长按。关闭弹窗恢复焦点且不滚动页面。展示与导航保持原边界；W312／D674 增加独立「快捷操作」卡，D681 扩展后默认提供一键安全重启与自动选择，其余按钮在每卡设置勾选；沿用现有确认、安全门和 Agent 代价，不新增跨项目执行器。

W397／D775：项目卡在查看模式常显「输入」，在当前页弹窗固定项目名称与路径；不改变卡片占位。复用 `project-order-form.js`，仅向来源 `/p/<id>/api/action` 提交 `input.emit {content,branch:'main',client_request_id}`；打开弹窗不调用 Agent，紫色「提交指令」才保存执行授权，可靠挂载收据不代表 Worker 已创建或开始。不追加到已有 Worker，不提供管家或完整项目工作台。离线禁止提交但允许填写；正文按 document 与项目隔离，关闭重开、信息刷新保留，迟到 ACK 不清除新编辑，失败不自动重试；同一未确认请求保留去重身份。请求单飞且在途阻止同页离开，关闭输入弹窗不撤销已发请求；离页释放视图，刷新／关闭页面对未提交正文或在途请求提示离开风险。草稿仅当前页面会话，不写入共享布局或项目持久草稿。提交后可通过来源链接查看挂载状态。

编辑模式中每卡「内容」打开内容与布局设置；「紧凑／标准／宽幅」预设、列／行／宽／高及四向移动按钮均先进入表单，应用才更新页面草稿。仍按十二列规范布局避让，小屏显示投影不写回桌面坐标；卡片就地显示位置与尺寸，拖动、缩放和键盘操作保留。「恢复默认布局／重新读取设置」位于「更多布局操作」，整页保存、取消、撤销与重做不变。

「添加卡片」打开可搜索的已登记项目／统一额度窗口／运行诊断／快捷操作库，已添加来源不能重复选择，空面板也有入口；不在这里新建项目或账号。每卡设置支持适用内容、额度来源、项目导航和移出总览；诊断设置说明固定采样范围并允许移出。移除不删除来源，重新添加使用现有配置模型的默认内容；撤销可恢复移除前的完整草稿。面板设置管理整体选择和全局导航。弹窗「应用到草稿」只修改内存，取消弹窗不修改页面草稿。

撤销／重做覆盖内容、来源、导航和布局；「恢复默认布局」经确认仅重排当前可见卡片，保留内容和旧成员布局，仍可撤销。「保存更改」以进入编辑时的 revision 一次发布相对确认配置的 partial patch；无改动保存只验证 revision，不写入显示投影。「取消编辑」恢复整份确认配置。当前表单或请求未结束时阻止同页离开，未保存修改离开时确认，关闭／刷新页面使用浏览器原生提醒；页面释放注销监听与守卫。

## 配置与兼容

`GET /api/host/dashboard` 返回完整设备 v7 模型：

```js
{
  version: 7, revision, account_view: 'list', diagnostics: true, quick_actions: true,
  quick_action_buttons: ['safe_restart', 'auto_select'],
  cards: [{ type: 'account', connection_id }],
  hidden_projects: [project_id],
  layout: [{ id, x, y, w, h }],
  content: [{ id, sections: [section] }],
  widgets: null // 或完整 widget 数组；[] 表示有意清空
}
// 每个 widget：
{ id, type, project_id, connection_ids: [], links: [], sections: [] }
```

`POST /api/host/dashboard` 接受 `{expected_revision,cards?,hidden_projects?,layout?,content?,account_view?,widgets?,diagnostics?,quick_actions?,quick_action_buttons?}`，至少一个配置字段。省略字段保持不变；成功返回完整 v7 ACK。`quick_action_buttons` 为按钮枚举数组，可空、去重并按固定目录顺序规范化；未知枚举拒绝，不接受自定义执行内容。`quick_actions` 仅允许 boolean，控制快捷操作卡，与项目／账户成员独立；`diagnostics` 仅允许 boolean，控制全局运行诊断卡，不改变项目或额度成员。乐观锁覆盖整份配置，白名单、结构、数量和 256KiB 总大小在服务构造前校验。设备私有根、写锁、原子发布与路径安全不变。Host 先规范化 patch，不创建伪项目、不查询账户或启动 daemon。

- 旧 v1–v6 文件只读映射为 v7、`quick_action_buttons:['safe_restart','auto_select']`，v1–v5 补 `quick_actions:true`，v6 保留原整卡可见性；v1–v4 补 `diagnostics:true`，v1–v3 的 `widgets:null` 保持，不自动改写。前端继承旧可见项目、所选账户、内容和位置；查看和仅布局保存保持 `widgets` 原样。`null` 与有意空数组不可互换，旧 localStorage 顺序不自动导入。
- 保留 v3 的 `cards/hidden_projects/layout/content/account_view`。历史数组保存仅改账户选择，不清空其它字段；`account_view` 仍仅接受 `list/tiles`，不支配聚合展示。旧账户、项目及成员布局／内容不因投影被删除。v4 显式成员决定来源，空 sections、空额度成员、不可用来源和自定义链接仍保留；相关来源／内容／导航显式编辑只改相关成员，导航编辑需要 materialize legacy 时完整保留旧选择与分来源内容。超 100 成员先拒绝保存并保留草稿，不截断、不 POST。
- `widgets` 最多 100 个完整对象；ID 唯一，格式 `widget:[a-z0-9][a-z0-9-]{0,79}`。类型为上述五种，前三种必须绑定 16 位小写 hex 项目 ID，其余 `project_id:null`。
- `connection_ids` 仅 accounts 可非空，最多 100 个唯一 UUID；`links` 仅 shortcuts 可非空，最多 24 个完整 `{scope,target,project_id}`。全局目标 `notices/project-management/model-sources/runners/settings/agent-status/automation/docs` 绑定 null，项目目标 `workers/inputs/versions/notices` 绑定项目 ID。
- `sections` 按类型为：status `metrics/distribution/delivery`；messages `messages`；workers `recent`；accounts `quota/balance/reset/observed/details/history/provenance`；shortcuts `shortcuts`。允许空数组，异常与来源占位不被内容开关隐藏。
- `cards` 最多 100，`hidden_projects/layout/content` 最多 300；layout 支持 widget ID 和旧项目／`accounts`／`account:<UUID>` ID，旧 content 保留原 ID，新内容写 `widgets.sections`。

保存与刷新反馈使用 toast，编辑工具栏显示未保存／保存未确认状态，不用业务状态行推移看板。确认请求在途禁止重复提交与取消；失败保留完整草稿和撤销历史，不自动重试。离页或弹窗替换后的迟到 ACK 不关闭新弹窗或抢焦点。保存未确认时锁定再次写入；「重新读取设置」经明确确认、读取成功后才丢弃草稿，读取失败不清空。写入 ACK 与后续绘制失败分别报告。刷新保留编辑稿及原 revision，不借新 revision 覆盖其他客户端。

## 固定几何与信息密度

规范布局为 12 列 × 24px 行高；存储 `x:0–11,y:0–4095,w:1–12,x+w<=12,h:6–80`。项目默认 6×24，额度窗口 6×16，快捷操作 6×12，查看投影至少 4×10；窄屏六列投影至少三列，再收窄为单列满宽。优先使用原项目／`accounts` 坐标，否则按原成员的最早坐标作聚合种子；旧小尺寸和原成员几何保持存储，不把响应式或最小展示投影写回，仅显式尺寸编辑改尺寸。

业务数量、加载、错误、长标题、消息 ACK、详情查看和内容设置不改变高度，不测内容自动下移邻居。ResizeObserver 只观察看板宽度；保存与用户尺寸编辑才改规范布局。只有整个总览滚动，不设嵌套列表滚动窗；详情放弹窗。

头／尾各 44px，原 5px 顶边框与固定 padding/gap 对应正文预算 `h*24-140`。项目消息 92px、六指标 92px（两列三行，标签 11px／数值 20px）、状态分布与合并各 44px，模块间 6px；Worker 使用余下预算，每槽 44px、间隔 4px。默认 h24 正文 436px 含三条 Worker；h10 正文 100px 优先两行消息，未容纳的所选内容仍在详情，零容量不请求 `limit=0`。纯导航项目正文用同样 44px 槽分页。额度每来源 88px、间隔 4px，容量 `floor((body+4)/92)`、上限 12；h16／h17 均两来源，h10 一来源。空页保留槽位；分页和控件不随数量伸缩。每账户最多并排两项指标，其余完整字段／来源／所选历史在详情弹窗；不因多指标增加内部分页栏。现金、Key 预算和套餐不混加，未知不填零，异常、停用、已删除来源与观测年龄保留。长标题单行省略，完整标题保留在可访问名称／帮助中。

## 消息、Worker 与刷新

启用消息的在线来源只读 `GET /p/<id>/api/notices?status=open&limit=3` 与 `status=unread&limit=3`，最多三个项目并发。待答／告知各一行：数量、最新内容、明确 D/N 与显式 W 编号。RPC `total` 包含历史 plan，`non_plan_total` 排除它们；Web 过滤 plan 后只将有效后者投影为 `total`。旧来源无精确总数使用下界／`+`，过滤空页且 `has_more` 时有界续读；离线／失败不冒称无消息。

点击原生新标签定位来源 `#notices-<id>`，不自动答复或已读。「已知」仅针对当前显示的未读 info，通过 Host inbox/action 携带来源与 `expected_identity`，来源单飞，成功 ACK 立即更新同源卡片与详情，陈旧快照／ACK 不复活已知记录，失败保留该条。三个预载告知耗尽后仅对该来源继续有界读取；续读失败显示未知，不混为已知写入失败或零条。未知 kind 不猜 question，也不提供已知。完整消息入口始终保留。

Worker 使用来源 `/api/workers?scope=work&limit=&before=` 有界分页；服务页面内 ID 升序，展示倒序，不能拿三条摘要冒充全部历史。导航指向真实 Worker、历史输入、版本和 Notice；没有独立项目 `#code` 路由。

进入面板只读配置、项目状态、消息和账户缓存，不联网查服务商、不启动离线后台。显式「刷新全部」重读项目／消息并逐账户调用设备 `agent.connections.query {id}`，只查询当前聚合额度窗口所选来源，去重、最多三个并发，不用无 ID 全账户查询。账户单项和额度卡刷新同样只查对应来源，共享在途锁；不调用 Agent／模型、不修改账号配置。逐项失败不阻止其他项，完成后独立重读缓存，整份并发结果不互相覆盖。离页后不回填或启动余下查询；重置到期不代表额度恢复，倒计时仅在重绘计算，不设后台实时计时器。

## 快捷操作卡

卡片 ID `widget:quick-actions`，由设备 `quick_actions` 控制，默认显示；可移动、缩放、移除并从卡片库加回，选择和布局参与同一编辑草稿、撤销／重做、整页保存与取消。移除不删除维护记录，布局保留供重新添加。编辑时禁止从卡片开始维护动作或修改自动选择策略，已确认的在途流程与进度不因尺寸变化、信息刷新或布局保存而重建。

W312／D681：按钮目录由 `src/shared/dashboard-quick-actions.js` 统一供配置校验、Host、前端和编辑器使用；包括 `safe_restart`、`auto_select`、`interrupt_all`、`resume_all`、`restart_all`，默认前两项。每卡设置逐项勾选，只应用到草稿；取消、撤销／重做、保存和重载与整卡配置一致，全空显示选择提示，不执行策略变更或清空来源。没有独立 Host 重启或刷新按钮。

`dashboard-quick-actions.js` 保留单个卡片及 `service-restart.js` 的 `quick_actions` 模式控制器，只构造所选按钮；更改选择不重建在途维护流程。项目管理使用 `management` 模式，保留项目行重启、独立界面重启与手动维护，不重复一键入口。所有维护模式共享模块级单飞；安全重启沿用 `safeRestartFlow` 静默中断，手动全部中断仍生成完成提醒，继续和一键确认沿用紫色 `agent-call`／`agentHelp`。

自动选择使用 `auto-select-action.js` 复用全局页的持续授权确认，关闭为普通动作。`workspace-automation.js` 是卡片、全局页与 banner 的唯一策略状态／读写接缝，仍走既有 Host revision API；展示已确认开启／关闭或未知，配置按钮不等于授权。确认与写入共享单飞，迟到读取不回退新 ACK；未知或失败写入锁定再次写入，必须显式重新读取，观察器不暗中重试或解除未知。离页、编辑或策略 revision 变化使未提交的确认失效。

正文按固定槽位纵排按钮，窄屏文字换行；容纳不了的已选按钮在原地详情弹窗完整展示且仍可执行，不导航离开总览。正文有界显示当前进度／异常，详情复用原控件与控制器并显示完整实时结果，不使卡片撑高或产生嵌套滚动列表。离页或移除释放控制器、观测与自身弹窗，停止后续写入；已发请求仍可能生效，不能承诺撤销。恢复卡片或返回页面不恢复旧执行授权。手动维护仍在项目管理，执行安全契约不因展示迁移而改变。

## 运行诊断卡

诊断卡 ID 为 `widget:diagnostics`，默认显示；总览设置可隐藏／恢复，位置与尺寸沿用共享固定网格。该卡独立于 `widgets` 成员，不因启停诊断迁移旧配置、清空成员或改变项目／账户选择。

卡片显示最近 60／300 秒平均输入、输出 token/s、估算 USD/min 和最近十分钟趋势。输入包含缓存读取／写入，reasoning 不重复叠加；费用只是会话报告的美元估算，不是账户扣款、套餐折算或最终账单。数据主要在响应／回合结束后落账，不承诺生成期间逐 token 实时监控。不同单位分别绘图；更新时间、来源覆盖与未知贡献必须保留。W266／A266-1 调整 W252／D597 的展示：不完整时间桶仍绘制正的已知小计柱，但与完整桶统一使用纯色柱和普通背景，不再用斜纹强调缺失；卡片与详情一致。不完整图的峰值仍以 `≥` 标明下界，覆盖提示与未知贡献计数保留。未知贡献且已知小计为零的桶留空，不冒充确认零消耗；可访问说明仍区分已知小计和完整统计。

用户专属无参数 RPC `system.diagnostics` 在各项目只读采集现有会话；Host 的根路径 `GET /api/host/diagnostics` 无参数，只聚合已登记且有权访问的来源。返回 `{version:1,generated_at,currency:'USD',estimated:true,windows,buckets,coverage,projects}`：`windows` 为 60／300 秒的已知输入、输出、费用、请求数及速率，另有 `unknown_tokens`、`unknown_cost` 和 `complete`；`buckets` 为 60 个十秒桶，含起点 `at` 及已知用量／未知贡献计数。`coverage` 包含 `projects_total/projects_online/projects_reporting/complete`；`projects` 带身份、名称、`online/offline/unavailable/unsupported` 状态、来源采样时间与安全诊断。不返回会话正文、凭证或任意 RPC 代理。

未知字段表示未知贡献者计数，不是推测缺失 token 数。离线、不可达、旧后台、不完整会话、缺时间或费用都不能冒充完整零值；保留已知小计并标记不完整。没有登记项目也不是已确认零消耗。fork 中明确属于其它 Worker 的上下文不重复计费。采集使用有界增量读取／缓存与单飞，不高频扫描全部历史；预算不足必须降级为不完整。大会话初始尾读不完整时，在原单文件与总采样预算内逐次从头连续回补，优先处理新追加记录；只有回补追上当前读取位置且没有解析／保留预算丢失，才原子替换临时小计并解除截断标记，不重复计费。大字符串正文压缩但仍验证 JSON 转义，真实缺失、异常和超预算不会因刷新或时间经过被直接清除。

诊断自动刷新只在启用卡片且页面可见时运行，通常十秒、省电偏好三十秒；隐藏／离页停止，迟到结果不能覆盖新页面或抢焦点。诊断刷新不查询服务商、不启动离线后台、不调用 Agent，也不自动执行账户刷新。Host 不持有权威运行事实，只做来源只读聚合；单个来源失败不阻塞其余来源。

## 验证责任

child 验证专项及受影响路径；顶层开发指令汇总后负责真实组合、CSP／双主题／320px 浏览器与最终 `bun run test`。实际日志与未覆盖风险记录在 Worker 交付。

```bash
bun run test/web/check-dashboard-panel-browser.js /tmp/lush-dashboard-check
bun run check:workbench
bun run scripts/check-project-board.js
bun run test/web/check-dashboard-widgets-browser.js /tmp/lush-widget-grid-check
```

面板 fixture 使用真实编译资源、CSP、临时 v4 配置及可控来源，覆盖聚合固定槽、导航、分页、最小卡片详情、h17 边界、已知失败／ACK／续读、原始成员保留和百来源压力；旧账户组检查命令转到该组合 fixture。工作台检查以临时 Host 和两个独立 Firefox profile 验证设备共享与页面隔离。不连接真实账户或用户后台；合成手势不能替代硬件触屏，Firefox 证据不涵盖 Chromium／Safari。
