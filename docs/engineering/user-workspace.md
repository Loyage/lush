# 用户工作台与设备唯一配置契约

本章是设备唯一配置、全局策略及来源收件箱的当前契约；目标与反例见[设计理念](../design/user-workspace.md)。旧项目配置不再活跃，显式迁移见[设备迁移](device-settings.md)。

W210／D492 已移除 Worker 并发额度功能：设备设置、CLI 及状态不再提供并发上限，旧盘上值保留但忽略，旧并发环境变量不生效。无项目或设备槽池，不新增 Host 槽接口；运行时依赖、冻结、维护与实际退出等安全门仍保留，见[移除并发槽](global-slots.md)。

## 不变边界

每项目一个 lushd；`Config.home`、`LUSH_HOME`、Store、Git 和 Worker 身份不改变。设备根沿用 `launcherStateDir(env)/shared`。Host 只管理用户配置、聚合读面与来源转发，不持有 Worker 权威事实、不调度跨项目工作。

项目统一使用 `/p/<project-id>/` 页面；根页面为用户工作台，即便 Host 以单项目模式启动。既有单项目无前缀 API 可保持兼容，但新前端不以根路径冒充项目身份。根 hash 保留 `#projects`、`#notices`、`#settings`、`#agent-status`、`#model-sources`、`#runners`、`#automation`、`#cli-interfaces` 和文档；项目页旧全局页面 hash 引导独立根页面，不在项目 shell 编辑设置。

## 后台总览开发摘要（W186／决定 #446）

项目卡片采用「状态指标＋最近 Worker」。Host 显式刷新时调用 `system.summary {development:true}`，用户读面才附加 `development`；普通首页轮询和 Agent 默认摘要不做新增全量聚合。`Project.developmentSummary()` 只读完整 tasks 的新式 Worker（含历史 say），返回精确 `workers_total`、`active`、`awaiting_acceptance`（指令）、`parent_confirmation`（child）、`agents_running`（真实 invocation）、`pending_merges`（pending/review）、`merging`、`merge_conflicts`、`counts:[{status,count}]`，及最多 3 条按 ID 倒序的 `recent_workers:[{id,worker_number,display_title,auto_title,goal,status,integration}]`（仅指令／child，正文裁至 200 字符）。总数和状态分布包含 main/owner 及历史，进行中排除分支所有者及待验收；派生待父确认不冒称待用户验收。Host 严格白名单投影，不传 Profile、凭证或完整 Worker。旧服务缺少摘要时明确不可用，不据局部最近列表推算总数；离线不展示旧值为现状。读取仍不启动后台，不改变自动合并或验收流程。

## 总览面板与管理分离（W204／D481、D500）

根 `#projects` 改为无大标题的可定制面板，全局与每卡设置都在当前页弹窗打开；W234／D552 恢复每项目一张原色彩／字体／边框的聚合卡与统一额度窗口，配置所选来源、动态内容与常用导航；v4 独立成员仅作无损兼容存储，不在查看／布局保存时迁移。固定尺寸与列表槽位不随业务状态增长，超量翻页、详情弹窗；内容、位置及尺寸设备共享；W253／D587 使用统一草稿编辑模式管理新增、移除、设置和网格布局，整页保存／取消，网格吸附和碰撞避让。`#project-management` 仍承接目录登记、后台维护、配色编辑与新建 Worker，不再挂载总览卡片设置。进入面板只读；账户查询仅由单卡或全局刷新显式触发，后者只查已摆放账户。

配置版本兼容、partial patch、消息计数／逐条已知、固定尺寸和验证边界统一见[总览面板](dashboard-panel.md)；不在此复制版本号或历次布局方案。

## 全局中断完成提醒（W216／D508）

项目维护投影与 Worker／项目两层 Hook 新节点见[中断完成信号](interrupt-completion.md)。Host `/api/host/projects` 为每项附加严格白名单 `summary.maintenance`，保留原 `maintenance_paused`；畸形／旧字段不提供成功证据，不启动离线项目。浏览器只读观察本次确认固定范围与精确批次，全部已完成且当前空闲再提醒，不自动重启／继续，不拥有项目权威事实。来源 info Notice 在项目保存，离页停止观察，关闭页面不承诺推送。

