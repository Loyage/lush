# 用户工作台与设备唯一配置契约

本章落实 W162／用户决定 #402、#408、#411，优先于旧设备继承、项目自动选择与项目新指令默认值描述。目标与反例见[设计理念](../design/user-workspace.md)。下面是本次实现契约，不是验收成功证明。

## 不变边界

每项目一个 lushd；`Config.home`、`LUSH_HOME`、Store、Git 和 Worker 身份不改变。设备根沿用 `launcherStateDir(env)/shared`。Host 只管理用户配置、聚合读面与来源转发，不持有 Worker 权威事实、不调度跨项目工作。

项目统一使用 `/p/<project-id>/` 页面；根页面为用户工作台，即便 Host 以单项目模式启动。既有单项目无前缀 API 可保持兼容，但新前端不以根路径冒充项目身份。根 hash 保留 `#projects`、`#notices`、`#settings`、`#agent-status`、`#model-sources`、`#quick-explain`、`#automation` 和文档；项目页旧设备设置 hash 引导独立根页面，不在项目 shell 编辑设置。

## 设备配置分区

配置基础 Worker 负责 `src/config.js`、`src/core/device-config.js`、`settings.js`、`device-migration.js`、`quick-explanation.js` 的设置类、`src/agent/` 配置／环境／网络／连接／Pi／资源／包模块、`core/agent-connections.js`、project 设置／Agent／快捷解释／包 wrappers、设置类 RPC handlers、CLI scope／config／Agent 接入及相关测试。不改 project 自动化、Host、Web assets、server.js 或 RPC registry。

- 有 `deviceHome` 的真实 Config 只以设备文件为技术设置和连接来源，项目旧文件不参与有效值或来源并集。默认公开 scope 为 device；显式 project scope 拒绝并说明项目覆盖已停用。`settingsConfigurationScope(config,scope)` 负责技术设置的有效作用域，低层 configurationHome/readLocal 选根留给显式迁移与没有 deviceHome 的独立最小测试配置，不能形成生产旁路。
- 设备技术配置读写均用户专属，包括未显式传 scope 的 agent.config/models/resources；registry 白名单与 handler 二次检查共同守门。Agent 的 system.status 不返回完整设备 profile，安全 Worker 摘要和项目运行事实仍可读。项目采样的生命周期归属不得因为技术scope统一为device而失效。
- 完整 Worker profile 及已存在调用快照保持；AGENTS.md、可提交 `.lush-agent/` 是项目上下文，不是技术覆盖。当前调用不热切换。
- 用户 #408 选择设备唯一 Markdown 本机补充：真实 Config 只读取 `<deviceHome>/agent/common.md` 与受支持角色 `.md`，不再读取 `<project>/.lush/agent/*.md` 作为活跃补充，缺设备文件不回退。没有 deviceHome 的最低层独立测试可保留旧根。项目 `.lush-agent/`、管理角色／Pi 默认模式的隔离规则、Prompt 组合顺序与总字节上限保持。
- `agent init --local` 用户专属、create-only 写设备补充；使用设备 settings-write 锁和私有根／目录／文件校验，不覆盖既存文件、不偷锁。读取缺失文件不创建根，拒绝 symlink／硬链接／外来所有者／公开权限／超限文件，不把原文放入错误。
- 显式迁移扩展到旧项目私有 common／受支持角色 Markdown：固定来源与目标、只读预检、私有备份、revision／内容／身份复核与冲突检查；同内容可复用，不同内容阻止覆盖。预检说明仓库专属内容可能传播到所有项目，正文不进入预检／审计／错误。成功导入后旧 Markdown 原文件仍保留但不参与新调用；不自动迁移，不将 `.lush-agent/` 或 AGENTS.md 复制到设备。
- 其余迁移继续读取旧项目文件、预检、稳定 ID／冲突校验、备份、跨进程锁和 OAuth guard；不得因收敛有效读取而让迁移错误读取设备文件当来源。JSON／env／凭证仍沿原发布后退役与恢复协议，不能因 Markdown 扩展破坏 OAuth 单活安全。安装相对路径归一、旧历史保留。迁移只由用户显式执行，不操作真实项目。
- 新 `src/core/device-preferences.js`：导出 `PREFERENCE_DEFAULTS`、`readDevicePreferences(config)`、`saveDevicePreferences(config,patch,expectedRevision)`。config 的 deviceHome 优先，设备服务的 home 可作设备根。
- 偏好读模型 `{version:1,revision,values}`；严格白名单 partial patch，revision 乐观锁、原子私有文件和跨进程 settings-write 锁。允许键：`markdown`、`theme`、`sidebarSort`、`taskGraphMinimal`、`reduceMotion`、`polling`、`toastDuration`、`transcriptOrder`、`noticeChannels`、`noticeNotifications`。值／默认与现有 prefs 一致；折叠、具体筛选和当前选区不加入。
- localStorage 首帧缓存不自动覆盖后端；设备配置缺失时使用规范默认，需要显式保存才能成为持久设置。读取不创建根，不联网。每页记住自己最后应用的权威快照；同源其它标签先更新共享缓存时，本页后续读取仍应发布变化，不能把缓存相同误当作页面已经同步。

