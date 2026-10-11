# 总览面板与设备共享卡片

本章固定 W204／决定 #481 的布局、设置与刷新契约，优先于 W199 的只读瀑布流和管理页卡片设置位置。用户目标见[用户工作台理念](../design/user-workspace.md)。入口为根 `#projects`；目录登记与后台维护仍在 `#project-management`。

## 页面与职责

- `project-picker.js` 的总览路径只负责页面身份、懒加载与来源项目原生新标签链接。总览隐藏视图标题栏，不重复显示大标题、英文眉题或功能介绍。
- `dashboard-panel.js` 持有本页面唯一配置 revision，统一卡片选择、内容设置、布局保存与显式刷新。全局设置和每卡设置都在当前总览；项目管理不再读取或挂载卡片配置。
- `project-board.js` 消费外传布局，提供网格拖动、边角缩放和键盘替代操作；普通展示模式不显示编辑手柄。布局编辑期间只改内存，保存才写设备，取消恢复上次确认配置。
- `project-dashboard-content.js` 组合项目指标、状态分布、合并进度、最近 Worker、消息与快捷入口。各模块可单独关闭。指标复用项目概览语义色，不被项目辨识色替换。
- `dashboard-cards.js` 只读取设备连接与缓存，默认显示来源名、额度条、窗口、重置时间、现金／预算读数、上次观测与刷新按钮。详情、来源信息与历史观测由每卡设置选择；错误、未知、停用与来源缺失不能因精简而隐藏。

没有独立项目代码路由，快捷入口使用真实的 Worker 列表、历史输入和版本迭代；代码查看继续在具体 Worker 的「代码与改动」中，不提供失效的 `#code` 链接。

## 配置与兼容

`GET /api/host/dashboard` 返回完整设备读模型：

```js
{
  version: 2, revision,
  cards: [{ type: 'account', connection_id }],
  hidden_projects: [project_id],
  layout: [{ id, x, y, w, h }],
  content: [{ id, sections: [section] }]
}
```

`POST /api/host/dashboard` 接受 `{expected_revision,cards?,hidden_projects?,layout?,content?}`，至少一个配置字段。省略字段必须保持不变；保存成功返回完整 v2。乐观锁覆盖全配置，严格白名单和有限大小校验在服务构造前进行。旧 v1 文件只读映射为空布局、内容与隐藏项目数组，不自动改写；显式保存才发布 v2。旧浏览器 localStorage 顺序不自动导入共享配置。

- `cards` 延续最多 100 个账户 UUID，不存余额或秘密。已删除来源可保留占位，用户在总览取消选择后保存移除。
- `hidden_projects` 最多 300 个登记格式的项目 ID，默认显示已登记项目；隐藏不移除入口、不改变后台或权限。
- `layout`／`content` 各最多 300 个唯一卡片 ID。项目 ID 为 16 位小写 hex；账户 ID 为 `account:<UUID>`。
- 布局采用 12 列、24px 基础行高，`x` 为 0–11，`y` 为 0–4095，`w` 为 1–12 且 `x+w<=12`，`h` 为 6–80。拖动网格吸附并避让重叠，未配置卡片确定性补齐。窄屏重排不改写设备坐标。
- 项目内容键为 `metrics/distribution/delivery/recent/messages/shortcuts`，默认全开；账户为 `quota/balance/reset/observed/details/history/provenance`，默认前四项。空数组允许隐藏所有可选内容，但名称、异常及刷新入口仍保留。

存储沿用设备私有根、配置写锁、原子发布和路径／文件安全校验。`saveDashboardSettings(config,patchOrCardsArray,expectedRevision)` 接受 partial patch；历史数组调用仅改账户选择、不清空其他配置。Host `saveDashboard(body)` 先规范化 patch 再转发，不创建伪项目、不查询账户或启动 daemon。

设置保存失败保留表单和布局草稿，提示先重新读取核对，不自动重试。重新读取是显式丢弃草稿；读取失败不得清空草稿。保存 ACK 与后续显示更新失败必须分开报告。刷新信息期间保留正在编辑的选择、内容与布局及其原 revision，不能拿新 revision 提交旧表单覆盖别的客户端。

## 消息与刷新边界

每个已展示且启用消息模块的在线项目分别只读 `GET /p/<id>/api/notices?status=open&limit=3` 与 `status=unread&limit=3`，最多三个项目并行。显示最近待决与未读生命周期告知；未读判定来自原 Notice 的来源事件和 `read_at`，不能猜标题或 Worker 后来状态。

消息使用明确 D/N 编号、来源项目与显式 Worker 编号，待决琥珀色、告知蓝色。点击在新标签定位来源 `#notices-<id>`，不自动答复、忽略或已读。分页、部分读取失败和离线必须明示，不能把未确认或截断误称为无消息；完整记录入口始终保留。

进入总览仅读取配置、项目状态、消息与账户缓存，不联网查服务商、不启动离线后台。显式「刷新全部」重新读取项目／消息并逐账户调用设备 `agent.connections.query {id}`，只查已摆放账户，不使用无 ID 的全账户查询。单卡刷新只查询该账户；不调用 Agent 或模型，不变更账号配置。

账户查询最多三个并发，逐项失败不阻止其它项。并发查询返回的整份列表不得互相覆盖；完成后独立本地重读。失败与未知不填零，现金、Key 预算与套餐不可互换，重置时间到期不代表额度已恢复。离页或换文档后迟到结果不能回填或启动剩余查询；离线项目不因消息读取或全局刷新启动。

## 验证责任

设备配置、布局和账户 child 各验证专项与受影响路径；W204 在全部成果落地后负责总览组合测试、真实浏览器 CSP／双主题／320px 验证、文档检查及最终 `bun run test`。测试、日志与未覆盖风险记录在 Worker 交付，不以契约文本代替通过证据。

```bash
bun run test/web/check-dashboard-panel-browser.js /tmp/lush-dashboard-check
bun run check:workbench
bun run scripts/check-project-board.js
bun run test/web/check-dashboard-accounts-browser.js
```

面板浏览器 fixture 使用真实编译资源、CSP 和临时设备配置；工作台回归使用真实临时 Host 与两个独立 Firefox profile 检查设备共享卡片选择和布局。它们不连接真实账户、启动用户后台或调用模型。触屏仅验证手势意图与原生滚动，不能替代硬件触屏测试。
