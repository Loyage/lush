# 模块地图：Web 前端

本章是 `src/ui/web/assets/` 的职责与导出清单。浏览器端使用原生 ES module，不经过打包。修改执行过程相关模块前，必须先读[设计理念](../design/agent-process.md)与[阅读器边界](transcript-reader.md)。修改按钮文案、图标、样式或 `agent-call` 标识前，必须先读[按钮帮助与 Agent 触发标识](../design/ui-guidance.md)。公开面以[核心 API 收敛](core-api.md)与 `src/rpc/registry.js` 为准；**下面涉及草稿、Intent / Plan、效果展示、介绍、托管模式、统计面板与旧一键合并的行都是历史遗留实现**：文件仍在源码与测试里，但没有公开入口，不能当作当前可操作的界面。

> 模块地图：[总览](modules.md) → [Runtime 与持久化](modules-runtime.md) → **Web 前端** → [CLI、RPC 与测试](modules-interfaces.md)


浏览器端 ES module，无打包器：`index.html` 先以 module 加载 `/appearance.js`（head 中定主题）再加载 `/app.js`，其余模块走 import 图，
由 `server.js` 的扩展名白名单按 basename 服务。

**三个必须遵守的接缝：**

- **`app.js` 导出 `boot()`**，并在被当作模块加载时执行一次 `await boot()`。
  `boot()` 先清掉上一次的定时器/监听器，再按当前全局 DOM 重新装配。理由：`bun test`
  在多个测试文件之间**共享模块注册表**，DOM 测试要给每个文件装自己的 stub，只能靠重复调用 `boot()`。
- **面板之间不互相 import 实现，只 import 接缝。** 跳转走 `navigate.js`，共享可变状态走 `state.js`，
  本地偏好（键名 / 默认值 / 读写）走 `prefs.js`，这既断掉循环依赖，也让面板文件之间没有编辑冲突面。
- **确认与输入一律走 `dialog.js` 的应用内弹窗，不用原生 `confirm` / `prompt` / `alert`。**
  原生弹窗不属于页面，浏览器可以静默吃掉它（勾过「阻止此页面创建更多对话框」、沙箱 iframe、
  内嵌 webview 等），那时 `confirm()` 不显示任何东西直接返回 false：调用方以为用户点了取消，
  用户看到的是「点了没反应」（分支图的「归档」就这样变成过死按钮）。`test/dom-stub.js` 把三个原生
  函数换成抛错，UI 一旦退回去测试就失败。

