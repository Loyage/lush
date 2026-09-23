# Lush 开发约定

Lush 是**项目级的多 agent 开发应用**。Bun / JavaScript / SQLite；daemon 与 CLI 零第三方运行时依赖。Web 文档视图内置固定版本的 Mermaid 浏览器资源，仅在文档含图时按需加载。

## 作用域

- 一个 daemon 对应一个 canonical 项目目录，状态固定在 `<project>/.lush/`。
- CLI 项目命令默认向上发现 `.lush/project.json` 或 `.git`；用 `--project PATH` 显式选择项目。Web 四条命令无 `--project` / `LUSH_PROJECT` 时进入全局项目启动器。
- `LUSH_PROJECT` 会传入 agent 子进程，agent 在独立 worktree 中仍连接原项目。
- `LUSH_HOME` 不许指向独立的全局目录；非空时必须等于 `<project>/.lush`。
- 实体只有 Input / Task / Agent / Message / Notice / Event。不要引入电脑级调度。

## 命令一律走 bun run

```bash
bun run doctor                  # 首先确认项目 / home / daemon 的代码身份
bun run test
bun run start                   # 只启动所选项目；已有 daemon 不会换版本
bun run daemon-restart          # 运行代码、提示词或配置变更后重启
bun run say '输入'              # 立即提交单条输入，不等开发完成
bun run draft add '输入'        # 只写缓存，不规划；按回车逐条攒
bun run drafts                  # 看缓存里有什么
bun run draft commit            # 缓存整体交给一个 planner：拆任务 + 建依赖
bun run tree
bun run inspect 3
bun run web                     # 后台启动全局 Web 项目选择器；自动恢复上次项目并启动/连接 daemon
bun run web --project PATH      # 兼容的单项目 Web；日志在该项目 .lush/web.log
bun run desktop                 # Electron 桌面版；独立随机端口，可与 Web 同时打开
bun run web-status              # 在不在跑、跑的是不是这份代码、日志在哪
bun run web-restart             # 改完 src/ui/web/ 停掉那个后台 Web 再按当前代码起一个新的
bun run web-stop                # 停掉后台 Web（只停命令行确实是 Lush Web 的进程）
bun run stop
```

任意入口可加 `--project PATH`；操作其他项目时必须显式指定。`bun run lush <command>` 也遵循同一套项目发现规则，没有默认全局 home 的例外。

**daemon 与 web 是两个独立进程，改完代码两个都要重启。** 无 `--project` 的 Web/桌面启动器会在选定项目后自动启动或连接 daemon；显式 `--project` 的单项目 Web 不替用户启动 daemon。`bun run daemon-restart` 只管当前项目 daemon；`bun run web` 后台起的 Web 进程自己活到被杀为止，不会跟着 daemon 换版本。只重启 daemon 就去刷新页面，会看到旧 Web 进程把**新的** `app.js` 发下来、却对自己不认识的 API 路由（例如后来才加的 `/api/docs`）回 404——页面直接「打开失败」。改 `src/ui/web/` 下任何东西之后，先 `bun run web-restart` 再看页面：它停掉端口上那个后台 Web（只认命令行确实是 Lush Web 的进程）再按当前代码起一个新的；直接再跑 `bun run web` 只会幂等报告「已在运行」。重启 Web 会清空登录会话，浏览器要重新登录一次；跑的是不是这份代码用 `bun run web-status` 看（它比的是 Web 自己记下的代码指纹），不用靠猜。`bun run doctor` 只校验 daemon 的 fingerprint，报的是 daemon 的身份，不会告诉你 Web 是不是旧进程。

不要在开发测试时默认操纵用户正在开发的项目。测试用临时项目目录和 mock/可控子进程；测试结束停 daemon 并清理自己的临时文件。

## 安全与持久化

- Git 操作通过 `src/core/workspaces.js`，无 shell 插值，所有 Lush Git 变更串行。
- 每个 worker 独立 worktree / 分支；默认必须由用户明确批准合并。
- 不强制 reset / clean / 删除工作区，不自动提交用户已有改动。失败工作区也有价值。
- `completed` 不等于 `merged`。保留独立的任务状态与 integration 状态。
- Task 的父子关系创建后不变；终态 task 不允许活动后代。依赖边（`task_deps`）只在 spawn 时写入，之后不可变。
- 依赖只做结构校验（自依赖、祖先、悬空 id、多 code 边、非 worker 上游）；语义冲突由 planner 判断，拿不准就问用户。
- 输入分 `develop` / `explain` 两类（`inputs.flow`，未判定按 develop）：explain 输入不得派生 worker/coordinator（`Project.spawn` 硬校验），因此了解类输入不产生 worktree 与待合并改动；改判只影响之后的 spawn。
- `code` 依赖把上游分支当作下游 worktree 的基线，所以合并必须上游先行；`task merge` 会拒绝越级。
- 输入缓存在 `drafts` 表：草稿可在提交前删除，提交后行保留并回写 `input_id`；已提交的输入永不删除。
- Agent 等待子任务或用户时释放 invocation 槽；新输入有独立规划槽。
- Task 与 agent 是终身一对一的身份（`<role>#<id>`），但凭证只代表一次 invocation：库里只存 SHA-256，`actor()` 必须同时校验 hash 命中与「仍在 running 且未被 abort」。不要把 token 改成终身有效，否则上一轮逃逸的后台进程会重新变成合法 actor。
- 消息只在 invocation 之间送达。注意「父任务刚 park、子任务刚完成、running Map 还未清理」之间的 lost-wakeup 竞态。
- 重启不自动重放有未知副作用的调用；不迁移、不覆盖磁盘上已有的数据。

## 模块

修改模块前必须先读 `docs/design/README.md` 中的对应设计理念；执行记录、工具渲染、检索与选区解释必须先读 `docs/design/agent-process.md`。理念指导取舍，模块地图规定职责与接口，不得只看功能清单而忽略用户目标。

- `src/config.js`：项目发现与不可变绑定。
- `src/persistence/store.js`：SQLite 事实来源。
- `src/core/project.js`：任务树、消息、notice、调度与生命周期。
- `src/core/workspaces.js`：Git 工作区、人工批准合并、安全清理。
- `src/agent/`：共享指令、pi 与 mock 后端。
- `src/rpc/` / `src/daemon/`：通信、装配、锁与退出。
- `src/ui/client.js`：CLI / Web 的统一客户端。
- `src/cli/` / `src/ui/web/`：用户界面。

上面是粗粒度分区；每个文件负责什么、导出什么、哪个分区可以并行改，权威入口只有 `docs/engineering/modules.md`，细表按它链接的 Runtime、Web、CLI / RPC / 测试短章维护。

`src/identity.js` 的 fingerprint 覆盖整个 src、bin 和 package.json。相同路径但 fingerprint 不同表示 daemon 仍运行旧代码；重启正确项目才生效。

更多见 `README.md` 与 `docs/README.md`；文档格式、分层、链接与 Mermaid 约定见 `docs/contributing/documentation.md`。
