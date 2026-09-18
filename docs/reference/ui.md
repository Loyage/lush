# 用户界面

> 参考层：Lush 的交互入口。业务规则仍在 Core，所有界面通过同一套 JSON-RPC 操作 daemon。

## UI 模块

`src/ui/` 是交互层的统一入口：

- `ui/client.js`：所有 UI 共用的应用客户端。`connectUI(socket, timeout)` 统一装配 transport；`execute(method, params)` 是完整命令网关；daemon 状态、service tree、**单节点视图（`serviceView`，默认取 description / templates / prompt 三个 section）**、**提交 intension / intension 列表 / 详情 / 解析器视角的 `intensionContext` / 撤回**、task 列表 / task 树 / **task 调用链** / 取消 / 删除、task result 与交互式 session、**notice 列表 / 详情 / 答复 / 忽略**另有具名工作流。
- `ui/web.js` + `ui/web/`：本地 HTTP 服务与无第三方依赖的静态页面。
- `ui/cli.js`：CLI adapter；`bin/lush` 通过这里进入。参数树解析出 method / params 后统一调用 `UIClient.execute`，session / interactive call 使用同一个客户端的具名工作流；原 `src/cli/` 实现路径继续保留，避免破坏已有导入。
- 未来原生 TUI 应作为另一个 adapter 放在 `src/ui/` 下，并复用 `UIClient`，不直接读取 SQLite、RPC transport 或复制 Core 规则。

层次固定为 `UI adapter → UIClient → request transport（当前是 RPCClient）→ daemon/Core`。界面只负责输入与渲染；Service/Task 校验、并发限制和生命周期错误都由 daemon 的现有 RPC/Core 返回。

## Web UI

Web UI 与 daemon 生命周期完全独立：

```bash
bun run web             # 只启动 Web UI：http://127.0.0.1:4318
bun run web 8080        # 只启动 Web UI，并指定端口
bun run daemon-start    # daemon 需要单独启动
```

`bun run web` 不会启动、停止或重启 daemon。daemon 尚未运行时页面仍可打开并显示离线；daemon 后续启动或重启后，页面会在下一次轮询时自动恢复。

但 `lush-web` 自己也是**版本在启动瞬间冻结**的长驻进程，而且这一条对页面比对 daemon 更严：路由表与 `assets/` 下的页面在**构造时**一起读进内存，并盖上同一个 **UI revision**（`src/ui/**` 的摘要，见 `src/identity.js` 的 `uiRevision()`）。于是「一个进程服务的页面 + 它应答的 API」永远是同一版，不会出现「页面是新版、路由是旧版」的错位（页面逐请求读盘、路由启动时冻结时就会错位：新版页面调用的路由在旧版路由表里不存在，每次点击都是一句没头没脑的 404）。代价是：**改了 `src/ui/**` 必须重启 `lush-web`**（`bun run web`），刷新浏览器没用。

页面在每个 API 请求上带 `X-Lush-UI-Revision` 头。标签页会活得比服务它的进程久（端口被新版本接管后，旧 JS 还在跑），所以发现版本对不上时服务端不再让它一条条撞 404，而是直接回 `409`（`error.code = -32600`、`error.data.reason = "ui_revision_mismatch"`，消息里给出两个 revision 与「reload」），页面据此把顶部状态改成「页面已过期，请刷新」并提示一次。不带这个头的客户端（curl、测试、未来的其他 adapter）按老样子处理。

也可以直接执行：

```bash
LUSH_HOME=/path/to/home LUSH_WEB_PORT=4318 bun ./bin/lush-web
```

页面提供四类视图，侧边栏顶部可切换；右侧主栏只显示当前视图对应的面板，不再与左侧选中无关地堆叠：

1. **服务**（默认）：每 2.5 秒刷新 `service.tree`，显示节点状态与正在运行的 agent 数；右侧显示「说点什么」表单（你的话 + 可选的「目标 Service」提示）与「Service 能力」：选中任一 Service（包括 stopped）后用 `service.view` 显示它的 `description`（能力边界）、可创建的子模板（名称 / singleton / description / construct_prompt 可展开）与 `call_prompt`（在其上创建 Task 时 agent 收到的提示词）。提交走 `intent.submit { content, sid? }`（目标可留空 = 由解析器判断），提交后跳到「输入」视图看它排到哪了。
2. **输入**：你的 intension 队列（`intent.list`，默认只看队列中的，可按状态筛选；标签上的数字是排队中 + 等你裁决的条数）。右侧「输入详情」显示你的原话、指定的 Service（或「由解析器判断」）、解析 task 及其状态、`resolution`（它派了哪些 task / 为什么拒绝）、`response`（解析器给你的结论），以及这条输入相关的 notice（冲突裁决的问与答都在这里）；还没开始解析的可以一键撤回（`intent.withdraw`）。
3. **任务**：展示 `task.list` 返回的 task 森林（同一 service 树的父子关系由 `parent_task_id` 还原，可按「全部 / 根 Task / 子 Task」与状态筛选）。右侧首屏就是选中 Task 的详情：「Task 树」面板用 `task.tree` 显示它的 id / status / goal / 元信息（service、父 Task、创建与结束时间、子树大小）/ result（或 error），以及它派出去的全部子 Task；点击树中任一节点即以它为根重新展开，`↑` 返回上级。详情卡下面还有**调用链**（`task.trace` 的可折叠区块）：把该 task 子树里的派活 / 双向消息 / 结算按时间升序排成一行一步（每步给时间、kind、`#from service[sid] → #to service[sid]` 与 goal / 正文 / 结果；未读输入带「未读」标记），端点上的 `#id` 是按钮，点一下就能跳到那个 task；只取最近的 200 步，被截断时区块顶部会写明总步数。提交表单不占这个视图的首屏：面板右上角的 `＋ 说点什么` 一次点击切回提交表单（并聚焦输入框），选中项在视图之间保留。
4. **Notice**：agent 汇报给用户的消息（标签上的数字是 `open` 条数）。列表可按状态筛选（默认只看未处理），右侧「Notice 详情」显示上报者（task / service / goal）、kind、正文与它声明的表单；`open` 的 notice 可直接填写并提交（`notice.answer`），或忽略并记一个原因（`notice.dismiss`）。已回答 / 已忽略的 notice 只展示结果。列表里标着「等待答复」的 `wait` 项就是那个把某个 task 停在 `awaiting` 的 notice：提交或忽略后，那个 task 会拿到一次新输入并被唤醒。

