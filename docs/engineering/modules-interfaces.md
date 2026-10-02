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
| `cli/commands/system.js` | `daemon` / `status` / `doctor` / `log` / `host` / `host-restart` / `host-stop` / `host-status`；无 `--project` 时使用全局项目启动器，显式项目时保持单项目模式；`doctor` / `host-status` 分列磁盘、daemon、Web 身份并只给显式更新提示 | `run` |
| `cli/commands/intent.js` | `say`（新输入的唯一入口） | `run` |
| `cli/commands/task.js` | `worker`（list / tree / inspect / spawn / message / transcript [--follow] / history / wait / integrate / auto-merge ID on\|off / reserve / accept / reopen / sync-parent / resolve-sync / resolve / resolve-divergence / resolve-child-divergence / unreserve / approve-merge / cancel / retry / cleanup） | `run`、`followTranscript`、`FOLLOW_INTERVAL_MS` |
| `cli/commands/progress.js` | `progress plan KEY[:LABEL]...` / `progress complete KEY`（只写当前 Agent 的 Worker） | `run` |
| `cli/commands/notice.js` | `notice list/post/answer/dismiss/read`（read 为用户专属，只将 info 告知标已读） | `run` |
| `cli/commands/branch.js` | `branch tree / show / bind / archive` | `run` |
| `cli/commands/agent.js` | `agent show/models/set/reset` 配置 profile；`prompt/env` 查看最终组合和环境来源，`init` 创建共享/本机补充；`--prompt` 只作旧版 `--append-prompt` 别名 | `run` |
| `cli/commands/config.js` | `config show / set / reset`：读 `system.status.settings`、写 `system.configure`；用户专属，agent 调用被拒 | `run` |

历史命令模块（`draft.js` / `plan.js` / `spec.js` / `candidate.js` / `sleep.js`）仍在源码里，但 `COMMANDS` 不再挂载它们；`lush help` 也不列出，执行会报 `unknown command`。

展示专用 CLI/RPC 模块与预览子进程已删除；`showcase.*` 不再有 handler 或命令实现。历史 DB 列／行不迁移、不重写，旧 `agent.json.roles.showcase` 仅在读取时忽略，不出现在配置选项或 Prompt 中，写入该角色会被拒绝。历史展示 worktree 不走普通 checkout 清理：cleanup 拒绝；关联目录仍存在（或快照损坏而无法确认归属）时 archive 在任何删除前拒绝，即使显式 discard 也不绕过。

## RPC：`src/rpc/protocol.js` + `src/rpc/`

处理器的统一签名：`(project, params, actor) => result | Promise<result>`。

