# 模块地图：CLI、RPC 与测试

本章记录命令行、RPC 分派与测试文件的模块边界。当前可调用的方法以[核心 API 收敛](core-api.md)和 `src/rpc/registry.js` 为准；未列入白名单的 handler 与未挂载的命令模块仍然存在，但不再对外提供服务。

> 模块地图：[总览](modules.md) → [Runtime 与持久化](modules-runtime.md) → [Web 前端](modules-web.md) → **CLI、RPC 与测试**

## CLI：`src/cli/main.js` + `src/cli/`

命令处理器的统一签名：`export async function run(command, args, ctx)`，
其中 `ctx = { client, json }`；返回 `undefined` 表示「已经自己打印过，主流程不要再 print」。
`option` / `exact` / `print` 从 `args.js` 直接 import。

`main.js` 的 `COMMANDS` 表只挂载下面这些名字；`help.js` 的 `HELP` 是当前命令面的权威文本。

| 文件 | 命令 | 导出 |
|---|---|---|
| `cli/help.js` | 帮助文本 | `HELP` |
| `cli/args.js` | 参数解析与两种输出 | `option`、`exact`、`print` |
| `cli/print.js` | 树 / 会话 / 用量 / 分支谱系的渲染 | `printTree`、`printTranscript`、`transcriptStepText`、`printUsage`、`printBranchTree`、`printBranchShow`、`printBranchArchive` |
| `cli/commands/system.js` | `daemon` / `status` / `doctor` / `log` / `web` / `web-restart` / `web-stop` / `web-status`；无 `--project` 时使用全局项目启动器，显式项目时保持单项目模式；`doctor` / `web-status` 分列磁盘、daemon、Web 身份并只给显式更新提示 | `run` |
| `cli/commands/intent.js` | `say`（新输入的唯一入口） | `run` |
| `cli/commands/task.js` | `task`（list / tree / inspect / spawn / message / transcript [--follow] / history / wait / integrate / reserve / resolve / resolve-divergence / resolve-child-divergence / unreserve / approve-merge / cancel / retry / cleanup） | `run`、`followTranscript`、`FOLLOW_INTERVAL_MS` |
| `cli/commands/progress.js` | `progress plan KEY[:LABEL]...` / `progress complete KEY`（只写当前 agent task） | `run` |
| `cli/commands/notice.js` | `notice list/post/answer/dismiss` | `run` |
| `cli/commands/branch.js` | `branch tree / show / bind / archive` | `run` |
| `cli/commands/agent.js` | `agent show/models/set/reset` 配置 profile；`prompt/env` 查看最终组合和环境来源，`init` 创建共享/本机补充；`--prompt` 只作旧版 `--append-prompt` 别名 | `run` |
| `cli/commands/config.js` | `config show / set / reset`：读 `system.status.settings`、写 `system.configure`；用户专属，agent 调用被拒 | `run` |

历史命令模块（`draft.js` / `plan.js` / `spec.js` / `candidate.js` / `showcase.js` / `sleep.js`）仍在源码里，但 `COMMANDS` 不再挂载它们；`lush help` 也不列出，执行会报 `unknown command`。

## RPC：`src/rpc/protocol.js` + `src/rpc/`

处理器的统一签名：`(project, params, actor) => result | Promise<result>`。

