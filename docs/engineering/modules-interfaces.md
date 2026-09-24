# 模块地图：CLI、RPC 与测试

本章列出命令行、RPC 分派与测试文件边界；这些接缝连接 runtime 与外部调用方。

> 模块地图：[总览](modules.md) → [Runtime 与持久化](modules-runtime.md) → [Web 前端](modules-web.md) → **CLI、RPC 与测试**

## CLI：`src/cli/main.js` + `src/cli/`

命令处理器的统一签名：`export async function run(command, args, ctx)`，
其中 `ctx = { client, json }`；返回 `undefined` 表示「已经自己打印过，主流程不要再 print」。
`option` / `exact` / `print` 从 `args.js` 直接 import。

| 文件 | 命令 | 导出 |
|---|---|---|
| `cli/help.js` | 帮助文本 | `HELP` |
| `cli/args.js` | 参数解析与两种输出 | `option`、`exact`、`print` |
| `cli/print.js` | 树 / 阶梯 / 时间轴 / 合并 / 会话 / 用量 / 分支谱系的渲染 | `printTree`、`printLadder`、`printTimeline`、`printMergeMany`、`printTranscript`、`transcriptStepText`、`printUsage`、`printBranchTree`、`printBranchShow`、`printBranchImport`、`printBranchArchive` |
| `cli/commands/intent.js` | `say` / `intent` / `input` | `run` |
| `cli/commands/draft.js` | `draft` | `run` |
| `cli/commands/task.js` | `task` | `run`、`followTranscript`、`FOLLOW_INTERVAL_MS` |
| `cli/commands/progress.js` | `progress plan KEY[:LABEL]...` / `progress complete KEY`（只写当前 agent task） | `run` |
| `cli/commands/spec.js` | `spec` | `run` |
| `cli/commands/plan.js` | `plan` | `run` |
| `cli/commands/notice.js` | `notice` | `run` |
| `cli/commands/branch.js` | `branch`（tree / show / import / merge / sync / catchup / archive / summary） | `run` |
| `cli/commands/system.js` | `daemon` / `status` / `doctor` / `log` / `web` / `web-restart` / `web-stop` / `web-status`；Web 无 `--project` 时使用全局项目启动器，显式项目时保持单项目模式；`doctor` / `web-status` 分列磁盘、daemon、Web 身份并只给显式更新提示 | `run` |
| `cli/commands/showcase.js` | `showcase start/list/stop/preview`，preview 文件含 argv 数组 `command` 和可选 URL `path` | `run` |
| `cli/commands/candidate.js` | `candidate list/inspect/prepare/verify/accept/changes/reject` | `run` |
| `cli/commands/agent.js` | `agent show/models/set/reset` 配置 profile；`prompt/env` 查看最终组合和环境来源，`init` 创建共享/本机补充；`--prompt` 只作旧版 `--append-prompt` 别名 | `run` |
| `cli/commands/sleep.js` | `auto-manage on/off/status/resume/choices`（旧别名 `sleep`）：风险警告、显式 scope 与确认、项目管家状态及预算/选择历史 | `run` |
| `cli/commands/config.js` | `config`（`show` / `set concurrency|control-concurrency N` / `reset [concurrency|control-concurrency|all]`）：读 `system.status.settings`、写 `system.configure`；用户专属，agent 调用被拒 | `run` |
| `cli/main.js` | 全局参数、命令分发表、fingerprint 提醒；任意位置出现独立的 `--help` / `-h` 先打印帮助并返回（不构造 Config / client、不发 RPC）；仅 Web 四条命令允许在无项目配置下进入 launcher config | `main(argv)`（并 re-export `HELP`） |

## RPC：`src/rpc/protocol.js` + `src/rpc/`

处理器的统一签名：`(project, params, actor) => result | Promise<result>`。

