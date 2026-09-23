# 模块地图：Web 前端

本章是 `src/ui/web/assets/` 的职责与导出清单。浏览器端使用原生 ES module，不经过打包。修改执行过程相关模块前，必须先读[设计理念](../design/agent-process.md)与[阅读器边界](transcript-reader.md)。修改按钮文案、图标、样式或 `agent-call` 标识前，必须先读[按钮帮助与 Agent 触发标识](../design/ui-guidance.md)。

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
| `app.js` | 唯一入口：先经 `project-picker.js` 确认项目，再装配左栏顶部身份区按钮（品牌回概览 / 切换项目 / 移动端导航 / 右侧返回）、`#graph` / `#settings` / `#statistics` / 四个信息页 / 任务 / 文档的 hash 路由与两个定时器；定时器按「轮询频率」偏好重建 | `boot()` |
| `project-picker.js` | 无项目启动门：读取 `/api/launcher`，首次要求绝对项目路径，有缓存则直接进入；在全局模式显示「切换项目」，Electron 环境可调用 preload 暴露的原生目录选择器；项目未选定前不启动快照轮询 | `ensureProject()`、`openProjectPicker()`、`closeProjectPicker()` |
| `appearance.js` | head 中初始化深浅主题，装配左栏顶部的主题切换按钮；偏好经 prefs.js 读写（`lush.theme`），`system` 跟随系统、显式值覆盖系统，存储不可用时保留会话内选择 | `systemThemeMedia()`、`resolveTheme()`、`effectiveTheme()`、`applyTheme()`、`createAppearance()`、`initAppearance()`、`refreshTheme()` |
| `prefs.js` | 本地偏好中心：键名 / 默认值 / 解析与序列化、读写与变更通知都在这一份（`markdown` / `theme` / `sidebarSort` / `collapsed` / `filters` / `reduceMotion` / `polling` / `toastDuration` / `transcriptOrder` / `noticeNotifications`）；坏数据回落默认值，存储不可用不抛异常；老键（`lush.treeSort`、`lush.theme`、`lush.markdown`）继续生效；`resetPrefs()` 删除全部受管键（含历史键）并逐项通知回默认值 | `PREF_DEFS`、`PREF_NAMES`、`MARKDOWN_KEY`、`THEME_KEY`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`REDUCED_MOTION_KEY`、`POLLING_KEY`、`TOAST_DURATION_KEY`、`TRANSCRIPT_ORDER_KEY`、`THEME_VALUES`、`SORT_IDS`、`POLLING_MODES`、`TOAST_MODES`、`TRANSCRIPT_ORDER_MODES`、`pollingIntervals()`、`toastDurations()`、`readPref`、`writePref`、`setPref`、`onPrefChange`、`resetPrefs`、`prefsSnapshot`、`storageAvailable` |
| `sleep-ui.js` / `styles-sleep.css` | 睡觉模式设置与风险确认、全页面左栏状态及关闭/恢复入口、只读管家选择卡片；不在轮询时重置设置表单 | `sleepSettings()`、`renderSleepBanner(state)`、`sleepChoiceCard(choice)`；CSS |
| `render-settings.js` | 设置视图，分 我去睡觉了 / Agent / 界面 / 系统四个页签：打开设置时才读取 `/api/agent/config` 完整配置；Agent 页编辑项目默认与九类角色覆盖（agent / model / thinking / 默认 prompt / 追加 prompt / Pi 扩展与 Skills），可按需读 `/api/agent/models` 展示本机 CLI 当前模型目录、读 `/api/agent/resources` 多选已安装资源，经 `agent.configure` 写入项目；同页的环境变量键值表按需读取公共/角色 env（值默认 password 遮罩、逐项可查看），支持新增/删除/保存，拒绝非法、重复与 `LUSH_*` 名称，经 `agent.environment.configure` 写回；默认 prompt 正常显示内置全文并可一键恢复，替换内置 prompt 前显示风险警告并二次确认；界面页管理浏览器本地偏好与恢复默认；系统页展示 daemon 配置与路径，其中并发额度（执行 / 控制通道）是可编辑表单：显示生效值 / 环境默认值 / 来源 / 设置文件，保存 / 恢复环境默认走 `system.configure`，越界或后端报错就地提示，其余参数只读。打开期间轮询不用概览覆盖 | `openSettings()`、`renderSettings()` |
| `statistics-range.js` | 日间／日内独立筛选的默认值、UTC 日历快捷范围、含首尾日期到半开 API 时间段的转换与小时校验 | `statisticsDefaults()`、`statisticsToday(now?)`、`statisticsDates(filters,now?)`、`statisticsQuery(filters,now?)` |
| `render-statistics.js` | `#statistics` 的日间（日历／7 天／30 天／本月／全部）与日内（今天／昨天／日历＋小时区间）双视图及独立筛选、累计 token / 预计 USD、UTC SVG 柱状图（全高时段命中区、即时鼠标／键盘数值浮层，以 SVG 属性定位且约束在滚动视口内）、provider/model 费用表、缺失数据说明与手动刷新；迟到响应不能覆盖其他视图 | `openStatistics()`、`renderStatistics(data)` |
| `styles-statistics.css` | 统计面板的响应式卡片、表格与 SVG 主题样式；不使用内联 style，不放宽 CSP | CSS |
| `styles.css` | 双主题设计 token、应用布局（无应用顶栏：品牌 / 项目名 / 并发槽 / 连接状态 / 主题切换 / 退出登录在左栏顶部的身份区，内容区占满高度）、组件、响应式与 reduced-motion 动效（含设置页与强制减少动效 `[data-reduced-motion="true"]`） | CSS |
| `state.js` | 共享可变状态（一个对象，新字段不必改别的文件就能加）；`ui.view` 为唯一页面身份（id/key），导航接缝集中更新兼容读标记；`ui.indexOpen` 记录右侧信息页，`ui.lastGraph` 保存最近一次 `graph.get` 读模型，`ui.settingsOpen` 标记设置视图；折叠 / 筛选 / 排序偏好经 prefs.js 读写 | `ui`、`transcriptOpen`、`transcriptCache`、`mergeSelection`、`resetUiState()`、`readSidebarSortPref`、`readCollapsedPref`、`readFiltersPref`、`saveCollapsedPref`、`saveFiltersPref`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`SORT_IDS` |
| `navigate.js` | 导航间接层（断循环依赖）；注册返回带身份保护的 teardown，DOM 测试用完必须恢复，避免跨文件污染 | `registerNavigation({refresh, detail, overview, graph, resource}) -> restore()`、`refresh()`、`detail(taskId)`、`overview()`、`graph()`、`resource(id)` |
| `api.js` | fetch 与用户动作 | `api(url, options)`、`action(method, params)`、`loadHistory(taskId)` |
| `format.js` | 标签映射与格式化（纯函数） | `STATUS`、`INTEGRATION`、`ROLE`、`EVENTS`、`HOT`、`TERMINAL_STATUS`、`WAIT_REASON`、`PLAN_GATE`、`SPEC_STATUS`、`MERGE_STATUS`、`CHANGE`、`DEP_HELP`、`STEP`、`MD_STEP`、`GOAL_TITLE_LIMIT`、`statusOf`、`relative`、`duration`、`absolute`、`clock`、`tokens`、`tokensView`、`money`、`depsOf`、`waitingDeps`、`resolverOf`、`specStatus`、`specTitle`、`summarizeGoal`、`taskTitle`、`edgeLabel`、`lastView`、`short` |
| `help.js` | 按钮帮助浮层：为含义不直观的按钮渲染 `data-help`，装配桌面悬停 / 键盘聚焦 / 移动端长按，禁用按钮由外层 `.help-host` 承载；会调用 Agent 的按钮统一用 `agent-call` 类与 `agentHelp()` 文案 | `AGENT_NOTE`、`agentHelp`、`initHelp`、`hideHelp`、`setHelpTimers` |
| `dom.js` | DOM 原语；`button()` 第 4 参数接受 `{help, agent}`：`help` 非空写入 `data-help`，`agent: true` 加 `agent-call`；Agent 代价文案由调用方经 `agentHelp()` 生成 | `el`、`button`、`syncChildren`、`block`、`kv`、`badge`、`statusBadge` |
| `dialog.js` | 应用内确认 / 输入 / 表单弹窗（替代原生 `confirm` / `prompt`）：画进独立于 `#detail` 的 `#modal`，同刻只留一个弹窗，Esc / 点背景 / 取消＝取消，Enter / 输入框回车＝确认，关闭后焦点还给打开者；选项接受 `agent` 与 `confirmHelp`，确认按钮沿用 `agent-call` 与 `agentHelp()` | `confirmDialog(opts)`、`promptDialog(opts)`、`formDialog(opts)`、`closeDialog()` |
| `text.js` | agent 输出的 Markdown 偏好（只在设置页管理，偏好键 `lush.markdown`）；偏好变化时重画当前详情 | `markdownEnabled()`、`agentText(value, opts)` |
| `gauge.js` | 左栏身份区并发槽表 | `slotGauge(data)` |
| `filters-ui.js` | 筛选控件与选项工具 | `filterSelect`、`filterToggle`、`filterInput`、`syncSelectOptions`、`withCurrent`、`uniqueValues`、`roleOption`、`statusOption`、`specStatusOption`、`plannerOption`、`filterUi` |
| `sidebar-ui.js` | 统一页面导航：页面元数据、hash 写入、身份令牌、互斥画布、唯一 selected/aria-current、加载占位、视图栏、移动端收起、计数与兼容折叠状态 | `setViewChrome`、`activateDetailView({view,key?,hash?,title?,context?,hint?}) -> identity`、`openResource`、`paintCollapsed`、`setNavCount`、`selectNav`、`navTo` |
| `sidebar-init.js` | 装配左侧页面导航，以及移到右侧信息页内的筛选 / 排序控件 | `initSidebar()` |
| `composer.js` | 输入缓存与提交表单；默认折叠只留一行输入 + 一行操作（父分支字段与快捷键说明点开「展开」才出现，折叠态在控件上标出非空父分支；展开状态只在会话内）；提示统一交给 `messages.js`，不再自己写输入栏底部的 `#error` | `buffer()`、`selectedDraftIds()`、`syncComposer()`、`paintDraftPanel()`、`toggleDraftPanel()`、`paintComposerDetails()`、`toggleComposerDetails()`、`initComposer()` |
| `context-references.js` | 页面选区 / 语义元素的右键引用、任意选区的“介绍”入口、输入框与草稿引用卡片、可引用节点注册及 `data-ref` 定位索引（卡片点击导航 + 一次性闪烁，找不到给顶部提示；text 引用不定位） | `referenceable(node, descriptor)`、`initContextReferences()`、`renderComposerReferences()`、`setComposerReferences()`、`locateReference(reference)`、`locatable(reference)`、`clearLocateFlash()` |
| `messages.js` | 顶部消息提示（toast）：`#error` 从 `.composer` 底部搬进固定浮层，脱离 `.app` 的 grid；停留时长是本地偏好（`lush.toastDuration`，标准档＝信息 4s / 错误 8s），失败 / 错误类带手动关闭按钮，鼠标悬停暂停倒计时，同一段文本反复写入不重置计时（离线错误不闪烁），空文本立即隐藏。错误 `role=alert` / `aria-live=assertive`，信息 `role=status` / `aria-live=polite`；计时器可注入（DOM 测试用假时钟） | `show(value, kind)`、`clear()`、`setTimers(next)` |
| `render-drafts.js` | 待提交缓存与引用摘要 | `renderDrafts(data)` |
| `render-intents.js` | Intent 列表：原始目标、planner 闸门、Plan 计数、最近展示任务的只读链接，以及历史 Review Candidate 的「打开结果 / 接受并合入 / 要求修改」动作 | `renderIntents(data)` |
| `render-specs.js` | 拆解队列（只读） | `renderSpecs(data)`、`specItem(spec)`、`specDeps(value)` |
| `render-tree.js` | 全类型任务列表与任务树（含规划、历史调度、展示与执行介绍）；固定完整类型筛选、兄弟链、依赖标签、为什么没在跑；明确标出“活动 + 最近历史”的截断范围，通过 `/api/tasks?scope=all&before=` 按需加载更早页，筛选只针对已加载记录 | `renderTree(data)` |
| `render-notices.js` | 独立「管家选择」Event 游标页、待决计数、按状态分页记录、面板内答复与 Plan 审批、只读历史；resolver 首次请示使用明确动作；轮询保留输入与已加载历史 | `initNoticeRecords()`、`loadNoticeRecords({more?,preserve?})`、`renderNotices(data)`、`openNotice(noticeId)`、`noticePanel(notice, task?)` |
| `notice-notifications.js` | 默认关闭的客户端提醒：用户授权、开关状态、按项目建立首屏基线、增量通知与去重；浏览器 Notification / Electron IPC 适配 | `initNoticeNotifications()`、`notificationStatus()`、`setNoticeNotifications(enabled)`、`notificationControl()`、`createNoticeNotifier(options)`、`resetNoticeNotifier()`、`observeNotices(data)` |
| `notice-banner.js` | 全局常驻待决提醒条：汇总快照里全部 `status==="open"` 的 notice（问卷 / 计划审批 / 普通提问），与左栏「待我处理」、`renderNotices` 同口径；节点在 `.content-shell` 内、`#detail` / `#resource-panels` 之外，因此概览、任务详情、设置、统计、分支图、文档与四个信息页都可见（桌面常驻，移动端 sticky 在 `.view-toolbar` 下方）；宿主是 `role="status"` 的 `<section id="notice-banner">`，内容为一个可点、可键盘聚焦的 `<button>`，点击 `openResource("notices")` 后 `openNotice(最新 id)`（必须在 `renderNotices` 之后调用，保证 `ui.noticeIndex` 已更新）；用 `host.dataset` 签名幂等，轮询不重画、不抢焦点、不触发系统通知 | `renderNoticeBanner(data)` |
| `render-ladder.js` | 按目标分支分组的交付队列、变更栈与批量落地 | `renderLadder(data)`、`mergeBatch(ids, candidates)`、`renderMergeResult(entry)` |
| `render-timeline.js` | 并行时间轴 | `renderTimeline(timeline)` |
| `render-history.js` | 事件时间线；默认最近 100 条，明确显示截断并用 `before` 游标逐页加载更早记录 | `renderHistory(history, opts)` |
| `render-diff.js` | 改动概览 | `renderDiff(diff)` |
| `render-progress.js` | task 执行计划：防御性统计 versioned `progress`；详情逐步区分“用时”（完成态 serif italic）与“已执行”（当前态 monospace bold）并实时计时；终态 task 不再挂 live tick，而按最后 Run 结束时间冻结当前步骤并标明失败 / 取消 / 结束时中止，后续步骤显示未执行；任务树画紧凑摘要，分支诊断画整行进度条并给 running task 显著但尊重 reduced-motion 的扫光 / 流动动效 | `progressStats(progress)`、`formatProgressDuration(ms)`、`refreshProgressDurations(root)`、`renderTaskProgress(progress, opts)`、`renderCompactProgress(progress)`、`renderGraphProgress(progress, opts)` |
| `render-agent.js` | Agent 区块：执行过程默认收起、显式点击才加载与展开，提供终端模式入口；模型与用量直接展开；增量更新最近一步，带 tokens 时并排一个与步骤同口径的 chip | `renderAgent(task, usage, reading?)`、`paintUsageLast(taskId, usage)` |
| `transcript-model.js` | 紧凑摘要与会话／调用 ID 配对的纯阅读投影；不改变原步骤 | `stepSummary(step)`、`callKey(step)`、`groupSteps(steps)` |
| `structured-value.js` | 文本安全的惰性 JSON 树、节点／深度限额及原文回退；字符串保留换行，支持默认展开根节点 | `structuredValue(text, {openRoot?,preview?})` |
| `transcript-body.js` | 执行正文共享渲染：工具参数语义标签、修改前后、命令／输出换行、长内容就地预览展开；原文不改写 | `transcriptBody(step, {key?,preview?})` |
| `transcript-reader.js` | 展开过程后的全文检索、筛选、分页；命中在终端阅读器定位，boot 时清理旧请求 | `transcriptReader(taskId)`、`openTranscriptStep(taskId,seq)`、`resetTranscriptReaders()` |
| `transcript-terminal.js` | Pi 风格的只读全宽终端阅读器：连续正文、会话分隔、分段续读、搜索定位后向前翻页、手动读取新记录、关闭恢复位置与焦点；无 Pi/PTY 依赖 | `openTranscriptTerminal(taskId,seq?)`、`closeTranscriptTerminal()` |
| `explanations.js` | 选区直达无工具解释 Agent 的旁侧面板、状态读取与来源快照／历史（执行步骤与通用选区两种 v1 快照都能渲染，不出现 `undefined`）；终端模式下挂在其 dialog 顶层内，Esc 只关闭解释；关闭不取消任务，boot 清理计时器 | `startExplanation(taskId,seq,quote)`、`startSelectionExplanation(quote,location)`、`openExplanation(id)`、`explanationHistory(taskId)`、`closeExplanationPanel()` |
| `render-transcript.js` | 用户展开后的正文优先执行过程：阅读方向默认最新在前（`transcriptOrder` 可切回时间正序），asc 走 `task.transcript`、desc 走 `task.transcript_latest`（初次取尾窗、`before=oldest` 加载更早、`after=next` 增量续读），按调用身份聚合输入输出、跨翻页边界配对并保留展开与阅读位置、跳到新内容；每一步按 `tokens.first` 印一次占用 chip（精确 `上下文 X` / 估算 `+X`） | `transcriptContent(taskId)`、`paintTranscript(taskId)`、`appendTranscriptSteps(taskId, steps)`、`loadTranscript(taskId)`、`fetchTranscriptAfter(taskId, after)`、`transcriptOrder()`、`tokensChip(tokens)` |
| `render-showcase.js` | 合格分支的展示启动确认（重查后端准入）、展示详情（静态 HTML sandbox、预览链接及停止）；失败 / 取消后若磁盘已有报告，明确标成中断前写入的未确认部分产物，不冒充完整交付 | `startBranchShowcase`、`renderShowcase` |
| `render-verify.js` | 检验区块 | `renderVerifications(task)` |
| `render-resolutions.js` | 合并冲突处理记录 | `renderResolutions(task)` |
| `retry-dialog.js` | 失败 / 取消任务的「检查后重试」完整 Profile 编辑器：读取该角色当前生效配置、模型目录与 Pi 资源，提交 task-local 覆盖且不改项目配置 | `retryTask(task)` |
| `render-detail.js` | 任务详情整页：一句话短标题（`taskTitle`）、完整 goal 以 Markdown 正文排在结果之前、状态、结果优先的阅读顺序与任务操作 | `renderDetail(task, history, diff, usage)`、`renderDetailError(taskId, message)` |
| `render-overview.js` | 项目概览：指标按 Intent / 并行执行 / 需要你决定计，不提供展示启动按钮、指标或大列表，仅保留关联 Intent 已有展示的查看链接，候选同时显示 verification 的 pass / fail / partial / unverified / unknown；Intent 成果主线（含候选报告入口）先于折叠的 Git 交付诊断，任务只作明细；`kind='info'` 提醒、运行中 agent 与时间轴、维护信息照旧（`render-ladder.js` / `merge-select.js` 仍可用，但没有常驻视图） | `renderOverview(data)` |
| `graph-layout.js` | 分支图纯逻辑：fork 边拼出分支森林（任务挂到自己的分支下并把父分支作为嵌套；planner / scheduler 由 `graph.get` 派生出输入锚点分支后与 worker 任务同样挂载，无需新逻辑）；归档的分支不占分支树——跳过 `archived` 的 branch 节点与它们名下的任务，把它们还在的后代接到最近的可见祖先上（没有就升为根），这种后代的关系标 `parent_archived`（「父分支已归档」，中性色），`missing`（红色「分支缺失」）只留给谁都没归档、ref 真不见了的情况、每棵子树的 `subtreeBranches` / `subtreeTasks` 计数（收起时告诉用户藏了什么）、组内 code 层级（同层新的在前：任务按 id 降序，兄弟分支按 created_at 降序、未知时间排最后）、标签与廉价结构指纹，以及折叠偏好的 localStorage 形态——指纹把「待你决断」的 notice 也算进来（`graphFingerprint(snapshot)` 取 snapshot 里 open 且 question / plan 的 notice 按 id 排序，`graphRenderKey(graph)` 取任务节点的 `notice` id / kind 与 `notice_count`），所以新 notice 出现、被答复 / 忽略或换成另一条都会让分支图在既有 3s / 10s 陈旧规则内重拉重画（`kind='info'` 与 answered / dismissed 不算）；给每个分支算出 `archived` / `archived_at` 与 `archivable`（可归档判断：已登记、未归档也未删除、非当前检出、自己与后代都没有活动任务，且 ref 或 worktree 至少还有一个）；工作态显示口径由 `workingState(entry)` 单独回答（本分支 running / 本分支在等 / 只有子树在跑 / 停下来了）；每个分支另带 `relation`（`edgeRelation` 的结果，可能是 null）：归档把 ref 删掉之后 git 里算不出父子关系（daemon 报 `missing`），但那是用户自己按的归档，不是故障——已归档的分支 `relation` 为 null，父分支已归档的报 `parent_archived`，两者都不算 `unmerged` | `graphLayout(graph)`、`graphFingerprint(snapshot)`、`graphRenderKey(graph)`、`parseGraphCollapsed(raw)`、`serializeGraphCollapsed(set)`、`aheadBehindText(node)`、`nodeMarks(node)`、`workingState(entry)` |
| `render-graph.js` | 核心交互式分支流程图：task 行显示执行计划横向进度条，running 时带显著动效；顶部先汇总分支 / 任务 / 当前检出与关系图例；面板与连接线按父子关系着色（领先绿 / 一致灰 / 落后蓝 / 分歧琥珀 / 缺失红 / 父分支已归档灰），表头给出该关系的动作（合入父分支 / 让子分支跟上父分支 / 在子分支解决分歧），做不了的也画出来但禁用并写明原因；父子关系靠 CSS 画的竖线与拐角表达，整棵子树可收起（状态存 localStorage，重画不丢）；可归档的分支提供「归档」按钮（确认框写明会连它下面 N 条后代分支一起删，确认后调 `branch.archive`，带 `discard:true`；归档的分支随后不再画在图上）；图末的兜底分组（「未归属分支的任务」——`branch` 与 `target_branch` 在图上都找不到节点的任务）每行多一个「删除」按钮，走用户专属的 `task.delete`（与 CLI 的 `lush task delete` 同源），确认框写明「任务行与它的后代、消息、事件、notice、spec 一起删且不可撤销」，成功后重拉图；这是页面上唯一会丢任务历史的按钮，别处的任务行不给（那些先走归档 / 回收）。`main` 主干行只在展示层隐藏「未登记」、来源、汇总状态与后代任务计数（`graph.get` 原始字段不变，名称 / commit / 当前检出 / 折叠 / 工作态 / 父子关系和内容照常显示），非 `main` 分支保留完整诊断；分支表头按 `workingState` 渲染工作态标识（在跑 / 在等 chip、子树工作中），在跑的任务行带脉冲点，停下来的分支加 `.graph-idle` 整体降噪但保留未合并与关系色；真的有任务在本分支上跑（`workingState(...).key === 'running'`，不含仅子树在跑）的分支行另加 `.graph-running`：整行外环呼吸动效（只动外环的扩散与不透明度、周期 2.4s，不位移不缩放；在等 / 子树 / 停下来的分支都没有这个 class，保持静止；`prefers-reduced-motion` 下随全局规则关闭）；带待决 notice 的任务行（`graph.get` 的 `notice` / `notice_count`）另加 `.graph-emphasis-awaiting` 琥珀强调（可与工作态强调并存）并就地渲染决策区：徽标（`question` →「◔ 等你决定」/ `plan` →「计划待批」）、标题、正文与「另有 N-1 条待决」，`question` 给 textarea +「回复并继续任务」（`notice.answer`）与「忽略」（`notice.dismiss`，⌘/Ctrl+回车与任务详情一致），`plan` 给「批准并开发」（`plan.approve`）与「驳回」（`plan.reject`，沿用 `promptDialog`、空理由不发）；动作与任务详情 / 意图面板同源，成功后 `loadGraph()` 重拉、失败写顶部提示（`messages.js`）；有内容或正聚焦的决策输入会让这次 `renderGraph` 跳过重画（`hasPendingDecision`），避免 1.5s 轮询把用户打了一半的字与焦点冲掉。`fetchGraph()` 只拉数与更新 `ui.lastGraph` / `ui.graphFetchedAt` / `ui.graphFingerprint`（单飞），供概览复用，`loadGraph()` 再渲染分支图 | `openGraph()`、`fetchGraph()`、`loadGraph()`、`renderGraph(graph, opts)` |
| `detail.js` | 拉取并渲染任务详情，仅用户已展开过程时读取执行记录；窄屏新导航收起索引并定位内容，轮询保留滚动 | `loadDetail(taskId)` |
| `docs.js` | 「文档」视图：路由（`#docs` / `#doc-<id>`）、取数、搜索索引懒加载与站内相对链接解析 | `docsTarget(hash)`、`resolveDocPath(from, raw)`、`docLinkResolver(current, docs)`、`loadDocsSearchIndex()`、`openDocs(id)`、`loadDocs(id)`、`DOCS_HASH` |
| `docs-search.js` | 浏览器全文搜索纯逻辑：NFKC / 小写归一化，中英文子串、多词 AND、字段加权、摘要与稳定排序；Mermaid 仅低权重参与 | `normalizeDocsQuery(value)`、`searchDocs(index, query, limit)` |
| `render-docs.js` | 「文档」视图的目录、懒加载内容搜索、Markdown 正文、Mermaid 启动与兜底 | `renderDocsIndex(docs, onOpen, options)`、`renderDoc(doc, resolveLink, onOpen)`、`renderDocError(id, message, onOpen)` |
| `mermaid-docs.js` | 只在文档存在 Mermaid 容器时加载本地固定版本，以 strict 模式逐图校验，并通过显式唯一 id 渲染成隔离的 blob SVG 图片（避免节点/箭头串图，也不用为 Mermaid 放宽主页面的 inline-style CSP）；换文档时回收 blob URL，切换深浅主题时从保留源码串行重绘，超长、超量、加载或语法失败均回退为源码。Agent 输出不走这条路径 | `renderMermaidDiagrams(root)`、`refreshMermaidDiagrams(root)`、`clearMermaidDiagrams(root)` |
| `refresh.js` | 轮询有界 `/api/overview`（revision 未变时不重画；旧 host 回退完整 snapshot）、概览、热任务增量刷新、筛选重画；右侧信息页 / 文档 / 设置 / 统计打开时不让概览覆盖；切回概览立即用缓存绘制，不等 revision 变化或轮询空闲；「项目概览」与「分支图」共用同一份 `graph.get`（`ui.lastGraph`）与同一条陈旧规则（指纹变且距上次 ≥3s，或 ≥10s），概览先用快照画、后台取图后就地重画；changed 时在 `renderNotices(data)` 之后同步调用 `renderNoticeBanner(data)` | `refresh()`、`overview()`、`liveRefresh()`、`applyFilters()` |

