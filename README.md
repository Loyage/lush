# Lush

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

Lush 是项目级的多 agent 开发应用。你描述想要的结果，Lush 在独立的 Git 分支与 worktree 里并行拆解、实现与验证，把成果冻结成精确的提交，最后由你明确批准落地。当前输入路径是 **order（指令）**：一条输入直连一个拥有独立分支与 worktree 的 Worker，它自己判断亲自做还是再派子 Worker。旧 Intent / Plan / Candidate 的对外操作已下线；磁盘历史数据、会话与工作区原样保留，不自动迁移或删除。它面向长期维护真实代码库、希望把重复开发真正并行起来的开发者。

Bun 1.2+ / JavaScript / SQLite / Unix socket；daemon 与 CLI 零第三方运行时依赖。后台支持 macOS 与 Linux；Windows 可连接远程 Host，或按[WSL2 方案](docs/deployment/windows-wsl2.md)在本机运行 Linux 后台。客户端安装见[macOS 客户端](docs/deployment/macos-client.md)与[Windows 客户端](docs/deployment/windows-client.md)。

## 设计理念

### 你描述目标，机器负责拆解

你输入的是目标，不是工作清单。这条目标直接成为一个拥有独立分支与 worktree 的 Worker：它先理解现状，再决定亲自完成还是派生并发子 Worker；子 Worker 完成后由直接父 Worker 的 Agent 确认固定提交并快进集成。旧规划链不再创建或调度Worker；现有历史行仍保留在磁盘。

### 输入与 Worker 相连：围绕目标，而不是工作清单

每条指令输入保存原话、引用及其 Worker，便于回看目标和结果，而不必从 Git 分支名猜测。当前对外入口只服务 Worker 中心工作流。

