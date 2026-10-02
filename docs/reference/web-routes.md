# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。代码里的 `CORE_READS`（只读路由白名单）、`CORE_TASK_READ` / `CORE_DOC_READ`（任务与文档读取形状）和 `MUTATIONS`（`POST /api/action` 动作白名单）是权威来源；白名单之外的 `/api/**` 一律 404，不再回落到其它项目或旧接口。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理。全局工作台（无 `--project`）为**每个项目**给出一条稳定身份路由 `/p/<project-id>/**`；带 `--project` 的单项目模式固定绑定且拒绝切换，并保留无前缀的兼容路径。

**项目身份来自路由。** 全局模式下页面、读取路由与 `POST /api/action` 都必须走 `/p/<project-id>/`；服务端用不透明 ID 在已登记集合（本地启动器列表或公网 `web.json.projects` 白名单）里反查 canonical 路径，URL 片段永远不会被当作文件路径。无前缀的项目读写一律拒绝并提示刷新，**绝不回退到某个「当前项目」**；未知／已移除的身份返回错误（页面请求回项目列表）。下表在全局模式下均加 `/p/<project-id>` 前缀，单项目模式则用原路径。

## 宿主级路由

- `GET /`、`/app.js`、`/styles.css`、`/assets/**`：Web 资源（无项目前缀）。全局模式下 `/` 是项目启动器与列表，`/p/<id>/` 是该项目的工作台。
- `GET /api/host`：返回 `mode`、上次打开的项目（`last_project` / `last_project_id`）与已登记项目列表（`projects`，含 `connected` / `last`；`mode` 为 `host` 或 `bound`）。只报告上次落点，不因此自动启动或连接任何 daemon。另返回当前服务进程的 `pid` 与 `restart_supported`；嵌入式 Host 不支持进程重启时为 `false`。
- `GET /api/host/projects`：项目列表对已登记目录检查项目 socket，并对可达的 lushd 有界读取 `system.summary`，返回 `running` 与摘要；`connected` 仅表示 Host 已打开连接，二者不是同一状态。读取列表不会启动任何 lushd，未登记项目不会被扫描；单个项目失败只影响自己那一行。
- `POST /api/host/select`：仅全局模式可用，JSON `{project}` 必须是现存目录的绝对路径（公网模式还必须在白名单内）；登记该项目、按需启动 / 连接 daemon，返回该项目稳定路由 ID（`id`）。它不再设置全局「当前项目」，页面归属由前端跳到 `/p/<id>/` 决定。
- `POST /api/host/remove`：仅全局模式可用，JSON `{id}` 只从列表移除入口并断开这个 Web 连接，**不停止 daemon**；停 daemon 仍走显式项目命令。
- `GET /api/docs`、`GET /api/docs/search-index`、`GET /api/docs/<id>`：「文档」视图的目录、搜索索引与 Markdown 正文，读的是随这份代码发布的 `docs/**/*.md` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。搜索索引只在用户第一次搜索时返回标题、小节、正文、普通代码与低权重 Mermaid 字段，匹配和排序在浏览器完成。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；未命中返回 404。

## 服务重启

两个入口必须使用同源、已登录的 JSON `{}` 请求；不得传项目路径、强制停止选项或 Agent token。它们不经过通用 `/api/action`。

- `POST /api/host/restart`：宿主级，无项目前缀；返回 `{restarting:true}` 后当前 Host worker 退出，由它的 supervisor 在原端口启动全新进程，加载磁盘代码。不停止任何项目 daemon。影响连接此 Host 的全部页面，登录会话会清空；前端可有界读取 `/api/host`，等 `pid` 改变或 401 后重新登录。仅通过 `bin/lush-host` 启动的受监督 Host 支持该操作；直接嵌入 `startWeb()` / 直接 CLI 前台调试默认不支持。
- `POST /api/service/restart`：项目级，全局模式必须带 `/p/<project-id>` 前缀。Host 调用用户专属、无参数的 RPC `system.stop_if_idle`；daemon 同步检查 invocation（包括尚未退栈的已停驻调用）、模型调用、排队及执行中的 Git 工作、合并与后台写入，忙碌即拒绝。准入后封闭调度与新 RPC 写入，返回 `{stopping:true}` 并正常退出。Host 等项目锁释放后启动新 daemon，返回 `{restarted:true,project,pid}`；不强杀、不自动重放调用，也不操作其他项目。重复点击会被拒绝；停止/启动超时报错并保留日志，需检查项目 `.lush/daemon.log`。

旧 daemon 不认识 `system.stop_if_idle` 时拒绝操作，不回退到不安全的 `system.stop`。更新本功能时需先通过现有命令行入口加载新 daemon 与 Host。