## 项目外观兼容（决定 #411）

与 W160 项目外观增量合入时保持以下适配边界：

- `theme` 仍仅由设备偏好管理，根页面与所有项目页面共用；项目外观读取、初始化、保存和轮询不得覆盖主题，也不得阻断设备主题同步。
- 保留项目名称、标签标题、侧栏辨识色与已有颜色；项目配色保留为身份元数据，编辑入口位于用户工作台，不在项目 shell 恢复设置面板或主题按钮。
- 已有 `<project>/.lush/appearance.json` 的旧 `theme` 留存但不参与显示，不自动导入设备偏好；更新配色不得删除或改写该历史值。身份元数据不成为 Agent／运行设置的项目覆盖。
- 保留 Host 已登记身份、只读不启动 daemon、私有文件校验、revision 冲突与迟到响应保护。验证两个不同旧主题的项目仍显示同一设备主题，颜色分别保留；设备主题切换跨页面同步，颜色保存不修改设备主题或另一项目。

## 设备自动化分区

Runtime Worker 负责新增 `src/core/device-automation.js`、project `auto-select.js`／`completion.js`／`hooks.js`／`status.js`、base/lifecycle 的监测生命周期接缝、hooks RPC handler、CLI hooks 及相关 tests。不修改配置分区文件、Host、server.js、assets 或 registry。

`DeviceAutomationSettings(config)` 导出为共享私有文件读写器，设备根同上：

- `get()` → `{version:1,revision,auto_select:{enabled},completion_defaults:{enabled,level}}`；默认关闭、level 默认 merge。
- `save(patch,expectedRevision)` 接受 auto_select 和／或 completion_defaults 的严格 partial patch，返回完整读模型；同 revision 防迟到覆盖，不新增项目级开关。
- `withPolicy(fn)` 在设备 settings-write 锁内重读权威策略，调用同步 fn(model)，用于最终自动答复事务。锁不跨 Agent 调用／异步网络，未知锁不偷取。
- 设备配置读取损坏／暂时忙时不得自动答复，保留问题和可诊断状态。旧项目自动选择／默认流程只保留历史，不自动放大全局授权。
- `setDaemonAutoSelect`／`setCompletionDefaults` 可保留用户 RPC／CLI 兼容，实际修改全局策略并返回原完整 hooksList；前端统一走 Host 新接口。旧用户 API仍不能由 Agent token 调用。
- Project 有界可取消 monitor（建议一秒）读取策略变化；开启／启动时有界处理积压，关闭停止新答复。监测由 daemon 初始化／shutdown 装配，与浏览器和 Host 无关；读 API 本身不执行 Hook。
- 自动答复与来源／消息事务不变，答复提交前在 withPolicy 下再次确认开启；关开关的写入与答复提交串行排序。若 notice.post 调用处仍处于外层 SQLite transaction，自动答复推迟到提交后的 microtask，重新持设备锁确认；不能先释放设备锁再提交旧授权答案。即时 post 返回可能暂为 open，持久答案与暂停／实际退出边界为准。
- `completionDefaults()` 返回全局 enabled/level/revision；实际新建指令复制授权，不修改已有任务及 child 流程。
- 用户 summary 的 auto_select 添加设备作用域／策略 revision 安全证据，前端不得用旧 daemon 的缺失字段假称已生效。

## 全局收件箱分区