CLI 使用 `lush order '目标'`（源码快捷命令 `bun run order`），RPC / Web 使用 `order.submit`；旧 `say` 入口不保留别名。新 Worker 类型为 `order`，历史 `say` 仅在读取边界兼容为指令，不迁移数据库、分支或工作区。Input、历史输入与暂存的名称不变；详见[指令更名边界](docs/engineering/core-api.md#指令更名与历史读取边界)。

### 精确的 commit，而不是笼统的“完成了”

新路径的合并请求冻结源 commit 与父分支基线，并在集成或撤销前防止其他 Lush 交付推进父分支；旧路径则使用 Review Candidate 固定 integration commit 与基线。无论哪条路径，你接受或批准的是一个精确 commit，而不是仍会移动的分支名。

### Branch 支撑：Git 只做基础设施

分支与 worktree 负责代码隔离、集成与恢复，退回到基础设施层。每个 worker 有自己干净的工作区和分支；合并默认需要你批准；出现分歧时在子侧解决冲突，并只落地测试过的树。

### 三层：Lush UI → Lush Host → lushd

- **Lush UI**：浏览器页面／Electron 窗口，只展示状态和发送带项目身份的请求；没有项目数据库或 Agent 调度器。
- **Lush Host**（`bin/lush-host` / `bun run lush host start`）：本机入口，提供 UI、认证、项目登记、连接与请求转发。一个 Host 可连接多个项目；列表只探测已登记项目的 lushd，打开项目时按需连接或启动。它的 `launcher.json` 仅是界面元数据，不是项目事实来源。
- **lushd**（`bin/lushd`）：每个 canonical 项目目录一个 daemon，独占该项目的 SQLite、RPC、Agent 与 Git 工作区；事实写入 `<project>/.lush/`。CLI `lush` 也是项目客户端，可直接连接 lushd。

Host 不进行跨项目调度。共享同一份 Lush 代码的不同项目互不干扰；项目 API 带 `/p/<project-id>/` 身份，受管 SSH 环境另带 `/e/<environment-id>/` 前缀。主体中的「项目管理」「环境与连接」区分打开窗口、连接环境和启停后台；关闭窗口或断开 SSH 不停止开发。设计与施工边界见[工作台与开发环境](docs/design/workbench.md)及[接入契约](docs/engineering/workbench.md)。

### 人类把关：Agent 不是沙箱

目录绑定隔离的是 Lush 的数据库、RPC、调度与工作区，不是操作系统的文件权限。Agent 拥有当前用户的权限，改动需要你审阅。这是可信用户工具，不是面向不可信用户的多用户沙箱。

## 一条输入怎么走

- **暂存与回看**：Enter 把想法保存到项目缓冲区，Shift+Enter 换行；在「历史输入」中搜索原始指令、编辑暂存并逐条发射。暂存不创建 Worker，也不调用 Agent。见[历史输入与暂存](docs/input-history.md)。
- **发送**：「发送」或 Ctrl/⌘+Enter 只提交输入框里这一条，创建有独立分支与 worktree 的待开始 Worker；Ctrl/⌘+Shift+Enter 创建并立即开始。不走旧 planner 或快速路由。
- **静息与唤醒**：Agent 一轮结束后 Worker 静息但不终结；新消息、子Worker结算或用户追加说明会唤醒同一个 Worker（用户追加说明时会在本轮工具结束后收口，不打断正在执行的命令）。
- **交付**：你直接说的话对应的指令 Worker 默认关闭自动合并，可在开发时勾选「自动合并」（跨轮保留），或在就绪后点击「合并」；Agent 派出的新 child 默认开启且不可关闭自动合并，无需逐个操作。安全点固定源提交后由父 Worker 自有队列的 runtime 串行 Squash，不创建 merge Worker、不改变父子关系，也不额外调用父 Agent。分歧由原 Worker 合入固定父基线，修复期间保留父执行位；挂起后恢复重新排队。无提交的干净 child 直接交付结果等父确认。`completed` 不等于已合并；落地保留分支和工作区，归档仍由你决定。
- **提问**：通过 Notice 向用户询问关键决策；补充需求通过 `worker message` 送到现有 Worker。

以上是当前输入路径。完整操作过程见[一条指令输入如何交付](docs/task-flow.md)；设计边界见[Worker 中心输入](docs/engineering/task-centered-input-design.md)。当前接口白名单及旧数据边界见[核心 API 收敛](docs/engineering/core-api.md)。公开入口现统一为 `lush worker`、RPC `worker.*` 与 Web Worker 路由；这是不保留旧 Task 入口别名的破坏性更名，已有数据不迁移，保留字段与事件见[更名边界](docs/engineering/core-api.md#worker-更名与兼容边界)。

## 部署方式

Lush 提供两种图形化使用方式，两者复用同一份 Web UI 与 API：

| 方式 | 适合场景 | 启动 |
|---|---|---|
| 本地 Web | 日常使用的主工作台，用浏览器打开 | 在 Lush 源码目录执行 `bun run lush host start`；直接进入主体，在项目管理里打开独立项目窗口 |
| 桌面应用 | macOS / Linux 可选择本地目录；Windows 为远程客户端，独立窗口可同时工作 | 源码：准备开发依赖后 `bun run desktop`，SSH 自动部署另需显式[准备运行包](docs/deployment/desktop-build-agent.md)；macOS 安装包携带本机 Bun，Windows 仅远程，见[Mac](docs/deployment/macos-client.md) / [Windows](docs/deployment/windows-client.md)与[远程桌面部署](docs/deployment/remote-desktop.md) |

Host 默认只监听回环。SSH-only Linux 可在本地 Electron 使用[SSH 预检与确认部署](docs/deployment/ssh-desktop.md)，自动建立自有隧道、安装用户私有运行包并打开远端 Host；项目与 Agent 仍在远端。原有认证 HTTPS 和手工隧道见[远程 Host](docs/deployment/remote-host.md)。其它部署形态统一见[用户 / Agent 配套教程索引](docs/deployment/README.md)。

## 部署文档：用户与 Agent 各一份

你不需要自己完成安装、配置与排错。[部署索引](docs/deployment/README.md)按场景提供配套教程：**用户版解释方案和原因，Agent 版负责帮助配置与验收。** 覆盖 macOS/Linux 本机、远程 Host、桌面 SSH 首次部署、远程桌面、Windows 客户端和 WSL2。

本机部署先读[用户说明](docs/deployment/local-deployment.md)，再把[Agent 指导](docs/deployment/agent-guide.md)交给你的 coding agent（pi、Codex、Claude Code 等），并说明目标机器与项目；Windows 同机后台先读[WSL2 用户说明](docs/deployment/windows-wsl2.md)。部署 Agent 应先检查现状、询问未知选择，再安装与验证，不默认迁移项目、开放公网或调用付费模型。

## 接下来读什么

- [文档总览](docs/README.md)：完整文档地图与推荐阅读顺序。
- [一条指令输入如何交付](docs/task-flow.md)：当前输入与交付流程。
- [Worker 中心输入](docs/engineering/task-centered-input-design.md)：指令 / 子Worker / 预约的设计边界。
- [核心 API 收敛](docs/engineering/core-api.md)：当前公开接口和旧数据边界。
- [核心架构](docs/core-architecture.md)：Worker、Agent 与 Git 交付边界。
