# 用户界面

> 参考层：Lush 的交互入口。业务规则仍在 Core，所有界面通过同一套 JSON-RPC 操作 daemon。

## UI 模块

`src/ui/` 是交互层的统一入口：

- `ui/client.js`：所有 UI 共用的应用客户端。`connectUI(socket, timeout)` 统一装配 transport；`execute(method, params)` 是完整命令网关；daemon 状态、service tree、后台创建根 task、task result 与交互式 session 另有具名工作流。
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

页面提供两项最小能力：

1. 每 2.5 秒刷新 `service.tree`，显示节点状态与正在运行的 agent 数；
2. 选中 active Service、填写 goal，以 `call { detach: true }` 创建并立即启动根 Task，随后轮询 `task.result` 展示结果。

HTTP adapter 的接口是：

| HTTP | 含义 |
| --- | --- |
| `GET /api/tree` | 返回 `{ services }`，数据来自 RPC `service.tree` |
| `POST /api/tasks` | JSON `{ sid, goal }`；后台创建根 Task，成功返回 `202 { task }` |
| `GET /api/tasks/:id` | 返回 `{ task }`，数据来自 RPC `task.result` |

Web UI 只允许绑定 `127.0.0.1` / `::1` / `localhost`，默认固定为 `127.0.0.1`；不提供远程监听开关。写请求要求 `Content-Type: application/json`，API 拒绝跨 Origin 请求，响应带 CSP 等安全头。它仍然继承 Lush 的本地单用户安全模型：不要通过反向代理把它暴露给不可信用户。