Host Inbox Worker 负责新增 `src/host/global-inbox.js`、`src/host/project-host.js` 的窄聚合接缝、Notice 增量只读 RPC／投影和必要持久附属同步元数据、`src/rpc/registry.js` 中仅该新增方法及权限、Notice handlers、对应 backend tests。不改 server.js、assets、设备配置／自动化文件。

`GlobalInboxService(projectHost,{env,...options})` 对外：

- `list({status='all',before=null,limit=30}={})` → `{version:1,items,cursor,has_more,complete,projects}`。status 支持 all/open/unread/automatic/failed；before 是不透明全局分页游标，不是某项目整数。
- item 为 `{project_id,project_name,project,notice,online,checked_at}`；notice 沿用安全 Notice 投影，含可空 task_worker_number。稳定身份为项目身份加 Notice 真实记录身份，分页不能以局部 ID跨项目排序。
- projects 为 `[{id,name,online,checked_at,error,complete}]`，失败安全诊断、有界读取／退避，明确是否初始化／补齐完成。
- `get(projectId,noticeId)` 返回同形 item，在线重核来源；离线可返回已缓存项但不能执行动作。
- `action({project_id,id,method,answer?,expected_identity?})` 严格限定 notice.answer/notice.dismiss/notice.read，固定登记身份转发并返回新 item；不接受路径、token 或任意 RPC。有 expected_identity 时必须与用户所见真实记录一致；Host 固定来源身份，源 RPC 在同一事务原子核验，避免读后删除／整数 ID 复用误答。兼容旧源调用可省略该参数，新 UI 有 sync_identity 必须携带。
- `refresh()`／`close()` 可用于生命周期；刷新单飞、取消／超时有界。聚合 list/get 是只读，不启动后台或调用 Agent。
- 用户专属只读 `notice.sync {cursor?:opaque|null,limit?:1..100}` → `{version:1,project,epoch,reset,changes:[{id,identity,deleted,notice?}],cursor,has_more}`。初始快照固定 watermark 分页扫描历史，再补 delta；日志过期／数据库代际变化明确 reset 重建，未补齐时 complete=false。
- Notice 投影附加 `sync_identity`（稳定随机真实记录身份）、`sync_revision`（单调变更序号）、`sync_epoch`（数据库代际）。附属技术索引／有界 `notice_sync_changes` 和 INSERT/UPDATE/DELETE triggers 覆盖新增、答复、已读、终态直接 SQL 与删除；不回填或改写 Notice 原行，不新增核心实体，不能用首页 200 条截断冒充全量。
- 缓存在用户配置目录的私有派生文件，限大小、权限／路径校验、原子写入；不是权威答案库。每次响应先以当前 registry／访问白名单过滤，移除来源不能泄漏旧缓存。使用临时用户配置根测试。
- projectHost.projects 的安全 summary 可增加 auto_select 以供全局策略状态展示，不扩大其它公开事实。

## Host HTTP 与父分区

父 Worker 负责 `src/ui/web/server.js`、`src/host/user-services.js`、新 HTTP／真实多项目组合 tests、架构与使用文档、最终回归。user-services 惰性加载三个分区稳定导出（依赖注入支持权限专项），固定设备根、请求白名单、错误安全投影及关闭期不准入；新路由保持原登录、Host／Origin、JSON／no-store 和白名单边界：

- `GET /api/host/preferences` → 偏好读模型；`POST /api/host/preferences` 接受 `{patch,expected_revision}`。
- `GET /api/host/automation` → 自动化读模型，可附加项目能力／确认状态。
- `POST /api/host/automation` 接受 `{patch,expected_revision}`，只写设备策略，不循环修改每项目开关。开启是持续用户授权，不以读取执行积压。
- `GET /api/host/inbox?status=&before=&limit=` → list。
- `GET /api/host/inbox/notice?project_id=&id=` → get。
- `POST /api/host/inbox/action` → action。
- 设备设置仍用 `/api/host/settings/**`，前端始终走该根 API，与当前项目是否在线无关。
- 显式旧配置迁移使用原固定项目 RPC；全局设置页可选已登记来源并带稳定项目路由预检／确认，不允许请求任意磁盘路径。
- Host stop 停止聚合服务和在途设置操作，但不停止项目 daemon 或撤销全局策略。

## 前端分区

