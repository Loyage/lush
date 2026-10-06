# Agent 指导：macOS / Linux 本机部署

本文交给帮助用户部署的 AI coding agent：在用户确认的 macOS / Linux 机器上检查环境、安装、启动并验证 Lush。配套[用户说明](local-deployment.md)解释方案原因与取舍；远程入口另走[Host Agent 指导](remote-host-agent.md)，Windows 本机后台另走[WSL2 指导](windows-wsl2-agent.md)。接口细节见[接口参考](../reference/README.md)。

## 目标与约束

- 在这台机器上把 Lush 跑起来，让用户能用浏览器开始工作。
- 默认只在本机安装与运行；除非用户明确要求公网访问，不要改动监听地址、也不要在没有认证的情况下暴露端口。
- 不要替用户提交、stash 或覆盖已有代码改动；所有 Lush 的 Git 写操作由 runtime 串行执行。
- 每一步都要能验证。信息不足或涉及风险时停下来问用户，不要猜测。
- 先确认目标机器 / 用户、已有 Lush 检出、项目、后端与模型选择，复用现有环境。安装、提权、重启和真实模型调用须用户同意；不复制凭证或把密钥写入仓库 / 报告。
- 项目必须有初始提交；只读检查未提交改动及 Git 姓名 / 邮箱，缺失时询问，不替用户猜身份或初始化提交。默认只做状态验收，不提交指令、不创建 Worker、不调用付费模型。

## 前置条件

