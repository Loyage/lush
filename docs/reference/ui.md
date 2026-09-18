# 用户界面

> 参考层：Lush 的交互入口。业务规则仍在 Core，所有界面通过同一套 JSON-RPC 操作 daemon。

## UI 模块

`src/ui/` 是交互层的统一入口：

- `ui/client.js`：所有 UI 共用的应用客户端。`connectUI(socket, timeout)` 统一装配 transport；`execute(method, params)` 是完整命令网关；daemon 状态、service tree、后台创建根 task、task 列表 / task 树 / 取消 / 删除、task result 与交互式 session 另有具名工作流。
- `ui/web.js` + `ui/web/`：本地 HTTP 服务与无第三方依赖的静态页面。
- `ui/cli.js`：CLI adapter；`bin/lush` 通过这里进入。参数树解析出 method / params 后统一调用 `UIClient.execute`，session / interactive call 使用同一个客户端的具名工作流；原 `src/cli/` 实现路径继续保留，避免破坏已有导入。
- 未来原生 TUI 应作为另一个 adapter 放在 `src/ui/` 下，并复用 `UIClient`，不直接读取 SQLite、RPC transport 或复制 Core 规则。

层次固定为 `UI adapter → UIClient → request transport（当前是 RPCClient）→ daemon/Core`。界面只负责输入与渲染；Service/Task 校验、并发限制和生命周期错误都由 daemon 的现有 RPC/Core 返回。

## Web UI

Web UI 与 daemon 生命周期完全独立：

```bash
just web             # 只启动 Web UI：http://127.0.0.1:4318
just web 8080        # 只启动 Web UI，并指定端口
just daemon-start    # daemon 需要单独启动
```

`just web` 不会启动、停止或重启 daemon。daemon 尚未运行时页面仍可打开并显示离线；daemon 后续启动或重启后，页面会在下一次轮询时自动恢复。

也可以直接执行：

```bash
LUSH_HOME=/path/to/home LUSH_WEB_PORT=4318 bun ./bin/lush-web
```

页面提供两类视图，侧边栏顶部可切换：

1. **服务**（默认）：每 2.5 秒刷新 `service.tree`，显示节点状态与正在运行的 agent 数；选中 active Service 后可在右侧「创建 Task」填写 goal，以 `call { detach: true }` 创建并立即启动根 Task。
2. **任务**：展示 `task.list` 返回的 task 森林（同一 service 树的父子关系由 `parent_task_id` 还原，可按「全部 / 根 Task / 子 Task」与状态筛选）。选中任一 Task 后，右侧「Task 树」用 `task.tree` 显示它不仅包含自己、还包含它派出去的全部子 Task；点击树中任一节点即以它为根重新展开，`↑` 返回上级。

选中 Task 后可以取消或删除它：

- **取消**走 `task.cancel`，会连同整棵子树一起取消并中断正在运行的 agent（活动 Task 可取消）；
- **删除**走 `task.delete { recursive: true }`，只允许删除已结束的 Task，且删除的是整棵子树的记录（messages / agent_calls 作为 service 历史保留）。

两个动作都会弹出确认框。

HTTP adapter 的接口是：

| HTTP | 含义 |
| --- | --- |
| `GET /api/tree` | 返回 `{ services }`，数据来自 RPC `service.tree` |
| `GET /api/tasks` | 返回 `{ tasks }`；查询参数 `sid` / `status` / `roots=roots\|children` / `limit` 透传给 RPC `task.list` |
| `POST /api/tasks` | JSON `{ sid, goal }`；后台创建根 Task，成功返回 `202 { task }` |
| `GET /api/tasks/:id` | 返回 `{ task }`，数据来自 RPC `task.result` |
| `GET /api/tasks/:id/tree` | 返回 `{ task }`，数据来自 RPC `task.tree`（含 `children` 递归） |
| `POST /api/tasks/:id/cancel` | 取消该 Task 及其子树，返回 `{ task }`（取消后的 `task.tree`） |
| `POST /api/tasks/:id/delete` | JSON `{ recursive?: boolean }`；删除结果返回 `{ deleted: [task_id...] }` |

Web UI 只允许绑定 `127.0.0.1` / `::1` / `localhost`，默认固定为 `127.0.0.1`；不提供远程监听开关。写请求要求 `Content-Type: application/json`，API 拒绝跨 Origin 请求，响应带 CSP 等安全头。取消与删除是破坏性动作，沿用 Lush 的本地单用户安全模型：不要通过反向代理把它暴露给不可信用户。