| 文件 | 职责 | 导出 |
|---|---|---|
| `rpc/protocol.js` | framing（编码、解析、帧上限）；并 re-export `Dispatcher` 保持旧 import 可用 | `MAX_FRAME`、`encode`、`errorResponse`、`parseRequest`、`Dispatcher` |
| `rpc/registry.js` | 方法白名单、参数白名单、权限集合与统一校验。**唯一公开面**：未列入 `PARAMS` 的方法一律 `unknown method` | `PARAMS`、`USER_ONLY`、`AGENT_ONLY`、`assertAllowed(method, params, actor)` |
| `rpc/handlers/system.js` | 用户专属 `system.configure`；只读 `system.status`（兼容完整状态）与 `system.summary`（首页用持久 revision/索引聚合的无 Agent 全配置摘要）；`graph.get`；`agent.*`（含用户专属配置与环境文件）；历史 `sleep.*` / `system.usage` 仍可被内部调用，但不在白名单 | `handlers` |
| `rpc/handlers/task.js` | `task.*`：`graph` / `list` / `activity` / `page` / `tree` / `inspect` / `history` / `history_page` / `diff` / `usage` / `transcript*`、`spawn`、agent-only 的 `integrate` / `resolve_child_divergence` / `progress.*`，以及用户专属的 `reserve` / `unreserve` / `resolve` / `resolve_divergence` / `approve_merge` / `cancel` / `retry` / `cleanup` | `handlers` |
| `rpc/handlers/notice.js` | `notice.list/page/post/answer/dismiss` | `handlers` |
| `rpc/handlers/branch.js` | `branch.tree/show/bind/archive`（`branch.bind` / `branch.archive` 在 `USER_ONLY`） | `handlers` |
| `rpc/handlers/input.js` | 历史 `input.*` / `draft.*`：源码保留，不在白名单 | `handlers` |
| `rpc/handlers/spec.js` | 历史 `spec.*` / `plan.*`：源码保留，不在白名单 | `handlers` |
| `rpc/handlers/candidate.js` | 历史 `candidate.*`：源码保留，不在白名单 | `handlers` |
| `rpc/handlers/showcase.js` | 历史 `showcase.*`：源码保留，不在白名单 | `handlers` |
| `rpc/dispatcher.js` | 合并 handler 表（查重名、查漏），校验后分派 | `class Dispatcher` |

## 测试：`test/`

拆分只搬文件、不改断言。测试文件之间共享模块注册表，所以**每个测试文件必须自给自足**
（自己的 fixture / world / DOM stub），不要靠别的文件先跑过。

当前测试按分区落位：

| 分区 | 文件 |
|---|---|
| Task 中心主链 | `test/project/say.test.js`、`task-signals.test.js`、`task-centered-graph.test.js`、`lifecycle.test.js`、`scheduling.test.js`、`preempt.test.js`、`progress.test.js`、`recovery.test.js`、`limits.test.js`、`agents.test.js`、`status.test.js` |
| 公开面契约 | `test/core-api.test.js`（RPC 白名单）、`test/help-guard.test.js`（帮助与命令面）、`test/web/core-api.test.js` |
| Git / worktree | `test/workspaces/{naming,merge,cleanup,genealogy,anchor,archive,branch-diagnostics,branch-first}.test.js` |
| Web 读面与安全 | `test/web/{security,assets,read-models,project-route,core-studio,multi-project,launcher}.test.js` |
| Web DOM | `test/web/dom-*.test.js`（各自 `boot()`） |
| Notice 记录与提醒 | `test/project/{notice-page,notice-info,questionnaire}.test.js`、`test/web/{notice-records,notice-notifications,questionnaire}.test.js` |
| 执行过程阅读 | `test/transcript*.test.js`、`test/web/{transcript-reader,dom-transcript-reader,dom-transcript-terminal}.test.js` |
| 运行设置与 Agent | `test/runtime-settings.test.js`、`test/config*.test.js`、`test/agent-settings.test.js`、`test/soft-budget.test.js` |
| 文档 | `test/docs-check.test.js`、`test/docs-search.test.js`、`test/markdown.test.js`、`test/mermaid-docs.test.js`、`test/web/docs.test.js` |
| 历史遗留（内部实现仍在，无公开入口） | `test/drafts/**`、`test/project/{intent-layer,plan-gate,specs-queue,candidates,analysis,explanations,intro,showcase,showcase-eligibility,showcase-reservation,sleep,verification-evidence}.test.js`、`test/{candidate-cli,showcase-cli,sleep-cli,merge-all,orchestrate,verify,task-clear,task-delete,usage-*}.test.js` 及其 `test/web/*` 对应文件；它们验证的是历史兼容与内存实现，不能当作公开能力 |

`test/helpers.js`、`test/dom-stub.js` 是被多个文件共用的**公共面**：只增不改，改签名会同时影响所有分区。

---

[← 上一篇：Web 前端](modules-web.md) · [返回模块地图总览](modules.md)
