# Lush

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

Lush 是项目级的多 agent 开发应用。你描述想要的结果，Lush 在独立的 Git 分支与 worktree 里并行拆解、实现与验证，把成果冻结成精确的提交，最后由你明确批准落地。当前输入路径是 **say**：一条输入直连一个拥有独立分支与 worktree 的 AP，它自己判断亲自做还是再派子 AP。旧 Intent / Plan / Candidate 的对外操作已下线；磁盘历史数据、会话与工作区原样保留，不自动迁移或删除。它面向长期维护真实代码库、希望把重复开发真正并行起来的开发者。

Bun 1.2+ / JavaScript / SQLite / Unix socket；daemon 与 CLI 零第三方运行时依赖。支持 macOS 与 Linux。

## 设计理念

### 你描述目标，机器负责拆解

你输入的是目标，不是任务清单。这条目标直接成为一个拥有独立分支与 worktree 的 AP：它先理解现状，再决定亲自完成还是派生并发子 AP；子 AP 完成后由直接父 AP 的 Agent 确认固定提交并快进集成。旧规划链不再创建或调度 AP；现有历史行仍保留在磁盘。

### 输入与 AP 相连：围绕目标，而不是任务清单

每条 say 输入保存原话、引用及其 AP，便于回看目标和结果，而不必从 Git 分支名猜测。当前对外入口只服务 AP 中心工作流。

### 精确的 commit，而不是笼统的“完成了”

新路径的合并请求冻结源 commit 与父分支基线，并在集成或撤销前防止其他 Lush 交付推进父分支；旧路径则使用 Review Candidate 固定 integration commit 与基线。无论哪条路径，你接受或批准的是一个精确 commit，而不是仍会移动的分支名。

### Branch 支撑：Git 只做基础设施

分支与 worktree 负责代码隔离、集成与恢复，退回到基础设施层。每个 worker 有自己干净的工作区和分支；合并默认需要你批准；出现分歧时在子侧解决冲突，并只落地测试过的树。

### 项目级，而不是电脑级

一个 daemon 只绑定一个项目目录，所有事实写入 `<project>/.lush/`；没有跨项目的全局调度器。共享同一份代码仓库的不同项目互不干扰。

### 人类把关：Agent 不是沙箱

目录绑定隔离的是 Lush 的数据库、RPC、调度与工作区，不是操作系统的文件权限。Agent 拥有当前用户的权限，改动需要你审阅。这是可信用户工具，不是面向不可信用户的多用户沙箱。

## 一条输入怎么走

- **发送**：「发送」只提交输入框里这一条，一条输入立即成为一个拥有独立分支与 worktree 的 AP；不走旧草稿、规划或快速路由。
- **静息与唤醒**：Agent 一轮结束后 AP 静息但不终结；新消息、子 AP 结算或用户追加说明会唤醒同一个 AP（用户追加说明时会在本轮工具结束后收口，不打断正在执行的命令）。
- **交付**：AP 可以预约**展示**或**合并请求**（二选一）。合并请求冻结源 commit 与父分支基线并把父分支锁住，直到父 Agent 确认集成或你显式撤销；main 只在你按固定 commit + 基线批准后才前进。`completed` 不等于已合并。
- **提问**：通过 Notice 向用户询问关键决策；补充需求通过 `ap message` 送到现有 AP。

以上是当前输入路径。完整操作过程见[一条 say 输入如何交付](docs/ap-flow.md)；设计边界见[AP 中心输入](docs/engineering/ap-centered-input-design.md)。当前接口白名单及旧数据边界见[核心 API 收敛](docs/engineering/core-api.md)。

## 部署方式

Lush 提供两种图形化使用方式，两者复用同一份 Web UI 与 API：

| 方式 | 适合场景 | 启动 |
|---|---|---|
| 本地 Web | 日常使用的主工作台，用浏览器打开 | 在 Lush 源码目录执行 `bun run web`；首次选择项目，之后新窗口落在上次项目，可同时打开多个项目 |
| 桌面应用 | 更接近原生应用，提供系统目录选择器 | 先 `bun install`，再执行 `bun run desktop` |

两者默认只监听本机。需要从手机或其他设备访问，要在 `web.json` 中配置登录认证并置于 HTTPS 反向代理之后。命令行、远程访问等其它形态属于部署细节，统一收录在次级部署文档中。

## 用 Agent 部署

你不需要自己完成安装、配置与排错。**把 [Agent 部署指导文件](docs/deployment/agent-guide.md) 交给你的 AI coding agent**（pi、Codex、Claude Code 等），它就能完成环境准备、启动 daemon 与 Web / 桌面、配置 Agent、验证安装并给出下一步。

这份指导文件是自包含的：包含前置条件、命令、远程访问与安全边界，人也可以直接照着执行。

## 接下来读什么

- [文档总览](docs/README.md)：完整文档地图与推荐阅读顺序。
- [一条 say 输入如何交付](docs/ap-flow.md)：当前输入与交付流程。
- [AP 中心输入](docs/engineering/ap-centered-input-design.md)：say / 子 AP / 预约的设计边界。
- [核心 API 收敛](docs/engineering/core-api.md)：当前公开接口和旧数据边界。
- [核心架构](docs/core-architecture.md)：AP、Agent 与 Git 交付边界。
