# Lush

**Operating System for AI — AI 的操作系统，而不是 AI Operating System。**

Lush 把 AI 工作组织成持久化的逻辑 Process。每个 Process 有自己的 Agent、Context、状态、生命周期和父子关系。PID 0 代表 Lush 自身。它不是 Unix 进程管理器，也不是模型供应商的 CLI 包装器。

## MVP 范围

Bun 1.2+ / JavaScript (ESM) / `bun:sqlite` / Unix Domain Socket / JSON-RPC 2.0；**没有任何第三方依赖**，不用 Nix、不用 Python、不需要 `bun install`。支持 macOS 和 Linux。CLI 和 Agent Tools 调用同一套 Core API。

```bash
# 仓库开发模式，无需安装：CLI 与 daemon 都用 bun 直接运行
export PATH="$PWD/bin:$PATH"
export LUSH_HOME="${TMPDIR:-/tmp}/lush-demo-$USER"
export LUSH_PROVIDER=mock
lush daemon start
lush status
lush tree
lush spawn 0 generic-service --name project-manager
lush spawn 1 generic-task --name implement-login --goal '实现登录功能'
lush call 2 '请介绍一下你当前的身份和任务'
lush attach 2
# 输入 /exit 或 Ctrl-D 退出；不会停止 Process
lush call 1 '创建一个子任务，研究 OAuth 登录实现方式'
lush tree
lush inspect 2
lush daemon stop
lush daemon start
lush tree  # 树、Context、对话和调用历史仍在
lush daemon stop
```

也可通过 `bun run bin/lush`（或 `bun run bin/lushd` 前台运行 daemon）调用；`bun link` 之后 `lush` / `lushd` 会进入 PATH。

## 常用命令（Justfile）

```bash
just                 # 列出全部命令
just doctor          # 工具链 / 数据目录 / daemon 状态
just test            # bun test（just test openai 可按文件名过滤）
just demo            # 完整 CLI / daemon 演示
just verify          # test + demo

just daemon-start    # 起 daemon（幂等）
just bootstrap       # 起 daemon 并创建 project-manager → implement-login
just tree | just ps | just status
just spawn 0 generic-task implement-login '实现登录功能'
just call 2 '请介绍一下你自己'
just attach 2
just inspect 2       # just history 2 0 50
just stop 1 | just kill 2 | just reclaim 2
just daemon-stop     # 或 just daemon-restart（保留进程树与历史）
just log             # tail $LUSH_HOME/daemon.log
just clean           # 停 daemon 并删除仓库内的 .lush
```

`just` 默认把开发数据放在仓库内的 `.lush/`（已 gitignore），不碰你日常的 `~/.local/state/lush`；用 `LUSH_HOME` 可覆盖（此时 `just clean` 只提示、不删除仓库外的目录）。

## Provider

默认 `LUSH_PROVIDER=mock`：确定性架构演示，不是真实语言模型。支持身份查询、中文/英文创建子任务请求，以及显式工具指令：

```bash
lush call 1 '/tool process.spawn {"template":"research-task","name":"research-oauth","goal":"研究 OAuth 登录实现方式"}'
lush call 2 '/tool process.update_state {"patch":{"progress":"designing"}}'
lush call 2 '/tool process.complete {"result":"done"}'
```

真实模型使用 OpenAI-style Chat Completions（多轮 tool calling）：

```bash
export LUSH_PROVIDER=openai
export LUSH_API_KEY='...'
export LUSH_BASE_URL='https://api.openai.com/v1'
export LUSH_MODEL='your-model'
lush daemon start
```

环境变量由 **daemon 启动时** 读取，切换需重启。API key 不写入数据库。请求走 Bun 的 `fetch`，自动遵循标准代理环境变量（`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`）；本机 loopback base URL 会把 loopback 主机名补进 `NO_PROXY`，保证本地模型直连。拒绝 HTTP 重定向以避免转发 API key。调用带 `AbortSignal`，取消后不再执行工具或写入结果；daemon 退出时不会等待网络请求自然结束。不自动重试有副作用的 Agent 调用。不支持流式输出。Mock 的自然语言识别只是演示规则，真实 Agent 能力取决于模型。

## 文档

- [总体架构](docs/architecture.md)
- [Process 模型及生命周期](docs/process-model.md)
- [RPC / CLI 协议](docs/rpc.md)
- [开发任务](docs/tasks.md)

## 验证

```bash
just verify   # = bun test（35 项）+ bun run demo
bun test      # 只跑测试
bun run demo  # 只跑演示
```

数据默认保存在 `$XDG_STATE_HOME/lush` 或 `~/.local/state/lush`，可用 `LUSH_HOME` 覆盖。包含 SQLite 数据库、socket、daemon 锁及日志。目录仅限当前用户访问。模板内置于 `src/templates/builtin/`；`$LUSH_HOME/templates/*.json` 可增加新模板，不覆盖内置模板；重启后加载。

**生命周期提示：** spawn 自动进入 running；一次 call 返回不等于 Task 完成。完成的 Task 不再接受 call/attach；可通过 inspect 查看历史。stop 仅用于 Service，kill 停止 Service / 取消 Task。父进程结束时，活动直接子节点改挂 PID 0，自己的后代不变。`reclaim` 仅标记结束的 Task 为 reclaimed，历史不删除。PID 0 只能通过停止 daemon 退出。

本地单用户 MVP：没有 ACL、沙箱、自动调度、自动任务恢复、向量数据库或 Web UI。内置工具仅管理 Lush，不包含 shell、文件编辑或联网搜索；coding/research 模板并不自动提供这些外部能力。不要向不可信用户暴露 socket；Agent 可以调用其他 Process，因此工具调用不是安全隔离边界。
