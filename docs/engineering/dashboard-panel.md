# 总览面板与设备共享卡片

本章固定 W204／D481、D500 与 W212／D505 的布局、弹窗设置、统一额度和高密度平铺契约，优先于 W199 的只读瀑布流和管理页卡片设置位置。用户目标见[用户工作台理念](../design/user-workspace.md)。入口为根 `#projects`；目录登记与后台维护仍在 `#project-management`。

## 页面与职责

- `project-picker.js` 的总览路径只负责页面身份、懒加载与来源项目原生新标签链接。总览隐藏视图标题栏，不重复显示大标题、英文眉题或功能介绍。
- `dashboard-panel.js` 持有本页面唯一配置 revision，统一卡片选择、内容设置、布局保存与显式刷新。全局设置和每卡设置都通过当前总览的独立 `#modal` 弹窗打开，不占看板流、不移动卡片；项目管理不再读取或挂载卡片配置（D500）。
- `project-board.js` 消费外传布局，提供网格拖动、边角缩放和键盘替代操作；普通展示模式不显示编辑手柄。只有页面全局「编辑布局」按钮能开启拖动／缩放，卡片设置不提供独立开启入口。布局编辑期间只改内存，保存才写设备，取消恢复上次确认配置。
- `project-dashboard-content.js` 组合项目指标、状态分布、合并进度、最近 Worker、消息与快捷入口。各模块可单独关闭。指标复用项目概览语义色，不被项目辨识色替换。
- `dashboard-accounts-group.js` 将所选来源放进唯一 `accounts` 卡片，支持紧凑列表／账号小面板；内部来源不单独排版，仍可逐项刷新。`dashboard-cards.js` 只读取设备连接与缓存，默认显示来源名旁的观测年龄、窗口简称与已用百分比、额度条及紧凑重置倒计时；现金／Key 预算保留类型和单位。无剩余量时不逐指标重复“剩余未知”，不能把未知填零，完整字段留在可选详情。详情、来源信息与历史观测由每卡设置选择；错误、未知、停用与来源缺失不能因精简而隐藏。

没有独立项目代码路由，快捷入口使用真实的 Worker 列表、历史输入和版本迭代；代码查看继续在具体 Worker 的「代码与改动」中，不提供失效的 `#code` 链接。

## 配置与兼容

`GET /api/host/dashboard` 返回完整设备读模型：

```js
{
  version: 3, revision, account_view: 'list', // 或 'tiles'
  cards: [{ type: 'account', connection_id }],
  hidden_projects: [project_id],
  layout: [{ id, x, y, w, h }],
  content: [{ id, sections: [section] }]
}
```

`POST /api/host/dashboard` 接受 `{expected_revision,cards?,hidden_projects?,layout?,content?,account_view?}`，至少一个配置字段。省略字段必须保持不变；保存成功返回完整 v3。`account_view` 仅允许 `list/tiles`。乐观锁覆盖全配置，严格白名单和有限大小校验在服务构造前进行。旧 v1/v2 文件只读映射为 v3（显示方式默认 list，v1 缺省数组为空），不自动改写；显式保存才发布 v3，完整 v3 不允许缺字段。旧浏览器 localStorage 顺序不自动导入共享配置。

- `cards` 延续最多 100 个账户 UUID，代表统一窗口内选择的来源，不存余额或秘密。已删除来源可保留占位，用户在总览取消选择后保存移除。
- `hidden_projects` 最多 300 个登记格式的项目 ID，默认显示已登记项目；隐藏不移除入口、不改变后台或权限。
- `layout`／`content` 各最多 300 个唯一卡片 ID。项目 ID 为 16 位小写 hex；统一窗口 ID 为 `accounts`；兼容旧账户 ID `account:<UUID>`，保留但不分别显示。
- 布局采用 12 列、24px 基础行高，`x` 为 0–11，`y` 为 0–4095，`w` 为 1–12 且 `x+w<=12`，`h` 为 6–80。拖动网格吸附并避让重叠，未配置卡片确定性补齐。`h` 是最小高度，不是内容上限；测量内容后向上取整到网格行数并自动下移有碰撞的卡片，实际展示高度可以超过 80 行。窄屏重排、测量高度和自动下移均只做显示投影，不改写设备坐标或触发布局保存。
- 项目内容键为 `metrics/distribution/delivery/recent/messages/shortcuts`，默认全开；账户为 `quota/balance/reset/observed/details/history/provenance`，默认前四项。空数组允许隐藏所有可选内容，但名称、异常及刷新入口仍保留。

