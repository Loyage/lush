# Lush 开发约定

Lush 是**项目级的多 agent 开发应用**。Bun / JavaScript / SQLite；daemon 与 CLI 零第三方运行时依赖。Web 文档视图内置固定版本的 Mermaid 浏览器资源，仅在文档含图时按需加载。

## 作用域

- Lush UI（浏览器/桌面）↔ 整机入口 Lush Host（`bin/lush-host`）↔ 每项目一个 lushd（`bin/lushd`）。Host 只登记、鉴权、路由及转发，不持有Worker事实；一个 lushd 对应一个 canonical 项目目录，状态固定在 `<project>/.lush/`。
- CLI 项目命令默认向上发现 `.lush/project.json` 或 `.git`；用 `--project PATH` 显式选择项目。Web 四条命令无 `--project` / `LUSH_PROJECT` 时进入全局工作台；未选择项目时管理、设置与帮助仍可用。
- `LUSH_PROJECT` 会传入 agent 子进程，agent 在独立 worktree 中仍连接原项目。
- `LUSH_HOME` 不许指向独立的全局目录；非空时必须等于 `<project>/.lush`。
- 实体只有 Input / Worker / Agent / Message / Notice / Event。不要引入电脑级调度。
- 公开入口全面使用 Worker：CLI `lush worker`、RPC `worker.*`、HTTP `/api/worker/<id>` / `/api/workers` / `/api/worker-graph`，不留旧 Task 别名。存储字段、事件、环境变量与内部路径的保留边界以 `docs/engineering/core-api.md` 为准，不做数据迁移或机械改名。

用户提交统一称 order（指令）：CLI `lush order`、RPC/Web `order.submit`、快捷命令 `bun run order`；旧 say 公开入口无别名。新记录 `task_kind='order'`，历史 `task_kind='say'` 只在读取/类型判定边界兼容，不迁移已有行、分支/worktree 或会话；Input、历史输入、暂存仍保持独立名称。权威边界见 `docs/engineering/core-api.md`。

## 命令一律走 bun run

```bash
bun run doctor                  # 首先确认项目 / home / daemon 的代码身份
bun run test
bun run start                   # 只启动所选项目；已有 daemon 不会换版本
bun run daemon-restart          # 运行代码、提示词或配置变更后重启
bun run order '输入'              # 立即提交单条输入，不等开发完成
# Web 主输入 Enter 暂存；“历史输入”编辑/逐条发射。旧 draft CLI 不再注册。
bun run tree
bun run inspect 3
bun run lush host start [--project PATH] # 后台启动 Web 工作台；显式打开项目才启动/连接 daemon
bun run desktop                 # 源码 Electron；本地独立随机端口，SSH 缺包只给准备提示
bun run desktop:prepare DIR     # 显式导入可信同检出 Linux 双架构 CI 包；替换旧生成物需 --replace
bun run lush host status         # 在不在跑、跑的是不是这份代码、日志在哪
bun run lush host restart        # 改完 src/ui/web/ 停掉那个后台 Web 再按当前代码起一个新的
bun run lush host stop           # 停掉后台 Web（只停命令行确实是 Lush Web 的进程）
bun run stop
```

任意入口可加 `--project PATH`；操作其他项目时必须显式指定。`bun run lush <command>` 也遵循同一套项目发现规则，没有默认全局 home 的例外。

**lushd 与 Lush Host 是两个独立进程，改完两端代码两个都要重启。** 无 `--project` 的 Web/桌面启动器会在选定项目后自动启动或连接 daemon；显式 `--project` 的单项目 Web 不替用户启动 daemon。`bun run daemon-restart` 只管当前项目 daemon；`bun run lush host start` 后台起的 Web 进程自己活到被杀为止，不会跟着 daemon 换版本。只重启 daemon 就去刷新页面，会看到旧 Web 进程把**新的** `app.js` 发下来、却对自己不认识的 API 路由（例如后来才加的 `/api/docs`）回 404——页面直接「打开失败」。改 `src/ui/web/` 下任何东西之后，先 `bun run lush host restart` 再看页面：它停掉端口上那个后台 Web（只认命令行确实是 Lush Web 的进程）再按当前代码起一个新的；直接再跑 `bun run lush host start` 只会幂等报告「已在运行」。重启 Web 会清空登录会话，浏览器要重新登录一次；跑的是不是这份代码用 `bun run lush host status` 看（它比的是 Web 自己记下的代码指纹），不用靠猜。`bun run doctor` 只校验 daemon 的 fingerprint，报的是 daemon 的身份，不会告诉你 Web 是不是旧进程。

跑测试时，若测试彼此独立且不会争用共享状态、端口或其他资源，尽量并行运行以缩短等待；有依赖或资源冲突时再串行执行。不要在开发测试时默认操纵用户正在开发的项目。测试用临时项目目录和 mock/可控子进程；测试结束停 daemon 并清理自己的临时文件。

## 安全与持久化