| 文件 | 职责 | 导出 |
|---|---|---|
| `app.js` | 唯一入口：先经 `project-picker.js` 确认项目，再装配左栏顶部身份区按钮（品牌回概览 / 切换项目 / 移动端导航 / 右侧返回）、`#task-graph` / `#settings` / `#statistics` / 四个信息页 / Task / 文档的 hash 路由与两个定时器；定时器按「轮询频率」偏好重建；全局模式下另按 20s 低频刷新左栏项目列表摘要 | `boot()` |
| `route.js` | 当前页面的项目身份只来自地址：`/p/<id>/` 是本页项目，`/` 是单项目模式或全局列表；`projectApi()` 给项目 API 加前缀（启动器与文档等宿主级资源不加），`projectHref()` 生成项目地址。不 import 任何模块，`api.js` / `prefs.js` 都以它为准 | `projectRoute()`、`projectBase()`、`projectApi()`、`projectHref()` |
| `project-picker.js` | 全局项目列表与启动门：读 `/api/host`；根路径按 `last_project_id` 只做新窗口首次落点跳转，其余展示项目列表（名称 / 路径 / 已连接摘要 / 移除）；已在某个项目页时用新标签打开别的项目，切换不会丢掉当前标签的输入；Electron 环境可调用 preload 暴露的原生目录选择器；项目未选定前不启动快照轮询 | `ensureProject()`、`openProjectPicker()`、`closeProjectPicker()`、`refreshProjectList()` |
| `appearance.js` | head 中初始化深浅主题，装配左栏顶部的主题切换按钮；偏好经 prefs.js 读写（`lush.theme`），`system` 跟随系统、显式值覆盖系统，存储不可用时保留会话内选择 | `systemThemeMedia()`、`resolveTheme()`、`effectiveTheme()`、`applyTheme()`、`createAppearance()`、`initAppearance()`、`refreshTheme()` |
| `prefs.js` | 本地偏好中心：键名 / 默认值 / 解析与序列化、读写与变更通知都在这一份（`markdown` / `theme` / `sidebarSort` / `collapsed` / `filters` / `taskGraphStatuses` / `reduceMotion` / `polling` / `toastDuration` / `transcriptOrder` / `noticeNotifications`）；坏数据回落默认值，存储不可用不抛异常；老键（`lush.treeSort`、`lush.theme`、`lush.markdown`）继续生效；`collapsed` / `filters` / `sidebarSort` / `taskGraphStatuses` 按项目隔离（键加 `:<project-id>` 后缀），主题等外观偏好共享；`resetPrefs()` 删除全部受管键（含历史键）并逐项通知回默认值 | `PREF_DEFS`、`PREF_NAMES`、`MARKDOWN_KEY`、`THEME_KEY`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`REDUCED_MOTION_KEY`、`POLLING_KEY`、`TOAST_DURATION_KEY`、`TRANSCRIPT_ORDER_KEY`、`THEME_VALUES`、`SORT_IDS`、`POLLING_MODES`、`TOAST_MODES`、`TRANSCRIPT_ORDER_MODES`、`pollingIntervals()`、`toastDurations()`、`readPref`、`writePref`、`setPref`、`onPrefChange`、`resetPrefs`、`prefsSnapshot`、`storageAvailable`、`scopedKey` |
| `sleep-ui.js` / `styles-sleep.css` | 托管模式设置与风险确认、全页面左栏状态（管家值守/预算暂停、本会话已处理与选择计数、token 用量）及关闭/恢复入口、只读管家选择卡片；不在轮询时重置设置表单 | `sleepSettings()`、`renderSleepBanner(state)`、`sleepChoiceCard(choice)`；CSS |
| `render-settings.js` | 设置视图，分 托管模式 / Agent / 界面 / 系统四个页签：打开设置时才读取 `/api/agent/config` 完整配置；Agent 页编辑项目默认与九类角色覆盖（agent / model / thinking / 默认 prompt / 追加 prompt / Pi 扩展与 Skills），可按需读 `/api/agent/models` 展示本机 CLI 当前模型目录、读 `/api/agent/resources` 多选已安装资源，经 `agent.configure` 写入项目；同页的环境变量键值表按需读取公共/角色 env（值默认 password 遮罩、逐项可查看），支持新增/删除/保存，拒绝非法、重复与 `LUSH_*` 名称，经 `agent.environment.configure` 写回；默认 prompt 正常显示内置全文并可一键恢复，替换内置 prompt 前显示风险警告并二次确认；界面页管理浏览器本地偏好与恢复默认；系统页展示 daemon 配置与路径，其中并发额度（执行 / 控制通道）与调用 / 拆解限额（单次调用超时 / 单 Task 调用上限 / 最大拆解深度）是可编辑表单：显示生效值 / 环境默认值 / 来源 / 设置文件，保存 / 恢复环境默认走 `system.configure`，越界或后端报错就地提示；系统页另有「输入前缀（仅旧提交路径）」编辑器：列出每个前缀与派活目标（worker / research），可增删、校验空/超长/重复前缀，保存按整表写 `system.configure({settings:{input_routes}})`、恢复默认送 `{input_routes:null}`，显示是否被覆盖；该表只影响旧客户端提交（`input.submit` / 旧批量 `draft.commit`），新 say 不走快速路由，所以这里不再重画输入框高亮；系统页另有「快速介绍」编辑器：填 API 地址 / 模型 / API Key（只写不显，可单独清除），保存 / 清除走 `intro.configure`，显示可调用状态与配置文件路径。打开期间轮询不用概览覆盖 | `openSettings()`、`renderSettings()` |
| `statistics-range.js` | 日间／日内独立筛选的默认值、UTC 日历快捷范围、含首尾日期到半开 API 时间段的转换与小时校验 | `statisticsDefaults()`、`statisticsToday(now?)`、`statisticsDates(filters,now?)`、`statisticsQuery(filters,now?)` |
| `render-statistics.js` | `#statistics` 的日间（日历／7 天／30 天／本月／全部）与日内（今天／昨天／日历＋小时区间）双视图及独立筛选、累计 token / 预计 USD、UTC SVG 柱状图（全高时段命中区、即时鼠标／键盘数值浮层，以 SVG 属性定位且约束在滚动视口内）、provider/model 费用表、缺失数据说明与手动刷新；迟到响应不能覆盖其他视图 | `openStatistics()`、`renderStatistics(data)` |
| `styles-statistics.css` | 统计面板的响应式卡片、表格与 SVG 主题样式；不使用内联 style，不放宽 CSP | CSS |
| `styles.css` | 双主题设计 token、应用布局（无应用顶栏：品牌 / 项目名 / 并发槽 / 连接状态 / 主题切换 / 退出登录在左栏顶部的身份区，内容区占满高度）、组件、响应式与 reduced-motion 动效（含设置页与强制减少动效 `[data-reduced-motion="true"]`） | CSS |
| `state.js` | 共享可变状态（一个对象，新字段不必改别的文件就能加）；`ui.view` 为唯一页面身份（id/key），导航接缝集中更新兼容读标记；`ui.indexOpen` 记录右侧信息页，`ui.settingsOpen` 标记设置视图；折叠 / 筛选 / 排序偏好经 prefs.js 读写 | `ui`、`transcriptOpen`、`transcriptCache`、`mergeSelection`、`resetUiState()`、`readSidebarSortPref`、`readCollapsedPref`、`readFiltersPref`、`saveCollapsedPref`、`saveFiltersPref`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`SORT_IDS` |
| `navigate.js` | 导航间接层（断循环依赖）；注册返回带身份保护的 teardown，DOM 测试用完必须恢复，避免跨文件污染 | `registerNavigation({refresh, detail, overview, resource}) -> restore()`、`refresh()`、`detail(taskId)`、`overview()`、`resource(id)` |
| `service-restart.js` | 设置系统页的两个独立重启入口：应用内确认、范围与忙碌保护提示、重复点击保护、Host 能力探测；Host 换进程后有界探测新 pid，恢复刷新或转登录，失败就地提示 | `serviceRestartControls(options?)`、`waitForHostRestart(pid,options?)` |
| `api.js` | fetch 与用户动作；请求路径经 `route.js` 挂到本页项目前缀下 | `api(url, options)`、`action(method, params)`、`loadHistory(taskId)`、`projectApi` |
| `format.js` | 标签映射与格式化（纯函数） | `STATUS`、`INTEGRATION`、`ROLE`、`EVENTS`、`HOT`、`TERMINAL_STATUS`、`PLAN_GATE`、`SPEC_STATUS`、`MERGE_STATUS`、`CHANGE`、`DEP_HELP`、`STEP`、`MD_STEP`、`GOAL_TITLE_LIMIT`、`statusOf`、`relative`、`duration`、`absolute`、`clock`、`tokens`、`tokensView`、`money`、`depsOf`、`waitingDeps`、`resolverOf`、`specStatus`、`specTitle`、`summarizeGoal`、`taskTitle`、`edgeLabel`、`lastView`、`short` |
| `help.js` | 按钮帮助浮层：为含义不直观的按钮渲染 `data-help`，装配桌面悬停 / 键盘聚焦 / 移动端长按，禁用按钮由外层 `.help-host` 承载；会调用 Agent 的按钮统一用 `agent-call` 类与 `agentHelp()` 文案 | `AGENT_NOTE`、`agentHelp`、`initHelp`、`hideHelp`、`setHelpTimers` |
| `dom.js` | DOM 原语；`button()` 第 4 参数接受 `{help, agent}`：`help` 非空写入 `data-help`，`agent: true` 加 `agent-call`；Agent 代价文案由调用方经 `agentHelp()` 生成；`roleBadge(role)` 产出带 `role-<role>` 类的类型胶囊（未知角色回落 `role-unknown`），`routeBadge()` 产出统一的「⚡ 快速路由」徽章 | `el`、`button`、`syncChildren`、`block`、`kv`、`badge`、`statusBadge`、`roleBadge`、`routeBadge` |
| `dialog.js` | 应用内确认 / 输入 / 表单弹窗（替代原生 `confirm` / `prompt`）：画进独立于 `#detail` 的 `#modal`，同刻只留一个弹窗，Esc / 点背景 / 取消＝取消，Enter / 输入框回车＝确认，关闭后焦点还给打开者；选项接受 `agent` 与 `confirmHelp`，确认按钮沿用 `agent-call` 与 `agentHelp()` | `confirmDialog(opts)`、`promptDialog(opts)`、`formDialog(opts)`、`closeDialog()` |
| `text.js` | agent 输出的 Markdown 偏好（只在设置页管理，偏好键 `lush.markdown`）；偏好变化时重画当前详情 | `markdownEnabled()`、`agentText(value, opts)` |
| `gauge.js` | 左栏身份区并发槽表 | `slotGauge(data)` |
| `filters-ui.js` | 筛选控件与选项工具；`filterMulti` 提供常展开的即时复选组，空集合表示全部，`sync(options,value)` 复用选项节点并保留焦点 | `filterSelect`、`filterToggle`、`filterMulti`、`filterInput`、`syncSelectOptions`、`withCurrent`、`uniqueValues`、`roleOption`、`statusOption`、`specStatusOption`、`plannerOption`、`filterUi` |
| `sidebar-ui.js` | 统一页面导航：页面元数据、hash 写入、身份令牌、互斥画布、唯一 selected/aria-current、加载占位、视图栏、移动端收起、计数与兼容折叠状态 | `setViewChrome`、`activateDetailView({view,key?,hash?,title?,context?,hint?}) -> identity`、`openResource`、`paintCollapsed`、`setNavCount`、`selectNav`、`navTo` |
| `sidebar-init.js` | 装配左侧页面导航，以及移到右侧信息页内的筛选 / 排序控件 | `initSidebar()` |
| `composer.js` | 输入表单；默认折叠只留一行输入 + 一行操作（父 Task 下拉框与快捷键说明点开「展开」才出现，折叠态在控件上标出已选父 Task；展开状态只在会话内）；父 Task 候选取同一份 `overview` 快照里仍有分支的主干 / owner / say Task（正在展示冻结提交的 say 除外），**选项值仍是分支名**，所以选择的是 Task、`say.submit` 的语义（可带父分支）不变，候选变化时才重建 DOM 并保留仍有效的选择；发送按钮与 ⌘/Ctrl+Enter 以 `say.submit {start:false}` 只建 `paused`（详情显示「待开始」）Task，⌘/Ctrl+Shift+Enter 以 `start:true` 立即运行；进详情可用 `task.configure` 固定本轮 Agent / 模型 / Prompt / 扩展 / Skills / 软预算与按任务的 Pi 环境变量，再用 `task.resume` 开始；引用随本条 `say.submit` 一起提交；**输入框不做快速路由前缀高亮**：新 say 不走快速路由 | `syncComposer()`、`parentTasks()`、`renderParentOptions()`、`paintComposerDetails()`、`toggleComposerDetails()`、`initComposer()` |
| `input-routes.js` | 浏览器侧快速路由前缀**表**：只提供 `ROUTE_TARGETS` / `DEFAULT_INPUT_ROUTES` 给设置页的旧提交路径编辑器；不再带匹配实现（新 say 不走快速路由，输入框也不再高亮），前缀匹配只存在于 `src/core/input-routes.js` | `ROUTE_TARGETS`、`DEFAULT_INPUT_ROUTES` |
| `context-references.js` | 页面选区 / 语义元素的右键引用、任意选区的“快速介绍”入口（执行步骤仍开只读解释 Agent，其余直连模型）、输入框与草稿引用卡片、可引用节点注册及 `data-ref` 定位索引（卡片点击导航 + 一次性闪烁，找不到给顶部提示；text 引用不定位） | `referenceable(node, descriptor)`、`initContextReferences()`、`renderComposerReferences()`、`setComposerReferences()`、`locateReference(reference)`、`locatable(reference)`、`clearLocateFlash()` |
| `messages.js` | 顶部消息提示（toast）：`#error` 从 `.composer` 底部搬进固定浮层，脱离 `.app` 的 grid；停留时长是本地偏好（`lush.toastDuration`，标准档＝信息 4s / 错误 8s），失败 / 错误类带手动关闭按钮，鼠标悬停暂停倒计时，同一段文本反复写入不重置计时（离线错误不闪烁），空文本立即隐藏。错误 `role=alert` / `aria-live=assertive`，信息 `role=status` / `aria-live=polite`；计时器可注入（DOM 测试用假时钟） | `show(value, kind)`、`clear()`、`setTimers(next)` |
| `render-drafts.js` | 待提交缓存与引用摘要；每条草稿可就地编辑、移除、引用卡片定位，或用带 `agent-call` 与 `agentHelp()` 说明的「执行」按钮只提交这一条（`draft.commit {ids:[id]}`） | `renderDrafts(data)` |
| `render-intents.js` | Intent 列表：原始目标、planner 闸门、Plan 计数、最近展示 Task 的只读链接，以及历史 Review Candidate 的「打开结果 / 接受并合入 / 要求修改」动作；输入带 `route` 时行内加「⚡ 快速路由」徽章 | `renderIntents(data)` |
| `render-specs.js` | 拆解队列（只读） | `renderSpecs(data)`、`specItem(spec)`、`specDeps(value)` |
| `render-tree.js` | 全类型 Task 的平铺列表（保留旧文件与导出名，不渲染树）；筛选只显示命中项，不补祖先、不缩进、不画兄弟链，排序跨父子层级且不继承后代优先级（`tree-order.js` 的 `orderTasks(tasks,{mode,openNoticeIds})`）；状态 / 任务类型常展开即时多选，兼容历史与未知类型；专用及历史角色用 `roleBadge`（不显示通用 `agent` 角色标签）、快速路由用 `.route-flagged` 与 `routeBadge`；保留依赖标签、等待原因与进度；明确标出“活动 + 最近历史”的截断范围，通过 `/api/tasks?scope=all&before=` 按需加载更早页，筛选与搜索只针对已加载记录 | `renderTree(data)` |
| `render-notices.js` | 独立「管家选择」Event 游标页、待决计数、按状态分页记录、面板内答复与 Plan 审批、只读历史；resolver 首次请示使用明确动作；轮询保留输入与已加载历史 | `initNoticeRecords()`、`loadNoticeRecords({more?,preserve?})`、`renderNotices(data)`、`openNotice(noticeId)`、`noticePanel(notice, task?)` |
| `notice-notifications.js` | 默认关闭的客户端提醒：用户授权、开关状态、按项目建立首屏基线、增量通知与去重；浏览器 Notification / Electron IPC 适配 | `initNoticeNotifications()`、`notificationStatus()`、`setNoticeNotifications(enabled)`、`notificationControl()`、`createNoticeNotifier(options)`、`resetNoticeNotifier()`、`observeNotices(data)` |
| `notice-banner.js` | 全局常驻待决提醒条：汇总快照里全部 `status==="open"` 的 notice（问卷 / 计划审批 / 普通提问），与左栏「待我处理」、`renderNotices` 同口径；节点在 `.content-shell` 内、`#detail` / `#resource-panels` 之外，因此概览、Task 详情、设置、统计、Task 图、文档与信息页都可见（桌面常驻，移动端 sticky 在 `.view-toolbar` 下方）；宿主是 `role="status"` 的 `<section id="notice-banner">`，内容为一个可点、可键盘聚焦的 `<button>`，点击 `openResource("notices")` 后 `openNotice(最新 id)`（必须在 `renderNotices` 之后调用，保证 `ui.noticeIndex` 已更新）；用 `host.dataset` 签名幂等，轮询不重画、不抢焦点、不触发系统通知 | `renderNoticeBanner(data)` |
| `render-ladder.js` | 按目标分支分组的交付队列、变更栈与批量落地 | `renderLadder(data)`、`mergeBatch(ids, candidates)`、`renderMergeResult(entry)` |
| `render-history.js` | 事件时间线；默认最近 100 条，明确显示截断并用 `before` 游标逐页加载更早记录；事件引用的消息正文（后端附在 `event.message`）按收发方向与信号展示，普通消息仍按 Agent 输出渲染 | `renderHistory(history, opts)` |
| `render-diff.js` | 改动概览 | `renderDiff(diff)` |
| `render-progress.js` | Task 执行计划：防御性统计 versioned `progress`；有 runtime 投影时用 `work_ms` + `active_since` 显示 Agent 的实际工作用时（`kind:'wait'` 的等待条用 `wait_ms` + `waiting_since` 单独实时计时，不计入完成度），旧数据没有投影时回落 `started_at` 墙钟；详情逐步区分“用时”（完成态 serif italic）与“已执行”（当前态 monospace bold），等待条用 `--waiting` 配色；终态 Task 不再挂 live tick，而按最后 Run 结束时间冻结当前步骤并标明失败 / 取消 / 结束时中止，后续步骤显示未执行；Task 树画紧凑摘要，分支诊断画整行进度条并给 running Task 显著但尊重 reduced-motion 的扫光 / 流动动效 | `progressStats(progress)`、`liveProgressMs(item, now?)`、`formatProgressDuration(ms)`、`refreshProgressDurations(root)`、`renderTaskProgress(progress, opts)`、`renderCompactProgress(progress)`、`renderGraphProgress(progress, opts)` |
| `render-agent.js` | Agent 区块：显式点击打开全屏执行详情，保留可复制的 `lush task transcript ID --follow` 终端命令；模型与用量直接展开；增量更新最近一步及 tokens chip | `renderAgent(task, usage)`、`paintUsageLast(taskId, usage)` |
| `render-results.js` | 最新结果直接可见，历史 invocation 结果按身份／时间惰性折叠；合并 runs 与完成事件，借既有 history-page 有界翻页，保留重复文本与刷新时阅读节点 | `renderResults(task, history?, previous?)` |
| `transcript-model.js` | 紧凑摘要与会话／调用 ID 配对的纯阅读投影；不改变原步骤 | `stepSummary(step)`、`callKey(step)`、`groupSteps(steps)` |
| `structured-value.js` | 文本安全的惰性 JSON 树、节点／深度限额及原文回退；字符串保留换行，支持默认展开根节点 | `structuredValue(text, {openRoot?,preview?})` |
| `transcript-body.js` | 执行正文共享渲染，富文本／纯文本只差 `plain`：富文本给工具参数语义标签、修改前后、结构化 JSON、按语言给命令与文件正文着色、长内容就地预览展开；`plain` 给终端保留原始换行与扁平字段，不渲染 Markdown／JSON 树／着色。原文不改写 | `transcriptBody(step, {key?,preview?,plain?})` |
| `code-highlight.js` | 按需加载固定版本 highlight.js（common 构建，见同目录 `highlight-LICENSE.txt`）：只在出现带语言代码时拉取，用受控 DOM 构建器把输出落成 token span，不把 HTML 字符串 innerHTML 进页面；加载失败／未知语言／超长正文静默回退纯文本。另提供语言名归一化与按文件扩展名推断语言 | `enhanceCode(target, text, language)`、`normalizeLanguage(value)`、`languageFromPath(value)`、`resetCodeHighlight()` |
| `transcript-reader.js` | 紧凑搜索框（Enter／按钮显式提交）、筛选、分页；通过页面回调把同页命中交给全屏正文，定位器就地跳转；原文可限定在当前命中卡片内分段读取，关闭 / boot 作废旧请求 | `transcriptReader(taskId,{locate?,onStart?,onPage?,onError?,onClear?})`、`openTranscriptStep(taskId,seq,{root?}?)`、`releaseTranscriptReader(taskId)`、`resetTranscriptReaders()` |
| `transcript-view.js` | 全屏只读双栏执行详情；左栏固定搜索 / 筛选与独立滚动的分页摘要（Ctrl/⌘+Shift+F 聚焦），右栏一一对应的命中正文与配对内容（每页至多 50 项、最多 4 个并发步骤请求）；返回全部记录复用原增量渲染与排序偏好，搜索期间只提示新记录，关闭恢复位置 / 焦点并作废检索，原生 dialog 顶层承载引用菜单 | `openTranscriptView(taskId,seq?)`、`closeTranscriptView()` |
| `explanations.js` | 旁侧阅读面板：执行步骤直达无工具解释 Agent，选中文字直达模型 API 的「快速介绍」（直连结果与来源快照、按 `POST /api/action` + 轮询 `/api/intro/:id` 读取），以及两者合并在一个面板里的解释历史（快速介绍与执行步骤分两组，不出现 `undefined`）；全屏执行详情中挂在其 dialog 顶层内，Esc 只关闭解释；关闭不取消任务，boot 清理计时器 | `startExplanation(taskId,seq,quote)`、`startIntro(quote,location)`、`openExplanation(id)`、`openIntro(id)`、`explanationHistory(taskId)`、`closeExplanationPanel()` |
| `render-transcript.js` | 用户展开后的正文优先执行过程：阅读方向默认最新在前（`transcriptOrder` 可切回时间正序），初次加载 asc 走 `task.transcript`、desc 走 `task.transcript_latest`，两个阅读方向都提供有界翻页入口（`加载更早` 用 `before=oldest`、`加载更多` 用 `after=next`），按调用身份聚合输入输出、跨翻页边界配对并保留展开与阅读位置、跳到新内容；搜索命中经 `locateTranscriptStep` 取以目标 `seq` 为中心的有界窗口（前/后各 100 步）并在富文本视图就地展开滚动；每一步按 `tokens.first` 印一次占用 chip（精确 `上下文 X` / 估算 `+X`） | `transcriptContent(taskId)`、`transcriptMatch(taskId,step,related?)`、`paintTranscript(taskId)`、`appendTranscriptSteps(taskId, steps)`、`loadTranscript(taskId)`、`loadTranscriptWindow(taskId, seq)`、`locateTranscriptStep(taskId, seq)`、`fetchTranscriptAfter(taskId, after)`、`transcriptOrder()`、`tokensChip(tokens)` |
| `render-showcase.js` | 分支「预约效果展示」的重查与确认（`reserve_allowed`，确认后 `showcase.reserve`，已满足准入则后端立即启动并跳详情）、取消预约（`showcase.unreserve`），以及展示详情（静态 HTML sandbox、预览链接及停止）；失败 / 取消后若磁盘已有报告，明确标成中断前写入的未确认部分产物，不冒充完整交付 | `reserveBranchShowcase`、`unreserveBranchShowcase`、`renderShowcase` |
| `render-verify.js` | 检验区块 | `renderVerifications(task)` |
| `render-resolutions.js` | 合并冲突处理记录 | `renderResolutions(task)` |
| `retry-dialog.js` | 失败 / 取消 Task 的「检查后重试」完整 Profile 编辑器：读取该角色当前生效配置、模型目录与 Pi 资源，提交 task-local 覆盖且不改项目配置 | `retryAP(task)` |
| `render-iteration.js` | Task 详情/图共用的待验收、历史显式继续开发、安全同步父分支与独立 Agent 解决同步冲突；冻结/归档/执行前置禁用，最终准入由后端校验 | `iterationControls(task,{refresh,events})`、`iterationBlocker(task)`、`guardedAction(node,reason)`、`isIterationTask(task)` |
| `render-delivery.js` | 新式 say/child 运行中显示「预约合并」、静息显示「合并到父 Task」，version 2 请求冻结后展示 merge 子 Task 自动 Squash 的状态、分歧回原 Task 处理、失败复查及合并后归还原父 Task（进入待验收并保留分支/worktree，可追加输入继续同一 Task 与再次交付，验收/归档独立）；已展示的 say 可重新打开走相同自动交付。历史 version 1 预约仍显示旧审批控件。旧逻辑：新 say 在静息、有执行结果且有待交付提交时优先显示「请求合并」（仍经 `task.reserve` 发出固定提交请求，不自动批准）；展示交付并结算为 completed 的 say 无 pending 可等，同样显示「请求合并」直接补发一次固定提交请求（撤销后也保留该入口），未就绪时保留互斥展示/合并预约与撤销、pending 的显式安全复查（复用同类 `task.reserve`，让父分支交付锁之类阶段性阻塞可见）、父子分歧时用户确认后派源侧解分歧 Agent 子 Task（终态 say 同样可派；不自动集成父分支，终态 say 的产物由 runtime 推进并重新发请求；终态未集成 child 引导检查并显式归档后新派，子 Task 详情不提供重放）、已发出未集成的请求显示失效诊断（`parent_moved` / `parent_locked` / `source_moved` / `contained`）、给只读「复查请求」（复用同类 `task.reserve`，会按当前 Git 事实重写诊断）并可「撤销请求」解除父分支交付锁（确认弹窗说明不删分支与提交）、冻结源 commit + 父 baseline 的用户批准；Task 详情/Task 图复用同一组确认与按钮提示，展示预约用 `agent-call` + `agentHelp`；旧 Task 与非 say 子节点不显示 | `deliveryControls(task,{refresh})` |
| `render-detail.js` | Task 详情整页：非终态 say/child 的操作栏首位提供「追加输入」，点击打开多行输入弹窗，经 `task.message` 发给当前 Task，暂停中的任务仍需开始 / 继续；一句话短标题（`taskTitle`）、完整 goal 以 Markdown 正文排在结果之前、状态、结果优先的阅读顺序与 Task 操作；头部用 `roleBadge` 显示专用及历史类型颜色（不显示通用 `agent` 角色标签；Agent 身份与运行信息保留），`task.route` 为真时另带「⚡ 快速路由」徽章，`task_kind='analysis'` 另带「只读分析」徽章；main/owner 详情给「问这条分支」（`agent-call` + 弹窗确认）：问题经用户专属 `task.analyze` 启一个只读分析子 Task 并跳过去；Task 有可归档分支时在操作区给「归档」（读模型 `branch_archive` 投影，复用 `branch-archive.js`，与 Task 图同源） | `renderDetail(task, history, diff, usage)`、`renderDetailError(taskId, message)` |
| `render-overview.js` | 项目概览：Task 指标、最近任务、待决与运行中的 Agent，运行时信息默认折叠；没有旧分支图入口，也不再拉 Git 分支图 | `renderOverview(data)` |
| `task-graph-layout.js` | Task 父子森林纯逻辑：缺失父节点作为可见根，坏数据成环不死循环 | `taskForest(graph)` |
| `render-task-graph.js` | `#task-graph` 独立视图：Task 卡片展示目标、结果、等待原因、执行进度、待决、交付与当前 Git 诊断；卡片不显示通用 `agent` 角色标签，保留专用及历史角色和 `task_kind`；卡片按真实状态配色（running 呼吸外环，其余各一色，中性 idle 兜底），表头汇总行以同一套状态色列计数兼作图例；使用 `task-graph-parts.js` 的待决/诊断组件与 Task 详情交付按钮；merge 队列身份与其它 Task 一样常驻图上（不再按队列活跃度自动收起），卡上在队列有动作时多一行队列摘要；表头的状态计数兼作筛选开关，可按状态隐藏 / 恢复 Task（偏好存 `lush.taskGraph.hiddenStatuses`，`prefs.js` 受管），被筛掉的父节点下的子 Task 顶成根；main/owner 卡片另给「合并所有」入口：只读筛出这条分支下所有已静息、待合并的 say/child，确认一次后由 `task.reserve_all` 交给父 Task 的 v2 merge 子任务串行处理（无可合并项时禁用并写明原因）；折叠按项目存、输入草稿不被轮询覆盖；分支诊断另显示真实 Git 父分支、当前检出、领先/落后计数和关系状态；可归档分支的卡片在分支诊断里给「归档」（与 Task 详情同源，读模型给 `branch_info.archivable` / `subtree_branches`） | `openTaskGraph()`、`loadTaskGraph()`、`renderTaskGraph(graph)` |
| `task-graph-parts.js` | Task 图的有界文件改动/工作区诊断与就地待决控件；文件展开状态走 `ui.taskGraphFilesExpanded`，答复后用调用方提供的刷新接缝重拉 | `branchDiagnostics(branch)`、`decisionRow(node,refresh)` |
| `branch-archive.js` | 「归档分支」这条用户动作的唯一实现，Task 图 / Task 详情两个入口共用：确认弹窗写清会连后代分支一起删 worktree 与本地 ref、未提交改动会丢、Task／消息／事件／会话保留，确认后发 `branch.archive {branch, discard:true}`，把结果写进顶部提示并调用调用方传的 `refresh()` 重拉对应视图；`BRANCH_ARCHIVE_HELP` 是三个入口共用的按钮含义说明（归档是放弃代码的记录状态，不等于删除 Task） | `runBranchArchive(branch,{refresh})`、`BRANCH_ARCHIVE_HELP` |
| `detail.js` | 拉取并渲染 Task 详情，仅用户已展开过程时读取执行记录；窄屏新导航收起索引并定位内容，轮询保留滚动 | `loadDetail(taskId)` |
| `docs.js` | 「文档」视图：路由（`#docs` / `#doc-<id>`）、取数、搜索索引懒加载与站内相对链接解析 | `docsTarget(hash)`、`resolveDocPath(from, raw)`、`docLinkResolver(current, docs)`、`loadDocsSearchIndex()`、`openDocs(id)`、`loadDocs(id)`、`DOCS_HASH` |
| `docs-search.js` | 浏览器全文搜索纯逻辑：NFKC / 小写归一化，中英文子串、多词 AND、字段加权、摘要与稳定排序；Mermaid 仅低权重参与 | `normalizeDocsQuery(value)`、`searchDocs(index, query, limit)` |
| `render-docs.js` | 「文档」视图的目录、懒加载内容搜索、Markdown 正文、Mermaid 启动与兜底 | `renderDocsIndex(docs, onOpen, options)`、`renderDoc(doc, resolveLink, onOpen)`、`renderDocError(id, message, onOpen)` |
| `mermaid-docs.js` | 只在文档存在 Mermaid 容器时加载本地固定版本，以 strict 模式逐图校验，并通过显式唯一 id 渲染成隔离的 blob SVG 图片（避免节点/箭头串图，也不用为 Mermaid 放宽主页面的 inline-style CSP）；换文档时回收 blob URL，切换深浅主题时从保留源码串行重绘，超长、超量、加载或语法失败均回退为源码。Agent 输出不走这条路径 | `renderMermaidDiagrams(root)`、`refreshMermaidDiagrams(root)`、`clearMermaidDiagrams(root)` |
| `refresh.js` | 轮询有界 `/api/overview`（revision 未变时不重画；旧 host 回退完整 snapshot）、概览、热 Task 增量刷新、筛选重画；右侧信息页 / 文档 / 设置 / 统计打开时不让概览覆盖；切回概览立即用缓存绘制，不等 revision 变化或轮询空闲；概览不再拉 Git 分支图；Task 图通过 `/api/task-graph` 单飞刷新，快照变且距上次 ≥3s 或距上次 ≥10s 时重拉，正在输入时不重画；changed 时在 `renderNotices(data)` 之后同步调用 `renderNoticeBanner(data)` | `refresh()`、`overview()`、`liveRefresh()`、`applyFilters()` |