- 操作系统：macOS 或 Linux。Windows 本机后台使用 WSL2 Linux，先按[WSL2 环境配置指导](windows-wsl2-agent.md)执行；方案原因见[用户说明](windows-wsl2.md)。
- [Bun](https://bun.sh) 1.2 或更高：`bun --version`。
- Git；被开发的项目必须是 Git worktree 根目录，且至少有一次提交。
- 至少一个已认证的编码 Agent CLI：`pi` 或 `codex`。
- 用 Nix 管理环境的机器优先用 Nix 安装上述工具，不要用 `apt` / `brew` / 全局 `npm install`。

## 1. 取得代码并安装

```bash
git clone <lush-repo> && cd lush   # 用已确认的仓库地址替换；或复用已有检出
bun install --frozen-lockfile     # 在 Lush 源码目录；当前无第三方运行依赖
```

## 2. 启动

下面命令在 Lush 源码目录执行，所有路径和模型占位符必须替换。显式单项目 Host 不启动 daemon，因此先 `start`；不得修改项目绑定变量绕过继承环境冲突。已有服务先检查身份，未经同意不重启或强杀。下面两种 Host 启动命令择一。

`start` 只启动某个项目的 daemon；无 `--project` 的 `host` 是全局多项目工作台，先展示主体，明确打开项目时才启动或连接对应 daemon。每个已打开项目有自己的地址 `/p/<project-id>/`，不同窗口 / 标签各自保持自己的项目；从项目列表移除只隐藏入口并断开 Web 连接，不停止 daemon。

```bash
bun run start --project /absolute/path/to/my-project   # 只启动项目 daemon
bun run lush host start                                 # 全局 Web 启动器（默认 127.0.0.1:4318）
bun run lush host start 4318 --project /absolute/path/to/my-project # 绑定单项目的 Web
```

浏览器默认打开 `http://127.0.0.1:4318`，见[用户说明](local-deployment.md#浏览器与-host)。全局 Host 的 `launcher.json` 只是用户级入口记录，不写入项目 `.lush/`；服务器访问由用户按[Host 指导](remote-host-agent.md)自行配置。

其余命令（提交输入、查看Worker、合并、回收）见 [CLI 与 RPC](../reference/api.md)；当前指令操作路线见[一条指令输入如何交付](../task-flow.md)。

## 3. 配置 Agent

默认 Agent 是 `pi`，也支持 `codex`；对应 CLI 必须在 PATH 中可用且已完成认证。

```bash
bun run lush --project /absolute/path/to/my-project agent show
bun run lush --project /absolute/path/to/my-project agent models pi
# 仅按用户选择配置；后端可选 pi / codex，角色覆盖需复查 show。
bun run lush --project /absolute/path/to/my-project agent set default --agent pi --model <MODEL>
bun run lush --project /absolute/path/to/my-project agent prompt worker
```

- 项目级配置写在 `<project>/.lush/agent.json`：一个 `default` 加 planner / coordinator / worker / research / verifier / merger / explainer / butler 八类角色覆盖。写入原子替换，运行中的调用不打断，下一次调用生效。
- 角色 Prompt 由内置片段依次叠加 `.lush-agent/common.md`、`.lush-agent/<role>.md`、`.lush/agent/common.md`、`.lush/agent/<role>.md` 与 `append_prompt`。不要用非空 `default_prompt` 覆盖内置协议，除非你完整保留了Worker API、权限与交付流程。
- 账号登录/刷新/查询与后续 Agent 的默认网络通过项目[出站网络设置](../engineering/outbound-network.md)配置；只在 Agent env 设置代理不会改变 daemon 的登录网络。不要替用户改整机代理、重启活动服务或把客户端回环地址当作远端地址。
- Agent 子进程环境在 daemon 环境之上热加载 `<project>/.lush/agent/agent.env` 与 `<project>/.lush/agent/<role>.env`，用于代理等个人设置；`LUSH_*` 保留给 runtime，不能覆盖。细节见 [Agent 环境与权限](../reference/agent-environment.md)。

## 4. 远程 / 公网访问

本机部署默认只监听回环。用户需要跨设备访问时，先读[远程 Host 用户说明](remote-host.md)，再按[远程 Host Agent 指导](remote-host-agent.md)自行配置 SSH、IP/端口 HTTP 或域名 HTTPS；认证模板、配置路径与代理步骤只在该指导维护。

注意：创建 `web.json` 会启用认证并使 Host 监听 `0.0.0.0`，启动前必须确认网络暴露范围。HTTP 可用但有明文凭证和会话风险，应警告并推荐 HTTPS 或自建 SSH 隧道。不自动更改现有公网配置；完整安全约束见[HTTP 与认证](../reference/http.md)。

## 5. 运行配置

环境变量只提供默认值；并发额度与调用 / 拆解限额可被 `<project>/.lush/settings.json` 覆盖，改后立即生效、不需要重启。

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `LUSH_PROJECT` | 从 cwd 发现 | 显式项目目录；设置后 Web 也进入单项目绑定模式 |
| `LUSH_PROVIDER` | `pi` | 首次未写项目配置时的 Agent：`pi` / `codex`；`mock` 为离线测试模式 |
| `LUSH_CONCURRENCY` | `8` | worker / research / verifier 执行槽的环境默认值 |
| `LUSH_CONTROL_CONCURRENCY` | `2` | planner 等控制面槽的环境默认值，不被执行面占用 |
| `LUSH_CALL_TIMEOUT` | `10800` | 单次模型调用超时秒数（3 小时） |
| `LUSH_TASK_CALLS` | `24` | 单 Worker invocation 总上限 |
| `LUSH_MAX_DEPTH` | `8` | Worker树最大层数 |
| `LUSH_PI_COMMAND` | `pi` | Pi 可执行文件 |
| `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL` / `LUSH_PI_THINKING` | Pi 默认 | `.lush/agent.json` 不存在时的 Pi 初始选择 |
| `LUSH_CODEX_COMMAND` | `codex` | Codex 可执行文件 |
| `LUSH_CODEX_MODEL` / `LUSH_CODEX_THINKING` | Codex 默认 | `.lush/agent.json` 不存在时的 Codex 初始选择 |

`LUSH_HOME` 不是独立作用域：若保留该变量，必须恰好等于所选项目的 `.lush`，否则拒绝运行。

```bash
bun run lush --project /absolute/path/to/my-project config
# 修改或 reset 配置仅在用户明确要求时执行，完整选项见 CLI 参考。
```

改 daemon 自身环境变量或运行代码后用 `bun run daemon-restart`，不是再次 `start`。`.lush/agent/*.env` 与 Prompt 文件每次 invocation 前热加载，不需要重启。Web 是独立进程：改完 `src/ui/web/` 用 `bun run lush host restart`，否则页面可能加载新资源却打到旧 API 路由。

## 6. 状态目录

```text
<project>/.lush/
├── project.json       不可跨目录复用的项目绑定
├── settings.json      运行设置（并发额度、调用/拆解限额、快速路由前缀）的覆盖；不存在表示全部使用环境默认
├── project.db         SQLite：inputs / drafts / tasks / task_specs / task_deps / agent_runs / artifacts / review_candidates / messages / notices / events / branches
├── sessions/          每个 Worker 的独立 Pi session 与当前输入文件
├── worktrees/         worker 工作区、每条输入的聚合分支检出、检验期间临时对照检出
├── verify/            每个 verifier 的自包含 HTML 检验报告
├── daemon.lock        项目 daemon 单实例锁
└── daemon.log         daemon 日志
```

socket 位于用户私有临时目录，只为通信；持久状态始终在项目内。`.lush/` 不应跨项目复用或删除，也不要让其它程序同时修改正在合并的工作树。

## 7. 安全边界

- 这是**可信用户工具，不是沙箱**。目录绑定隔离的是 Lush 的数据库、RPC、调度和工作区，不是操作系统的文件权限；Agent 的 bash 拥有当前用户权限，角色约束主要依赖 Agent 指令。
- 应审阅改动，不向不可信用户暴露 socket，也不与其他程序并发修改正在合并的工作树。
- 公网 Web 必须启用对应作用域的登录认证；HTTP 允许但有明文风险，推荐 HTTPS。这仍不把 Agent 或宿主机变成面向恶意用户的安全沙箱。合并与最终接受等用户专属操作不能由普通 Agent 调用绕过。
- daemon 意外被 `SIGKILL` 时可能留下外部进程；恢复不会重放Worker，但仍应检查进程与工作区后再重试。

## 8. 验证

```bash
bun run doctor --project /absolute/path/to/my-project       # daemon 代码身份
bun run lush host status --project /absolute/path/to/my-project  # Host 身份与日志
# 以下是需要时在 Lush 源码目录运行的仓库检查，不是 GUI 或模型验收。
bun run test          # 全部现有 Web/core 测试；使用可控假 Agent，不调用付费模型
bun run docs:check
```

`doctor` 发现代码身份不一致时只给出带正确 `--project` 的更新命令，不会自动重启；按提示重启对应进程后再复验。

## 9. 排错速查

| 现象 | 处理 |
|---|---|
| 页面「打开失败」或 API 404 | Web 进程仍是旧代码：`bun run lush host restart` |
| daemon 行为与磁盘代码不一致 | `bun run daemon-restart` |
| 改了 `src/ui/web/` 却没生效 | `bun run lush host restart`，不是 `bun run lush host start` |
| 不确定当前跑的是谁 | `bun run doctor`（daemon）与 `bun run lush host status`（Web） |
| 想离线演示调度 | `LUSH_PROVIDER=mock bun run start --project ...` |

Mock 只派调研Worker，不调用模型、不修改代码。部署验收默认不必启动它。

## 10. 交付结果

交付工具版本、Lush / 项目路径、Agent 配置（无密钥）、页面地址、代码身份、实际验证 / 未验证项、日志与下次启停命令。浏览器项目页面必须实际读取状态；没有 GUI 权限时请用户确认，不以 HTTP 成功替代浏览器验收。失败保留完整日志，断线不自动重发写请求。

仅在用户确认无须保留活动工作后停止入口（`bun run lush host stop`，单项目需带 `--project`）或项目 daemon（`bun run stop --project ...`）；不设置自启、不删除 `.lush/`。Host 与 daemon 更新须分别检查与重启。

---

[← 用户说明](local-deployment.md) · [返回部署索引](README.md)
