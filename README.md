# LushCode

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

LushCode 是项目名，软件名称为 Lush，以代码开发为中心。管理命令为 `lush`，Worker 协作命令为 `lushw`，后台服务为 `lushd`；`.lush`、`LUSH_*` 及既有数据命名保持不变。

Lush 是项目级的多 agent 开发应用。你描述目标，一个 Worker 在独立 Git 分支与 worktree 中理解、实现和验证；需要时再派并行子 Worker。你审阅成果，决定合并与验收。它面向长期维护真实代码库、希望把重复开发真正并行起来的开发者。

Bun 1.2+ / JavaScript / SQLite / Unix socket；daemon 与 CLI 零第三方运行时依赖。后台支持 macOS/Linux，使用浏览器访问。Windows 可连接服务器 Host，或运行[WSL2 后台](docs/deployment/windows-wsl2.md)。

## 设计理念

### 你描述目标，机器负责拆解

一条 order（指令）对应一个拥有独立工作区的 Worker，由它决定亲自完成还是委派，不要求你先写工作清单。

### 输入与 Worker 相连：围绕目标，而不是工作清单

原话、引用、各轮输入与结果关联保存，便于回看目标，不必从分支名猜测。管理 CLI 使用 `lush order '目标'`，源码统一使用 `bun run lush …`（不保留业务快捷包装）；开发协作使用绑定当前 invocation 的 `lushw self/parent/children`，例如 `bun run lushw self show` 查看自身、`bun run lushw children message W5-1 '补充说明'` 给直接 child 追加要求。项目级查询与管理统一使用 `lush`，入口名称不替代身份授权，见[CLI 分区](docs/reference/api.md#开发与管理双入口)。

### 精确的 commit，而不是笼统的“完成了”

交付固定源成果和本次父基线，落地与测试结论分别记录；“调用结束”“已合并”“已验收”不是同一件事。

### Branch 支撑：Git 只做基础设施

worktree 隔离并行开发，源侧修复保留固定提交与现场，不在父分支留下未经验证的冲突。具体[交付协议](docs/engineering/merge.md)与[安全边界](docs/engineering/git-boundary.md)不由界面状态替代。

### 三层：Lush UI → Lush Host → lushd

浏览器展示并发送带项目身份的请求；Host 负责登录、登记、设备设置和来源转发；每 canonical 项目一个 lushd 持有 SQLite、Worker、调度和 Git 事实。Host 不跨项目调度。项目独立浏览器标签，关闭页面不停止后台，见[核心架构](docs/core-architecture.md)。

### 一次配置，同设备项目复用

技术配置和偏好设备唯一，Worker 可保存完整显式运行参数，项目数据与执行仍隔离。旧项目配置只[显式预检迁移](docs/device-settings.md)，不自动覆盖。全局可选择[Agent 能力](docs/agent-capabilities.md)，关闭不等于撤销权限或中断已有工作。

### 人类把关：Agent 不是沙箱

项目绑定隔离 Lush 的事实与工作区，不隔离操作系统权限；Agent 使用当前用户权限。这是可信用户工具，不是多用户沙箱。

## 一条输入怎么走

主输入可暂存、条件发射或仅创建 Worker；明确的管理输入使用隔离管理能力。Agent 等待消息或决定时静息，下一轮继续同一 Worker。关键选择由 Notice 提问，补充需求追加给现有 Worker。

指令默认由你请求合并或启用自动合并；派生 child 默认自动交付，父 runtime 在安全点串行处理。合并后保留现场供继续开发；**验收即归档**，安全回收开发资源、保留历史，脏现场和未处理需求阻止验收。完整操作见[指令流程](docs/task-flow.md)和[历史输入与暂存](docs/input-history.md)，不需要逐个操作 child。

## 部署方式

在 LushCode 源码目录执行 `bun run lush host start`，浏览器打开工作台，再登记／打开项目。Host 本机也必须登录；缺少对应 `web.json` 时拒绝启动，无默认账号。v2 默认回环，公网需显式授权与项目白名单。

远程 Host、SSH 转发、域名、证书和防火墙由用户配置，Lush 不管理隧道。HTTP 会暴露明文传输风险，推荐 HTTPS 或用户自建 SSH 隧道。安装、认证与验证步骤见[部署索引](docs/deployment/README.md)。

## 部署文档：用户与 Agent 各一份

[部署索引](docs/deployment/README.md)按本机、远程、WSL2 提供配套说明：用户版解释方案，Agent 版指导检查、配置与验收。未知选择先确认，不默认迁移、开放公网或调用付费模型。

## 接下来读什么

- [文档总览](docs/README.md)：按问题找入口，不要求顺序通读。
- [指令流程](docs/task-flow.md)：创建、追加、交付与验收。
- [接口参考](docs/reference/README.md)：CLI、RPC 与 HTTP。
- [核心 API 与历史兼容](docs/engineering/core-api.md)：当前公开入口、退休能力和数据保护。
- [贡献指南](docs/contributing/README.md)：验证责任与文档维护。
