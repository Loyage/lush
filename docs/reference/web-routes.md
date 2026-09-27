# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。代码里的 `CORE_READS`（只读路由白名单）、`CORE_AP_READ` / `CORE_DOC_READ`（AP 与文档读取形状）和 `MUTATIONS`（`POST /api/action` 动作白名单）是权威来源；白名单之外的 `/api/**` 一律 404，不再回落到其它项目或旧接口。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理。全局工作台（无 `--project`）为**每个项目**给出一条稳定身份路由 `/p/<project-id>/**`；带 `--project` 的单项目模式固定绑定且拒绝切换，并保留无前缀的兼容路径。

**项目身份来自路由。** 全局模式下页面、读取路由与 `POST /api/action` 都必须走 `/p/<project-id>/`；服务端用不透明 ID 在已登记集合（本地启动器列表或公网 `web.json.projects` 白名单）里反查 canonical 路径，URL 片段永远不会被当作文件路径。无前缀的项目读写一律拒绝并提示刷新，**绝不回退到某个「当前项目」**；未知／已移除的身份返回错误（页面请求回项目列表）。下表在全局模式下均加 `/p/<project-id>` 前缀，单项目模式则用原路径。

## 宿主级路由

- `GET /`、`/app.js`、`/styles.css`、`/assets/**`：Web 资源（无项目前缀）。全局模式下 `/` 是项目启动器与列表，`/p/<id>/` 是该项目的工作台。
- `GET /api/host`：返回 `mode`、上次打开的项目（`last_project` / `last_project_id`）与已登记项目列表（`projects`，含 `connected` / `last`；`mode` 为 `host` 或 `bound`）。只报告上次落点，不因此自动启动或连接任何 daemon。
- `GET /api/host/projects`：项目列表对已登记目录检查项目 socket，并对可达的 lushd 有界读取 `system.summary`，返回 `running` 与摘要；`connected` 仅表示 Host 已打开连接，二者不是同一状态。读取列表不会启动任何 lushd，未登记项目不会被扫描；单个项目失败只影响自己那一行。
- `POST /api/host/select`：仅全局模式可用，JSON `{project}` 必须是现存目录的绝对路径（公网模式还必须在白名单内）；登记该项目、按需启动 / 连接 daemon，返回该项目稳定路由 ID（`id`）。它不再设置全局「当前项目」，页面归属由前端跳到 `/p/<id>/` 决定。
- `POST /api/host/remove`：仅全局模式可用，JSON `{id}` 只从列表移除入口并断开这个 Web 连接，**不停止 daemon**；停 daemon 仍走显式项目命令。
- `GET /api/docs`、`GET /api/docs/search-index`、`GET /api/docs/<id>`：「文档」视图的目录、搜索索引与 Markdown 正文，读的是随这份代码发布的 `docs/**/*.md` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。搜索索引只在用户第一次搜索时返回标题、小节、正文、普通代码与低权重 Mermaid 字段，匹配和排序在浏览器完成。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；未命中返回 404。

## 项目读取

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | 兼容快照读面；首页轮询走带 revision 的 `/api/overview` |
| `GET /api/overview?revision=N` | 有界 AP 核心读模型（与 `/api/snapshot` 同源） |
| `GET /api/aps?scope=&before=&limit=` | `ap.page`，有界 AP 分页，`scope` 为 `work` / `all` |
| `GET /api/notices?status=&before=&limit=` | `notice.page`：全部类型事项与处理结果的按需分页；过滤掉旧 `plan` 类型；参数和留档语义见[待决问题](rpc/notices.md) |
| `GET /api/graph` | 分支节点、fork 连线实时状态与 AP 关系（`graph.get`） |
| `GET /api/ap-graph` | AP 父子读面（`ap.graph`） |
| `GET /api/agent/config` | `agent.config` |
| `GET /api/agent/models?agent=pi\|codex` | 按需读取所选本机 CLI 当前可用模型目录；失败时带预设与 warning 回退 |
| `GET /api/agent/resources` | 不执行资源代码地读取当前用户和项目已安装的 Pi 扩展、Skills 与 package 资源 |
| `GET /api/agent/environment?target=common\|ROLE` | 按需读取公共或单角色 env 文件，包含明文值；底层 `agent.environment` 为用户专属，公网模式必须先登录，页面默认遮罩 |
| `GET /api/ap/ID` | `ap.inspect` |
| `GET /api/ap/ID/history?after=N` | `ap.history` |
| `GET /api/ap/ID/history-page?before=N&limit=N` | `ap.history_page` |
| `GET /api/ap/ID/diff` | `ap.diff` |
| `GET /api/ap/ID/usage` | `ap.usage` |
| `GET /api/ap/ID/transcript?after=N` | `ap.transcript` |
| `GET /api/ap/ID/transcript-latest?after=N&before=N&limit=N` | 用户专属 `ap.transcript_latest`，全量扫描的最新优先窗口（默认 0 / 0 / 100） |
| `GET /api/ap/ID/transcript-search?query=&kind=&tool=&errors=&after=&limit=` | 用户专属 `ap.transcript_search`，当前 AP 完整记录检索／筛选／分页 |
| `GET /api/ap/ID/transcript-page?seq=1&offset=0` | 用户专属 `ap.transcript_page`，连续完整文字分页 |
| `GET /api/ap/ID/transcript-step?seq=N&offset=0` | 用户专属 `ap.transcript_step`，分段原文、配对及前后上下文 |

执行记录相关游标与界限见[执行记录阅读器](../engineering/transcript-reader.md)。

## 用户动作

`POST /api/action` 接受 JSON `{method, params}`，只放行 `MUTATIONS`：`agent.configure`、`agent.environment.configure`、`system.configure`、`say.submit`、`ap.spawn`、`ap.message`、`ap.reserve`、`ap.resolve`、`ap.resolve_divergence`、`ap.unreserve`、`ap.approve_merge`、`ap.cancel`、`ap.retry`、`ap.cleanup`、`notice.answer`、`notice.dismiss`、`branch.bind`、`branch.archive`。请求不接受 `_token`，agent 不能借 Web 通道写库。

任何不在上述白名单的写入（含已下线的草稿、Candidate 验收、托管模式、展示、介绍与旧合并入口）都不再提供 Web 操作。
