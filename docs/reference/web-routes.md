# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。代码里的 `CORE_READS`（只读路由白名单）、`CORE_WORKER_READ` / `CORE_DOC_READ`（Worker与文档读取形状）和 `MUTATIONS`（`POST /api/action` 动作白名单）是权威来源；白名单之外的 `/api/**` 一律 404，不再回落到其它项目或旧接口。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理。全局工作台（无 `--project`）为**每个项目**给出一条稳定身份路由 `/p/<project-id>/**`；带 `--project` 的单项目模式固定绑定且拒绝切换，并保留无前缀的兼容路径。

**项目身份来自路由。** 全局模式下页面、读取路由与 `POST /api/action` 都必须走 `/p/<project-id>/`；服务端用不透明 ID 在已登记集合（本地启动器列表或公网 `web.json.projects` 白名单）里反查 canonical 路径，URL 片段永远不会被当作文件路径。无前缀的项目读写一律拒绝并提示刷新，**绝不回退到某个「当前项目」**；未知／已移除的身份返回错误（页面请求回项目列表）。下表在全局模式下均加 `/p/<project-id>` 前缀，单项目模式则用原路径。

## Worker 页面与命名

浏览器的 Worker 详情使用 `#worker-ID`，执行详情仍在详情页显式点击打开，不提供独立 hash；平铺列表使用 `#workers`，父子树使用 `#worker-graph`。HTTP 与 Web 写动作同步使用下文的 `/api/worker/**`、`/api/workers`、`/api/worker-graph` 和 `worker.*`。旧 Task 路由与动作不保留别名；数据字段与历史事件仍可保留 `task`，完整边界见[核心 API 更名说明](../engineering/core-api.md#worker-更名与兼容边界)。

## 宿主级路由

- `GET /`、`/app.js`、`/styles.css`、`/assets/**`：Web 资源（无项目前缀）。全局模式下 `/` 是可在未选项目时使用的完整主体，`#projects` / `#environments` 管理项目与环境；`/p/<id>/` 是该项目的工作台。
- `GET /api/host`：返回 `mode`、上次打开的项目（`last_project` / `last_project_id`）与已登记项目列表（`projects`，含 `connected` / `last`；`mode` 为 `host` 或 `bound`）。只报告上次落点，不因此自动启动或连接任何 daemon。另返回当前服务进程的 `pid` 与 `restart_supported`；嵌入式 Host 不支持进程重启时为 `false`。
- `GET /api/host/projects`：项目列表对已登记目录检查项目 socket，并对可达的 lushd 有界读取 `system.summary`，返回 `running` 与摘要；`connected` 仅表示 Host 已打开连接，二者不是同一状态。读取列表不会启动任何 lushd，未登记项目不会被扫描；单个项目失败只影响自己那一行。
- `POST /api/host/select`：仅全局模式可用，JSON `{project}` 必须是现存目录的绝对路径（公网模式还必须在白名单内）；登记该项目、按需启动 / 连接 daemon，返回该项目稳定路由 ID（`id`）。它不再设置全局「当前项目」，页面归属由前端跳到 `/p/<id>/` 决定。
- `POST /api/host/projects/start` / `stop`：JSON `{id}`，只允许已登记的项目身份。启动是显式操作；停止复用 daemon 的空闲准入并等待退出，不取消 Worker、不强杀；忙碌拒绝。`/api/host` 的 `project_control:true` 宣告支持。项目 API、旧标签轮询、另一个 Host 的附着都不会重新启动已停止的项目。
- `POST /api/host/remove`：仅全局模式可用，JSON `{id}` 只从列表移除入口并断开这个 Web 连接，**不停止 daemon**；停止走上述独立入口。
- `GET /api/docs`、`GET /api/docs/search-index`、`GET /api/docs/<id>`：「文档」视图的目录、搜索索引与 Markdown 正文，读的是随这份代码发布的 `docs/**/*.md` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。搜索索引只在用户第一次搜索时返回标题、小节、正文、普通代码与低权重 Mermaid 字段，匹配和排序在浏览器完成。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；未命中返回 404。

## 环境管理与受管 SSH

`GET /api/environments` 返回服务执行机器/用户、SSH 能力、允许别名和连接记录；`POST /api/environments/ssh/inspect|connect|cancel|disconnect` 的参数、一次性授权、执行位置和公网 `LUSH_SSH_HOSTS` 白名单见[工作台接入契约](../engineering/workbench.md)。这些是入口 Host 级端点，不随当前远程项目前缀改变。

受管环境页面使用 `/e/<environment-id>/` 或 `/e/<environment-id>/p/<project-id>/`，界面资源由入口 Host 提供，已知项目 JSON API 经已连接的受管 SSH 隧道转发。不得代理任意 URL、远端脚本或透传入口 Cookie。HTTPS Host 暂保留独立 origin 的窗口，不通过此隧道代理。

## 服务重启

两个入口必须使用同源、已登录的 JSON `{}` 请求；不得传项目路径、强制停止选项或 Agent token。它们不经过通用 `/api/action`。

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
| `GET /api/workers?scope=&before=&limit=` | `worker.page`，有界Worker分页，`scope` 为 `work` / `all` |
| `GET /api/notices?status=&before=&limit=` | `notice.page`：全部类型事项与处理结果的按需分页；过滤掉旧 `plan` 类型；参数和留档语义见[待决问题](rpc/notices.md) |
| `GET /api/worker-graph` | Worker 父子读面（`worker.graph`） |
| `GET /api/versions?cursor=&limit=` | 用户专属只读 `branch.history`，main 第一父链、固定 tip 分页与精确 Worker/原始指令关联；见 [分支 RPC](rpc/branches.md#branchhistory) |
| `GET /api/agent/config` | `agent.config` |
| `GET /api/agent/status` | 用户专属 `agent.status {}`，当前项目 Pi 安装、模型目录、资源、脱敏账号与可查询余额/额度；仅进入页面和手动刷新时读取，详见 [Agent 状态](rpc/agents.md) |
| `GET /api/agent/connections` | 用户专属 `agent.connections.list {}`；只读取项目托管连接及缓存，不导入 Pi 登录 |
| `GET /api/agent/connections/history?id=&days=` | 用户专属 `agent.connections.history`；本地连接历史，不访问上游 |
| `GET /api/agent/usage/config` | 用户专属 `agent.usage.config {}`；声明式查询模板与采样设置，见 [Agent 状态](rpc/agents.md) |
| `GET /api/agent/usage/history?provider=&account_key=&days=` | 用户专属 `agent.usage.history`，只读本地脱敏缓存；days 为 1/7/30/90，不访问上游 |
| `GET /api/agent/models?agent=pi\|codex` | 按需读取所选本机 CLI 当前可用模型目录；失败时带预设与 warning 回退 |
| `GET /api/agent/resources` | 不执行资源代码地读取当前用户和项目已安装的 Pi 扩展、Skills 与 package 资源 |
| `GET /api/agent/environment?target=common\|ROLE` | 按需读取公共或单角色 env 文件，包含明文值；底层 `agent.environment` 为用户专属，公网模式必须先登录，页面默认遮罩 |
| `GET /api/worker/ID` | `worker.inspect` |
| `GET /api/worker/ID/delete-preview` | 用户专属 `worker.delete_preview {id}`，只读完整删除范围和资源清单，不接受查询参数 |
| `GET /api/worker/ID/history?after=N` | `worker.history` |
| `GET /api/worker/ID/history-page?before=N&limit=N` | `worker.history_page` |
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

`/api/showcases` 与历史展示 Worker 的 `/api/worker/ID/report` 均返回 404；不再提供展示资源、预览或动作入口。历史 Worker 仍可经通用Worker读面回看，磁盘报告与历史记录不删除。

执行记录相关游标与界限见[执行记录阅读器](../engineering/transcript-reader.md)。代码读面见[代码阅读器](../engineering/code-reader.md)；Host 仅转发，复用项目身份与登录会话，不在概览后台读取代码。拒绝未知/重复查询字段、任意 cwd/ref 和 Agent token；`changed` 只接受 `true/false`。

## 用户动作

`POST /api/action` 接受 JSON `{method, params}`，只放行 `MUTATIONS`：`agent.configure`、`agent.environment.configure`、`agent.usage.configure`、`system.configure`、`order.submit`、`draft.add`、`draft.update`、`draft.remove`、`worker.spawn`、`worker.message`、`worker.auto_merge`、`worker.reserve`、`worker.reserve_all`、`worker.accept`、`worker.reopen`、`worker.sync_parent`、`worker.resolve_sync`、`worker.resolve`、`worker.resolve_divergence`、`worker.unreserve`、`worker.approve_merge`、`worker.cancel`、`worker.retry`、`worker.interrupt`、`worker.resume`、`worker.configure`、`worker.cleanup`、`worker.delete`、`notice.answer`、`notice.dismiss`、`notice.read`、`branch.bind`、`branch.archive`。请求不接受 `_token`，agent 不能借 Web 通道写库。

账号连接另开放 `agent.connections.save/remove/sampling/query/login.start/login.finish/device.start/device.poll/device.cancel`，均经项目的 `POST /api/action`、登录与 Origin 校验；设备码检查也是显式 action，不新增读取路由。设备授权 ID、OAuth token、回调授权码均不返回读面，不进审计事件或错误。参数和操作见[Agent 账号连接](rpc/agents.md#托管账号连接)。

任何不在上述白名单的写入（含已下线的批量草稿提交、Candidate 验收、托管模式、展示、介绍与旧合并入口）都不再提供 Web 操作。
