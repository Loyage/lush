# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。代码里的 `CORE_READS`（只读路由白名单）、`CORE_WORKER_READ` / `CORE_DOC_READ`（Worker与文档读取形状）和 `MUTATIONS`（`POST /api/action` 动作白名单）是权威来源；白名单之外的 `/api/**` 一律 404，不再回落到其它项目或旧接口。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理。全局工作台（无 `--project`）为**每个项目**给出一条稳定身份路由 `/p/<project-id>/**`；带 `--project` 的单项目模式固定绑定且拒绝切换，并保留无前缀的兼容路径。

**项目身份来自路由。** 全局模式下页面、读取路由与 `POST /api/action` 都必须走 `/p/<project-id>/`；服务端用不透明 ID 在已登记集合（本地启动器列表或公网 `web.json.projects` 白名单）里反查 canonical 路径，URL 片段永远不会被当作文件路径。无前缀的项目读写一律拒绝并提示刷新，**绝不回退到某个「当前项目」**；未知／已移除的身份返回错误（页面请求回项目列表）。下表在全局模式下均加 `/p/<project-id>` 前缀，单项目模式则用原路径。

## Worker 页面与命名

浏览器的 Worker 详情使用 `#worker-ID`，执行详情仍在详情页显式点击打开，不提供独立 hash；「工作列表」`#workers` 只含开发 Worker，「管家列表」`#valets` 只含持久 Valet，两列表共享 overview 与 `scope=all` 有界历史分页、即时状态筛选和提交式文本搜索，明确仅检索已读取范围；「工作树」使用 `#worker-graph`，不把 Valet 的操作目标当作委派子节点。独立当前「交付」导航与计数轮询已退休；整合操作复用真实 Worker 身份，不改父子连线，接口与 merge_operation 见[一次性整合](rpc/convergence.md#一次性整合)。旧 #deliveries[-history] 及 run／node／source 深链接仅兼容历史合并记录，不恢复策略写入；截断、未知及过期游标仍明确提示，数据见[兼容视图](rpc/convergence.md#项目交付视图d642)。#worker-graph-worker-ID 继续定位真实来源；整合 Worker 工作完成／待验收不等于操作已落地。Valet 详情保留指令、结果与执行阅读区，另提供「停用授权」「停止管家」及重新预检后确认删除；停止请求不等于实际退出，调用与在途操作收口前不得删除，未知结果不重放。仍无开发、Git、合并、验收或连续追加对话；精确删除保护见[维护接口](rpc/maintenance.md#彻底删除-worker)。HTTP 与 Web 写动作同步使用下文的 `/api/worker/**`、`/api/workers`、`/api/worker-graph` 和 `worker.*`。旧 Task 路由与动作不保留别名；数据字段与历史事件仍可保留 `task`，完整边界见[核心 API 更名说明](../engineering/core-api.md#worker-更名与兼容边界)。

问卷、通知详情和 Agent 正文中的独立 W／V 用户编号（例如 `W141-1`、`V1`）自动显示为蓝色下划线链接。链接使用 `#worker-number-W141-1` 或 `#worker-number-V1`，打开时通过当前项目只读查找解析真实内部身份，再进入原有 `#worker-ID` 通用详情；支持键盘与新标签打开，不把编号当作内部 ID，也不在渲染时查询。未知／已删除编号明确报错。代码块、已有链接、编辑区和普通操作按钮不自动改写；选择题选项中的编号链接与选择按钮独立，查看 Worker 不会作答，返回问卷保留未提交草稿。静态 HTML 效果预览仍保持原 sandbox，不注入跳转能力。

项目自动化 #hooks 是完工默认、推送、待验收告知三项设置目录，对应 #hooks-completion／#hooks-push／#hooks-acceptance_notice，无运行记录标签；旧 #hooks-convergence 返回目录并说明持续归并退休，不读取或保存默认策略。旧功能 `-history` 书签转到对应设置，`#hooks-history` 返回目录；`#hooks-emission` 及其旧记录入口转到输入／草稿，条件发射不属于项目自动化。`#cli-interfaces` 为「CLI 接口」学习与管家权限一体页，旧 `#valet-settings` 跳新入口。标题置顶，搜索紧邻结果之前，不设固定前缀，可输入实际 `lush`／`lushc` 完整命令或名称／介绍；实时本地匹配命令／名称／介绍，中文 IME 组合期间不刷新。说明使用随 Host 发布的内容版本缓存，浏览不连接项目后台；读写接口统一搜索和逐级浏览，空关键词列全部顶层目录；目录／搜索结果／子命令都按命令路径单词数升序（不计 `lush`／`lushc`、参数及选项），同词数保持目录顺序；列表限制阅读宽度、收紧列距，桌面为命令、简介、读写标记及管家权限四列，权限默认标明未读取；点击「读取项目权限」后才请求当前项目权限，多 RPC 明示多项，进入详情逐项配置。读写仅作为行内状态显示，跨类目录标为「读／写」；标记不授予执行权限。单条详情及子命令保留关键词和权限草稿。默认突出用途、格式、示例、风险及各关联 RPC 的当前项目管家权限／审核上限；高级参数及兼容限制折叠；窄屏将简介移到命令下方并适当省略，读写和权限仍可见，长命令可在单元格内换行；详情权限单列、顶部返回。底部统一保存完整权限与 revision，对当前项目新旧 Valet 统一生效；未开始的排队／待确认操作执行前重检，已开始的不强行中断，已执行的不撤销。不影响其他项目，不新建操作；已有未开始的请求按最新权限继续或受阻，失败／取消项不重放。浏览说明不执行 CLI 或调用 Agent；权限边界见[项目管家权限](../engineering/hook-signals-management.md)。无项目仍可浏览说明，不可编辑权限，不恢复信号／绑定页。旧 W263／D611 删除独立 Valet 信号／绑定设置和指令／Hook 工具页面及其 Web 配置入口，不迁到其他页面：`#management`／`#management-history` 跳 `#valets`，`#hook-tools`／`#hooks-commands`／`#hook-tools-history` 及旧命令详情地址跳 `#hooks`，并说明入口已移除。推送页只读引用指令；Worker 实例 Hook 控制、既有后端 API、CLI、授权与历史保持原协议。`#versions` 不再独立渲染，通过有界 overview 核对真实 `task_kind=main` 且 `branch=main` 的持久身份后跳 `#worker-ID`，缺少 main 明示不可用，不从整数 ID 猜编号或身份。旧看板版本快捷链接仅从 Web 投影隐藏，不改已保存配置。精确操作入口见[使用指南](../hooks.md#页面入口)。

## 宿主级路由

- `GET /`、`/app.js`、`/styles.css`、`/assets/**`：Web 资源（无项目前缀）。全局模式下 `/` 是可在未选项目时使用的完整主体，`#projects` 展示和设置项目与账户面板，`#project-management` 管理项目入口与后台；`/p/<id>/` 是该项目的工作台。
- `GET /web-<content-version>-cli-catalog.json`：HTML 提供精确静态目录 URL；命令、参数和审核策略参与版本身份。仅安全代码说明，登录与 Origin 校验后按私有、不可变缓存提供 JSON／gzip 及 ETag；不读取项目权限，不附着项目后台。旧 `cli.catalog` RPC 及 `/api/cli/catalog`、`/api/host/cli/catalog` 保留，原生兼容页面可用 Host-only 读面，新页面不再以动态目录 API 为加载前提。缓存和实时权限边界见[CLI 目录](../hooks.md#cli-目录缓存与权限)。
- `GET /api/host/session`：仅根路径、无查询参数，已登录后只返回 `{username}`（当前 Host 登录配置的账户名）。保留 Origin 校验、认证和 no-store，不返回密码/hash、Cookie/token 或路径，不连接或启动任何 daemon；未登录 401，注销/到期后旧 Cookie 失效。不是历史输入作者或多用户账户接口。
- `GET /api/host`：返回 `mode`、上次打开的项目（`last_project` / `last_project_id`）与已登记项目列表（`projects`，含 `connected` / `last`；`mode` 为 `host` 或 `bound`）。只报告上次落点，不因此自动启动或连接任何 daemon。另返回当前服务进程的 `pid` 与 `restart_supported`；嵌入式 Host 不支持进程重启时为 `false`。
- `GET /api/host/dashboard`：设备共享总览 v5 配置，前端聚合项目卡、统一额度窗口及运行诊断卡；保留原始 widgets、固定网格及旧选择／内容字段，新增 `diagnostics:boolean`。`widgets:null` 兼容投影与 partial patch `POST` 见[总览面板契约](../engineering/dashboard-panel.md)。用户专属、严格字段／revision／私有文件校验，v1–v4 文件只读兼容。配置不存余额或凭证，读取不启动后台或查询账号；显式刷新已摆放账户沿用设备连接查询接口。
- `GET /api/host/diagnostics`：用户专属根路径、无查询参数；只读聚合已登记且授权可访问项目的 `system.diagnostics`，返回 1／5 分钟平均 token/s、估算 USD/min、十分钟趋势和来源覆盖／未知状态。保留登录、Origin、no-store 和严格白名单，不接受路径、token 或任意 RPC，不启动离线后台、查询服务商或调用模型；字段与费用口径见[运行诊断卡](../engineering/dashboard-panel.md#运行诊断卡)。
- `GET /api/host/projects`：项目列表对已登记目录检查项目 socket，并对可达的 lushd 有界读取 `system.summary`，返回 `running` 与摘要（可含已验证的正整数 `pid`、实际 `agents_running`、维护暂停、待决数，以及 `development` 的全项目状态指标和最近 3 条 Worker；详见[开发摘要契约](../engineering/user-workspace.md#后台总览开发摘要w186决定-446)）。新 Host 只在显式总览读取请求 `development:true`；旧 daemon 不支持参数时只读降级，开发摘要缺失明确不可用，不能把 `agents_total` 当作真实调用数；`connected` 仅表示 Host 已打开连接，二者不是同一状态。读取列表不会启动任何 lushd，未登记项目不会被扫描；单个项目失败只影响自己那一行。
- `GET /api/host/projects/<id>/appearance`：只读项目外观元数据，不启动 daemon；返回 `{id,name,project,appearance}`，未初始化时 appearance 为 null。`POST` 同路径接受 `{initialize:true}` 或 `{color,expected_revision}`，首次分配尽量不重复的预设色，保存须匹配 revision。#411：项目 `.lush/appearance.json` 的旧 theme 留存但不生效，兼容回传相同 theme、改变拒绝；配色在用户工作台管理，设备主题另走 preferences API；只认已登记／白名单身份，拒绝路径、token、未知字段和 query，沿用认证／Origin／JSON／no-store。详见[项目外观契约](../engineering/workbench.md#项目外观w160)。
- `POST /api/host/select`：仅全局模式可用，JSON `{project}` 必须是现存目录的绝对路径（公网模式还必须在白名单内）；登记该项目、按需启动 / 连接 daemon，返回该项目稳定路由 ID（`id`）。它不再设置全局「当前项目」，页面归属由前端跳到 `/p/<id>/` 决定。
- `POST /api/host/projects/start` / `stop`：JSON `{id}`，只允许已登记的项目身份。启动是显式操作；停止复用 daemon 的空闲准入并等待退出，不取消 Worker、不强杀；忙碌拒绝。`/api/host` 的 `project_control:true` 宣告支持。项目 API、旧标签轮询、另一个 Host 的附着都不会重新启动已停止的项目。
- `POST /api/host/remove`：仅全局模式可用，JSON `{id}` 只从列表移除入口并断开这个 Web 连接，**不停止 daemon**；停止走上述独立入口。
- `GET /api/docs`、`GET /api/docs/search-index`、`GET /api/docs/<id>`：「文档」视图的目录、搜索索引与 Markdown 正文，读的是随这份代码发布的 `docs/**/*.md` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。搜索索引只在用户第一次搜索时返回标题、小节、正文、普通代码与低权重 Mermaid 字段，匹配和排序在浏览器完成。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；未命中返回 404。

## 用户工作台路由（W162）

工作台的设备偏好、全局自动化和跨项目 Inbox 接口只有根路径，不添加 `/p/<id>` 前缀，也不依赖“当前项目”。精确数据模型及实现进度见[用户工作台契约](../engineering/user-workspace.md)。它们复用 Host 登录、Origin、JSON 与 no-store；拒绝未知／重复参数、项目路径、Agent token 和任意 RPC。

| 路由 | 参数与行为 |
|---|---|
| `GET /api/host/preferences` | 无查询参数；返回 `{version,revision,values}` 的设备权威偏好 |
| `POST /api/host/preferences` | `{patch,expected_revision}`，严格偏好白名单、非空 patch，过期版本拒绝 |
| `GET /api/host/automation` | 无查询参数；设备策略 `{version,revision,auto_select,completion_defaults}`，completion_defaults 仅历史兼容只读 |
| `POST /api/host/automation` | `{patch,expected_revision}`，仅设备自动选择；completion_defaults 写入退役，未来默认走项目接口 |
| `GET /api/host/inbox?status=&before=&limit=` | status 为 all/open/unread/automatic/failed；before 为不透明全局游标，limit 为 1..100（默认30） |
| `GET /api/host/inbox/notice?project_id=&id=` | 只接受当前有权访问的登记身份及正整数 Notice ID；不同来源的整数ID不可混用 |
| `POST /api/host/inbox/action` | `{project_id,id,method,answer?,expected_identity?}`；仅 notice.answer/dismiss/read，answer只用于answer；有真实记录身份时新UI携带expected_identity，源事务核验防整数ID复用误答 |

接口依赖失败只返回安全的未确认诊断，不公开原始认证／上游响应，也不把已提交但未确认的动作说成未执行。Host 停止关闭已实例化聚合服务，不停止项目 daemon 或撤销全局授权。

## 快速对话已删除

全部快速对话页面、Prompt／模型配置和调用入口已移除。`/api/quick-chat/**`、`/api/host/quick-chat/**`、`/api/quick-explain/**`（含 Host 设置路径与项目前缀）不再开放，`quick_explain.*` 不在动作白名单或 RPC 注册表中。专用数据清理见[退役契约](../engineering/project-quick-chat.md)。

## 设备设置与旧配置迁移

`GET /api/host/settings/<suffix>` 与 `POST /api/host/settings/action` 是已登录用户专属的窄设置入口，无项目前缀、仅 device scope；不接受 Worker/模型调用/历史/迁移/项目路径/token。设置的唯一有效来源以[用户工作台契约](../engineering/user-workspace.md)为准；安全迁移见[旧配置迁移契约](../engineering/device-settings.md)。Host 不为管理配置启动 daemon，也不构造伪项目。

项目路由的兼容配置读面仅接受 device scope；显式 `scope=project` 已拒绝，不继续提供项目设置覆盖。`GET /api/settings/migration` 与 `settings.migration.apply {revision,confirm:true}` 仍经固定项目路由显式预检／确认，不接受任意磁盘路径。历史与 Worker 运行参数接口不接受 device scope，不搬迁项目事实。

## 服务器访问边界

Lush 不提供 `/api/environments` 受管 SSH 或 `/e/<environment-id>/` 代理路由。用户自行在服务器运行 Host，并配置 SSH 转发、IP/端口或域名后由浏览器直接访问，见[远程 Host](../deployment/remote-host.md)。项目仍使用该 Host 的 `/p/<project-id>/` 身份。

## 当前项目维护暂停

项目页「全部中断／全部继续」使用用户专属无参数 `system.interrupt_all` / `system.resume_all`，经当前项目 `POST /api/action` 转发；不影响其它项目，不自动重启服务。全局项目管理在底部服务重启区域的「手动维护」中提供同名按钮：只读重核此 Host 已登记在线项目并确认固定范围，然后逐项通过 `/p/<project-id>/api/action` 调用相同接口；不新增 Host 批量 API，不启动离线项目。中途失败停止后续，报告已接受、失败／未确认与未执行范围，不自动重试或撤销；请求接受不代表已安全退出或立即运行。继续按钮及确认带 Agent 代价，与重启共用单飞和离页保护。两个动作只接受 `{method,params:{}}`（params 可省略），拒绝多余 envelope／params／query 字段和 Agent token。返回同源 `maintenance` 投影；`system.summary`／`system.status` 也提供该读面，包括维护门、暂停进度、真实在途计数、可重启与固定阻塞原因。详情与字段权威见[维护暂停契约](../engineering/project-maintenance.md)。

暂停在 daemon 重启后保留；新调用（含子 Worker／管理 Agent）不得越过维护门。恢复只处理本次影响的工作，原静息父级保留等待关系，原个人暂停／待开始／失败／待验收不批量启动。运行中工具与已开始后台操作安全收尾；请求接受不表示已退出，真正服务重启仍按下面的同步空闲门重检。

## 服务重启

两个入口必须使用同源、已登录的 JSON `{}` 请求；不得传项目路径、强制停止选项或 Agent token。它们不经过通用 `/api/action`。

入口在全局工作台 `/#project-management`「项目管理」，不在设备设置或项目工作页：每个项目行有「重启项目后台」，底部有「一键安全重启」「重启界面服务」，「全部重启」位于「手动维护」展开区。W176／决定 #434：「全部重启」包含此 Host 已登记的所有在线项目后台和当前界面服务，不涵盖未登记或离线项目。先只读刷新项目列表，确认中列出固定项目名称／路径和数量；确认后新上线的项目不加入。再次检查 Host 能力，逐个调用带固定项目身份的重启接口，全部成功后才重启 Host。不新增接口或跨项目调度。任一项目忙碌或失败时停止后续步骤、不重启界面，就地报告已完成、失败／未确认和未执行范围，不自动重试；写入超时不能当作没有生效。Host 不支持按钮重启时禁用界面／全部按钮，项目行仍可独立重启；离线项目行禁用。独立项目重启成功只刷新项目管理，保留目录与未发送指令；Host 重启仍会断开全部连接页面，可能丢失未发送输入并要求重新登录。

「一键安全重启」复用上述维护和下述重启接口，不增加批量 API。流程、原有暂停保留、失败处置及页面生命周期以[一键安全重启契约](../engineering/project-maintenance.md#一键安全重启w249d579)为准。

- `POST /api/host/restart`：宿主级，无项目前缀；返回 `{restarting:true}` 后当前 Host worker 退出，由它的 supervisor 在原端口启动全新进程，加载磁盘代码。不停止任何项目 daemon。影响连接此 Host 的全部页面，登录会话会清空；前端可有界读取 `/api/host`，等 `pid` 改变或 401 后重新登录。仅通过 `bin/lush-host` 启动的受监督 Host 支持该操作；直接嵌入 `startWeb()` / 直接 CLI 前台调试默认不支持。
- `POST /api/service/restart`：项目级，全局模式必须带 `/p/<project-id>` 前缀。Host 调用用户专属、无参数的 RPC `system.stop_if_idle`；daemon 同步检查 invocation（包括尚未退栈的已停驻调用）、模型调用、排队及执行中的 Git 工作、合并与后台写入，忙碌即拒绝。准入后封闭调度与新 RPC 写入，返回 `{stopping:true}` 并正常退出。Host 等项目锁释放后启动新 daemon，返回 `{restarted:true,project,pid}`；不强杀、不自动重放调用，也不操作其他项目。重复点击会被拒绝；停止/启动超时报错并保留日志，需检查项目 `.lush/daemon.log`。

旧 daemon 不认识 `system.stop_if_idle` 时拒绝操作，不回退到不安全的 `system.stop`。更新本功能时需先通过现有命令行入口加载新 daemon 与 Host。

## 项目读取

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | 兼容快照读面；首页轮询走带 revision 的 `/api/overview` |
| `GET /api/overview?revision=N` | 有界 Worker 核心读模型（与 `/api/snapshot` 同源） |
| `GET /api/inputs?cursor=&limit=&q=&status=&integration=` | 用户专属 `input.history`，全项目原始输入与未提交草稿搜索/筛选/分页，见[历史输入接口](../engineering/input-history.md) |
| `GET /api/input/{kind}/{id}` | 用户专属 `input.get`，`kind` 为 `draft` / `input`，完整正文与引用 |
| `GET /api/input-parents` | 用户专属 `input.parents`，完整可选父 Worker 读面 |
| `GET /api/worker-lookup?number=Wn(-n)*` 或 `number=Vn` | 只读 `worker.lookup {number}`，严格完整用户编号，返回 `{id,worker_number}`；仅当前项目查找，不接受额外或重复参数 |
| `GET /api/workers?scope=&before=&limit=` | `worker.page`，有界Worker分页，`scope` 为 `work` / `all` |
| `GET /api/notices?status=&before=&limit=` | `notice.page`：全部类型事项与处理结果的按需分页；过滤掉旧 `plan` 类型；参数和留档语义见[待决问题](rpc/notices.md) |
| `GET /api/worker-graph` | Worker 父子读面（`worker.graph`） |
| `GET /api/worker-delivery-graph` | 用户专属[项目交付视图](rpc/convergence.md#项目交付视图d642)（`worker.delivery_graph`） |
| `GET /api/versions?cursor=&limit=` | 用户专属只读 `branch.history`，main 第一父链、固定 tip 分页与精确 Worker/原始指令关联；见 [分支 RPC](rpc/branches.md#branchhistory) |
| `GET /api/version-graph?delivery=&cursor=&limit=` | 用户专属只读 `branch.version_graph`，省略 delivery 读取完整 main 可达图；delivery 为正整数成功交付 Event ID。固定图范围签名分页，未知／重复字段、token、非正整数字段拒绝；沿用登录／Origin／固定项目路由，不接受 POST action，见 [分支 RPC](rpc/branches.md#branchversion_graph) |
| `GET /api/worker/<id>/run-settings` | `worker.run_settings {id}`；显式读取已有有效 Profile，用户专属/no-store，无查询参数，不含连接凭证 |
| `GET /api/agent/config` | `agent.config` |
| `GET /api/agent/status` | 用户专属 `agent.status {}`，version 2 Pi/Codex 软件路径、版本与可用性；显式诊断/刷新时读取，不读取配置/认证、不联网或启动模型，详见 [Agent 状态](rpc/agents.md) |
| `GET /api/agent/selection/resources` | 用户专属 `agent.selection.resources {}`；本地托管 API/模型范围、执行后端能力、余额状态与观测时间，不含秘密、不联网；不接受查询参数 |
| `GET /api/agent/connections` | 用户专属 `agent.connections.list {}`；只读取项目托管连接及缓存，不导入 Pi 登录 |
| `GET /api/agent/connections/history?id=&days=` | 用户专属 `agent.connections.history`；本地连接历史，不访问上游 |
| `GET /api/agent/usage/config` | 用户专属 `agent.usage.config {}`；旧配置只读兼容，页面不调用；旧配置写入明确退役，见 [Agent 状态](rpc/agents.md) |
| `GET /api/agent/usage/history?provider=&account_key=&days=` | 用户专属 `agent.usage.history`，模型来源中的旧历史只读存档；days 为 1/7/30/90，不访问上游、不按旧策略清理记录 |
| `GET /api/agent/models?agent=pi\|codex` | 按需读取所选本机 CLI 当前可用模型目录；失败时带预设与 warning 回退 |
| `GET /api/agent/resources` | 不执行资源代码地读取当前用户和项目已安装的 Pi 扩展、Skills 与 package 资源 |
| `GET /api/agent/network` | 用户专属 `agent.network {}`；项目网络安全投影，不返回代理用户名/密码，不联网，见[出站网络](../engineering/outbound-network.md) |
| `GET /api/agent/environment?target=common\|ROLE` | 按需读取公共或单角色 env 文件，包含明文值；底层 `agent.environment` 为用户专属，公网模式必须先登录，页面默认遮罩 |
| `GET /api/hooks/commands/export` | 用户专属 `hooks.command_export`；仅 id UUID＋version 正整数，返回 `{filename,markdown}`；只读导出单条精确版本的 Skill 风格定义，不安装、不注入 Agent 或赋予调用能力 |
| `GET /api/hooks/commands/executions` | 用户专属 `hooks.command_history`；before 正整数事件游标、limit 1..100、execution_id UUID（与 before 互斥），返回每次运行持久安全摘要；只读不执行命令 |
| `GET /api/branch-integrate-plan?branch=BRANCH` | 用户专属 branch.integrate_plan，只读完整集合预检；[精确参数](rpc/convergence.md#一次性整合) |
| `GET /api/branch-integration?id=ID` | 用户专属 branch.integration，完整操作与固定成员；[精确参数](rpc/convergence.md#一次性整合) |
| `GET /api/branch-convergence[?branch=BRANCH]` | 用户专属历史策略／列表兼容，list 另含 defaults；不安装配置或启动 daemon |
| `GET /api/branch-convergence/defaults` | 用户专属历史默认兼容，无查询参数；不再应用于新 Worker |
| `GET /api/branch-convergence/runs?branch=BRANCH&before=N&limit=N` | 用户专属 `branch.convergence_runs`，branch 必填，before 正整数、limit 默认20/最多50；拒绝额外或重复查询参数，见[分支归并接口](rpc/convergence.md) |
| `GET /api/cli/catalog` | 用户专属只读 `cli.catalog {}`，不接受查询参数；version:1、source:builtin-cli、commands 为完整公开 CLI 层级（path/parent/name/directory/description/format/usage/example/risk/advanced/rpc；format 是默认简要调用格式，usage 含展开的完整选项）。每个 rpc 项的 method/parameters/audience 与审核权限来自注册表及 management-policy；一对多按 CLI 选项或调用阶段说明，不等于赋予整条 CLI／Shell 能力。普通／管理 Agent 均不可调用此新 RPC；管理工具继续用 manager.catalog |
| `GET /api/host/cli/catalog` | 同一代码内置说明，根 Host 只读、登录保护、no-store，无 query，不读取项目设置／凭证，不启动或连接项目 daemon；无当前项目亦可学习 |
| `GET /api/management/permissions` | 用户专属 `management.permissions`，当前项目新旧管家共用的完整权限与审核目录；不接受查询参数。保存经 `management.permissions_update {permissions,expected_revision}`，字段和权限见[管家契约](../engineering/hook-signals-management.md) |
| `GET /api/hooks` | 用户专属 `hooks.list`，节点／动作目录、安全模板、快捷指令目录 commands（无 authorized）、daemon Hooks、时间信号与管理 Worker 投影，不接受查询参数 |
| `GET /api/worker/ID/hooks` | 用户专属 `worker.hooks`，安全挂载、修订与最近收据，不接受查询参数 |
| `GET /api/worker/ID` | `worker.inspect` |
| `GET /api/worker/ID/relations?after=N&limit=N` | 用户专属 `worker.relations`，直接父及直接子节点分页；拒绝未知／重复查询参数，默认 after=0、limit=50，最多200条；[字段协议](rpc/tasks.md#局部-worker-关系) |
| `GET /api/worker/ID/delete-preview` | 用户专属 `worker.delete_preview {id,force?}`，只读完整删除范围和资源清单，仅接受单个 `force=true` 查询参数以强制预检对应残留检出 |
| `GET /api/worker/ID/history?after=N` | `worker.history` |
| `GET /api/worker/ID/history-page?before=N&limit=N` | `worker.history_page` |
| `GET /api/worker/ID/reading-page?before_event=N&before_message=N&limit=N&query=` | 用户专属 `worker.reading_page`，完整 Event／收件箱分批扫描，实际扫描游标、完整正文匹配与明确错误；[字段协议](rpc/tasks.md#输入与结果完整历史读面) |
| `GET /api/worker/ID/reading-record?kind=event\|message&record_id=N&offset=N` | 用户专属 `worker.reading_record`，核验 Worker 归属，每段最多 24,000 UTF-16 字符，next_offset 连读；拒绝未知／重复／token 查询字段 |
| `GET /api/worker/ID/progress-history?before=N&limit=N` | `worker.progress_history`（倒序规划快照，默认10、最多100条） |
| `GET /api/worker/ID/diff` | `worker.diff` |
| `GET /api/worker/ID/code-state?scope=&after=&limit=` | 用户专属 `worker.code_state`，代码净变化与未提交状态分页 |
| `GET /api/worker/ID/code-tree?scope=&path=&query=&changed=&after=&limit=&revision=` | 用户专属 `worker.code_tree`，全项目文件目录/路径筛选分页 |
| `GET /api/worker/ID/code-file?scope=&path=&view=&side=&offset=&limit=&context=&revision=` | 用户专属 `worker.code_file`，固定采样下的正文/逐行差异分段 |
| `GET /api/worker/ID/usage` | `worker.usage` |
| `GET /api/worker/ID/report` | 仅 verifier 的自包含 HTML 检验报告；使用独立 sandbox CSP，非 verifier 返回 404 |
| `GET /api/worker/ID/transcript?after=N` | `worker.transcript` |
| `GET /api/worker/ID/transcript-latest?after=N&before=N&limit=N` | 用户专属 `worker.transcript_latest`，全量扫描的最新优先窗口（默认 0 / 0 / 100） |
| `GET /api/worker/ID/transcript-search?query=&kind=&tool=&errors=&after=&limit=` | 用户专属 `worker.transcript_search`，当前Worker完整记录检索／筛选／分页 |
| `GET /api/worker/ID/transcript-page?seq=1&offset=0` | 用户专属 `worker.transcript_page`，连续完整文字分页 |
| `GET /api/worker/ID/transcript-step?seq=N&offset=0` | 用户专属 `worker.transcript_step`，分段原文、配对及前后上下文 |

完整 Git 分支谱系仅保留 `graph.get` RPC，已移除的 `/api/graph` 不提供 HTTP 兼容入口。

选择快照已停用：`GET /api/notice/ID/snapshot` 返回 404，`notice.rechoose` 不在 action 白名单中；历史问卷回放不变，见[停用说明](../engineering/choice-snapshots.md)。

`/api/showcases` 与历史展示 Worker 的 `/api/worker/ID/report` 均返回 404；不再提供展示资源、预览或动作入口。历史 Worker 仍可经通用Worker读面回看，磁盘报告与历史记录不删除。

执行记录相关游标与界限见[执行记录阅读器](../engineering/transcript-reader.md)。代码读面见[代码阅读器](../engineering/code-reader.md)；Host 仅转发，复用项目身份与登录会话，不在概览后台读取代码。拒绝未知/重复查询字段、任意 cwd/ref 和 Agent token；`changed` 只接受 `true/false`。

## 用户动作

`POST /api/action` 接受 JSON `{method, params}`，只放行 `MUTATIONS`：`agent.configure`、`agent.environment.configure`、`agent.network.configure`、`agent.usage.configure`、`system.configure`、`system.interrupt_all`、`system.resume_all`、`order.submit`、`input.emit`、`input.emission_cancel`、`input.exclusive_release`、`draft.add`、`draft.update`、`draft.remove`、`worker.spawn`、`worker.message`、`worker.rename`、`worker.auto_merge`、`worker.completion`、`worker.acceptance_notice`、`hooks.automation_settings`、`hooks.completion_defaults`、`worker.reserve`、`worker.reserve_all`、`worker.accept`、`worker.reopen`、`worker.sync_parent`、`worker.resolve_sync`、`worker.resolve`、`worker.resolve_divergence`、`worker.unreserve`、`worker.approve_merge`、`worker.cancel`、`worker.retry`、`worker.interrupt`、`worker.resume`、`worker.configure`、`worker.cleanup`、`worker.delete`、`notice.answer`、`notice.dismiss`、`notice.read`、`branch.bind`、`branch.archive`。请求不接受 `_token`，agent 不能借 Web 通道写库。Agent-only `worker.auto_title` 不在 Web 写白名单，页面只读消费生成的 auto_title，用户调整仍经 worker.rename。`agent.usage.configure` 仅保留旧协议接缝，当前明确返回退役错误，不再写入旧配置；正式来源采样仍使用 `agent.connections.sampling`。

账号连接另开放 `agent.connections.save/remove/sampling/query/login.start/login.finish/device.start/device.poll/device.cancel`，均经项目的 `POST /api/action`、登录与 Origin 校验；设备码检查也是显式 action，不新增读取路由。设备授权 ID、OAuth token、回调授权码均不返回读面，不进审计事件或错误。参数和操作见[Agent 账号连接](rpc/agents.md#托管账号连接)。

旧 `intro.*` / `explanation.*` / `quick_explain.*` 全部关闭，不保留快速对话或专用模型配置的兼容入口。

Hooks 另开放 `hooks.save/remove/auto_select/signal_save/signal_remove`、`hooks.command_save/command_remove/command_import`（快捷指令注册、编辑、删除与旧配置显式导入，command_authorize 已删除；手动执行入口已删除，只由 Hook 运行；无 GET 写入口；持久历史只读接口见上表）、`management.permissions_update/create/submit/binding_update`、`worker.hook_attach/hook_update/hook_remove`，均为当前项目用户专属 action；自动选择使用设备策略 revision 和 Host 全局接口；项目未来默认、显示原则及待验收告知使用 hooks.automation_settings／worker.acceptance_notice，旧 hooks.completion_defaults 同源项目策略。精确字段与权限见[项目自动化接口](rpc/hooks.md#新指令默认流程)。

一次性整合通过当前项目 POST /api/action 的 branch.integrate_start／branch.integrate_cancel／branch.integrate_retry，精确参数与 revision 见[整合接口](rpc/convergence.md#一次性整合)。严格 `{method,params}` envelope，禁止 query、多余字段和任何 _token，沿用登录／Origin／项目身份校验。旧 branch.convergence_set／branch.convergence_defaults_set 只返回退休错误；branch.convergence_retry 仅兼容合法旧运行。只读 RPC 不进入 action 白名单，没有 GET 写入口，未知落地不重放。

管理 Agent 的专用 `manager.query/start/retry/catalog/history/call` RPC 不进入 Web 动作白名单；旧 Valet 时间信号／绑定设置 Web 入口已退休，「CLI 接口」仅就地配置当前项目新旧管家的统一权限；用户仍可经既有 CLI／API 保存信号绑定，或主输入「管理 Lush」即时提交 management.submit 新建 Valet，不从 Web 构造管理 Actor。危险请求用用户 Notice 答复固定授权，管理模型和自动选择均不能代签。授权范围见[时间信号与管理契约](../engineering/hook-signals-management.md)。

任何不在上述白名单的写入（含已下线的批量草稿提交、Candidate 验收、托管模式、展示、旧介绍与旧合并入口）都不再提供 Web 操作。
