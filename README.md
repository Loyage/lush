# Lush

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

Lush 是项目级的多 agent 开发应用。你描述想要的结果，Lush 在独立的 Git 分支与 worktree 里并行拆解、实现与验证，把成果冻结成精确的提交，最后由你明确批准落地。当前输入路径是 **say**：一条输入直连一个拥有独立分支与 worktree 的 Task，它自己判断亲自做还是再派子 Task。历史 Intent / Plan / Candidate 数据仍可查看并按旧规则安全收尾。它面向长期维护真实代码库、希望把重复开发真正并行起来的开发者。

Bun 1.2+ / JavaScript / SQLite / Unix socket；daemon 与 CLI 零第三方运行时依赖。支持 macOS 与 Linux。

## 设计理念

### 你描述目标，机器负责拆解

你输入的是目标，不是任务清单。这条目标直接成为一个拥有独立分支与 worktree 的 Task：它先理解现状，再决定亲自完成还是派生并发子 Task；子 Task 完成后由直接父 Task 的 Agent 确认固定提交并快进集成。历史路径里的规划 Agent、结构化 Plan 与依赖图仍适用于旧项目，按原规则安全收尾。

### Intent 优先：围绕目标，而不是围绕任务

一次输入连同它的目标分支与整体交付状态一起保存为 Intent。你可以随时回看“我当初想做的是什么”，而不是在一堆任务标题里猜。

### 精确的 commit，而不是笼统的“完成了”

并行成果在私有分支内自动聚合，冻结成 Review Candidate（一份不可变的 integration commit 与基线）；新路径下交付同样冻结源 commit 与父分支基线，并在集成或撤销前不让父分支被别的交付推进。无论哪条路径，你接受或批准的是一个精确 commit，而不是仍会移动的分支名。

### Branch 支撑：Git 只做基础设施

分支与 worktree 负责代码隔离、集成与恢复，退回到基础设施层。每个 worker 有自己干净的工作区和分支；合并默认需要你批准；出现分歧时在子侧解决冲突，并只落地测试过的树。

### 项目级，而不是电脑级

一个 daemon 只绑定一个项目目录，所有事实写入 `<project>/.lush/`；没有跨项目的全局调度器。共享同一份代码仓库的不同项目互不干扰。

### 人类把关：Agent 不是沙箱

目录绑定隔离的是 Lush 的数据库、RPC、调度与工作区，不是操作系统的文件权限。Agent 拥有当前用户的权限，改动需要你审阅。这是可信用户工具，不是面向不可信用户的多用户沙箱。

## 一条输入怎么走

- **缓存与发送**：「存草稿」只写缓存；「发送」只提交输入框里这一条，草稿各自有自己的发送按钮。一条输入立即成为一个拥有独立分支与 worktree 的 Task，不等其它草稿，也不走快速路由前缀。
- **静息与唤醒**：Agent 一轮结束后 Task 静息但不终结；新消息、子任务结算或用户追加说明会唤醒同一个 Task（用户追加说明时会在本轮工具结束后收口，不打断正在执行的命令）。
- **交付**：Task 可以预约**展示**或**合并请求**（二选一）。合并请求冻结源 commit 与父分支基线并把父分支锁住，直到父 Agent 确认集成或你显式撤销；main 只在你按固定 commit + 基线批准后才前进。`completed` 不等于已合并。
- **了解类问题**：对 main/owner 的 `task analyze ID '问题'` 会跑一次只读分析（分离检出、无分支），结论成为该 Task 的结果，不产生待合并改动。

以上是当前输入路径。历史 Intent → Plan → Candidate 链（旧客户端与已存在数据）见[行动任务流程](docs/task-flow.md)；设计取舍与实施进度见 [Task 中心输入架构](docs/engineering/task-centered-input-design.md) 与[分段实施与验收](docs/engineering/task-centered-input-rollout.md)。

## 部署方式

Lush 提供两种图形化使用方式，两者复用同一份 Web UI 与 API：

| 方式 | 适合场景 | 启动 |
|---|---|---|
| 本地 Web | 日常使用的主工作台，用浏览器打开 | 在 Lush 源码目录执行 `bun run web`，首次选择项目后自动恢复 |
| 桌面应用 | 更接近原生应用，提供系统目录选择器 | 先 `bun install`，再执行 `bun run desktop` |

两者默认只监听本机。需要从手机或其他设备访问，要在 `web.json` 中配置登录认证并置于 HTTPS 反向代理之后。命令行、远程访问等其它形态属于部署细节，统一收录在次级部署文档中。

## 用 Agent 部署

你不需要自己完成安装、配置与排错。**把 [Agent 部署指导文件](docs/deployment/agent-guide.md) 交给你的 AI coding agent**（pi、Codex、Claude Code 等），它就能完成环境准备、启动 daemon 与 Web / 桌面、配置 Agent、验证安装并给出下一步。

这份指导文件是自包含的：包含前置条件、命令、远程访问与安全边界，人也可以直接照着执行。

## 接下来读什么

- [文档总览](docs/README.md)：完整文档地图与推荐阅读顺序。
- [Task 中心输入架构](docs/engineering/task-centered-input-design.md)：当前输入路径（say / Task / 预约 / 固定提交批准）的设计与限制。
- [行动任务流程](docs/task-flow.md)：历史 Intent → Plan → Candidate 链（旧客户端与旧数据的安全收尾）。
- [核心架构](docs/core-architecture.md)：四个中心与实体边界。