统一卡片未保存布局时，从最靠上的所选旧账户位置（先 y、再 x）创建 6×16 初始窗口，x 限制在可容纳六列的位置，再由网格避让，项目保存坐标不改写；无旧位置则放空位。`dashboard-layout-model.js` 仅计算展示，旧账户字段保留在设备中，当前页内容／选择切换沿用窗口位置，显式重读丢弃内存种子。只有「保存布局」发布窗口坐标；首次未保存位置在重进时重新计算。统一内容未设置时沿用各来源旧内容开关；保存统一内容后覆盖窗口内所有来源，但不删除旧字段。配置仍有 300 项上限，超过时安全拒绝，不偷偷清理历史。

存储沿用设备私有根、配置写锁、原子发布和路径／文件安全校验。`saveDashboardSettings(config,patchOrCardsArray,expectedRevision)` 接受 partial patch；历史数组调用仅改账户选择、不清空其他配置。Host `saveDashboard(body)` 先规范化 patch 再转发，不创建伪项目、不查询账户或启动 daemon。

卡片内容与内部账户列表必须自然展开，不建立内部滚动窗；详情展开／收起、宽度和内容变化后重新测量并避让。仅整个总览滚动，测量不得反过来把卡片越撑越高或产生 ResizeObserver 循环。字号与留白仅在总览收紧，不把项目工作页／管理页一起缩小，操作保留触摸命中区域。

保存、刷新及布局反馈沿用应用 toast，弹窗内错误就地呈现，不再用状态行推移看板；关闭后的卡片焦点恢复不自动滚动页面。设置弹窗通过 `formDialog({onConfirm,canConfirm})` 在确认保存后关闭；请求在途禁止重复提交、取消、Escape 与背景关闭。失败保留原表单和布局草稿，提示先重新读取核对，不自动重试。弹窗被导航或其它弹窗替换后，迟到确认不能关闭新弹窗或抢焦点。重新读取是显式丢弃草稿；读取失败不得清空草稿。保存 ACK 与后续显示更新失败必须分开报告。刷新信息期间保留正在编辑的选择、内容与布局及其原 revision，不能拿新 revision 提交旧表单覆盖别的客户端。

## 消息与刷新边界

每个已展示且启用消息模块的在线项目分别只读 `GET /p/<id>/api/notices?status=open&limit=3` 与 `status=unread&limit=3`，最多三个项目并行。显示最近待决与未读生命周期告知；未读判定来自原 Notice 的来源事件和 `read_at`，不能猜标题或 Worker 后来状态。

消息使用明确 D/N 编号、来源项目与显式 Worker 编号，待决琥珀色、告知蓝色。点击在新标签定位来源 `#notices-<id>`，不自动答复、忽略或已读。分页、部分读取失败和离线必须明示，不能把未确认或截断误称为无消息；完整记录入口始终保留。

进入总览仅读取配置、项目状态、消息与账户缓存，不联网查服务商、不启动离线后台。显式「刷新全部」重新读取项目／消息并逐账户调用设备 `agent.connections.query {id}`，只查已摆放账户，不使用无 ID 的全账户查询。窗口内单项刷新只查询该账户，「刷新额度」刷新所选来源；与页面全局刷新共用在途锁，不调用 Agent 或模型，不变更账号配置。

账户查询最多三个并发，逐项失败不阻止其它项。并发查询返回的整份列表不得互相覆盖；完成后独立本地重读。失败与未知不填零，现金、Key 预算与套餐不可互换，重置时间到期不代表额度已恢复。观测年龄与重置倒计时在卡片重绘时计算，不设独立后台计时器，不冒称持续实时更新；显式刷新重新查询并重绘。离页或换文档后迟到结果不能回填或启动剩余查询；离线项目不因消息读取或全局刷新启动。

## 验证责任

设备配置、布局和账户 child 各验证专项与受影响路径；顶层开发指令在全部成果落地后负责总览组合测试、真实浏览器 CSP／双主题／320px 验证、文档检查及最终 `bun run test`（本次为 W212）。测试、日志与未覆盖风险记录在 Worker 交付，不以契约文本代替通过证据。

```bash
bun run test/web/check-dashboard-panel-browser.js /tmp/lush-dashboard-check
bun run check:workbench
bun run scripts/check-project-board.js
bun run test/web/check-dashboard-accounts-browser.js
bun run test/web/check-dashboard-accounts-group-browser.js
```

面板浏览器 fixture 使用真实编译资源、CSP 和临时设备配置；工作台回归使用真实临时 Host 与两个独立 Firefox profile 检查设备共享卡片选择和布局。它们不连接真实账户、启动用户后台或调用模型。触屏仅验证手势意图与原生滚动，不能替代硬件触屏测试。
