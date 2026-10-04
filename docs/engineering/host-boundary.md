# Lush 三层边界

```mermaid
flowchart LR
  UI["Lush UI：浏览器 / Electron"] -->|"/api/host 或 /p/id/api/*"| Host["Lush Host：每台设备的入口"]
  CLI["lush CLI"] -->|"项目 RPC"| D1
  Host -->|"项目 Unix socket / RPC"| D1["lushd：项目 A"]
  Host -->|"项目 Unix socket / RPC"| D2["lushd：项目 B"]
  D1 --> A["A/.lush/ + Git"]
  D2 --> B["B/.lush/ + Git"]
```

启动与环境管理遵循[工作台设计](../design/workbench.md)和[接入契约](workbench.md)：主体先于项目启动，每个项目独立窗口，Web SSH 在服务用户侧执行。无项目/离线状态不阻塞管理、界面设置与文档；关闭窗口和断开 SSH 不停止任务。

- **UI**（`src/ui/web/assets/`、`src/ui/desktop/`）：不读取本机 socket、项目数据库或 Git。项目操作必须使用当前页面 `/p/<id>/` 的身份；Web 受管 SSH 另带 `/e/<environment-id>/` 前缀，不能省略或回落本地；宿主级列表和文档不带项目身份。
- **Host**（`bin/lush-host`、`src/host/`、HTTP 适配器 `src/ui/web/server.js`）：处理浏览器认证、项目登记、路由、连接缓存和有界状态读取。`GET /api/host/projects` 只检查已登记目录对应的 socket，不启动 daemon；显式选择/启动项目时才按需启动；项目 API 附着不会启动 daemon，避免旧标签页轮询撤销停止操作。`launcher.json` 是界面缓存，不是Worker数据库。桌面本地工作窗口共享该桌面进程持有的临时 Host；远程工作窗口直接访问远端 Host，关闭窗口不停止任何项目 lushd。本地 Electron → 远程 Host → 远程项目 lushd 的接入方式见[远程桌面部署](../deployment/remote-desktop.md)。
- **lushd**（`bin/lushd`、`src/daemon/`、`src/core/`、`src/persistence/`、`src/rpc/`）：一项目一进程，绑定 canonical 路径，事实仅在 `<project>/.lush/`，执行 Agent 与项目内调度。Host 不复制事实、不做跨项目调度。UI 当前通过有界轮询读取项目消息与状态，Host 只把响应转交相应页面；尚无后台推送通道。CLI `lush` 也可直接通过项目 socket 访问 lushd。

对外入口：`bun run lush host start|stop|restart|status`，`bun run lush-host`（前台），以及原有项目端 `bun run start|daemon-restart|stop`。原 `web*` 命令、`bin/lush-web`、`/api/launcher*` 已移除；原有 `launcher.json` 和 `web.json` 留在原用户配置目录，不迁移或清除项目数据。运行中的旧 Host 不会自动换代码：确认没有需要保留的登录会话后重启 Host；项目代码变化还需分别重启相应 lushd。