| 文件 | 职责 | 导出 |
|---|---|---|
| `rpc/protocol.js` | framing（编码、解析、帧上限）；并 re-export `Dispatcher` 保持旧 import 可用 | `MAX_FRAME`、`encode`、`errorResponse`、`parseRequest`、`Dispatcher` |
| `rpc/registry.js` | 方法白名单、参数白名单、权限集合与统一校验 | `PARAMS`、`USER_ONLY`、`AGENT_ONLY`、`assertAllowed(method, params, actor)` |
| `rpc/handlers/system.js` | 用户专属 `sleep.start/stop/resume/status/choices`；`system.*`（兼容完整 `system.status`、首页走持久 revision/索引聚合且无 Agent 全配置的 `system.summary`、用户专属的 `system.configure` 与只读 `system.usage`）、`graph.get`、Agent 配置与资源接口；环境文件的 `agent.environment` / `agent.environment.configure` 因可能含密钥，读写都为用户专属 | `handlers` |
| `rpc/handlers/input.js` | `input.*`、`draft.*` | `handlers` |
| `rpc/handlers/task.js` | `task.*`（`task.retry(id,profile?)` 可带仅本轮生效的完整 Agent Profile；旧 `task.list/history` 保留；新增 `task.activity`、`task.page`、`task.history_page` 有界读接口，以及用户专属的 `task.transcript_search` / `task.transcript_step` / `task.transcript_page` / `task.transcript_latest`）、用户专属 `explanation.start/list/get` 与 `intro.start/list/get/config/configure`、agent-only 的 `progress.plan` / `progress.complete` | `handlers` |
| `rpc/handlers/spec.js` | `spec.*`、`plan.*` | `handlers` |
| `rpc/handlers/notice.js` | `notice.*` | `handlers` |
| `rpc/handlers/branch.js` | `branch.tree/show/import/merge/sync/archive/summary`（`branch.archive` 参数 `branch` / `discard`，在 `USER_ONLY`；`branch.summary` 参数 `branch` / `summary`，agent 可写、省略 branch 时写自己的分支，用户必须显式点名） | `handlers` |
| `rpc/handlers/showcase.js` | `showcase.start/reserve/unreserve/list/stop/preview`；start/reserve/unreserve/stop 用户专属，preview 仅当前展示 agent | `handlers` |
| `rpc/handlers/candidate.js` | `candidate.list/inspect/prepare/verify/accept/changes/reject`；所有变更操作 USER_ONLY | `handlers` |
| `rpc/dispatcher.js` | 合并 handler 表（查重名、查漏），校验后分派 | `class Dispatcher` |

## 测试：`test/`

拆分只搬文件、不改断言。测试文件之间共享模块注册表，所以**每个测试文件必须自给自足**
（自己的 fixture / world / DOM stub），不要靠别的文件先跑过。

