# 总览面板与设备共享卡片

W234／D552 恢复根 `#projects` 的原项目聚合卡片、统一额度窗口与项目辨识色／字体／边框，保留固定占位、紧凑动态信息、逐条已知和可配置常用导航。此决定替代 D547 的五种独立卡片与 TailAdmin 外观，但保留其 v4 存储兼容。弹窗设置、设备共享和显式保存沿用 W204／D481、D500。用户目标见[用户工作台理念](../design/user-workspace.md)；目录登记与后台维护仍在 `#project-management`。

## 页面与职责

- `project-picker.js` 负责页面身份、懒加载和原生来源链接，总览不重复显示大标题、眉题或功能介绍。
- `dashboard-panel.js` 持有唯一配置 revision，协调卡片添加／移除、来源与内容设置、布局保存及显式刷新。全局与每卡设置通过独立 `#modal` 打开，不改变卡片占位；项目管理不挂载面板配置。
- `dashboard-widget-aggregate-model.js` 将 legacy/null 与 v4 原始成员只读聚合为每项目一张卡和一个 `accounts` 窗口；项目 ID 与账户来源的集合／内容并集不改写原始配置。全局导航在工具栏，项目导航在所属卡片。
- `dashboard-widget-aggregate-render.js` 渲染原项目指标、消息和 Worker 组合，按几何分配固定槽位；宽卡直接显示所选导航，窄卡／编辑模式以详情或入口弹窗兜底，纯导航项目在正文分页。`dashboard-widget-render.js`／`dashboard-widget-pagination.js` 保留来源隔离的消息、Worker 和固定分页接缝，`dashboard-widget-model.js` 保留 v4 成员校验／兼容接口。`project-dashboard-content.js` 复用语义；`dashboard-cards.js` 读取连接缓存、渲染有界指标与独立详情；`dashboard-accounts-group.js` 负责统一额度来源窗口。
- `project-board.js` 消费布局，负责网格吸附、避让、响应式投影、拖动、边角缩放和键盘操作。保留调用方原始 `li` 及其属性；`renderCard(row,{geometry})` 与 `row.geometry` 接收显示投影，`onGeometryChange(row,geometry,item)` 仅在几何变化时回调，`getLayout()` 保持规范 12 列坐标。来源配色使用 `project_id`，不把 widget ID 当项目路径。

卡片设置入口由空白处长按 650ms 或聚焦后 Shift+F10 显示；移动、滚动、取消和交互控件不触发。Esc／点击外部收起，关闭弹窗恢复焦点且不滚动页面。布局编辑只有全局按钮开启，查看模式隐藏并禁用手柄；编辑只改内存，保存才写设备，取消恢复确认配置。总览仅提供可配置的项目／全局导航，不增加 Agent 调用或维护动作。

## 配置与兼容

`GET /api/host/dashboard` 返回完整设备模型：

```js
{
  version: 4, revision, account_view: 'list',
  cards: [{ type: 'account', connection_id }],
  hidden_projects: [project_id],
  layout: [{ id, x, y, w, h }],
  content: [{ id, sections: [section] }],
  widgets: null // 或完整 widget 数组；[] 表示有意清空
}
// 每个 widget：
{ id, type, project_id, connection_ids: [], links: [], sections: [] }
```

`POST /api/host/dashboard` 接受 `{expected_revision,cards?,hidden_projects?,layout?,content?,account_view?,widgets?}`，至少一个配置字段。省略字段保持不变；成功返回完整 v4 ACK。乐观锁覆盖整份配置，白名单、结构、数量和 256KiB 总大小在服务构造前校验。设备私有根、写锁、原子发布与路径安全不变。Host 先规范化 patch，不创建伪项目、不查询账户或启动 daemon。

- 旧 v1–v3 文件只读映射为 v4、`widgets:null`，不自动改写。前端继承旧可见项目、所选账户、内容和位置；查看和仅布局保存保持 `widgets` 原样。`null` 与有意空数组不可互换，旧 localStorage 顺序不自动导入。
- 保留 v3 的 `cards/hidden_projects/layout/content/account_view`。历史数组保存仅改账户选择，不清空其它字段；`account_view` 仍仅接受 `list/tiles`，不支配聚合展示。旧账户、项目及成员布局／内容不因投影被删除。v4 显式成员决定来源，空 sections、空额度成员、不可用来源和自定义链接仍保留；相关来源／内容／导航显式编辑只改相关成员，导航编辑需要 materialize legacy 时完整保留旧选择与分来源内容。超 100 成员先拒绝保存并保留草稿，不截断、不 POST。
- `widgets` 最多 100 个完整对象；ID 唯一，格式 `widget:[a-z0-9][a-z0-9-]{0,79}`。类型为上述五种，前三种必须绑定 16 位小写 hex 项目 ID，其余 `project_id:null`。
- `connection_ids` 仅 accounts 可非空，最多 100 个唯一 UUID；`links` 仅 shortcuts 可非空，最多 24 个完整 `{scope,target,project_id}`。全局目标 `notices/project-management/model-sources/settings/agent-status/automation/docs` 绑定 null，项目目标 `workers/inputs/versions/notices` 绑定项目 ID。
- `sections` 按类型为：status `metrics/distribution/delivery`；messages `messages`；workers `recent`；accounts `quota/balance/reset/observed/details/history/provenance`；shortcuts `shortcuts`。允许空数组，异常与来源占位不被内容开关隐藏。
- `cards` 最多 100，`hidden_projects/layout/content` 最多 300；layout 支持 widget ID 和旧项目／`accounts`／`account:<UUID>` ID，旧 content 保留原 ID，新内容写 `widgets.sections`。