Task 图走 `task.graph` / `/api/task-graph`、`#task-graph`，不复用 Git fork 边。旧「分支与合并」导航、`#graph` 页面、`/api/graph` HTTP 路由、分支图渲染与布局模块已移除；旧 hash 回概览。完整谱系和未绑定本地分支绑定仅保留 CLI / RPC，不增加隐藏页面。历史分支引用保留快照，但点击时明确说明 Web 定位入口已移除；Task 图仅提供通用文字/选区引用，不新增分支语义引用。

Task 卡片显示真实 Git 父分支、当前检出、领先/落后计数及关系状态；Squash 后 Git 分歧与 `integration=merged` 可以同时成立，不互相冒充。文件统计、列表限额与未知口径见[分支诊断接缝](modules.md#分支诊断增量读面)。交付按钮复用 `render-delivery.js`，归档复用 `branch-archive.js`。参见 [Task 图与固定输入规则](task-graph.md)。

其它纯逻辑模块：`markdown.js`、`tree-order.js`、`live.js`、`sidebar.js`；`merge-select.js` 是交付队列的候选、冻结与 code-only 顺序预览接缝，由 `render-ladder.js` 使用。`live.js` 的实时刷新间隔不再是写死常量：`liveInterval()` 读「轮询频率」偏好，标准档等于改造前的 3000ms。

真实浏览器布局回归入口：`scripts/check-transcript-layout.js`（Firefox / geckodriver，无第三方 JS 依赖），职责与命令见[执行记录阅读器验证](transcript-reader.md#验证入口)。

## Web / 桌面宿主

| 文件 | 职责 | 导出 / 接缝 |
|---|---|---|
| `src/ui/web/server.js` | Host 的 HTTP 适配器：UI 资源、认证、窄 API 路由与 `/p/<project-id>/` 项目身份路由；项目连接与发现委托 `src/host/project-host.js` | `startWeb()`、`rememberWebProject()` |
| `src/host/project-host.js` | 已登记项目的连接缓存与 single-flight、身份解析、按需启动 lushd；列表仅探测已登记项目的 socket，不启动未打开的项目 | `createProjectHost()` |
| `src/host/control.js` | 后台 lush-host 进程识别（含 worker）、状态文件、端口探测与安全停止；状态记录可带 `supervisor_pid` 以关联启动者 | `webOwners()`、`stopStaleWeb()`、`recordWebState()` 等 |
| `src/host/service-control.js` | 项目级重启 single-flight：请求 idle 停止、等锁释放、启动新 daemon，无强杀 | `restartProjectDaemon(config)` |
| `src/host/supervisor.js` | `bin/lush-host` 的稳定进程所有者，等 worker 退出75后在同端口重新启动；普通退出不重放，退出时停止唯一 worker | `superviseHost(args?)` |
| `src/ui/web/docs.js` | 扫描随代码发布的 Markdown 文档与搜索字段 | `docsIndex()`、`docsSearchIndex()`、`readDoc()` |
| `src/host/registry.js` | 跨项目的登记列表、最后路径缓存、稳定路由 ID 派生、绝对目录 canonicalize、无项目 Web 控制配置 | `launcherStateDir()`、`readLauncherState()`、`writeLauncherState()`、`removeLauncherProject()`、`projectRouteId()`、`canonicalProjectPath()`、`launcherWebConfig()` |
| `src/ui/desktop/main.js` | Electron 装配入口：设置 userData，装配桌面 runtime | Electron `main` 入口 |
| `src/ui/desktop/runtime.js` | 连接菜单、可信连接页、本地 / 远程独立窗口、按窗口 IPC / 导航 / 通知安全边界及退出清理；远程直接加载所选 Host，不在本地复制业务 API | `createDesktop({electron, userData, localHost?, store?})` |
| `src/ui/desktop/local-host.js` | single-flight 启动随机端口临时 Host，处理启动失败、超时及退出；仅本地窗口需要 Bun，桌面退出只停自己持有的 Host | `createLocalHost(options?)` → `start()` / `stop()` |
| `src/ui/desktop/connections.js` | Host 根地址校验（HTTPS / 回环 HTTP）、会话分区与页面身份判定、最近连接和按 Host 的提醒偏好；纯连接元数据，不含项目事实或密码 | `normalizeHostUrl()`、`sameHost()`、`sessionPartition()`、`isProjectPage()`、`ConnectionStore` |
| `src/ui/desktop/connection.html` / `connection.js` / `connection.css` | 本地可信连接页：打开本地、输入远程 Host、最近连接、仅移除记录、失败就地显示；帮助复用 Web `help.js` | 桌面内部页面，无业务 API |
| `src/ui/desktop/connection-preload.cjs` | 仅连接页可用的本地 / 远程打开及记录管理 IPC | `window.lushConnections.list()` / `openLocal()` / `openRemote(url)` / `remove(url)` |
| `src/ui/desktop/preload.cjs` | 沙箱内的窄通知 IPC；只有本地工作窗口暴露目录选择，远程窗口不暴露；通知点击只导航到固定 `#notices` | `window.lushDesktop.chooseProject()`（仅本地）、`notificationSettings(enabled?)`、`notifyNotice(payload)` |

桌面壳不复制任何业务页面或 API。首启展示连接页，本地窗口共享桌面持有的临时 Host，远程窗口直接连接 HTTPS Host 或用户自行建立的回环 HTTP SSH 隧道；可同时使用本地和多个远程窗口。业务 UI / API 始终由各自 Host 提供；选择远程项目时路径属于远端，不使用本地目录选择器。登录会话按 Host origin 隔离并持久化，提醒开关按 Host 隔离；未知源、子 frame 和独立预览窗口不得调用工作窗口 IPC。完整行为与限制见[远程桌面部署](../deployment/remote-desktop.md)。

`markdown.js` 除默认渲染外还有两件「文档」视图需要的能力：`renderMarkdown(text, doc, options)` 里的
`options.link(raw, label)` 由调用方接管链接解析（返回 `{ href, external }`，返回空或抛错都回落到默认规则：
只有 http/https 成链接）、GFM 表格，以及只在 `options.diagrams === true` 时把 `mermaid` fence 标成待渲染容器。
不传 options 时 Mermaid 仍是普通代码，因此 Agent 输出不会加载或执行图表。带语言标记的 Markdown fence 交给
`code-highlight.js` 按需着色；未知语言与加载失败都回退原纯文本。

---

[← 上一篇：Runtime 与持久化](modules-runtime.md) · [下一篇：CLI、RPC 与测试 →](modules-interfaces.md)