| 现在 | 拆成 |
|---|---|
| `project.test.js` | `test/project/{intent-layer,plan-gate,specs-queue,agents,lifecycle,recovery,limits,permissions}.test.js` |
| `drafts-deps.test.js` | `test/drafts/{drafts,deps}.test.js` |
| `workspaces.test.js` | `test/workspaces/{naming,merge,cleanup,genealogy,anchor}.test.js` |
| `web-rpc.test.js` | `test/web/{security,assets,read-models,drafts,transcript,specs-intents,maintenance}.test.js` |
| `web-live-dom.test.js` | `test/web/dom-{merge,detail,drafts,specs-intents,sidebar}.test.js`（各自 `boot()`，见前端接缝） |
| 启动器与工作台 | `test/web/launcher.test.js`（首次选项目、绝对路径校验、全局最后项目恢复）、`test/web/appearance.test.js`（主题解析、跟随系统、显式覆盖、存储失败）、`test/web/settings.test.js`（设置入口 / `#settings` / 轮询不覆盖、偏好默认值与老键、每项即时生效、恢复默认、Agent 环境变量按需读取/遮罩/键值编辑/校验、系统信息组只读渲染、并发额度表单保存 / 恢复与越界报错）、`test/project/status.test.js`（`system.status` 的只读软件配置镜像与默认值）、`test/web/dom-studio.test.js`（信息优先级、折叠保留、移动端索引） |
| 效果展示准入 | `test/project/showcase-eligibility.test.js`（稳定性、主干/登记/脏工作区/Git 操作/子分支、历史文件树去重、并发启动与重试）；`test/project/showcase.test.js` 保留执行隔离/预览覆盖；`test/web/dom-showcase.test.js`、`test/web/dom-studio.test.js` 覆盖低调入口与不合格隐藏 |
| 分支诊断统计 | `test/workspaces/branch-diagnostics.test.js`（净改动、二进制、重命名及特殊文件名、工作区未提交去重、只读与缓存、失败降级、明细字节限额）；`test/project/graph.test.js` 覆盖图投影与合入后保留累计规模；`test/web/dom-graph.test.js` 覆盖统计渲染、文本安全、脏活刷新与明细展开保留 |
| Token 效率 | `test/project/token-efficiency.test.js`（相关上下文、快速路由事务与回滚、唤醒竞态/恢复/取消）；`test/soft-budget.test.js`（预算配置、Pi hook 与 provider 边界）；`test/usage-attribution.test.js`（身份、历史区间、unknown、缓存与上限）；`test/token-cli.test.js`（say 入口及短输出）；`test/web/dom-token-efficiency.test.js`（直接提交锁、草稿与输入保留、配置与归因展示） |
| 统计面板 | `test/usage-statistics.test.js`（全量、时间边界、UTC 分桶、模型切换、缺价、损坏与缓存失效）、`test/web/usage-statistics.test.js`（认证 API）、`test/web/dom-statistics.test.js`（双视图入口、独立筛选、SVG 即时浮层、错误与导航竞态）、`test/web/statistics-range.test.js`（UTC 日期快捷范围、闰日／跨年与日内小时边界）；Codex 用量留存由 `test/agent-settings.test.js` 覆盖 |
| 托管模式 | `test/project/sleep.test.js`（授权、作用域、规则/偏好、关闭竞态、人工答案优先、预算、恢复和审计分页）；`test/butler-provider.test.js`（无工具边界）；`test/sleep-cli.test.js`（确认和参数）；`test/web/sleep.test.js`（HTTP、开启确认、显著关闭、管家选择留档） |
| Notice 记录与提醒 | `test/project/notice-page.test.js`（超过 200 条历史、筛选与字节预算游标）、`test/web/notice-records.test.js`（HTTP 参数、分页、面板内答复／审批与只读问卷）、`test/web/notice-notifications.test.js`（默认关闭、权限、首屏基线、去重与桌面开关恢复） |
| 执行过程阅读与解释 | `test/transcript-reader.test.js`（全量搜索、截断后命中、过滤、配对、原文与文件边界）、`test/explainer-provider.test.js`（无工具参数及凭证隔离）、`test/project/explanations.test.js`（来源快照、无分支与权限）、`test/project/intro.test.js`（快速介绍配置遮蔽、直连与失败、恢复、不建任务）、`test/web/transcript-reader.test.js`（HTTP/RPC）、`test/web/intro.test.js`（快速介绍路由）、`test/web/dom-transcript-reader.test.js`（摘要、增量配对、JSON、检索与选区介绍） |
| 运行设置 | `test/runtime-settings.test.js`（存储原子性与权限、覆盖优先于环境、写后 status 与调度准入、agent 不得调用 `system.configure`）、`test/config-cli.test.js`（`lush config` 的 show / set / reset 与 `--json`） |
| `integration.test.js` | `test/integration/{daemon,pi,verify,shutdown,merge}.test.js` |

`test/helpers.js`、`test/dom-stub.js` 是被多个文件共用的**公共面**：只增不改，改签名会同时影响所有分区。

---

[← 上一篇：Web 前端](modules-web.md) · [返回模块地图总览](modules.md)
