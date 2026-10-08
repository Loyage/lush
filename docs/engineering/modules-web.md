# 模块地图：Web 前端

本章是 `src/ui/web/assets/` 的职责与导出清单。浏览器端使用原生 ES module，不经过打包。修改执行过程相关模块前，必须先读[设计理念](../design/agent-process.md)与[阅读器边界](transcript-reader.md)。修改按钮文案、图标、样式或 `agent-call` 标识前，必须先读[按钮帮助与 Agent 触发标识](../design/ui-guidance.md)。修改通知、分类渠道设置、已读与滑动消除前，必须先读[通知与告知](../design/notices.md)。公开面以[核心 API 收敛](core-api.md)与 `src/rpc/registry.js` 为准；**下面涉及旧批量草稿、Intent / Plan、介绍、托管模式、统计面板与旧一键合并的行都是历史遗留实现**：文件仍在源码与测试里，但没有公开入口，不能当作当前可操作的界面。

> 模块地图：[总览](modules.md) → [Runtime 与持久化](modules-runtime.md) → **Web 前端** → [CLI、RPC 与测试](modules-interfaces.md)


浏览器端 ES module，无打包器：`index.html` 先以 module 加载 `/appearance.js`（head 中定主题）再加载 `/app.js`，其余模块走 import 图，
由 `server.js` 的扩展名白名单按 basename 服务。

启动与环境管理的新边界见[工作台接入契约](workbench.md)，优先于历史连接页描述；界面资源、项目身份与后台控制分别验收。

