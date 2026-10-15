# 模块地图：Runtime 与持久化

本章定位 Agent 调用、Worker 编排、Git 和 SQLite 的长期边界，不重复导出／逐文件清单。公开入口与历史兼容见[核心 API](core-api.md)；参数以源码和[接口参考](../reference/README.md)为准。

> 模块地图：[总览](modules.md) → **Runtime 与持久化** → [Web 前端](modules-web.md) → [CLI、RPC 与测试](modules-interfaces.md)

## 一次性整合与历史归并接缝

自主整合、普通 serial 与历史 v3 的职责定位见[整合 Runtime](merge-convergence-runtime.md)，权限、验证及兼容边界见[实施接缝](merge-convergence-implementation.md)。

## 设备共享配置接缝

`src/core/device-config.js` 负责设备根、私有校验与跨进程锁；技术设置／连接由配置服务读取，项目 wrappers 只转发用户操作。当前有效作用域、偏好、策略和 Host 接入以[用户工作台](user-workspace.md)为准；`device-migration.js` 的显式旧根读取、备份与恢复见[迁移契约](device-settings.md)。项目 Store／Git／会话不共享，旧项目技术文件不能成为生产覆盖旁路。

## 指令类型的只读兼容接缝

`src/core/order-kind.js` 和 Store 行投影统一历史类型读取，SQL 筛选兼容新旧值；不回写已有行、名称或路径。公开命名和保留字段以[核心 API](core-api.md#指令更名与历史读取边界)为权威。

## Agent 运行时接缝

| 入口 | 长期职责 | 必要契约 |
|---|---|---|
| `src/agent/provider.js` | 后端路由、真实调用、输入确认、会话恢复与退出收口 | [invocation](invocation.md)、[双模式](agent-configuration-v2.md) |
| `src/agent/prompts.js`、`capabilities.js` | 必需核心、Prompt 组合与本轮可选能力快照 | [能力](agent-capabilities.md)、[环境](../reference/agent-environment.md) |
| `src/agent/settings.js`、`environment.js`、`private-prompts.js` | 用户配置、字面量 env 与设备私有补充 | [设备配置](user-workspace.md#设备配置分区) |
| `src/agent/connections.js`、`connection-runtime.js`、`src/core/agent-connections.js` | 私有认证、调用绑定、观测与项目历史 | [连接](agent-connections.md)、[模型目录](agent-model-catalog.md)、[设备码](codex-device-login.md) |
| `src/agent/pi-config.js`、`packages.js`、`resources.js`、`models.js` | Lush 隔离基础配置、安装库与只读资源发现 | [双模式与资源](agent-configuration-v2.md) |
| `src/agent/network.js` | 设备网络设置的项目调用快照与脱敏 | [出站网络](outbound-network.md) |
| `src/agent/pi-runtime.js`、`bin/lush-agent-guard` | 可信扩展、安全点与本调用进程树回收 | [Token 与抢占](token-efficiency.md)、[身份恢复](identity-and-recovery.md) |
| `src/agent/fork.js`、`bin/git` | 固定提交对应 Pi 上下文 checkpoint | [创建基线](branch-first.md) |
| `src/core/transcript*.js`、`usage-*.js` | 完整／快速会话读面与用量归因 | [阅读器](transcript-reader.md)、[资源](task-graph.md#累计资源消耗) |
| `src/agent/status*.js`、`src/core/agent-usage.js` | 软件诊断与旧余额只读存档 | [旧状态兼容](agent-usage.md) |

管理调用使用独立会话和可信工具，不 fork 开发上下文或加载开发资源；普通 Provider 描述不能扩大其权限，见[管理隔离](hook-signals-management.md)。

## 运行设置：`src/core/settings.js`

`RuntimeSettings` 负责设备运行参数、默认／覆盖投影、私有原子保存和热更新；键、范围、旧并发值和进度语义见[Agent 环境](../reference/agent-environment.md)，能力启停见[能力契约](agent-capabilities.md)。

## Worker编排：`src/core/project.js` + `src/core/project/`

`Project` 入口装配职责 mixin 并查重，`base.js` 持有共享服务与运行状态。按行为定位源码，不将整个 Project 当成一个可并行修改文件：

| 行为 | 定位入口 | 权威边界 |
|---|---|---|
| 指令创建与父所有者 | `project/order.js` | [Worker 中心输入](task-centered-input-design.md)、[条件发射](conditional-emission.md) |
| Worker、消息与因果上下文 | `project/tasks.js`、`messages.js`、`context.js` | [执行模型](execution-model.md)、[消息准入](../reference/rpc/tasks.md#追加消息的准入与失败处理) |
| 调用准入、退出与恢复 | `project/scheduling.js`、`lifecycle.js` | [invocation](invocation.md)、[不变量](invariants.md)、[身份恢复](identity-and-recovery.md) |
| 串行交付与源侧修复 | `project/merge-queue.js` | [合并协议](merge.md) |
| 验收、迭代与删除 | `project/iteration.js`、`deletion.js` | [统一验收](worker-acceptance.md)、[删除](../reference/rpc/maintenance.md) |
| 维护门与完成信号 | `project/maintenance.js` | [维护](project-maintenance.md)、[中断完成](interrupt-completion.md) |
| 自动化与授权执行 | `project/hooks.js`、`command-hooks.js`、`completion.js` | [Hooks](hooks.md)、[快捷指令](shortcut-commands.md)、[自动链](completion-hooks.md) |
| 管理与时间信号 | `project/management.js`、`hook-signals.js` | [管理契约](hook-signals-management.md) |
| 图、历史与只读统计 | `project/graph.js`、`progress.js`、`transcript.js`、`version-graph.js` | [Worker 图](task-graph.md)、[规划历史](../reference/rpc/tasks.md#规划历史)、[版本图](version-history.md) |

`project/order.js` 是兼容方法装配入口：`order-owner.js` 管理父分支所有者，`order-create.js` 创建指令，`order-reservation.js` 管理预约与准入，`order-divergence.js` 处理源侧分歧，`order-legacy-merge.js` 保留旧协议落地。它们共享 Project 的动态 `this`，不各自建立状态或 Git 锁；当前 v2 交付仍由 `merge-queue.js` 负责。

退休模块仍可能用于历史读取或恢复，不因其存在而开放调用。专用数据退役只走[明确清理范围](project-quick-chat.md)。

## Git 边界：`src/core/workspaces.js` + `src/core/workspaces/`

`Workspaces` 是 Lush Git 变更的唯一串行边界，无 shell 插值；Project 决定授权／生命周期，Git 层复核工作区、固定 ref、CAS 与落地凭据。[Git 边界](git-boundary.md)、[合并协议](merge.md)、[清理](cleanup.md)是安全约束，不由调用方跳过。

- `worktree.js` 创建／持有可信检出；`merge.js` 受检合并与精确落地；`cleanup.js` 安全资源回收。
- `command.js` 只执行用户授权 Hook 的受控命令，非沙箱；未知副作用不重放，见[命令授权](shortcut-commands.md)。
- `ref-guard.js` 观测精确 ref 转移，不以无关成功命令抵消未知移动，见[目标分支检测](target-branch-guard.md)。
- `code*.js` 只读可信路径与对象，POSIX no-follow／FD 边界见[代码阅读器](code-reader.md)；`diff.js` 的诊断协议见[分支参考](../reference/rpc/branches.md#branch-节点的-diagnostics)。
- `deletion.js` 仅在用户固定预检确认后放弃专属现场，不等同于 cleanup／验收，不删除 canonical 或共享检出，见[彻底删除](../reference/rpc/maintenance.md#彻底删除-worker)。

## 持久化：`src/persistence/store.js` + `src/persistence/store/`

`Store` 装配表职责，`schema.js` 维护 DDL、项目绑定与附属技术索引；持久数据是事实来源，Message/Event 不是调度或交付本身。事务只覆盖数据库，Git 副作用由 Workspaces 执行，再以精确收据回写；不能把跨两者操作当成一个 SQLite 事务。

- Worker／依赖／消息／事件分别定位 `store/tasks.js`、`deps.js`、`messages.js`、`events.js`；身份高水位与历史兼容见[核心 API](core-api.md)和[编号](../reference/api.md#用户编号与-cli-身份)。
- `store/reading.js` 实现完整历史扫描／长正文；协议见[Worker 读面](../reference/rpc/tasks.md#输入与结果完整历史读面)。
- Notice 安全投影与增量同步见[全局收件箱](user-workspace.md#全局收件箱分区)，不改写历史 Notice 原行。
- Run／Artifact 保留每次调用身份与结构化证据，缺证据为 unknown，见[Run 参考](../reference/rpc/tasks.md#run-与-artifact)。

---

[← 上一篇：模块地图总览](modules.md) · [下一篇：Web 前端 →](modules-web.md)