- Git 操作通过 `src/core/workspaces.js`，无 shell 插值，所有 Lush Git 变更串行。
- 每个 worker 独立 worktree / 分支；历史 worker 的合并仍由用户批准。新式 指令/child 的 version 2 交付由父 Worker 自有队列的 runtime 串行 Squash（含 main），不额外调用父 Agent。指令默认关闭自动合并，由用户开启 hook 或显式请求；新 child 默认开启且锁定。分歧由原 Worker 在源侧吸收固定父基线，修复期间保留父执行位；挂起释放，恢复重新排队并固定新基线。落地后待验收，分支/worktree 保留，验收与显式归档分开。
- 不强制 reset / clean / 删除工作区，不自动提交用户已有改动。失败工作区也有价值。
- `completed` 不等于 `merged`。保留独立的Worker状态与 integration 状态。
- 新 Worker 父子关系创建后始终保持委派关系；当前 version 2 交付不创建 merge Worker、不改源 Worker 的 `parent_id`。持久预约是交付事实，Message/Event 仅通知；按入队顺序、代码依赖优先，取得父执行位后才固定尝试基线。旧 version 1 语义不改；旧 version 2 merge 身份和在途重挂只凭明确预约/审计恢复原父，不猜身份、不删历史。终态 Worker 不允许活动后代。依赖边（`task_deps`）只在 spawn 时写入，之后不可变。
- 依赖只做结构校验（自依赖、祖先、悬空 id、多 code 边、非 worker 上游）；语义冲突由 planner 判断，拿不准就问用户。
- 输入分 `develop` / `explain` 两类（`inputs.flow`，未判定按 develop）：explain 输入不得派生 worker/coordinator（`Project.spawn` 硬校验），因此了解类输入不产生 worktree 与待合并改动；改判只影响之后的 spawn。
- `code` 依赖把上游分支当作下游 worktree 的基线，所以合并必须上游先行；当前交付队列也不得越级。
- 输入缓存在 `drafts` 表：草稿可在提交前删除，提交后行保留并回写 `input_id`；已提交的输入默认不可改写或删除。仅用户基于资源预检明确确认 `worker.delete` 时，随终态子树清除无剩余使用者的 Input 与已发射 Draft；活动调用、共享资源与外部依赖保护，ID 不复用。
- Agent 等待子Worker或用户时释放 invocation 槽；新输入有独立规划槽。
- Worker 与 agent 是终身一对一的身份（`<role>#<id>`），但凭证只代表一次 invocation：库里只存 SHA-256，`actor()` 必须同时校验 hash 命中与「仍在 running 且未被 abort」。不要把 token 改成终身有效，否则上一轮逃逸的后台进程会重新变成合法 actor。
- 消息只在 invocation 之间送达。注意「父Worker刚 park、子Worker刚完成、running Map 还未清理」之间的 lost-wakeup 竞态。
- 重启不自动重放有未知副作用的调用；不迁移、不覆盖磁盘上已有的数据。

## 模块

修改模块前必须先读 `docs/design/README.md` 中的对应设计理念；执行记录、工具渲染、检索与选区解释必须先读 `docs/design/agent-process.md`；引用、选区引用、引用卡片定位与快照/现状取舍必须先读 `docs/design/references.md`；改 Web 按钮文案、图标、样式，或新增会调用 Agent 的按钮前，必须先读 `docs/design/ui-guidance.md`——所有会调用 Agent 的按钮必须带 `agent-call` 紫色标识与 `agentHelp` 提示，含义不直观的按钮必须带 `data-help`，禁用按钮用外层 `.help-host` 承载。修改输入框、暂存、历史输入检索与状态投影前，必须先读 `docs/design/input-history.md`。修改通知、告知设置、已读与滑动消除交互前，必须先读 `docs/design/notices.md`。理念指导取舍，模块地图规定职责与接口，不得只看功能清单而忽略用户目标。

修改账号连接、凭证托管、余额/套餐观测、显式连接绑定与被动响应反馈前，先读 `docs/design/account-resources.md`；字段与模块边界见 `docs/engineering/agent-connections.md`，旧状态/历史兼容见 `docs/engineering/agent-usage.md`。私有权限不是沙箱，不得把凭证或原始认证响应放进读 API、会话或错误。

修改启动、项目入口、环境管理前，先读 `docs/design/workbench.md` 与 `docs/engineering/workbench.md`：每项目独立窗口，Web SSH 在服务所在机器执行，关闭/断开不停止任务；项目 API 附着只读，不能由旧页轮询自动启动已停止后台。

桌面 SSH 接入、部署脚本和远端产物修改前，先读 `docs/design/remote-ssh.md`；使用与构建边界见 `docs/deployment/ssh-desktop.md`、`ssh-desktop-agent.md` 和 `desktop-build-agent.md`。Mac / Windows 发行携带双架构 Linux 包，源码开发显式导入，不在启动时静默下载；macOS 安装包另携带本机私有 Bun / 后台，Windows 不启动本机后台。真实回环 SSH 验证不等于跨机器、ARM64、Electron 或 Windows 发布验收。

- `src/config.js`：项目发现与不可变绑定。
- `src/persistence/store.js`：SQLite 事实来源。
- `src/core/project.js`：Worker树、消息、notice、调度与生命周期。
- `src/core/workspaces.js`：Git 工作区、人工批准合并、安全清理。
- `src/agent/`：共享指令、pi 与 mock 后端。
- `src/rpc/` / `src/daemon/`：通信、装配、锁与退出。
- `src/ui/client.js`：CLI / Host 连接 lushd 的统一客户端。
- `src/host/`：整机 Host 的登记、连接和进程生命周期。
- `src/cli/` / `src/ui/web/`：命令行和浏览器界面；Web server 是 Host 的 HTTP 适配器。

上面是粗粒度分区；每个文件负责什么、导出什么、哪个分区可以并行改，权威入口只有 `docs/engineering/modules.md`，细表按它链接的 Runtime、Web、CLI / RPC / 测试短章维护。

`src/identity.js` 的 fingerprint 覆盖整个 src、bin 和 package.json。相同路径但 fingerprint 不同表示 daemon 仍运行旧代码；重启正确项目才生效。

更多见 `README.md` 与 `docs/README.md`；文档格式、分层、链接与 Mermaid 约定见 `docs/contributing/documentation.md`。