## 设备配置分区

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

`DeviceAutomationSettings(config)` 导出为共享私有文件读写器，设备根同上：

- `get()` → `{version:1,revision,auto_select:{enabled},completion_defaults:{enabled,level}}`；自动选择默认关闭，completion_defaults 仅保留旧设备配置的兼容只读投影，不参与新建 Worker。
- `save(patch,expectedRevision)` 仅接受 auto_select 的严格 partial patch；completion_defaults 写入明确退役，旧文件不删除、不自动导入到项目。返回完整读模型，同 revision 防迟到覆盖。
- `withPolicy(fn)` 在设备 settings-write 锁内重读权威策略，调用同步 fn(model)，用于最终自动答复事务。锁不跨 Agent 调用／异步网络，未知锁不偷取。
- 设备配置读取损坏／暂时忙时不得自动答复，保留问题和可诊断状态。旧项目自动选择／默认流程只保留历史，不自动放大全局授权。
- `setDaemonAutoSelect` 的用户 RPC／CLI 兼容修改全局自动选择并返回完整 hooksList；前端走 Host。`setCompletionDefaults` 已改为项目独立策略同源入口，见[项目自动化接口](../reference/rpc/hooks.md#新指令默认流程)。均不能由 Agent token 调用。
- Project 有界可取消 monitor（建议一秒）读取策略变化；开启／启动时有界处理积压，关闭停止新答复。监测由 daemon 初始化／shutdown 装配，与浏览器和 Host 无关；读 API 本身不执行 Hook。
- 自动答复与来源／消息事务不变，答复提交前在 withPolicy 下再次确认开启；关开关的写入与答复提交串行排序。若 notice.post 调用处仍处于外层 SQLite transaction，自动答复推迟到提交后的 microtask，重新持设备锁确认；不能先释放设备锁再提交旧授权答案。即时 post 返回可能暂为 open，持久答案与暂停／实际退出边界为准。
- Project `completionDefaults()` 返回项目 enabled/level/revision；实际新建指令复制项目授权，不从设备配置或父 Worker 继承，不修改已有任务及 child 流程。
- 用户 summary 的 auto_select 添加设备作用域／策略 revision 安全证据，前端不得用旧 daemon 的缺失字段假称已生效。

## 全局收件箱分区

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

`src/host/user-services.js` 惰性装配设备偏好／策略和来源收件箱，固定设备根、请求白名单、安全错误及关闭期不准入；`src/ui/web/server.js` 适配 HTTP，保持登录、Host／Origin、JSON／no-store 边界：

- `GET /api/host/preferences` → 偏好读模型；`POST /api/host/preferences` 接受 `{patch,expected_revision}`。
- `GET /api/host/automation` → 自动化读模型，可附加项目能力／确认状态。
- `POST /api/host/automation` 接受 `{patch,expected_revision}`，只写设备自动选择；completion_defaults 明确拒绝，不循环修改项目策略。开启是持续用户授权，不以读取执行积压。
- `GET /api/host/inbox?status=&before=&limit=` → list。
- `GET /api/host/inbox/notice?project_id=&id=` → get。
- `POST /api/host/inbox/action` → action。
- 设备设置仍用 `/api/host/settings/**`，前端始终走该根 API，与当前项目是否在线无关。
- CLI 接口的设备共享管家权限使用根 `GET/POST /api/host/management/permissions`，不依赖登记项目或 daemon 在线；默认开放、旧限制退出授权和授权锁详见[全局管家权限](hook-signals-management.md#设备全局管家权限)。
- 显式旧配置迁移使用原固定项目 RPC；全局设置页可选已登记来源并带稳定项目路由预检／确认，不允许请求任意磁盘路径。
- Host stop 停止聚合服务和在途设置操作，但不停止项目 daemon 或撤销全局策略。

## 前端分区

- W171／决定 #421：根 shell 显示完整全局导航；项目 shell 只显示项目内部导航，左上品牌原生链接 `/#projects` 在新标签打开上级空间，不再显示全局页面按钮或全局收件箱顶部摘要。单项目 Host 根也为工作台，用明确项目身份进入工作。
- `settingsClient` 只接受 device，始终使用 Host 设置 API。删掉活跃项目覆盖／继承编辑，不删除历史记录；设备来源页不伪造全局消费者或历史，项目解释历史仍由项目页提供入口。
- 根 `#projects` 增强为后台总览：只读已登记项目，安全 summary 可附已验证的正整数 pid；不可达显示未确认状态，不冒充已停止。不再提供每行「处理消息」按钮；全局收件箱的具体消息与系统提醒通过 `/p/<id>/#notices-<notice-id>` 新标签定位来源项目「待我处理」记录（只读导航、不自动已读），告知为蓝色、待决为琥珀色。原全局来源筛选与详情书签保留兼容。新指令表单按需加载 `project-order-form.js`，固定 `/p/<id>/api/action` 的 `order.submit {content,branch:'main',start}`；默认仅创建，显式创建并开始带 Agent 标识。离线／空白禁发送，单飞跨刷新，正文／ACK 按项目与文档隔离，失败保留并提示先核对未知写入结果，不自动重试。刷新保留表单节点和编辑；未发原文为会话内草稿，不持久写项目 Draft。
- `#runners` 独立管理设备执行节点，复用设备编辑器；项目管理行与设备设置旧分区只提供导航，不再重复挂载。`#settings-runners` 兼容到独立页，`#runners-project-<host-project-id>` 固定来源并展开“项目授权与默认节点”；项目 shell 的旧全局书签引导新标签打开根页面。节点列表与异常、常用操作默认可见，身份／预算沿编辑器按需展开。项目授权模块按需读取 Host 已登记项目名与 ID，仅在线来源挂载原项目编辑器；离线、未登记、读取失败禁编辑，不启动后台，不把 Host 列表当授权权威。显式刷新保持仍在线的同一项目表单，切换／离页释放原编辑器、凭据和迟到请求；没有页面自动重渲染。
- 全局自动化页仅编辑设备自动选择，旧设备完工默认编辑入口退役。项目 hooks 页管理项目未来 Worker 默认及默认显示原则；具体授权／运行记录留在对应 Worker，命令和实际挂载安全边界保持。
- 全局收件箱可就地答复／已知，来源 Worker 使用完整项目链接；问卷 preview 用来源项目路由，输入草稿和通知去重按项目＋sync_epoch＋sync_identity 隔离。有 sync_identity 的记录提交动作必须携带 expected_identity，缺失字段不能伪造。离线动作禁用及 help-host 解释，ACK与后续刷新失败分开。
- 设备偏好后端权威，缓存首帧、显式写入、跨标签／客户端定期或版本失效同步；启动旧缓存不得写回覆盖新值。请求失败保留编辑并明确未保存。
- 全局提醒观察所有有权来源，首屏历史不补发，项目＋记录身份／同源锁去重；关闭页面不承诺后台推送。设备总开关不替客户端请求权限，授权只由用户手势触发。
- 全局模式提示在两种 shell 保持，关闭只修改设备策略，不依赖当前项目在线。启用／可能恢复 Agent 的动作具有 agent-call、agentHelp；非直观及禁用动作遵循 ui-guidance。
- 页面代际／迟到请求保护，320px／双主题／键盘与减少动效必须覆盖，不改变公开 Worker API 语义。

## 验证与交付

用户决定 #410：Web 首屏资源保留原绝对预算（冷 JS 最多24个，含CSS最多25个），扩展用户工作台采用至少四倍源码静态模块数对照；仍核验共享状态、懒执行、HTTP/CSP 与真实浏览器，不以提高绝对上限或删断言达标。

跨项目双 daemon／Host 的独立组合回归已删除；真实浏览器入口仍为 `bun run check:workbench`，使用临时项目验证，不操作真实凭证、配置或服务。mock／DOM 不能证明真实模型或浏览器表现，验证与交付责任见[贡献指南](../contributing/README.md#分层测试与交付)。