UI Worker 负责 `src/ui/web/assets/`（HTML 入口为 `assets/index.html`）及对应 DOM／独立浏览器 fixture tests，不修改 backend/server.js。

- W171／决定 #421：根 shell 显示完整全局导航；项目 shell 只显示项目内部导航，左上品牌原生链接 `/#projects` 在新标签打开上级空间，不再显示全局页面按钮或全局收件箱顶部摘要。单项目 Host 根也为工作台，用明确项目身份进入工作。
- `settingsClient` 只接受 device，始终使用 Host 设置 API。删掉活跃项目覆盖／继承编辑，不删除历史记录；设备来源页不伪造全局消费者或历史，项目解释历史仍由项目页提供入口。
- 根 `#projects` 增强为后台总览：只读已登记项目，安全 summary 可附已验证的正整数 pid；不可达显示未确认状态，不冒充已停止。每行「处理消息」进入 `#notices-project-<id>[-<status>]` 来源筛选，沿用全局分页／答复协议并提供所有项目出口。新指令表单按需加载 `project-order-form.js`，固定 `/p/<id>/api/action` 的 `order.submit {content,branch:'main',start}`；默认仅创建，显式创建并开始带 Agent 标识。离线／空白禁发送，单飞跨刷新，正文／ACK 按项目与文档隔离，失败保留并提示先核对未知写入结果，不自动重试。刷新保留表单节点和编辑；未发原文为会话内草稿，不持久写项目 Draft。
- 新全局自动化页调用上述根接口，含自动选择与未来指令默认流程。项目 hooks 页移除这两份编辑，项目授权、命令与实际挂载保持。
- 全局收件箱可就地答复／已知，来源 Worker 使用完整项目链接；问卷 preview 用来源项目路由，输入草稿和通知去重按项目＋sync_epoch＋sync_identity 隔离。有 sync_identity 的记录提交动作必须携带 expected_identity，缺失字段不能伪造。离线动作禁用及 help-host 解释，ACK与后续刷新失败分开。
- 设备偏好后端权威，缓存首帧、显式写入、跨标签／客户端定期或版本失效同步；启动旧缓存不得写回覆盖新值。请求失败保留编辑并明确未保存。
- 全局提醒观察所有有权来源，首屏历史不补发，项目＋记录身份／同源锁去重；关闭页面不承诺后台推送。设备总开关不替客户端请求权限，授权只由用户手势触发。
- 全局模式提示在两种 shell 保持，关闭只修改设备策略，不依赖当前项目在线。启用／可能恢复 Agent 的动作具有 agent-call、agentHelp；非直观及禁用动作遵循 ui-guidance。
- 页面代际／迟到请求保护，320px／双主题／键盘与减少动效必须覆盖。新前端模块在分区内更新导出地图，不改变公开 Worker API语义。

## 验证与交付

用户决定 #410：Web 首屏资源保留原绝对预算（冷 JS 最多24个，含CSS最多25个），扩展用户工作台采用至少四倍源码静态模块数对照；仍核验共享状态、懒执行、HTTP/CSP 与真实浏览器，不以提高绝对上限或删断言达标。

W171／决定 #421 验证：完整 `bun run test --timeout 30000` 3024 通过、0 失败（391 文件）；真实临时双 daemon／Host 验证 PID 与来源新指令隔离、离线发送不启动后台；Firefox 编译产物 fixture 覆盖双主题 1440/390/320px 的后台表单、刷新保留草稿、Agent 标识及品牌新标签保留项目现场；`check:workbench` 覆盖双浏览器／配色与 1440/900/390px。文档检查通过，既有篇幅警告保留。完整日志 `/tmp/lush-w171-logs/full-final.log`，浏览器与文档日志同目录。首轮专项新增指令导致 Notice 序号不再相等，修正测试顺序；首轮全量受 240 秒执行时限中断，不作为成功证据。未调用真实模型、未扫描未登记项目、未重启用户 daemon／Host。

各分区先实际运行完整专项 tests，报告通过数／日志路径和未验证风险，再提交干净工作区。父在 runtime 合并并检查后确认 child，运行真实临时双 daemon／Host 组合及完整 `bun run test --timeout 30000`、`bun run docs:check`；不以截断／未结束的测试宣称通过。不读取真实凭证，不迁移用户配置，不重启用户 daemon／Host。