设备共享设置新增接缝见[设备设置](device-settings.md)：`host/device-settings.js` 导出 `DeviceSettingsService`、`DEVICE_SETTINGS_READS`、`DEVICE_SETTINGS_ACTIONS`，无项目也能管理共享技术配置，不构造 Project/Store、不启动 daemon 或模型调用；缓存是有界本地/内存读面，不伪造项目历史/消费者。`server.js` 独立处理 `/api/host/settings/**` 白名单与 scope 查询校验，复用认证/Origin/JSON/no-store；停止 Web 会取消设置服务在途登录/网络/安装。项目设置仍经固定项目路由，新增 `/api/settings/runtime`、`/api/settings/migration`，历史读面不接收 device scope。前端 `settings-api.js` 专门服务设置，不更改 Worker/history 的通用 API 语义。其导出 `settingsClient(scope)`、`settingsClientFor(model)`、`projectSettingsAction(method,params)`，捕获项目上下文并检查迟到响应；`settings-scope.js` 导出 `scopeLabel/scopeImpact`、`draftFingerprint`、`scopeSelector/scopeSummary`、`clearOverrideButton`；`settings-migration.js` 导出 `renderSettingsMigration`（显式预检/确认，空范围禁用）。Agent/来源/系统/快捷解释页在各自 generation 与 scope draft 下组合，历史/消费者保留项目限制。

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
| `app.js` | 唯一入口：先装配主体，项目管理、界面设置与帮助不依赖已选项目；仅项目上下文装配开发与轮询。经 `project-picker.js` 只读确认项目后，再装配左栏顶部身份区按钮（品牌回概览 / 切换项目 / 移动端导航 / 右侧返回）、`#worker-graph` / `#workers` / `#worker-ID`（执行详情仍显式点击打开） / `#versions` / `#settings` / `#agent-status` / `#model-sources` / `#model-source-UUID` / `#statistics` / 其它信息页 / `#notice-ID` 数字通知深链接 / 文档的 hash 路由与两个定时器；定时器按「轮询频率」偏好重建；侧栏只展示当前项目身份，不读取或轮询跨项目列表 | `boot()` |
| `route.js` | 固定 `/p/<pid>/` 项目身份；Host API 与文档保留根路径，未知项目不回落其他项目；偏好按项目隔离 | `routeContext()`、`projectRoute()`、`projectBase()`、`projectApi()`、`projectHref()`、`preferenceScope()` |
| `project-picker.js` | 主体内项目管理：项目列表及后台状态集中在项目页面，打开或显式刷新时只读获取；根路径不自动跳上次项目；独立窗口打开、登记/移除入口、显式后台启停，未选项目不启动快照轮询，不使主体 inert | `ensureProject()`、`openProjectManager()`、`openProjectPicker()`、`closeProjectPicker()`、`refreshProjectList()`、`workbenchStatus()` |
| `styles-workbench.css` | 主体空态与项目管理布局 | CSS |
| `appearance.js` | head 中初始化深浅主题，装配左栏顶部的主题切换按钮；偏好经 prefs.js 读写（`lush.theme`），`system` 跟随系统、显式值覆盖系统，存储不可用时保留会话内选择 | `systemThemeMedia()`、`resolveTheme()`、`effectiveTheme()`、`applyTheme()`、`createAppearance()`、`initAppearance()`、`refreshTheme()` |
| `prefs.js` | 本地偏好中心：键名 / 默认值 / 解析与序列化、读写与变更通知都在这一份（`markdown` / `theme` / `sidebarSort` / `collapsed` / `filters` / `taskGraphStatuses` / `taskGraphMinimal` / `taskGraphCollapsed` / `reduceMotion` / `polling` / `toastDuration` / `transcriptOrder` / `noticeNotifications` / `noticeChannels`）；告知按三类 × 两渠道的客户端布尔偏好规范化；坏数据回落默认值，存储不可用不抛异常；老键（`lush.treeSort`、`lush.theme`、`lush.markdown`）继续生效；`collapsed` / `filters` / `sidebarSort` / `taskGraphStatuses` / `taskGraphMinimal` / `taskGraphCollapsed` 按项目隔离（键加 `:<project-id>` 后缀），主题等外观偏好共享；`resetPrefs()` 删除全部受管键（含历史键）并逐项通知回默认值 | `PREF_DEFS`、`PREF_NAMES`、`MARKDOWN_KEY`、`THEME_KEY`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`REDUCED_MOTION_KEY`、`POLLING_KEY`、`TOAST_DURATION_KEY`、`TRANSCRIPT_ORDER_KEY`、`THEME_VALUES`、`SORT_IDS`、`POLLING_MODES`、`TOAST_MODES`、`TRANSCRIPT_ORDER_MODES`、`pollingIntervals()`、`toastDurations()`、`readPref`、`writePref`、`setPref`、`onPrefChange`、`resetPrefs`、`prefsSnapshot`、`storageAvailable`、`scopedKey`、`normalizeNoticeChannels` |
| `sleep-ui.js` / `styles-sleep.css` | 托管模式设置与风险确认、全页面左栏状态（管家值守/预算暂停、本会话已处理与选择计数、token 用量）及关闭/恢复入口、只读管家选择卡片；不在轮询时重置设置表单 | `sleepSettings()`、`renderSleepBanner(state)`、`sleepChoiceCard(choice)`；CSS |
| `creation-profile-dialog.js` | 历史草稿发射时的完整运行参数确认，使用应用弹窗、页面身份与默认加载；取消保留旧覆盖，不调用 Agent | `chooseCreationProfile()` |
| `hook-controls.js` | 详情内置自动合并兼容与一行最高环节按钮控制，点击即保存；child 最低级别、补办/归档确认和旧服务兼容；保存用 revision、在途锁和项目/导航保护，见[自动链接缝](completion-hooks.md) | `autoMergeControl()`、`autoCompletionControl()`、`COMPLETION_LEVELS`、`HOOK_STATES` |
| `render-inputs.js` / `styles-inputs.css` | `#inputs` 历史输入页：资源页风格的等高摘要列表、全库搜索/双维状态筛选/有界分页；`#input-draft-<id>` / `#input-input-<id>` 独立原文详情、暂存编辑与单条发射，同页往返保留列表/编辑；完整父候选、版本冲突与请求身份保护，不被 overview 轮询重画；契约见[历史输入接口](input-history.md) | `openInputs({item?:{kind,id},push?:boolean})`、`INPUT_STATUS`、`INPUT_MERGE`；CSS |
| `hook-schedule.js` | 浏览器定时表单的显式 IANA 时区／日期转换与时间摘要；默认浏览器时区但明确保存，一次性 DST 模糊／缺失时间拒绝，模板元数据编辑保留精确 at | `browserTimezone`、`scheduledWallTime`、`scheduledInstant`、`hookSchedule`、`hookScheduleSummary` |
| `hook-signals.js` | 自动化页面的时间信号编辑与管理指令创建、绑定启停、安全摘要／结果；独立 revision、同表单去重 key、迟到响应保护、改期历史判断与截断提示；不改变开发输入框 | `createSignalForm(initial?,{ownsPage?}?)`（含 `loadResetTimes()`）、`createManagementForm`、`renderSignalManagement` |
| `management-profile-form.js` | 管理调用来源表单：Pi 托管／机器默认、独立管理配置，不重造私有 profile、不编辑开发 Prompt/env/扩展；使用现有来源选择器 | `createManagementProfileForm(settings,{ownsPage}?)` |
| `signal-reset-picker.js` | 时间信号表单的订阅刷新时间选择；按需只读当前项目连接缓存，区分账号／窗口，未知／失败／过期不可填、不回退旧成功值；精确复制瞬间、保留时区、注明观测时间，不联网／不绑定账号；保存与迟到响应守卫 | `createSignalResetPicker({ownsPage?,timezone,onSelect})` → `{node,load,setBusy}` |
| `render-hooks.js` / `hook-form.js` / `styles-hooks.css` | 项目「自动化」`#hooks` 目录、自动链介绍与模板；Worker 默认一行级别选择、异常摘要和折叠管理区；项目页面装配时间信号与管理指令，按需查看节点挂载/参数/执行结果和编辑；受控动作配置及统一标识；创建 Hook 完整运行设置只写、安全摘要只读，契约见 [Hooks](hooks.md) | `openHooks()`、`workerHooks(task,options?)`；表单辅助/CSS |
| `render-versions.js` | 工作分组 `#versions` 的只读 main 第一父链历史：显式加载、固定 tip 分页、刷新作废旧请求、失败保留旧历史并明确提示、无 main 空态；安全文本呈现提交 SHA / 作者 / 时间 / 摘要、精确关联的 Worker 与原始指令，跳转走 navigate 接缝，不执行 Agent；契约见[版本迭代](version-history.md) | `openVersions()`、`renderVersionCommit(commit)` |
| `styles-versions.css` | 版本迭代卡片、main tip 与完整 SHA、原始指令折叠和响应式布局，沿用双主题 token，无内联样式 | CSS |
| `render-agent-status.js` | `#agent-status`「Agent 配置」入口，默认按需读配置并展示 `renderAgentSettings`；高级诊断仅显式读取 version 2 Pi/Codex 软件路径、版本和可用性，无账号、模型、资源或额度查询，拒绝旧响应；默认开页/轮询不执行诊断。页签保留草稿，异步结果按页面身份保护；失败可重试、旧观测明确标旧，不猜当前 Worker 实际绑定。首次绘制前本地读取连接列表，供继承摘要把来源显示成用户命名的名称 | `openAgentStatus()`、`renderAgentStatus(data)` |
| `render-model-sources.js` | 独立「模型来源」`#model-sources` 及 `#model-source-UUID` 入口；进入只读本地连接/缓存，重复打开与同项目离页往返保留会话内公开草稿（不浏览器持久化），复用管理台并作废旧页面读取；深链接展开单来源内联详情；额外提供按需打开的旧余额历史只读存档，进入页面不自动读取旧历史/配置，不混入正式连接曲线 | `openModelSources({connectionId?}={})` |
| `render-agent-connections.js` / `styles-agent-connections.css` | 全宽模型来源管理台：信息列表在顶部、筛选/添加/批量工具在下方，摘要行最右侧为操作列（上次刷新时间、刷新、详情依次纵排），编辑仅在详情内；默认紧凑等高摘要行，仅含名称、服务商/启停、默认模型、本地凭证、最多两项现金/套餐摘要（套餐保留比例进度条）与刷新按钮上方缓存时间；订阅标题用结构化时长简写 5h/7d，摘要显示重置剩余时间，绝对日期/时间仅留详情折叠区，到期标待刷新，未知不猜，原始指标名留详情折叠区；省略观测成功但保留异常/部分状态，不提供全局详情开关；单来源详情保留完整端点/模型范围/默认思考、现金/套餐窗口、观测来源/时间与实际消费者，详情内仍可就地编辑/刷新；数量统计不混加币种套餐。名称/端点/服务商/模型搜索，服务商/启用/认证或观测筛选，多选当前筛选结果与清空，批量刷新/启停先明确范围、最多 3 项并发、逐项报告，启停全量保留其他公开字段且不处理秘密或删除。独立 query 的整份 list 不直接应用，最终本地重读避免并发快照互相覆盖；批量配置期间拒绝同项表单保存但保留新草稿。只读详情在所选摘要行下方内联展开，保留总览，重复点击/返回收起，刷新/筛选重定位；余额/剩余量加粗。编辑等操作保持桌面非模态固定侧面板（无 aria-modal/焦点陷阱），窄屏独立操作内容与可读总览卡片；编辑/详情/设备码/备用回调/历史/采样共用面板，打开聚焦、Escape/返回归还入口，公开草稿按连接留内存，取消/离页清空秘密并停止登录。物理模型 ID 示例与 provider/model 调用预览、可输入默认模型候选，仅显式修正当前 provider 前缀、不截断任意 slash ID。保存/登录后自动联网刷新已启用、有凭证且受支持的该连接（过期 OAuth 可由后台协调刷新），不调用模型，保存成功与查询失败分开；兼容 API 不查询。重置剩余时间本地按分钟更新，绝对本地时间留指标折叠详情，到期标待刷新，不声称额度恢复；隐藏文档暂停、离页清理，倒计时与设备码时钟独立注入 | `createAgentConnections({ownsPage,connectionId?,setTimeout?,clearTimeout?,now?,resetSetTimeout?,resetClearTimeout?})` → `{node,load,loadHistory,selectConnection,selectedConnection,dispose,resume}`；`renderConnectionResources(observation,{now?}?)`、`resetRemaining(value,now?)`；[账号连接](agent-connections.md)、[设备码登录](codex-device-login.md) |
| `agent-network-settings.js` | 系统设置的项目出站网络表单；按项目身份隔离安全配置与非秘密草稿，代理认证只留当前 DOM、提交后清空，不调用 Agent | `renderNetworkSettings({ownsPage?})`；[网络契约](outbound-network.md) |
| `model-choice.js` | 候选模型与可编辑名称的紧邻双控件；各自显式标签，手输与候选选中状态同步，不替换草稿 | `createModelChoice({model,candidates})` → `{node,sync}` |
| `agent-connection-picker.js` | 项目 Profile 与单 Worker 编辑器共用后端→来源→匹配模型选择；同组展示来源、候选与名称，辅助操作/说明后置，Codex CLI 候选由调用方显式提供；来源详情深链接；只读项目连接缓存，校验后端、模型范围及必需来源；默认保留模型草稿，Worker 入口显式启用主动换来源时填入默认模型（无默认保留并提示），读取/重置不自动填入，不隐式切换付费账号。Pi 不回退原认证，Codex CLI 托管选择禁用 | `createAgentConnectionPicker({backend,model,connectionId?,ownsPage?,onChange?,applyDefaultModelOnChange?})` → `{node,connection,models,actions,modelExtras,setCliModels,value,entry,load,sync,validate,reset}`；[共享模型选择契约](managed-model-selection.md) |
| `agent-profile-form.js` | 新建指令与 Worker 完整运行设置共用表单；模式裁剪、模型/资源读取、默认设定一键填入与字段校验。默认保留模型草稿，Worker 调用方可显式开启主动换源填入默认模型，思考深度保持原值 | `createProfileForm({profile,settings,role,ownsPage?,onChange?,applyDefaultModelOnChange?})` → `{node,ready,collect,validate,reset,...}`；[Web 配置](web-agent-configuration.md) |
| `render-agent-usage.js` | 模型来源中的旧余额历史只读存档：按需读取本地缓存，无配置/账号查询或写入；范围/账号/指标过滤、SVG 观测曲线和数据表、失败/重置/截断提示及迟到响应保护。正式连接复用曲线原语 | `createLegacyUsageHistory({ownsPage})`、`renderUsageSeries(series,range,config)` |
| `agent-usage-form.js` | 旧 HTTP 查询/采样表单的历史兼容代码，不再由页面组装；旧查询及配置写入已退役 | `usageConfigForm()`、`defaultUsageConfig()`（内部兼容） |
| `usage-window.js` | 仅按接口实际秒数格式化可读额度窗口与固定安全错误分类；未知时长不猜每日，额度查询/历史共用文案 | `usageWindow(seconds)`、`usageErrorLabels` |
| `styles-agent-usage.css` | 用量表单、响应式曲线、键盘/触摸观测点与数据表布局，双主题 token | CSS |
| `styles-agent-status.css` | Agent 配置与软件诊断响应式布局，沿用双主题 token，不使用内联样式；旧账号/模型样式不代表界面仍提供这些诊断 | CSS |
| `render-settings.js` | `#settings`「系统设置」仅分界面 / 系统两个页签；另导出供独立「Agent 配置」调用的共享子面板 `renderAgentSettings(settings,repaint)`，由拥有者提供完整配置和带页面身份保护的重画回调。子面板编辑项目默认与 Agent 角色覆盖（agent / model / thinking / 默认 prompt / 追加 prompt / Pi 扩展与 Skills），可按需读 `/api/agent/models` 展示本机 CLI 当前模型目录、读 `/api/agent/resources` 多选已安装资源，经 `agent.configure` 写入项目；同页的环境变量键值表按需读取公共/角色 env（值默认 password 遮罩、逐项可查看），支持新增/删除/保存，拒绝非法、重复与 `LUSH_*` 名称，经 `agent.environment.configure` 写回；默认 prompt 正常显示内置全文并可一键恢复，替换内置 prompt 前显示风险警告并二次确认；界面页管理浏览器本地偏好与恢复默认；系统页展示 daemon 配置与路径，其中并发额度（执行 / 控制通道）与调用 / 拆解限额（单次调用超时 / 单 Worker 调用上限 / 最大拆解深度）是可编辑表单：显示生效值 / 环境默认值 / 来源 / 设置文件，保存 / 恢复环境默认走 `system.configure`，越界或后端报错就地提示；系统页另有「输入前缀（仅旧提交路径）」编辑器：列出每个前缀与派活目标（worker / research），可增删、校验空/超长/重复前缀，保存按整表写 `system.configure({settings:{input_routes}})`、恢复默认送 `{input_routes:null}`，显示是否被覆盖；该表只影响旧客户端提交（`input.submit` / 旧批量 `draft.commit`），新指令不走快速路由，所以这里不再重画输入框高亮；系统页另有「快速介绍」编辑器：填 API 地址 / 模型 / API Key（只写不显，可单独清除），保存 / 清除走 `intro.configure`，显示可调用状态与配置文件路径。打开期间轮询不用概览覆盖 | `openSettings()`、`renderSettings()`、`renderAgentSettings(settings,repaint)` |
| `statistics-range.js` | 日间／日内独立筛选的默认值、UTC 日历快捷范围、含首尾日期到半开 API 时间段的转换与小时校验 | `statisticsDefaults()`、`statisticsToday(now?)`、`statisticsDates(filters,now?)`、`statisticsQuery(filters,now?)` |
| `render-statistics.js` | `#statistics` 的日间（日历／7 天／30 天／本月／全部）与日内（今天／昨天／日历＋小时区间）双视图及独立筛选、累计 token / 预计 USD、UTC SVG 柱状图（全高时段命中区、即时鼠标／键盘数值浮层，以 SVG 属性定位且约束在滚动视口内）、provider/model 费用表、缺失数据说明与手动刷新；迟到响应不能覆盖其他视图 | `openStatistics()`、`renderStatistics(data)` |
| `styles-statistics.css` | 统计面板的响应式卡片、表格与 SVG 主题样式；不使用内联 style，不放宽 CSP | CSS |
| `styles.css` | 双主题设计 token、应用布局（无应用顶栏：品牌 / 项目名 / 并发槽 / 连接状态 / 主题切换 / 退出登录在左栏顶部的身份区，内容区占满高度）、组件、响应式与 reduced-motion 动效（含设置页与强制减少动效 `[data-reduced-motion="true"]`） | CSS |
| `state.js` | 共享可变状态（一个对象，新字段不必改别的文件就能加）；`ui.view` 为唯一页面身份（id/key），导航接缝集中更新兼容读标记；`deletedWorkerIds` 保存本会话删除成功的身份，阻止在途旧 Worker/记录响应复活缓存与详情；`ui.indexOpen` 记录右侧信息页，`ui.settingsOpen` 标记设置视图，`ui.agentStatusPage` 保存 Agent 配置/诊断页与单飞读取身份，`ui.modelSourcesPage` 保存模型来源页身份及来源选择，`ui.versionsPage` 保存版本历史页的固定 tip / 游标与请求身份；折叠 / 筛选 / 排序偏好经 prefs.js 读写 | `ui`、`transcriptOpen`、`transcriptCache`、`mergeSelection`、`resetUiState()`、`readSidebarSortPref`、`readCollapsedPref`、`readFiltersPref`、`saveCollapsedPref`、`saveFiltersPref`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`SORT_IDS` |
| `navigate.js` | 导航间接层（断循环依赖）；注册返回带身份保护的 teardown，DOM 测试用完必须恢复，避免跨文件污染 | `registerNavigation({refresh, detail, overview, resource}) -> restore()`、`refresh()`、`detail(taskId)`、`overview()`、`resource(id)` |
| `service-restart.js` | 设置系统页的后台、界面与「全部重启」入口：应用内确认、范围与忙碌保护提示、重复点击保护、Host 能力探测；全部重启先完成当前项目后台重启，再重启界面，后台失败不动界面、部分成功明确提示；Host 换进程后有界探测新 pid，恢复刷新或转登录，失败就地提示 | `serviceRestartControls(options?)`、`waitForHostRestart(pid,options?)` |
| `api.js` | fetch 与用户动作；请求路径经 `route.js` 挂到本页项目前缀下 | `api(url, options)`、`action(method, params)`、`loadHistory(taskId)`、`projectApi` |
| `worker-kind.js` | 只读类型兼容：历史 `task_kind='say'` 判定为 `order`，指令类型标签统一中文「指令」，不修改传入对象；输入目标、概览、详情、图与交付/迭代控件共用；不兼容旧写入口 | `workerKind(task)`、`workerKindLabel(task)` |
| `format.js` | 标签映射与格式化（纯函数）；`EVENTS` 维护当前与历史事件中文名称，`eventLabel(event)` 区分提醒、待决问题与已记录来源的 Lush 自动选择／用户答复，未知类型明确标为「未识别事件」；`workerNumber(task)` 只接受服务端投影的 `Wn(-n)*`，其余回落 `#id`，`inputNumber(id)` 只格式化已发射原始 Input 为 `On` | `eventLabel`、`STATUS`、`INTEGRATION`、`ROLE`、`EVENTS`、`HOT`、`TERMINAL_STATUS`、`PLAN_GATE`、`SPEC_STATUS`、`MERGE_STATUS`、`CHANGE`、`DEP_HELP`、`STEP`、`MD_STEP`、`GOAL_TITLE_LIMIT`、`statusOf`、`interruptReason`、`relative`、`duration`、`absolute`、`clock`、`tokens`、`tokensView`、`money`、`depsOf`、`waitingDeps`、`resolverOf`、`specStatus`、`specTitle`、`summarizeGoal`、`taskTitle`、`edgeLabel`、`lastView`、`short`、`workerNumber`、`inputNumber`、`worktreeLabel`、`isHistoricalDelivery` |
| `worker-label.js` | Worker 用户编号展示层：项目作用域有界缓存 `ui.workerNumbers`，只收录服务端显式 `worker_number`（不按 Input 或父子关系推算、不发标签请求）；已知编号只用于只有整数身份的链接标签，显式 `null` 清除旧值，删除 Worker 时同步遗忘。`workerLabel(value, number?)` 接收对象或整数身份加可选编号，`rememberWorkers(list)`、`forgetWorkerLabel(id)` 供列表/图与删除路径使用 | `workerLabel`、`rememberWorkers`、`forgetWorkerLabel` |
| `help.js` | 按钮帮助浮层：目标在原生 popover/dialog 顶层时提示挂到同一层，隐藏后移回 body，避免被更多操作菜单遮挡；为含义不直观的按钮渲染 `data-help`，装配桌面悬停 / 键盘聚焦 / 移动端长按，禁用按钮由外层 `.help-host` 承载；会调用 Agent 的按钮统一用 `agent-call` 类与 `agentHelp()` 文案 | `AGENT_NOTE`、`agentHelp`、`initHelp`、`hideHelp`、`setHelpTimers` |
| `dom.js` | DOM 原语；`button()` 第 4 参数接受 `{help, agent}`：`help` 非空写入 `data-help`，`agent: true` 加 `agent-call`；Agent 代价文案由调用方经 `agentHelp()` 生成；`roleBadge(role)` 产出带 `role-<role>` 类的类型胶囊（未知角色回落 `role-unknown`），`routeBadge()` 产出统一的「⚡ 快速路由」徽章 | `el`、`button`、`syncChildren`、`block`、`kv`、`badge`、`statusBadge`、`roleBadge`、`routeBadge` |
| `dialog.js` | 应用内确认 / 输入 / 表单弹窗（替代原生 `confirm` / `prompt`）：画进独立于 `#detail` 的 `#modal`，同刻只留一个弹窗，Esc / 点背景 / 取消＝取消，Enter / 输入框回车＝确认，关闭后焦点还给打开者；选项接受 `agent` 与 `confirmHelp`，确认按钮沿用 `agent-call` 与 `agentHelp()` | `confirmDialog(opts)`、`promptDialog(opts)`、`formDialog(opts)`、`closeDialog()` |
| `text.js` | agent 输出的 Markdown 偏好（只在设置页管理，偏好键 `lush.markdown`）；偏好变化时重画当前详情 | `markdownEnabled()`、`agentText(value, opts)` |
| `gauge.js` | 左栏身份区并发槽表 | `slotGauge(data)` |
| `filters-ui.js` | 筛选控件与选项工具；`filterMulti` 提供常展开的即时复选组，空集合表示全部，`sync(options,value)` 复用选项节点并保留焦点 | `filterSelect`、`filterToggle`、`filterMulti`、`filterInput`、`syncSelectOptions`、`withCurrent`、`uniqueValues`、`roleOption`、`statusOption`、`specStatusOption`、`plannerOption`、`filterUi` |
| `sidebar-ui.js` | 统一页面导航：页面元数据、hash 写入、身份令牌、互斥画布、唯一 selected/aria-current、加载占位、视图栏、移动端收起、计数与兼容折叠状态；页面变化清空旧 `ui.composerTask` / `ui.composerAppendTarget`，退出显式追加模式并通过 `ui.syncComposer` 更新输入目标 | `setViewChrome`、`activateDetailView({view,key?,hash?,title?,context?,hint?}) -> identity`、`openResource`、`paintCollapsed`、`setNavCount`、`selectNav`、`navTo` |
| `sidebar-init.js` | 装配左侧页面导航，以及移到右侧信息页内的筛选 / 排序控件 | `initSidebar()` |
| `composer.js` | 输入表单；聚焦增高、失焦缩回单行（CSS），常驻模式条以图标、文字和主题色区分「新建独立 Worker / 继续当前 Worker」，显示实际父/追加目标、Enter 行为及阻塞原因，打字后不消失；影子文字与帮助同步显示实际目标；所有页面（含 main/owner 详情）默认新建独立 Worker，默认显式 main、保留用户选择的父分支；详情入口经 `appendToWorker(task)` 显式选定 `ui.composerAppendTarget` 后才经 `worker.message` 追加（Enter / 发送 / Ctrl/⌘+Enter），隐藏暂存与父选择，Shift+Enter 换行；`resetComposerMode()` / 返回按钮 / 空白且无引用时 Esc 退出追加，保留文字、引用与父选择；导航退出追加，同目标刷新保留模式；仅显式追加模式在加载中、终态、归档、冻结或不支持追加时禁用并说明，不改投；追加不支持引用时明确拒绝、保留原文与附件。`ui.syncComposer` 是导航/详情装配后的状态投影回调，`ui.composerTask` 仅保存当前成功读取的详情身份；Enter/暂存按钮通过 `draft.add` 保存正文、引用和父身份，Shift+Enter 换行，IME 与在途请求保护防误发/误清；默认折叠保留常驻模式条 + 一行输入 + 一行操作（父 Worker 下拉框与快捷键说明点开「展开」才出现，折叠态在控件上标出已选父 Worker；展开状态只在会话内）；父 Worker 候选取独立 `/api/input-parents` 完整读面，不依赖 `overview` 最近Worker窗，**选项值仍是分支名**，所以选择的是 Worker、`order.submit` 的语义（可带父分支）不变，候选变化时才重建 DOM 并保留仍有效的选择；「创建 Worker」按钮与 ⌘/Ctrl+Enter 以 `order.submit {start:false}` 只建 `paused`（详情显示「待开始」）Worker，⌘/Ctrl+Shift+Enter 以 `start:true` 立即运行；进详情可用 `worker.configure` 固定本轮 Agent / 模型 / Prompt / 扩展 / Skills / 软预算与按Worker的 Pi 环境变量，再用 `worker.resume` 开始；引用随本条 `order.submit` 一起提交；**输入框不做快速路由前缀高亮**：新指令不走快速路由 | `syncComposer()`、`appendToWorker(task)`、`resetComposerMode()`、`loadComposerParents()`、`parentTasks()`、`renderParentOptions()`、`paintComposerDetails()`、`toggleComposerDetails()`、`initComposer()` |
| `input-routes.js` | 浏览器侧快速路由前缀**表**：只提供 `ROUTE_TARGETS` / `DEFAULT_INPUT_ROUTES` 给设置页的旧提交路径编辑器；不再带匹配实现（新指令不走快速路由，输入框也不再高亮），前缀匹配只存在于 `src/core/input-routes.js` | `ROUTE_TARGETS`、`DEFAULT_INPUT_ROUTES` |
| `context-references.js` | 页面选区 / 语义元素的右键引用（代码正文选区继承已注册文本快照的路径、比较方向和采样出处，不新增代码语义目标）、有效选区的「解释」入口（统一 quick_explain 直连 API、不创建 Worker、超长不静默截断）、输入框与草稿引用卡片、可引用节点注册及 `data-ref` 定位索引（卡片点击导航 + 一次性闪烁，找不到给顶部提示；text 引用不定位） | `referenceable(node, descriptor)`、`initContextReferences()`、`renderComposerReferences()`、`setComposerReferences()`、`locateReference(reference)`、`locatable(reference)`、`clearLocateFlash()` |
| `messages.js` | 顶部消息提示（toast）：`#error` 从 `.composer` 底部搬进固定浮层，脱离 `.app` 的 grid；停留时长是本地偏好（`lush.toastDuration`，标准档＝信息 4s / 错误 8s），失败 / 错误类带手动关闭按钮，鼠标悬停暂停倒计时，同一段文本反复写入不重置计时（离线错误不闪烁），空文本立即隐藏。错误 `role=alert` / `aria-live=assertive`，信息 `role=status` / `aria-live=polite`；计时器可注入（DOM 测试用假时钟） | `show(value, kind)`、`clear()`、`setTimers(next)` |
| `render-drafts.js` | 历史下线面板，不用于新缓冲区（新页见 `render-inputs.js`）；待提交缓存与引用摘要；每条草稿可就地编辑、移除、引用卡片定位，或用带 `agent-call` 与 `agentHelp()` 说明的「执行」按钮只提交这一条（`draft.commit {ids:[id]}`） | `renderDrafts(data)` |
| `render-intents.js` | Intent 列表：原始目标、planner 闸门、Plan 计数，以及历史 Review Candidate 的「打开结果 / 接受并合入 / 要求修改」动作；输入带 `route` 时行内加「⚡ 快速路由」徽章 | `renderIntents(data)` |
| `render-specs.js` | 拆解队列（只读） | `renderSpecs(data)`、`specItem(spec)`、`specDeps(value)` |
| `render-tree.js` | `#workers` 全类型 Worker 的平铺列表（保留旧文件与导出名，不渲染树）；筛选只显示命中项，不补祖先、不缩进、不画兄弟链，排序跨父子层级且不继承后代优先级（`tree-order.js` 的 `orderTasks(tasks,{mode,openNoticeIds})`）；状态 / Worker类型常展开即时多选，兼容历史与未知类型；专用及历史角色用 `roleBadge`（不显示通用 `agent` 角色标签）、快速路由用 `.route-flagged` 与 `routeBadge`；保留依赖标签、等待原因与进度；明确标出“活动 + 最近历史”的截断范围，通过 `/api/workers?scope=all&before=` 按需加载更早页，筛选与搜索只针对已加载记录 | `renderTree(data)` |
| `notice-kind.js` | 生命周期告知/未读判定、按明确 lifecycle_type 过滤渠道（未知分类可见，待决不受过滤）、项目限定告知身份、记录筛选与数字 Notice hash；历史 info 不算未读 | `lifecycleNotice`、`unreadNotice`、`noticeChannelEnabled`、`noticeIdentity`、`noticeMatches`、`positiveId`、`noticeHash` |
| `render-notices.js` | 独立「管家选择」Event 游标页、待决与未读告知分开计数/分页、面板内答复与 Plan 审批、只读历史；生命周期告知直接打开 Worker，只有当前详情成功渲染才调用 `notice.read`；与告知条共用按项目/记录身份单飞的已读接缝，ACK 成功后缓存事实防止陈旧快照复活；Worker 删除身份过滤同时覆盖分页、告知条与迟到 ACK，删除时清除专属已读缓存，不能因在途请求恢复已删除记录；未缓存的数字深链接按 ID 查记录，迟到导航不标已读；轮询保留输入与已加载历史，revision 变化提示旧页可能过期、不后台扫描，显式刷新只读重载已加载页数并保留答复 | `initNoticeRecords()`、`loadNoticeRecords({more?,preserve?,reload?})`、`renderNotices(data)`、`readNotice(notice)`、`openNotice(noticeId)`、`noticePanel(notice, task?)` |
| `choice-snapshot.js` | 已回答/已忽略问卷的共用快照查看与独立重选入口；仅点击时只读加载状态、限制与准入，ready 后复用问卷编辑，重选草稿与原答复隔离、请求 UUID 跨刷新保留，成功保留新 Worker 链接并导航；历史答复不改写，不撤回原路线；契约见[选择快照](choice-snapshots.md) | `settledDecision(notice,{rechoose?})`、`choiceSnapshotPanel(notice)` |
| `render-questionnaire.js` | 问卷单多选、自定义、预览与最终汇总；原记录只读回放。可选重选参数隔离草稿命名空间及确认文案，不更改原 Notice | `questionnairePanel(notice,{settle?,dismiss?,draftScope?,reviewMessage?,submitLabel?,submitHelp?,allowDismiss?,failureMessage?})` |
| `notice-notifications.js` | 默认关闭的客户端系统提醒：用户授权、总开关、分类渠道过滤、按项目建立首屏基线与增量去重，关闭期间不补发；浏览器 Notification 使用数字 Notice ID 深链接并保留来源项目路径 | `notificationStatus()`、`setNoticeNotifications(enabled)`、`notificationControl()`、`createNoticeNotifier(options)`、`resetNoticeNotifier()`、`observeNotices(data)` |
| `notice-banner.js` | 全局常驻提醒条（移动端 sticky）：独立汇总待决事项，另按页面渠道偏好显示最新未读生命周期告知及可见数量；查看 Worker 成功后已读，「已知」及触摸左右横滑仅调用共享 `readNotice` 标记当前一条，不导航、不批准或调用 Agent，下一条依次显示；待决没有已知/滑动消除。宿主 `role="status" / aria-live="polite"`，告知行含查看与已知两个键盘按钮；WeakMap 状态/签名复用，ACK 单飞与焦点恢复、手势期间保留节点、垂直/短滑/取消/文本选择及合成点击保护；轮询不触发系统通知 | `renderNoticeBanner(data)` |
| `render-ladder.js` | 按目标分支分组的交付队列、变更栈与批量落地 | `renderLadder(data)`、`mergeBatch(ids, candidates)`、`renderMergeResult(entry)` |
| `render-history.js` | 事件时间线以中文名称为主标题、原始类型代码为次要字段同时显示，引用快照保留二者，不改写历史数据；默认最近 100 条，明确显示截断并用 `before` 游标逐页加载更早记录；事件引用的消息正文（后端附在 `event.message`）按收发方向与信号展示，自动答复消息标为来自 Lush 而非来自用户，普通消息仍按 Agent 输出渲染 | `renderHistory(history, opts)` |
| `render-task-message.js` | Worker 详情语义消息卡片：普通正文沿用 Markdown 偏好，已知 v1 信号／历史子Worker结算／Notice 答复显示中文标题、正文与关键字段，未知 JSON 回退有界结构树；惰性原文保留完整信封，长正文可就地展开，按消息身份与内容复用节点保留阅读状态 | `renderTaskMessage(message, taskId, previous?)` |
| `render-diff.js` | 改动概览 | `renderDiff(diff)` |
| `render-progress.js` | Worker 执行计划：防御性统计 versioned `progress`；有 runtime 投影时用 `work_ms` + `active_since` 显示 Agent 的实际工作用时（`kind:'wait'` 的等待条用 `wait_ms` + `waiting_since` 单独实时计时，不计入完成度），旧数据没有投影时回落 `started_at` 墙钟；详情逐步区分“用时”（完成态 serif italic）与“已执行”（当前态 monospace bold），漏报 `unconfirmed` 不抢占当前行、不计入完成度，`timing_unknown` 显示用时未知且不挂 live tick，等待条用 `--waiting` 配色；终态 Worker 不再挂 live tick，而按最后 Run 结束时间冻结当前步骤并标明失败 / 取消 / 结束时中止，后续步骤显示未执行；Worker 树画紧凑摘要，分支诊断画整行进度条并给 running Worker 显著但尊重 reduced-motion 的扫光 / 流动动效 | `progressReportingEnabled()`（读取项目快照中的开关，关闭时所有进度渲染返回 null）、`progressStats(progress)`、`liveProgressMs(item, now?)`、`formatProgressDuration(ms)`、`refreshProgressDurations(root)`、`renderTaskProgress(progress, opts)`、`renderCompactProgress(progress)`、`renderGraphProgress(progress, opts)` |
| `render-agent.js` | Agent 区块：显式点击打开全屏执行详情，保留可复制的 `lush worker transcript ID --follow` 终端命令；模型与用量直接展开；增量更新最近一步及 tokens chip | `renderAgent(task, usage)`、`paintUsageLast(taskId, usage)` |
| `render-goal.js` | 原始目标直接可见；用户追加输入从明确的 `message` 事件读取（不混入 Agent 消息、信号与 Notice 答复），按事件身份保留重复输入、从早到晚排列，追加历史只折叠一层、展开即见已加载的全部正文，刷新保留阅读节点与展开状态，复用 history-page 加载更早记录；原始目标与追加输入分别显示服务端投递时间、待输入或时间未知，不以提交时间冒充输入时间 | `renderGoal(task, history?, previous?)` |
| `render-results.js` | 最新结果直接可见，此前 invocation 结果按时间从新到旧排列，历史区默认展开、逐项正文不再折叠；合并 runs 与完成事件，借既有 history-page 有界翻页，保留重复文本与同签名刷新时阅读节点、手动折叠状态 | `renderResults(task, history?, previous?)` |
| `transcript-model.js` | 紧凑摘要与会话／调用 ID 配对的纯阅读投影；不改变原步骤 | `stepSummary(step)`、`callKey(step)`、`groupSteps(steps)` |
| `structured-value.js` | 文本安全的惰性 JSON 树、节点／深度限额及原文回退；字符串保留换行，支持默认展开根节点 | `structuredValue(text, {openRoot?,preview?})` |
| `transcript-body.js` | 执行正文共享渲染，富文本／纯文本只差 `plain`：富文本给工具参数语义标签、修改前后、结构化 JSON、按语言给命令与文件正文着色、长内容就地预览展开；`plain` 给终端保留原始换行与扁平字段，不渲染 Markdown／JSON 树／着色。原文不改写 | `transcriptBody(step, {key?,preview?,plain?})` |
| `code-view.js` | 执行详情代码页签生命周期与只读 state 采样；按前台/页签/偏好单飞刷新，版本变化仅提示，显式刷新更新文件树与正文，作废迟到响应 | `createCodeView(taskId,{onSearch?})` → `{root,setActive,dispose,refresh}` |
| `code-tree.js` | 全项目文件目录懒加载、改动清单、路径筛选、仅改动与分页；按 snapshot revision 读取，目录展开与选中状态保留 | `createCodeTree({request,onSelect,onStale})` → `{root,reset,select,invalidate}`、`fileStatusText(entry)` |
| `code-file.js` | 选中文件差异/正文、old/new 元信息、上下文与分段续读；不混合修订，提供路径搜索入口和只读引用出处 | `createCodeFile({request,onSearch,onStale,taskId})` → `{root,open,reload,invalidate,resume}` |
| `code-diff.js` | 服务端结构化 hunks 的统一/并排安全 DOM；旧新行号、增删标志、按语言着色与无末尾换行提示；内容分段保留字符 | `renderCodeDiff(hunks,path)`、`renderCodeContent(content,path)`、`appendCodeContent(container,content,path)`（按 `line_continued` 就地接续长行，不添加行号/换行） |
| `styles-code.css` | 代码页签/双栏文件树/差异/内容的深浅主题与窄屏样式，不改变项目导航 | CSS |
| `code-highlight.js` | 按需加载固定版本 highlight.js（common 构建，见同目录 `highlight-LICENSE.txt`）：只在出现带语言代码时拉取，用受控 DOM 构建器把输出落成 token span，不把 HTML 字符串 innerHTML 进页面；加载失败／未知语言／超长正文静默回退纯文本。另提供语言名归一化与按文件扩展名推断语言 | `enhanceCode(target, text, language)`、`normalizeLanguage(value)`、`languageFromPath(value)`、`resetCodeHighlight()` |
| `transcript-reader.js` | 紧凑搜索框（Enter／按钮显式提交）、筛选、分页；通过页面回调把同页命中交给全屏正文，定位器就地跳转；原文可限定在当前命中卡片内分段读取，关闭 / boot 作废旧请求 | `transcriptReader(taskId,{locate?,onStart?,onPage?,onError?,onClear?})`、`openTranscriptStep(taskId,seq,{root?}?)`、`releaseTranscriptReader(taskId)`、`pauseTranscriptReader(taskId)`、`searchTranscriptPath(taskId,path)`、`resetTranscriptReaders()` |
| `transcript-view.js` | 全屏只读执行详情，默认执行记录，增加平级代码页签（延迟创建 `code-view`）；切换保留两侧正文/搜索/位置并暂停隐藏视图读取、关闭清理请求与计时器；左栏固定搜索 / 筛选与独立滚动的分页摘要（Ctrl/⌘+Shift+F 聚焦），右栏一一对应的命中正文与配对内容（每页至多 50 项、最多 4 个并发步骤请求）；返回全部记录复用原增量渲染与排序偏好，搜索期间只提示新记录，关闭恢复位置 / 焦点并作废检索，原生 dialog 顶层承载引用菜单 | `openTranscriptView(taskId,seq?)`、`closeTranscriptView()` |
| `quick-explanation.js` | 新版旁侧选区解释面板：quick_explain start/followup/get、保留页面/选区、来源和 Prompt 快照、追问轮次与发送表单（`modelHelp()` 标识、进行中禁用、超长截断提示）、未配置引导；dialog 内挂载，捕获 Esc 只关闭解释，导航/boot/关闭清理轮询和监听，不取消后台 | `startQuickExplanation(quote,location)`、`openQuickExplanation(id)`、`closeQuickExplanationPanel()`、`explanationLocation(location)` |
| `render-quick-explanation.js` | 独立 #quick-explain 项目页面，来源/物理模型/Prompt 配置和全历史分页（摘要带追问轮数）；只读本地目录、迟到保护，保存不调用模型；历史确认后删除、运行中禁用 | `openQuickExplanationPage()` |
| `styles-quick-explanation.css` | 快捷解释表单、历史和面板的主题 token、窄屏及焦点样式 | CSS |
| `explanations.js` | 历史内部旁侧阅读面板（无公开入口）：执行步骤直达无工具解释 Agent，选中文字直达模型 API 的「快速介绍」（直连结果与来源快照、按 `POST /api/action` + 轮询 `/api/intro/:id` 读取），以及两者合并在一个面板里的解释历史（快速介绍与执行步骤分两组，不出现 `undefined`）；全屏执行详情中挂在其 dialog 顶层内，Esc 只关闭解释；关闭不取消Worker，boot 清理计时器 | `startExplanation(taskId,seq,quote)`、`startIntro(quote,location)`、`openExplanation(id)`、`openIntro(id)`、`explanationHistory(taskId)`、`closeExplanationPanel()` |
| `render-transcript.js` | 用户展开后的正文优先执行过程：阅读方向默认最新在前（`transcriptOrder` 可切回时间正序），初次加载 asc 走 `worker.transcript`、desc 走 `worker.transcript_latest`，两个阅读方向都提供有界翻页入口（`加载更早` 用 `before=oldest`、`加载更多` 用 `after=next`），按调用身份聚合输入输出、跨翻页边界配对并保留展开与阅读位置、跳到新内容；搜索命中经 `locateTranscriptStep` 取以目标 `seq` 为中心的有界窗口（前/后各 100 步）并在富文本视图就地展开滚动；每一步按 `tokens.first` 印一次占用 chip（精确 `上下文 X` / 估算 `+X`） | `transcriptContent(taskId)`、`transcriptMatch(taskId,step,related?)`、`paintTranscript(taskId)`、`appendTranscriptSteps(taskId, steps)`、`loadTranscript(taskId)`、`loadTranscriptWindow(taskId, seq)`、`locateTranscriptStep(taskId, seq)`、`fetchTranscriptAfter(taskId, after)`、`transcriptOrder()`、`tokensChip(tokens)` |
| `render-verify.js` | 检验区块 | `renderVerifications(task)` |
| `render-resolutions.js` | 合并冲突处理记录 | `renderResolutions(task)` |
| `worker-model-source.js` | Worker 详情的轻量来源/模型配置与当前/下次摘要；仅 paused / 请求中断的 order/child 可配置，Codex/旧后台带禁用原因。只送 `worker.configure {id,model_selection}`，不读 env/Prompt、不重建完整 Profile，失败保留表单，取消/离页作废迟到结果；当前来源只据运行时冻结字段或旧后台同调用事件，来源显示传入连接列表里用户命名的名称，列表缺失时才回退连接 ID | `canConfigureModelSource(task)`、`modelSourceSummary(task,history?,connections?)`、`modelSourceControl(task,onSaved?)`、`configureModelSource(task)` |
| `retry-dialog.js` | 失败 / 取消 Worker 的「检查后重试」及待开始 / 暂停 / 请求中断 Worker 的「调整运行设置」完整 Profile 编辑器：打开时自动读取本地模型来源列表与已选来源目录缓存，并读取角色当前生效配置、公共与角色环境变量及 Pi 资源；来源读取失败不阻断编辑，可手动重读且保留草稿；「加载默认参数」恢复打开面板时读取的全部默认值；提交 Worker 级覆盖且不改项目配置，环境特殊值以 JSON 字符串无损编辑 | `retryTask(task)`、`configureTask(task)`、`parseEnvLines(text)` |
| `render-iteration.js` | Worker 详情/图共用的待验收与静息无改动回答验收（「仅验收」保留代码现场、不追问归档；「验收并归档」点击后直接先验收再归档、不弹确认）、历史显式继续开发、安全同步父分支与独立 Agent 解决同步冲突；冻结/归档/执行前置禁用，最终准入由后端校验 | `iterationControls(task,{refresh,events})`、`iterationBlocker(task)`、`guardedAction(node,reason)`、`isIterationTask(task)` |
| `render-delivery.js` | Worker 详情/Worker 图共用合并控件：新式 指令/child 开发阶段显示持久「自动合并」复选框，调用 `worker.auto_merge`，按后端 `auto_merge` 的 enabled/locked/editable/reason 展示与禁用（缺投影保守只读）；`merge_readiness.ready` 为真时只显示「合并」（调用 `worker.reserve`，Git 准入仍须复核），pending 保留等待原因，不再显示预约按钮；version 2 请求显示冻结、自动 Squash、源侧解分歧与合并后待验收状态。历史 version 1 合并预约保留显式复查、撤销、源侧解分歧，以及固定 commit + baseline 审批；历史下线交付预约不提供操作 | `deliveryControls(task,{refresh})` |
| `render-detail.js` | Worker 详情整页：非终态 指令/child 的操作栏首位提供「向该 Worker 追加输入」，只切换并聚焦底部输入框，不弹窗、不调用 Agent；实际发送经 composer 的 `worker.message`，暂停中的Worker仍需开始 / 继续；一句话短标题（`taskTitle`）、完整 goal 以 Markdown 正文排在结果之前，并以 `render-goal.js` 默认折叠展示用户追加输入、状态、结果优先的阅读顺序与 Worker 操作；头部用 `roleBadge` 显示专用及历史类型颜色（不显示通用 `agent` 角色标签；Agent 身份与运行信息保留），`task.route` 为真时另带「⚡ 快速路由」徽章，`task_kind='analysis'` 另带「只读分析」徽章；旧 `task.analyze` 分支分析入口已下线，不因 Worker 更名重新开放；Worker 详情的代码现场回收保留「归档」入口，不提供独立回收或保留分支选项；另提供 `worker-delete.js` 的不可逆「删除」入口，清专属历史与资源；有可归档分支时显示（读模型 `branch_archive` 投影，复用 `branch-archive.js`，与 Worker 图同源），一起删除 worktree 与本地 ref，保留Worker和历史记录；来源摘要接收本地连接列表以显示来源名称 | `renderDetail(task, history, diff, usage, connections?)`、`renderDetailError(taskId, message)` |
| `render-overview.js` | 项目概览：Worker 指标、最近Worker、待决与运行中的 Agent，运行时信息默认折叠；没有旧分支图入口，也不再拉 Git 分支图 | `renderOverview(data)` |
| `task-graph-usage.js` | Worker 卡片自身/折叠子树的运行时长、输入、输出、美元估算；消费后端完整摘要，未知明示、聚合加粗、运行闪烁及键盘帮助 | `resourceSummary(node,folded)` |
| `task-graph-layout.js` | Worker 父子森林纯逻辑：缺失父节点作为可见根，坏数据成环不死循环；`layout_parent_id` 仅用于隐藏中间节点的布局，保留真实 `parent_id`。根与各层可见兄弟按自身关注度分档、同档创建时间倒序（ID 倒序兜底），不汇总后代或冒充 runtime 执行次序；完整规则见[Worker 图展示排序](task-graph.md#合并关系展示排序与动效) | `taskForest(graph)` |
| `task-graph-merge.js` | version 2 queue_protocol=1 阶段、展示排序优先级与只读父子合并关系；完整父摘要只消费后端 `merge_queue`，编号打开详情不调用 Agent | `MERGE_PHASES`、`mergePhase(node)`、`mergePriority(node)`、`mergeRelations(node)` |
| `task-graph-motion.js` | 整树刷新前后位置采样、阅读锚点/滚动恢复、250ms 可见卡片 FLIP；同结构真实重排才播放，减少动效时直接落位，无全局监听或计时器 | `captureGraph(host)`、`restoreGraph(host,box,before)`、`graphMotionRunning(box)` |
| `render-task-graph.js` | `#worker-graph` 独立视图：默认极简展示，顶部「详情模式」勾选框默认关闭，勾选展开完整卡片、取消回到极简；按项目保存（`taskGraphMinimal`，保留已有显式选择），等高 68px 双行只构建标题/状态/待决与进度或等待原因/合并摘要，保留层级、折叠和筛选；省略号通过原生非模态 popover 打开更多操作，复用完整卡片的输入、交付、验收、归档与彻底删除准入/确认，浮层打开时暂缓重画，关闭后下次刷新恢复；切换不丢待决草稿。Worker 卡片展示目标、结果、等待原因、执行进度、待决、交付与当前 Git 诊断；卡片不显示通用 `agent` 角色标签，保留专用及历史角色和 `task_kind`；卡片按真实状态配色（running 呼吸外环，其余各一色，中性 idle 兜底），表头汇总行以同一套状态色列计数兼作图例；使用 `task-graph-parts.js` 的待决/诊断组件与 Worker 详情交付按钮；merge 队列身份与其它 Worker 一样常驻图上（不再按队列活跃度自动收起），卡上在队列有动作时多一行队列摘要；表头的状态计数兼作筛选开关，可按状态隐藏 / 恢复 Worker（偏好存 `lush.taskGraph.hiddenStatuses`，`prefs.js` 受管），被筛掉的父节点下的子 Worker 顶成根；main/owner 卡片另给「合并所有」入口：只读筛出这条分支下所有已静息、待合并的 指令/child，确认一次后由 `worker.reserve_all` 交给父 Worker 自有队列的 runtime 串行处理（无可合并项时禁用并写明原因）；折叠按项目存、输入草稿不被轮询覆盖；分支诊断另显示真实 Git 父分支、当前检出、领先/落后计数和关系状态；可归档分支的卡片在分支诊断里给「归档」（与 Worker 详情同源，读模型给 `branch_info.archivable` / `subtree_branches`） | `openTaskGraph()`、`loadTaskGraph()`、`renderTaskGraph(graph)` |
| `task-graph-parts.js` | Worker 图的有界文件改动/工作区诊断与就地待决控件；文件展开状态走 `ui.taskGraphFilesExpanded`，答复后用调用方提供的刷新接缝重拉 | `branchDiagnostics(branch)`、`decisionRow(node,refresh)` |
| `branch-archive.js` | 「归档分支」这条用户动作的唯一实现，Worker 图 / Worker 详情两个入口共用：独立归档的确认弹窗写清会连后代分支一起删 worktree 与本地 ref、未提交改动会丢、Worker／消息／事件／会话保留；「验收并归档」直接先执行验收回调、不弹确认，成功后发 `branch.archive {branch, discard:true}`，把结果写进顶部提示并调用调用方传的 `refresh()` 重拉对应视图；`BRANCH_ARCHIVE_HELP` 是三个入口共用的按钮含义说明（归档是放弃代码的记录状态，不等于删除 Worker） | `runBranchArchive(branch,{refresh,acceptBeforeArchive?})`（组合动作不弹确认，直接调用验收回调，返回真才归档；独立归档仍须确认）、`BRANCH_ARCHIVE_HELP` |
| `worker-delete.js` | 详情/Worker图（含极简更多操作）的共享彻底删除：只读资源预检、完整范围/资源清单及丢弃代码的应用内最终确认，带固定 revision 发用户删除请求；活动记录禁用并提示先手动取消，main/owner 与历史只读展示记录不显示；成功后清专属前端缓存、返回列表或刷新原图，迟到响应/重复点击/失败不误导航或重试已成功删除 | `workerDeleteControl(task,{refresh?})`、`runWorkerDelete(task,{refresh?})`、`WORKER_DELETE_HELP` |
| `detail.js` | 拉取并渲染 Worker 详情，仅用户已展开过程时读取执行记录；窄屏新导航收起索引并定位内容，轮询保留滚动；只有仍是当前请求且成功渲染时返回 `true`，供告知入口确认实际打开；已删除身份及其在途旧响应不再请求/渲染；成功加载当前详情后写 `ui.composerTask` 并调用 `ui.syncComposer`，失败保留禁用而不改投；与详情并行读取本地连接列表（失败不阻断其余部分），用于把来源显示成用户命名的名称 | `loadDetail(taskId)` |
| `docs.js` | 「文档」视图：路由（`#docs` / `#doc-<id>`）、取数、搜索索引懒加载与站内相对链接解析 | `docsTarget(hash)`、`resolveDocPath(from, raw)`、`docLinkResolver(current, docs)`、`loadDocsSearchIndex()`、`openDocs(id)`、`loadDocs(id)`、`DOCS_HASH` |
| `docs-search.js` | 浏览器全文搜索纯逻辑：NFKC / 小写归一化，中英文子串、多词 AND、字段加权、摘要与稳定排序；Mermaid 仅低权重参与 | `normalizeDocsQuery(value)`、`searchDocs(index, query, limit)` |
| `render-docs.js` | 「文档」视图的目录、懒加载内容搜索、Markdown 正文、Mermaid 启动与兜底 | `renderDocsIndex(docs, onOpen, options)`、`renderDoc(doc, resolveLink, onOpen)`、`renderDocError(id, message, onOpen)` |
| `mermaid-docs.js` | 只在文档存在 Mermaid 容器时加载本地固定版本，以 strict 模式逐图校验，并通过显式唯一 id 渲染成隔离的 blob SVG 图片（避免节点/箭头串图，也不用为 Mermaid 放宽主页面的 inline-style CSP）；换文档时回收 blob URL，切换深浅主题时从保留源码串行重绘，超长、超量、加载或语法失败均回退为源码。Agent 输出不走这条路径 | `renderMermaidDiagrams(root)`、`refreshMermaidDiagrams(root)`、`clearMermaidDiagrams(root)` |
| `refresh.js` | 轮询有界 `/api/overview`（revision 未变时不重画；旧 host 回退完整 snapshot）、概览、热 Worker 增量刷新、筛选重画；右侧信息页 / 文档 / 设置 / 统计打开时不让概览覆盖；切回概览立即用缓存绘制，不等 revision 变化或轮询空闲；概览不再拉 Git 分支图；Worker 图通过 `/api/worker-graph` 单飞刷新，快照变且距上次 ≥3s 或距上次 ≥10s 时重拉，正在输入时不重画；changed 时在 `renderNotices(data)` 之后同步调用 `renderNoticeBanner(data)` | `refresh()`、`overview()`、`liveRefresh()`、`applyFilters()` |

预约展示、展示详情/预览、展示后专用合并入口与展示图类型/样式已删除。历史 Worker 与事件数据不改写；Worker列表/详情可按通用文本回看，历史下线交付不提供重试或操作。`isHistoricalDelivery()` 是详情、合并与迭代控件的只读隔离接缝。

可撤销中断与非阻塞继续的 Web 投影见[接缝](modules.md#可撤销中断与非阻塞继续接缝)：`format.js` 的 `statusOf()` / `interruptReason()` 消费 `interrupt_state`，requested 标为「中断请求中」、resuming 标为「继续排队中」并说明安全点/旧调用释放屏障；没有字段时保持旧状态显示。颜色、图例计数及筛选仍用真实 `status`，不把仍在运行的中断请求伪装为已暂停。详情保留原中断确认框，requested 时立即开放「继续」撤销与运行设置/原危险放弃确认；resuming 期间保留可重复继续入口，成功提示仅承诺请求已接受。继续沿用 `agent-call` 与 `agentHelp()`，下一次调用的设置不影响仍在运行的旧调用。`render-tree.js` 与完整/极简 Worker 图优先展示中断/继续原因，不误报为缺少并发槽；图上的中断/继续仍通过详情操作。

Web 中断回归：`test/web/dom-interrupt.test.js` 覆盖确认/取消、requested running/awaiting 的立即继续、resuming 重复继续、待开始/暂停、危险放弃确认、失败提示和完整/极简图投影；`test/web/dom-retry-dialog.test.js` 覆盖请求中断期间只保存下一次调用设置，`test/web/format.test.js` 覆盖旧读面兼容和终态陈旧意图保护。

Worker 图走 `worker.graph` / `/api/worker-graph`、`#worker-graph`，不复用 Git fork 边。旧「分支与合并」导航、`#graph` 页面、`/api/graph` HTTP 路由、分支图渲染与布局模块已移除；旧 hash 回概览。完整谱系和未绑定本地分支绑定仅保留 CLI / RPC，不增加隐藏页面。历史分支引用保留快照，但点击时明确说明 Web 定位入口已移除；Worker 图仅提供通用文字/选区引用，不新增分支语义引用。

Worker 卡片显示真实 Git 父分支、当前检出、领先/落后计数及关系状态；Squash 后 Git 分歧与 `integration=merged` 可以同时成立，不互相冒充。文件统计、列表限额与未知口径见[分支诊断接缝](modules.md#分支诊断增量读面)。交付按钮复用 `render-delivery.js`，归档复用 `branch-archive.js`。参见 [Worker 图与固定输入规则](task-graph.md)。

其它纯逻辑模块：`markdown.js`、`tree-order.js`、`live.js`、`sidebar.js`；`merge-select.js` 是交付队列的候选、冻结与 code-only 顺序预览接缝，由 `render-ladder.js` 使用。`live.js` 的实时刷新间隔不再是写死常量：`liveInterval()` 读「轮询频率」偏好，标准档等于改造前的 3000ms。

Worker树合并关系验证：`test/project/graph-merge-summary.test.js` 覆盖只读全量计数/有界关联条目/200 节点截断/历史协议；`test/web/dom-task-graph-relations.test.js` 覆盖阶段矩阵、真实父关系/排序、摘要/折叠/筛选、重排保护与减动效；浏览器脚本另验证真实 FLIP、阅读锚点、焦点与刷新不重启动效。

指令更名前端验证：`test/web/dom-order-compatibility.test.js` 覆盖新 `order` 与历史 `say` 的输入目标、父候选、交付/验收、Worker 图中文标签和概览计数；原始输入内容、分支名及工作区保持原样。提交入口在 `dom-inputs.test.js` / `dom-input-buffer.test.js` 验证 `order.submit`，真实 Web 白名单在 `core-api.test.js` 验证新入口及旧 `say.submit` 被拒。

Worker 彻底删除前端验证：`test/web/dom-worker-delete.test.js` 覆盖详情/完整卡片/极简菜单共享确认、完整资源清单、活动/共享资源阻塞、固定 revision、重复点击、失败保留、成功后缓存清理、原项目路由、导航竞态与迟到详情/记录响应；不替代 daemon 的真实资源清理验证。

Worker树极简模式验证：`test/web/dom-task-graph-minimal.test.js` 覆盖偏好、摘要、筛选/折叠、待决草稿与共享动作；`bun scripts/check-task-graph-layout.js` 使用临时 HTTP fixture 与 Firefox / geckodriver 验证双主题、窄屏/桌面等高布局、原生浮层、键盘/外部关闭与轮询保护，不连接用户 daemon。

Agent / 来源两页真实浏览器回归：`bun run check:agent-layout`（`scripts/check-agent-layout.js`），使用临时回环 HTTP fixture、Firefox / geckodriver，不连接用户 daemon、不使用账号或调用模型；覆盖双主题、1440/900/390px 的全宽总览、侧边详情与编辑、长名称 / 端点无溢出、Codex 双窗口进度与重置倒计时、本地搜索、打开聚焦 / 返回归还入口 / Escape、非模态语义及配置草稿在诊断失败后保留、Pi/Codex 软件诊断与只读旧历史存档按需打开（不读旧配置），输出截图与失败日志。不替代真实账号、触摸或完整宿主侧栏布局验收。

来源管理台 DOM 回归：`test/web/dom-model-sources.test.js`、`dom-agent-connections.test.js`、`dom-model-source-management.test.js` 覆盖本地只读总览、多维筛选、非模态侧面板焦点/返回/Escape、公开草稿恢复与秘密取消/离页清理、物理 slash ID 与显式前缀修正、默认范围校验、批量范围确认/三项并发/完整公开字段/逐项失败、真实 Service/Manager 公开默认设定与 DOM 编辑/自动查询/批量启停的组合保留、新编辑与迟到页面保护、并发查询整表快照隔离、保存/设备码/备用登录后自动刷新及查询失败分离、独立倒计时/隐藏暂停/到期待刷新/清理；不替代真实浏览器双主题、触摸与视觉验收。

真实浏览器布局回归入口：`scripts/check-transcript-layout.js`（Firefox / geckodriver，无第三方 JS 依赖），职责与命令见[执行记录阅读器验证](transcript-reader.md#验证入口)。

管理型 Worker 的 `render-detail.js` 详情只读：指令、结果、事件、用量与执行过程可读；不显示开发开始／重试、配置、消息、取消、交付、验收、删除、Git diff 或 Worker 挂载控制。绑定启停只在自动化页面；运行／失败／等待等状态均不得露出开发动作。

## Web 宿主

服务器运行 Host 与网络接入由用户配置，见[远程 Host](../deployment/remote-host.md)。Lush 不管理 SSH、远端部署或隧道。

| 文件 | 职责 | 导出 / 接缝 |
|---|---|---|
| `src/ui/web/server.js` | Host 的 HTTP 适配器：UI 资源、认证、窄 API 路由与 `/p/<project-id>/` 项目身份路由；项目连接与发现委托 `src/host/project-host.js` | `startWeb()`、`rememberWebProject()` |
| `src/host/project-host.js` | 已登记项目的连接缓存与 single-flight、身份解析、按需启动 lushd；列表仅探测已登记项目的 socket，不启动未打开的项目 | `createProjectHost()` |
| `src/host/control.js` | 后台 lush-host 进程识别（含 worker）、状态文件、端口探测与安全停止；状态记录可带 `supervisor_pid` 以关联启动者 | `webOwners()`、`stopStaleWeb()`、`recordWebState()` 等 |
| `src/host/service-control.js` | 项目级显式启动/停止/重启互斥；停止请求 idle 准入、等锁释放，无强杀 | `startProjectDaemon(config)`、`stopProjectDaemon(config)`、`restartProjectDaemon(config)` |
| `src/host/supervisor.js` | `bin/lush-host` 的稳定进程所有者，等 worker 退出75后在同端口重新启动；普通退出不重放，退出时停止唯一 worker | `superviseHost(args?)` |
| `src/ui/web/docs.js` | 扫描随代码发布的 Markdown 文档与搜索字段 | `docsIndex()`、`docsSearchIndex()`、`readDoc()` |
| `src/host/registry.js` | 跨项目的登记列表、最后路径缓存、稳定路由 ID 派生、绝对目录 canonicalize、无项目 Web 控制配置 | `launcherStateDir()`、`readLauncherState()`、`writeLauncherState()`、`removeLauncherProject()`、`projectRouteId()`、`canonicalProjectPath()`、`launcherWebConfig()` |

Worker 用户编号展示验证：`test/web/dom-worker-number.test.js` 覆盖 `Wn(-n)*` 接受与历史 `#id`/Draft `#id` 回落、深层子编号、合并队列链接、项目作用域与删除后缓存失效、列表搜索命中编号，以及点击导航与引用 `data-ref` 仍使用整数 `task-<id>`；`test/web/format.test.js` 固定 `taskTitle`/`edgeLabel` 的编号优先与回落口径。编号只改标签，URL/hash、API 参数、`data-task-id`、引用 target/location 与排序仍用整数身份。

`markdown.js` 除默认渲染外还有两件「文档」视图需要的能力：`renderMarkdown(text, doc, options)` 里的
`options.link(raw, label)` 由调用方接管链接解析（返回 `{ href, external }`，返回空或抛错都回落到默认规则：
只有 http/https 成链接）、GFM 表格，以及只在 `options.diagrams === true` 时把 `mermaid` fence 标成待渲染容器。
不传 options 时 Mermaid 仍是普通代码，因此 Agent 输出不会加载或执行图表。带语言标记的 Markdown fence 交给
`code-highlight.js` 按需着色；未知语言与加载失败都回退原纯文本。

---

[← 上一篇：Runtime 与持久化](modules-runtime.md) · [下一篇：CLI、RPC 与测试 →](modules-interfaces.md)
