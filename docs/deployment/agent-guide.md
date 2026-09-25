# Agent 部署指导

本文是**交给 AI coding agent 的部署说明书**：把整篇内容贴给 pi / Codex / Claude Code 等编码 Agent，并说明目标机器就是这台本机，它就能按步骤安装、启动并验证 Lush；人也同样可以照着执行。系统内部设计见[核心架构](../core-architecture.md)，接口细节见[接口参考](../reference/README.md)。

## 目标与约束

- 在这台机器上把 Lush 跑起来，让用户能用浏览器或桌面应用开始工作。
- 默认只在本机安装与运行；除非用户明确要求公网访问，不要改动监听地址、也不要在没有认证的情况下暴露端口。
- 不要替用户提交、stash 或覆盖已有代码改动；所有 Lush 的 Git 写操作由 runtime 串行执行。
- 每一步都要能验证。信息不足或涉及风险时停下来问用户，不要猜测。

## 前置条件

- 操作系统：macOS 或 Linux。
- [Bun](https://bun.sh) 1.2 或更高：`bun --version`。
- Git；被开发的项目必须是 Git worktree 根目录，且至少有一次提交。
- 至少一个已认证的编码 Agent CLI：`pi` 或 `codex`。桌面版另需安装 Electron（见下）。
- 用 Nix 管理环境的机器优先用 Nix 安装上述工具，不要用 `apt` / `brew` / 全局 `npm install`。

## 1. 取得代码并安装

```bash
git clone <lush-repo> && cd lush   # 或直接使用已有的 Lush 检出
bun install                        # 安装依赖；桌面版会安装 Electron
```

## 2. 启动

`start` 只启动某个项目的 daemon；无 `--project` 的 `web` 是全局项目启动器，首次要求选择项目，之后自动恢复并启动或连接对应 daemon。

```bash
bun run start --project /absolute/path/to/my-project   # 只启动项目 daemon
bun run web                                            # 全局 Web 启动器（默认 127.0.0.1:4318）
bun run web 4318 --project /absolute/path/to/my-project # 绑定单项目的 Web
bun run desktop                                        # Electron 桌面版；独立随机端口
```

| 形态 | 适合 | 说明 |
|---|---|---|
| 本地 Web | 日常主工作台 | 浏览器打开 `http://127.0.0.1:4318` |
| 桌面应用 | 想要原生窗口与目录选择器 | 与 Web 复用同一份 UI / API，可与后台 Web 同时运行 |
| 全局启动器 | 本机多个项目来回切换 | 最后项目记在用户配置目录，不写入项目 `.lush/` |
| 命令行 | 脚本化、服务器、无图形环境 | 完整命令见 [CLI 与 RPC](../reference/api.md) |

其余命令（提交输入、查看任务、合并、回收）见 [CLI 与 RPC](../reference/api.md)；当前 say 操作路线见[一条 say 输入如何交付](../task-flow.md)。

## 3. 配置 Agent

默认 Agent 是 `pi`，也支持 `codex`；对应 CLI 必须在 PATH 中可用且已完成认证。

```bash
lush agent show                       # 查看项目默认与各角色的当前配置
lush agent set default --agent pi --model <MODEL> --thinking <LEVEL>
lush agent set worker --agent codex --model <MODEL>
lush agent models pi                  # 读取本机 CLI 当前可用模型目录
lush agent prompt planner             # 查看某角色最终生效的 Prompt 与来源
lush agent init planner               # 创建可提交的 .lush-agent/ 补充文件
lush agent init worker --local        # 创建本机私有的 .lush/agent/ 补充文件
```

- 项目级配置写在 `<project>/.lush/agent.json`：一个 `default` 加 planner / coordinator / worker / research / verifier / merger / showcase / explainer / butler 九类角色覆盖。写入原子替换，运行中的调用不打断，下一次调用生效。
- 角色 Prompt 由内置片段依次叠加 `.lush-agent/common.md`、`.lush-agent/<role>.md`、`.lush/agent/common.md`、`.lush/agent/<role>.md` 与 `append_prompt`。不要用非空 `default_prompt` 覆盖内置协议，除非你完整保留了任务 API、权限与交付流程。
- Agent 子进程环境在 daemon 环境之上热加载 `<project>/.lush/agent/agent.env` 与 `<project>/.lush/agent/<role>.env`，用于代理等个人设置；`LUSH_*` 保留给 runtime，不能覆盖。细节见 [Agent 环境与权限](../reference/agent-environment.md)。

## 4. 远程 / 公网访问

默认只监听 `127.0.0.1`。需要从其它设备访问时，在对应作用域创建 `web.json`（权限必须 `600`）。单项目模式用项目内 `<project>/.lush/web.json`；全局启动器用用户配置目录下的 `web.json`（macOS `~/Library/Application Support/Lush/`，Linux `${XDG_CONFIG_HOME:-~/.config}/lush/`，Windows `%APPDATA%\Lush\`）。

```json
{
  "version": 1,
  "username": "your-name",
  "password": "a-strong-password-at-least-12-characters"
}
```

全局启动器的公网配置还必须用 `projects` 列出允许远程打开的项目绝对路径白名单：

```json
{
  "version": 1,
  "username": "your-name",
  "password": "a-strong-password-at-least-12-characters",
  "projects": ["/absolute/path/to/project"]
}
```

- 首次启动会把明文 `password` 原地替换为 scrypt `password_hash`，之后通过登录页取得 12 小时的 HttpOnly / SameSite 会话 Cookie。密码首尾空白忽略，大小写与中间字符必须一致；连续输错 5 次锁 60 秒。
- 公网部署**必须**置于 HTTPS 反向代理之后，否则登录密码在网络中明文传输。反向代理默认会把 `Host` 改写成 `127.0.0.1:4318`，与浏览器发出的对外 `Origin` 不一致，提交会被当作跨站拒绝。二选一：让代理保留原始 Host（推荐，nginx 用 `proxy_set_header Host $host;`），或在 `web.json` 里登记对外地址 `"origin": "https://lush.example.com"`（多个用 `"origins": [...]`）。
- 删除对应模式的 `web.json` 即恢复仅本机、无需登录的模式。Electron 桌面版始终只监听回环地址，不读取全局公网配置。
- 监听范围、会话与跨站判定的完整安全约束见 [HTTP 与认证](../reference/http.md)。

## 5. 运行配置

环境变量只提供默认值；并发额度可被 `<project>/.lush/settings.json` 覆盖，改后立即生效、不需要重启。

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `LUSH_PROJECT` | 从 cwd 发现 | 显式项目目录；设置后 Web 也进入单项目绑定模式 |
| `LUSH_PROVIDER` | `pi` | 首次未写项目配置时的 Agent：`pi` / `codex`；`mock` 为离线测试模式 |
| `LUSH_CONCURRENCY` | `4` | worker / research / verifier 执行槽的环境默认值 |
| `LUSH_CONTROL_CONCURRENCY` | `2` | planner 等控制面槽的环境默认值，不被执行面占用 |
| `LUSH_CALL_TIMEOUT` | `900` | 单次模型调用超时秒数 |
| `LUSH_TASK_CALLS` | `24` | 单 task invocation 总上限 |
| `LUSH_MAX_DEPTH` | `8` | 任务树最大层数 |
| `LUSH_PI_COMMAND` | `pi` | Pi 可执行文件 |
| `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL` / `LUSH_PI_THINKING` | Pi 默认 | `.lush/agent.json` 不存在时的 Pi 初始选择 |
| `LUSH_CODEX_COMMAND` | `codex` | Codex 可执行文件 |
| `LUSH_CODEX_MODEL` / `LUSH_CODEX_THINKING` | Codex 默认 | `.lush/agent.json` 不存在时的 Codex 初始选择 |

`LUSH_HOME` 不是独立作用域：若保留该变量，必须恰好等于所选项目的 `.lush`，否则拒绝运行。

```bash
lush config                                  # 并发额度：生效值、环境默认值、来源与设置文件
lush config set concurrency 8                # 执行通道并发上限（1..64）
lush config set control-concurrency 4        # 控制通道并发上限（1..16）
lush config reset all                        # 清除覆盖，回到环境默认
```

改 daemon 自身环境变量或运行代码后用 `bun run daemon-restart`，不是再次 `start`。`.lush/agent/*.env` 与 Prompt 文件每次 invocation 前热加载，不需要重启。Web 是独立进程：改完 `src/ui/web/` 用 `bun run web-restart`，否则页面可能加载新资源却打到旧 API 路由。

## 6. 状态目录

```text
<project>/.lush/
├── project.json       不可跨目录复用的项目绑定
├── settings.json      运行设置（并发额度、快速路由前缀）的覆盖；不存在表示全部使用环境默认
├── project.db         SQLite：inputs / drafts / tasks / task_specs / task_deps / agent_runs / artifacts / review_candidates / messages / notices / events / branches
├── sessions/          每个 task 的独立 pi session 与当前输入文件
├── worktrees/         worker 工作区、每条输入的聚合分支检出、检验期间临时对照检出
├── verify/            每个 verifier 的自包含 HTML 检验报告
├── daemon.lock        项目 daemon 单实例锁
└── daemon.log         daemon 日志
```

socket 位于用户私有临时目录，只为通信；持久状态始终在项目内。`.lush/` 不应跨项目复用或删除，也不要让其它程序同时修改正在合并的工作树。

## 7. 安全边界

- 这是**可信用户工具，不是沙箱**。目录绑定隔离的是 Lush 的数据库、RPC、调度和工作区，不是操作系统的文件权限；Agent 的 bash 拥有当前用户权限，角色约束主要依赖 Agent 指令。
- 应审阅改动，不向不可信用户暴露 socket，也不与其他程序并发修改正在合并的工作树。
- 公网 Web 必须启用对应作用域的登录认证并使用 HTTPS，但这仍不把 Agent 或宿主机变成面向恶意用户的安全沙箱。合并与最终接受等用户专属操作不能由普通 Agent 调用绕过。
- daemon 意外被 `SIGKILL` 时可能留下外部进程；恢复不会重放任务，但仍应检查进程与工作区后再重试。

## 8. 验证

```bash
bun run doctor        # 项目 / home / daemon / Web 的代码身份
bun run test          # 完整测试；使用可控的假 Agent，不调用付费模型
bun run docs:check    # 文档结构与相对链接
bun run web-status    # 后台 Web 在不在跑、跑的是不是当前代码、日志在哪
```

`doctor` 发现代码身份不一致时只给出带正确 `--project` 的更新命令，不会自动重启；按提示重启对应进程后再复验。

## 9. 排错速查

| 现象 | 处理 |
|---|---|
| 页面「打开失败」或 API 404 | Web 进程仍是旧代码：`bun run web-restart` |
| daemon 行为与磁盘代码不一致 | `bun run daemon-restart` |
| 改了 `src/ui/web/` 却没生效 | `bun run web-restart`，不是 `bun run web` |
| 不确定当前跑的是谁 | `bun run doctor`（daemon）与 `bun run web-status`（Web） |
| 想离线演示调度 | `LUSH_PROVIDER=mock bun run start --project ...` |

Mock 只派调研任务，不调用模型、不修改代码。