分支 `showcase` 准入读面经 `graph-layout.js` 透传并纳入 `graphRenderKey`，仅 `allowed === true` 时在分支详情显示次要展示按钮；旧 daemon 无字段时不开放，历史展示仍给查看链接。

分支诊断的 `diagnostics` 经 `graph-layout.js` 透传并纳入 `graphRenderKey`；`render-graph.js` 展示已提交文件数 / 文本增删行、基线、独立未提交统计、最近提交与可展开文件明细。`state.js` 的 `graphFilesExpanded` 保留会话内展开状态，重置时清空；没有统计基线或读取失败明确显示不可用，旧 daemon 无字段时兼容不画。接口与列表限额见[分支诊断接缝](modules.md#分支诊断增量读面)。

其它纯逻辑模块：`markdown.js`、`tree-order.js`、`live.js`、`sidebar.js`；`merge-select.js` 是交付队列的候选、冻结与 code-only 顺序预览接缝，由 `render-ladder.js` 使用。`live.js` 的实时刷新间隔不再是写死常量：`liveInterval()` 读「轮询频率」偏好，标准档等于改造前的 3000ms。

## Web / 桌面宿主

| 文件 | 职责 | 导出 / 接缝 |
|---|---|---|
| `src/ui/web/server.js` | 单项目与全局 launcher 两种 HTTP host；资源、认证、窄 API 路由、动态项目 binding；保留 `/api/snapshot`，新增 `/api/overview`、`/api/tasks`、事件历史页与设置页 Agent 配置按需路由 | `startWeb()`、`createProjectHost()`、`rememberWebProject()` |
| `src/ui/web/control.js` | 后台 Web 进程识别、状态文件、端口探测与安全停止 | `webOwners()`、`stopStaleWeb()`、`recordWebState()` 等 |
| `src/ui/web/docs.js` | 扫描随代码发布的 Markdown 文档与搜索字段 | `docsIndex()`、`docsSearchIndex()`、`readDoc()` |
| `src/ui/launcher.js` | 跨项目的最后路径缓存、绝对目录 canonicalize、无项目 Web 控制配置 | `launcherStateDir()`、`readLauncherState()`、`writeLauncherState()`、`canonicalProjectPath()`、`launcherWebConfig()` |
| `src/ui/desktop/main.js` | Electron 主进程：启动随机端口临时 Web host、管理窗口与 host 生命周期；校验主窗口 IPC 来源、持久化本端提醒开关、发送原生通知并聚焦待决面板 | Electron `main` 入口 |
| `src/ui/desktop/preload.cjs` | 原生目录选择与窄通知 IPC，不开放 Node；通知点击只导航到固定 `#notices` | `window.lushDesktop.chooseProject()`、`notificationSettings(enabled?)`、`notifyNotice(payload)` |

桌面壳不复制任何业务页面或 API。这样桌面版与浏览器版始终使用同一份 assets，并可同时连接同一个项目 daemon。

`markdown.js` 除默认渲染外还有两件「文档」视图需要的能力：`renderMarkdown(text, doc, options)` 里的
`options.link(raw, label)` 由调用方接管链接解析（返回 `{ href, external }`，返回空或抛错都回落到默认规则：
只有 http/https 成链接）、GFM 表格，以及只在 `options.diagrams === true` 时把 `mermaid` fence 标成待渲染容器。
不传 options 时 Mermaid 仍是普通代码，因此 Agent 输出不会加载或执行图表。

---

[← 上一篇：Runtime 与持久化](modules-runtime.md) · [下一篇：CLI、RPC 与测试 →](modules-interfaces.md)