面板的显示与隐藏一律靠 `hidden` 属性（CSS 里有全局 `[hidden] { display: none !important; }`，否则 `display: grid` 之类的类规则会盖过它），切换视图时页面回到顶部，因此首屏始终是当前视图的内容。

选中 Task 后可以取消或删除它：

- **取消**走 `task.cancel`，会连同整棵子树一起取消并中断正在运行的 agent（活动 Task 可取消）；
- **删除**走 `task.delete { recursive: true }`，只允许删除已结束的 Task，且删除的是整棵子树的记录（messages / agent_calls 作为 service 历史保留）。

两个动作都会弹出确认框。

HTTP adapter 的接口是：

| HTTP | 含义 |
| --- | --- |
| `GET /api/tree` | 返回 `{ services }`，数据来自 RPC `service.tree` |
| `GET /api/services/:sid/view` | 返回 `{ service }`，数据来自 RPC `service.view`，固定请求 `description` / `templates` / `prompt` 三个 section |
| `GET /api/tasks` | 返回 `{ tasks }`；查询参数 `sid` / `status` / `roots=roots\|children` / `limit` 透传给 RPC `task.list` |
| `GET /api/intents` | 返回 `{ intensions }`；查询参数 `status` / `sid`（`none` = 没指定 service）/ `open=1` / `limit` 透传给 RPC `intent.list` |
| `POST /api/intents` | JSON `{ content, sid? }`；提交一条用户输入，返回 `202 { intension }` |
| `GET /api/intents/:id` | 返回 `{ intension }`，数据来自 RPC `intent.inspect`（含解析 task 与相关 notice） |
| `GET /api/intents/:id/context` | 返回 `{ architecture }`，数据来自 RPC `intent.context`（解析器看到的同一份事实） |
| `POST /api/intents/:id/withdraw` | JSON `{ reason?: string }`；撤回还没开始解析的输入，返回 `{ intension }` |
| `GET /api/tasks/:id` | 返回 `{ task }`，数据来自 RPC `task.result` |
| `GET /api/tasks/:id/tree` | 返回 `{ task }`，数据来自 RPC `task.tree`（含 `children` 递归） |
| `GET /api/tasks/:id/trace` | 返回 `{ trace }`，数据来自 RPC `task.trace`；查询参数只有 `limit`（默认 200） |
| `POST /api/tasks/:id/cancel` | 取消该 Task 及其子树，返回 `{ task }`（取消后的 `task.tree`） |
| `POST /api/tasks/:id/delete` | JSON `{ recursive?: boolean }`；删除结果返回 `{ deleted: [task_id...] }` |
| `GET /api/notices` | 返回 `{ notices }`；查询参数 `status` / `task_id` / `sid` / `limit` 透传给 RPC `notice.list` |
| `GET /api/notices/:id` | 返回 `{ notice }`，数据来自 RPC `notice.inspect` |
| `POST /api/notices/:id/answer` | JSON `{ answer: object }`；按声明的 fields 校验后提交，返回 `{ notice }`（已 answered） |
| `POST /api/notices/:id/dismiss` | JSON `{ reason?: string }`；返回 `{ notice }`（已 dismissed） |

Web UI 只允许绑定 `127.0.0.1` / `::1` / `localhost`，默认固定为 `127.0.0.1`；不提供远程监听开关。写请求要求 `Content-Type: application/json`，API 拒绝跨 Origin 请求，响应带 CSP 等安全头。页面上所有 `/api/` 请求都会带 `X-Lush-UI-Revision`（见上）：与当前进程的 UI revision 不一致时一律 `409`（`ui_revision_mismatch`），不会继续路由——旧版页面在新版路由表上不管问什么都只有一个答案：刷新。取消与删除是破坏性动作，沿用 Lush 的本地单用户安全模型：不要通过反向代理把它暴露给不可信用户。
