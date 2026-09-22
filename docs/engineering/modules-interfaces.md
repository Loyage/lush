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
| `cli/print.js` | 树 / 阶梯 / 时间轴 / 合并 / 会话 / 用量 / 分支谱系的渲染 | `printTree`、`printLadder`、`printTimeline`、`printMergeMany`、`printTranscript`、`printUsage`、`printBranchTree`、`printBranchShow`、`printBranchImport`、`printBranchArchive` |
| `cli/commands/intent.js` | `say` / `intent` / `input` | `run` |
| `cli/commands/draft.js` | `draft` | `run` |
| `cli/commands/task.js` | `task` | `run` |
| `cli/commands/progress.js` | `progress plan KEY[:LABEL]...` / `progress complete KEY`（只写当前 agent task） | `run` |
| `cli/commands/spec.js` | `spec` | `run` |
| `cli/commands/plan.js` | `plan` | `run` |
| `cli/commands/notice.js` | `notice` | `run` |
| `cli/commands/branch.js` | `branch`（tree / show / import / merge / sync / catchup / archive / summary） | `run` |
| `cli/commands/system.js` | `daemon` / `status` / `doctor` / `log` / `web` / `web-restart` / `web-stop` / `web-status`；Web 无 `--project` 时使用全局项目启动器，显式项目时保持单项目模式 | `run` |
| `cli/commands/candidate.js` | `candidate list/inspect/prepare/verify/accept/changes/reject` | `run` |
| `cli/commands/agent.js` | `agent show/models/set/reset`；`--prompt` 只作旧版 `--append-prompt` 别名 | `run` |
| `cli/commands/config.js` | `config`（`show` / `set concurrency|control-concurrency N` / `reset [concurrency|control-concurrency|all]`）：读 `system.status.settings`、写 `system.configure`；用户专属，agent 调用被拒 | `run` |
| `cli/main.js` | 全局参数、命令分发表、fingerprint 提醒；仅 Web 四条命令允许在无项目配置下进入 launcher config | `main(argv)`（并 re-export `HELP`） |

## RPC：`src/rpc/protocol.js` + `src/rpc/`

处理器的统一签名：`(project, params, actor) => result | Promise<result>`。

| 文件 | 职责 | 导出 |
|---|---|---|
| `rpc/protocol.js` | framing（编码、解析、帧上限）；并 re-export `Dispatcher` 保持旧 import 可用 | `MAX_FRAME`、`encode`、`errorResponse`、`parseRequest`、`Dispatcher` |
| `rpc/registry.js` | 方法白名单、参数白名单、权限集合与统一校验 | `PARAMS`、`USER_ONLY`、`AGENT_ONLY`、`assertAllowed(method, params, actor)` |
| `rpc/handlers/system.js` | `system.*`（含用户专属的 `system.configure`）、`graph.get`、`agent.config`、`agent.models`、`agent.resources`、`agent.configure` | `handlers` |
| `rpc/handlers/input.js` | `input.*`、`draft.*` | `handlers` |
| `rpc/handlers/task.js` | `task.*`、agent-only 的 `progress.plan` / `progress.complete` | `handlers` |
| `rpc/handlers/spec.js` | `spec.*`、`plan.*` | `handlers` |
| `rpc/handlers/notice.js` | `notice.*` | `handlers` |
| `rpc/handlers/branch.js` | `branch.tree/show/import/merge/sync/archive/summary`（`branch.archive` 参数 `branch` / `discard`，在 `USER_ONLY`；`branch.summary` 参数 `branch` / `summary`，agent 可写、省略 branch 时写自己的分支，用户必须显式点名） | `handlers` |
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
| 启动器与工作台 | `test/web/launcher.test.js`（首次选项目、绝对路径校验、全局最后项目恢复）、`test/web/appearance.test.js`（主题解析、跟随系统、显式覆盖、存储失败）、`test/web/settings.test.js`（设置入口 / `#settings` / 轮询不覆盖、偏好默认值与老键、每项即时生效、恢复默认、系统信息组只读渲染、并发额度表单保存 / 恢复与越界报错）、`test/project/status.test.js`（`system.status` 的只读软件配置镜像与默认值）、`test/web/dom-studio.test.js`（信息优先级、折叠保留、移动端索引） |
| 运行设置 | `test/runtime-settings.test.js`（存储原子性与权限、覆盖优先于环境、写后 status 与调度准入、agent 不得调用 `system.configure`）、`test/config-cli.test.js`（`lush config` 的 show / set / reset 与 `--json`） |
| `integration.test.js` | `test/integration/{daemon,pi,verify,shutdown,merge}.test.js` |

`test/helpers.js`、`test/dom-stub.js` 是被多个文件共用的**公共面**：只增不改，改签名会同时影响所有分区。

---

[← 上一篇：Web 前端](modules-web.md) · [返回模块地图总览](modules.md)