## 项目读取

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | 兼容快照读面；首页轮询走带 revision 的 `/api/overview` |
| `GET /api/overview?revision=N` | 有界 Task 核心读模型（与 `/api/snapshot` 同源） |
| `GET /api/inputs?cursor=&limit=&q=&status=&integration=` | 用户专属 `input.history`，全项目原始输入与未提交草稿搜索/筛选/分页，见[历史输入接口](../engineering/input-history.md) |
| `GET /api/input/{kind}/{id}` | 用户专属 `input.get`，`kind` 为 `draft` / `input`，完整正文与引用 |
| `GET /api/input-parents` | 用户专属 `input.parents`，完整可选父 Task 读面 |
| `GET /api/tasks?scope=&before=&limit=` | `task.page`，有界任务分页，`scope` 为 `work` / `all` |
| `GET /api/notices?status=&before=&limit=` | `notice.page`：全部类型事项与处理结果的按需分页；过滤掉旧 `plan` 类型；参数和留档语义见[待决问题](rpc/notices.md) |
| `GET /api/graph` | 分支节点、fork 连线实时状态与任务关系（`graph.get`） |
| `GET /api/task-graph` | Task 父子读面（`task.graph`） |
| `GET /api/versions?cursor=&limit=` | 用户专属只读 `branch.history`，main 第一父链、固定 tip 分页与精确 Task/原始 say 关联；见 [分支 RPC](rpc/branches.md#branchhistory) |
| `GET /api/agent/config` | `agent.config` |
| `GET /api/agent/status` | 用户专属 `agent.status {}`，当前项目 Pi 安装、模型目录、资源、脱敏账号与可查询余额/额度；仅进入页面和手动刷新时读取，详见 [Agent 状态](rpc/agents.md) |
| `GET /api/agent/usage/config` | 用户专属 `agent.usage.config {}`；声明式查询模板与采样设置，见 [Agent 状态](rpc/agents.md) |
| `GET /api/agent/usage/history?provider=&account_key=&days=` | 用户专属 `agent.usage.history`，只读本地脱敏缓存；days 为 1/7/30/90，不访问上游 |
| `GET /api/agent/models?agent=pi\|codex` | 按需读取所选本机 CLI 当前可用模型目录；失败时带预设与 warning 回退 |
| `GET /api/agent/resources` | 不执行资源代码地读取当前用户和项目已安装的 Pi 扩展、Skills 与 package 资源 |
| `GET /api/agent/environment?target=common\|ROLE` | 按需读取公共或单角色 env 文件，包含明文值；底层 `agent.environment` 为用户专属，公网模式必须先登录，页面默认遮罩 |
| `GET /api/task/ID` | `task.inspect` |
| `GET /api/task/ID/history?after=N` | `task.history` |
| `GET /api/task/ID/history-page?before=N&limit=N` | `task.history_page` |
| `GET /api/task/ID/diff` | `task.diff` |
| `GET /api/task/ID/code-state?scope=&after=&limit=` | 用户专属 `task.code_state`，代码净变化与未提交状态分页 |
| `GET /api/task/ID/code-tree?scope=&path=&query=&changed=&after=&limit=&revision=` | 用户专属 `task.code_tree`，全项目文件目录/路径筛选分页 |
| `GET /api/task/ID/code-file?scope=&path=&view=&side=&offset=&limit=&context=&revision=` | 用户专属 `task.code_file`，固定采样下的正文/逐行差异分段 |
| `GET /api/task/ID/usage` | `task.usage` |
| `GET /api/task/ID/report` | 仅 verifier 的自包含 HTML 检验报告；使用独立 sandbox CSP，非 verifier 返回 404 |
| `GET /api/task/ID/transcript?after=N` | `task.transcript` |
| `GET /api/task/ID/transcript-latest?after=N&before=N&limit=N` | 用户专属 `task.transcript_latest`，全量扫描的最新优先窗口（默认 0 / 0 / 100） |
| `GET /api/task/ID/transcript-search?query=&kind=&tool=&errors=&after=&limit=` | 用户专属 `task.transcript_search`，当前任务完整记录检索／筛选／分页 |
| `GET /api/task/ID/transcript-page?seq=1&offset=0` | 用户专属 `task.transcript_page`，连续完整文字分页 |
| `GET /api/task/ID/transcript-step?seq=N&offset=0` | 用户专属 `task.transcript_step`，分段原文、配对及前后上下文 |

`/api/showcases` 与历史展示 Task 的 `/api/task/ID/report` 均返回 404；不再提供展示资源、预览或动作入口。历史 Task 仍可经通用任务读面回看，磁盘报告与历史记录不删除。

执行记录相关游标与界限见[执行记录阅读器](../engineering/transcript-reader.md)。代码读面见[代码阅读器](../engineering/code-reader.md)；Host 仅转发，复用项目身份与登录会话，不在概览后台读取代码。拒绝未知/重复查询字段、任意 cwd/ref 和 Agent token；`changed` 只接受 `true/false`。

## 用户动作

`POST /api/action` 接受 JSON `{method, params}`，只放行 `MUTATIONS`：`agent.configure`、`agent.environment.configure`、`agent.usage.configure`、`system.configure`、`say.submit`、`draft.add`、`draft.update`、`draft.remove`、`task.spawn`、`task.message`、`task.auto_merge`、`task.reserve`、`task.reserve_all`、`task.accept`、`task.reopen`、`task.sync_parent`、`task.resolve_sync`、`task.resolve`、`task.resolve_divergence`、`task.unreserve`、`task.approve_merge`、`task.cancel`、`task.retry`、`task.interrupt`、`task.resume`、`task.configure`、`task.cleanup`、`notice.answer`、`notice.dismiss`、`notice.read`、`branch.bind`、`branch.archive`。请求不接受 `_token`，agent 不能借 Web 通道写库。

任何不在上述白名单的写入（含已下线的批量草稿提交、Candidate 验收、托管模式、展示、介绍与旧合并入口）都不再提供 Web 操作。