保存与刷新反馈使用 toast，不用状态行推移看板。确认请求在途禁止重复提交、取消、Escape 和背景关闭；失败保留表单与布局稿，不自动重试。离页或弹窗替换后的迟到 ACK 不关闭新弹窗或抢焦点。显式重读才丢弃草稿，重读失败不清空；写入 ACK 与后续绘制失败分别报告。刷新保留编辑稿及原 revision，不借新 revision 覆盖其他客户端。

## 固定几何与信息密度

规范布局为 12 列 × 24px 行高；存储 `x:0–11,y:0–4095,w:1–12,x+w<=12,h:6–80`。项目默认 6×24，额度窗口 6×16，查看投影至少 4×10；窄屏六列投影至少三列，再收窄为单列满宽。优先使用原项目／`accounts` 坐标，否则按原成员的最早坐标作聚合种子；旧小尺寸和原成员几何保持存储，不把响应式或最小展示投影写回，仅显式尺寸编辑改尺寸。

业务数量、加载、错误、长标题、消息 ACK、详情查看和内容设置不改变高度，不测内容自动下移邻居。ResizeObserver 只观察看板宽度；保存与用户尺寸编辑才改规范布局。只有整个总览滚动，不设嵌套列表滚动窗；详情放弹窗。

头／尾各 44px，原 5px 顶边框与固定 padding/gap 对应正文预算 `h*24-140`。项目消息 92px、六指标 92px（两列三行，标签 11px／数值 20px）、状态分布与合并各 44px，模块间 6px；Worker 使用余下预算，每槽 44px、间隔 4px。默认 h24 正文 436px 含三条 Worker；h10 正文 100px 优先两行消息，未容纳的所选内容仍在详情，零容量不请求 `limit=0`。纯导航项目正文用同样 44px 槽分页。额度每来源 88px、间隔 4px，容量 `floor((body+4)/92)`、上限 12；h16／h17 均两来源，h10 一来源。空页保留槽位；分页和控件不随数量伸缩。每账户最多并排两项指标，其余完整字段／来源／所选历史在详情弹窗；不因多指标增加内部分页栏。现金、Key 预算和套餐不混加，未知不填零，异常、停用、已删除来源与观测年龄保留。长标题单行省略，完整标题保留在可访问名称／帮助中。

## 消息、Worker 与刷新

启用消息的在线来源只读 `GET /p/<id>/api/notices?status=open&limit=3` 与 `status=unread&limit=3`，最多三个项目并发。待答／告知各一行：数量、最新内容、明确 D/N 与显式 W 编号。RPC `total` 包含历史 plan，`non_plan_total` 排除它们；Web 过滤 plan 后只将有效后者投影为 `total`。旧来源无精确总数使用下界／`+`，过滤空页且 `has_more` 时有界续读；离线／失败不冒称无消息。

点击原生新标签定位来源 `#notices-<id>`，不自动答复或已读。「已知」仅针对当前显示的未读 info，通过 Host inbox/action 携带来源与 `expected_identity`，来源单飞，成功 ACK 立即更新同源卡片与详情，陈旧快照／ACK 不复活已知记录，失败保留该条。三个预载告知耗尽后仅对该来源继续有界读取；续读失败显示未知，不混为已知写入失败或零条。未知 kind 不猜 question，也不提供已知。完整消息入口始终保留。

Worker 使用来源 `/api/workers?scope=work&limit=&before=` 有界分页；服务页面内 ID 升序，展示倒序，不能拿三条摘要冒充全部历史。导航指向真实 Worker、历史输入、版本和 Notice；没有独立项目 `#code` 路由。

进入面板只读配置、项目状态、消息和账户缓存，不联网查服务商、不启动离线后台。显式「刷新全部」重读项目／消息并逐账户调用设备 `agent.connections.query {id}`，只查询当前聚合额度窗口所选来源，去重、最多三个并发，不用无 ID 全账户查询。账户单项和额度卡刷新同样只查对应来源，共享在途锁；不调用 Agent／模型、不修改账号配置。逐项失败不阻止其他项，完成后独立重读缓存，整份并发结果不互相覆盖。离页后不回填或启动余下查询；重置到期不代表额度恢复，倒计时仅在重绘计算，不设后台实时计时器。

## 验证责任

child 验证专项及受影响路径；顶层开发指令汇总后负责真实组合、CSP／双主题／320px 浏览器与最终 `bun run test`。实际日志与未覆盖风险记录在 Worker 交付。

```bash
bun run test/web/check-dashboard-panel-browser.js /tmp/lush-dashboard-check
bun run check:workbench
bun run scripts/check-project-board.js
bun run test/web/check-dashboard-widgets-browser.js /tmp/lush-widget-grid-check
```

面板 fixture 使用真实编译资源、CSP、临时 v4 配置及可控来源，覆盖聚合固定槽、导航、分页、最小卡片详情、h17 边界、已知失败／ACK／续读、原始成员保留和百来源压力；旧账户组检查命令转到该组合 fixture。工作台检查以临时 Host 和两个独立 Firefox profile 验证设备共享与页面隔离。不连接真实账户或用户后台；合成手势不能替代硬件触屏，Firefox 证据不涵盖 Chromium／Safari。