| 文件 | 职责 | 导出 |
|---|---|---|
| `rpc/protocol.js` | framing（编码、解析、帧上限）；并 re-export `Dispatcher` 保持旧 import 可用 | `MAX_FRAME`、`encode`、`errorResponse`、`parseRequest`、`Dispatcher` |
| `rpc/registry.js` | 方法白名单、参数白名单、权限集合与统一校验。**唯一公开面**：未列入 `PARAMS` 的方法一律 `unknown method` | `PARAMS`、`USER_ONLY`、`AGENT_ONLY`、`assertAllowed(method, params, actor)` |
| `rpc/handlers/system.js` | 用户专属 `system.configure`、`system.stop_if_idle`（同步 idle 准入并关闭调度，见[服务重启](../reference/web-routes.md#服务重启)）；只读 `system.status`（兼容完整状态）与 `system.summary`（首页用持久 revision/索引聚合的无 Agent 全配置摘要）；`graph.get`；`agent.*`（含用户专属配置与环境文件，以及按需读取脱敏 Pi 账号/安装状态的 `agent.status`，不纳入快照）；历史 `sleep.*` / `system.usage` 仍可被内部调用，但不在白名单 | `handlers` |
| `rpc/handlers/task.js` | `worker.*`：`graph` / `list` / `activity` / `page` / `tree` / `inspect` / `history` / `history_page` / `diff` / 用户专属 `code_state` / `code_tree` / `code_file` / `usage` / `transcript*`、`spawn`、agent-only 的 `integrate` / `resolve_child_divergence` / `progress.*`，共享但按身份校验的 `accept`（用户验收 say / 直接父 Agent 确认 child），以及用户专属的 `auto_merge` / `reserve` / `unreserve` / `reopen` / `sync_parent` / `resolve_sync` / `resolve` / `resolve_divergence` / `approve_merge` / `cancel` / `retry` / `cleanup` | `handlers` |
| `rpc/handlers/notice.js` | `notice.list/page/post/answer/dismiss/read`；list 待决优先、其次未读生命周期 info；page 的 `unread` 仅筛新生命周期告知；read 幂等、不答复也不唤醒 | `handlers` |
| `rpc/handlers/branch.js` | `branch.history/tree/show/bind/archive`（`branch.history` / `branch.bind` / `branch.archive` 在 `USER_ONLY`）；history 只读 main 第一父链 | `handlers` |
| `rpc/handlers/input.js` | 历史 `input.*` / `draft.*`：源码保留，不在白名单 | `handlers` |
| `rpc/handlers/spec.js` | 历史 `spec.*` / `plan.*`：源码保留，不在白名单 | `handlers` |
| `rpc/handlers/candidate.js` | 历史 `candidate.*`：源码保留，不在白名单 | `handlers` |
| `rpc/dispatcher.js` | 合并 handler 表（查重名、查漏），校验后分派 | `class Dispatcher` |

## 构建脚本：`scripts/`

| 文件 | 职责 | 导出 / 命令 |
|---|---|---|
| `scripts/build-desktop.js` | Windows x64 远程 Electron 客户端白名单 staging、固定版本 electron-builder / NSIS 配置、ASAR 内容与源码一致性校验、安装器 SHA-256；生成物只写入忽略的 `node_modules/lush-desktop-build/`，不复制 Host / daemon / Bun / `.lush` / 凭证，不自动发布或签名 | `APP_FILES`、`BUILD_DIR`、`buildPaths(root?)`、`stageDesktop(root?)`、`validateStage(app)`、`verifyArchive(archive, app)`、`builderConfig(root?)`、`writeChecksums(output)`；`bun run desktop:stage:win` / `desktop:build:win` / `desktop:verify:win` |

`.github/workflows/windows-desktop.yml` 在 Windows runner 实际生成并校验 NSIS 安装器，手动、相关 PR 或 main 提交触发，仅上传 14 天保留的安装器与校验和 artifact。无 tag 发布、GitHub Release 写权限或签名密钥；真实 Windows 安装与远程连接仍需人工验收。Windows 主入口不得静态导入未打包的 `local-host.js`；非 Windows 本地入口须按平台延迟加载，不进入远程包。

## 测试：`test/`

拆分只搬文件、不改断言。测试文件之间共享模块注册表，所以**每个测试文件必须自给自足**
（自己的 fixture / world / DOM stub），不要靠别的文件先跑过。

当前测试按分区落位：

| 分区 | 文件 |
|---|---|
| Worker 中心主链 | `test/project/say.test.js`、`merge-queue.test.js`、`parent-delivery.test.js`（父自有队列顺序/执行位/暂停重排/取消与精确恢复）、`delivery-compatibility.test.js`（重复交付/代码依赖/旧 v2 审计与 Git/DB 窗口/源漂移）、`delivery-review.test.js`（拒绝非法 sender 无副作用、busy 挂起/取消真实自动唤醒、父前进后精确恢复读模型）、`task-signals.test.js`、`task-centered-graph.test.js`、`lifecycle.test.js`、`scheduling.test.js`、`preempt.test.js`、`progress.test.js`、`recovery.test.js`、`limits.test.js`、`agents.test.js`、`status.test.js` |
| 公开面契约 | `test/core-api.test.js`（RPC 白名单）、`test/help-guard.test.js`（帮助与命令面）、`test/web/core-api.test.js`、`test/task-iteration-api.test.js`（四个用户专属接口/CLI mock）、`test/web/iteration-api.test.js`（HTTP mock）、`test/web/dom-iteration.test.js`（共享迭代动作） |
| Git / worktree | `test/workspaces/{naming,merge,cleanup,genealogy,anchor,archive,branch-diagnostics,branch-first,safety,task-squash}.test.js`（task-squash 核验精确凭据、双 ref 事务、guard、dirty/drift 与失败保留现场）；`safety` 直接验证通用 Git 安全门、历史展示 worktree 保留与 DB 附属数据只读兼容 |
| 服务重启 | `test/service-restart.test.js`、`test/web/service-restart.test.js`、`test/integration/service-restart.test.js`（idle 准入、鉴权/路由、真实进程与桌面所有权） |
| main 版本迭代 | `test/workspaces/version-history.test.js`（SHA-256/Unicode/配置与环境隔离）、`test/project/version-history.test.js`（真实第一父链/多轮交付/历史证据/伪标题/分页/安全大小/无 main）、`test/web/version-history-api.test.js`（RPC 权限/窄参数/认证/Origin/多项目隔离） |
| Web 读面与安全 | `test/web/{security,assets,read-models,project-route,core-studio,multi-project,launcher}.test.js` |
| Web DOM | `test/web/dom-*.test.js`（各自 `boot()`） |
| Windows 打包 | `test/packaging/windows-desktop.test.js`（白名单 / 清理隔离 / 静态依赖边界 / 真实 ASAR / 固定版本构建配置 schema / 安装器校验和 / CI 交付契约，不冒充 Windows 运行验证） |
| 桌面连接 | `test/desktop/{connections,runtime,local-host,connection-ui}.test.js`（地址 / 持久化 / 模拟 Electron 安全与窗口 / 真实临时 Host 生命周期 / 连接页 DOM） |
| Notice 记录与提醒 | `test/project/{notice-page,notice-info,lifecycle-notice,notice-lifecycle-type,questionnaire}.test.js`、`test/web/{notice-records,notice-notifications,lifecycle-notice-api,overview-lifecycle-notices,dom-lifecycle-notices,settings,questionnaire}.test.js`；真实 Firefox 独立临时 fixture：`bun run ./test/web/check-notice-banner-browser.js`（精确桌面/390px 视口、WebDriver 原生触摸）与 `bun run ./test/web/check-notice-interaction.js`（CSP、键盘/PointerEvents）；两者需 Firefox/geckodriver，不连接用户 daemon |
| 执行详情代码阅读 | `test/workspaces/code-reader.test.js`（真实临时 Git 工作区、基线/净变化、ignored/链接/外部程序/大文件/历史降级、受阻路径明确失败、长转义路径的字节分页及真实 RPC 帧预算）、`test/workspaces/code-posix.test.js`（真实 openat/readlinkat、换链竞态、FD 回收/CLOEXEC 与 Darwin loader 契约）、`test/web/code-reader-api.test.js`（用户权限、窄参数、认证、Origin、多项目路由） |
| 执行过程阅读 | `test/transcript*.test.js`、`test/web/{transcript-reader,dom-transcript-reader,dom-transcript-view,dom-results}.test.js` |
| Agent 状态 | `test/agent/{status,usage-query,usage-settings,codex-usage-parsing,usage-auth-codex}.test.js`（fake Pi SDK、密钥命令不执行、脱敏身份、内置/HTTP mock 查询、独立Codex刷新/锁/写回和安全设置）、`test/project/{agent-usage,agent-usage-provider,codex-usage-history}.test.js`（存储/定时采样/热更新/有界历史/联调）、`test/web/{agent-status-api,agent-usage-api,dom-agent-status,dom-agent-usage}.test.js`（用户鉴权/项目路由、配置表单/缓存曲线/异步状态） |
| 运行设置与 Agent | `test/runtime-settings.test.js`、`test/config*.test.js`、`test/agent-settings.test.js`、`test/soft-budget.test.js` |
| 文档 | `test/docs-check.test.js`、`test/docs-search.test.js`、`test/markdown.test.js`、`test/mermaid-docs.test.js`、`test/web/docs.test.js` |
| 历史遗留（内部实现仍在，无公开入口） | `test/drafts/**`、`test/project/{intent-layer,plan-gate,specs-queue,candidates,analysis,explanations,intro,sleep,verification-evidence}.test.js`、`test/{candidate-cli,sleep-cli,merge-all,orchestrate,verify,task-clear,task-delete,usage-*}.test.js` 及其 `test/web/*` 对应文件；它们验证的是历史兼容与内存实现，不能当作公开能力 |

`.github/workflows/code-reader-posix.yml` 独立运行代码读取器的 Linux/macOS 聚焦回归，覆盖最低支持 Bun 1.2.0 和当前固定 Bun 1.4.2；无 native 包或编译步骤。Linux 本地通过不等于 macOS 实测，Darwin loader mock 也不能替代 macOS job 的结果。

`test/helpers.js`、`test/dom-stub.js` 是被多个文件共用的**公共面**：只增不改，改签名会同时影响所有分区。

---

[← 上一篇：Web 前端](modules-web.md) · [返回模块地图总览](modules.md)
