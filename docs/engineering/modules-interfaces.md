# 模块地图：CLI、RPC 与测试

本章记录命令行、RPC 分派与测试文件的模块边界。当前可调用的方法以[核心 API 收敛](core-api.md)和 `src/rpc/registry.js` 为准；未列入白名单的 handler 与未挂载的命令模块仍然存在，但不再对外提供服务。

> 模块地图：[总览](modules.md) → [Runtime 与持久化](modules-runtime.md) → [Web 前端](modules-web.md) → **CLI、RPC 与测试**

## 设备设置与迁移接缝

[设备设置契约](device-settings.md)优先于下面旧的项目配置路径描述。既有设置 RPC 的可选 `scope` 默认 project，显式 device 管理不受项目覆盖影响；device 管理不能由 Agent token 调用。新增用户专属 `system.settings`、`settings.clear_override`、`settings.migration.preview/apply`，由 `handlers/system.js` 转发。迁移固定当前项目，不接收路径/项目选择参数，confirm 与预检 revision 必需。

`cli/settings-scope.js` 导出 `takeConfigurationScope(args)` / `scopedSettingsClient(client,scope)` / `safeConfigurationScope(value)`（安全 CLI metadata 白名单），仅在显式 --scope 时给支持它的设置请求加参数，不污染 Worker/历史。`config` 增加 `migrate` 预检与 `migrate --confirm --revision REV`；设置命令/来源/包支持 --scope，项目 prompt/env 检查与 init 不接受 scope。新接口与空闲保护回归在 `test/device-settings-interfaces.test.js`；Host 无项目、安全白名单和固定项目 scope 转发在 `test/web/device-settings-api.test.js`。

## CLI：`src/cli/main.js` + `src/cli/`

命令处理器的统一签名：`export async function run(command, args, ctx)`，
其中 `ctx = { client, json }`；返回 `undefined` 表示「已经自己打印过，主流程不要再 print」。
`option` / `exact` / `print` 从 `args.js` 直接 import。

`main.js` 的 `COMMANDS` 表只挂载下面这些名字；`help.js` 的 `HELP` 是当前命令面的权威文本。`agent set TARGET --connection UUID|off` 显式绑定/取消 Pi 连接，要求 qualified 物理模型，不做自动路由。未来策略的安全资源读接口 `agent.selection.resources {}` 也是用户专属，只读本地观测，GET `/api/agent/selection/resources` 不接受查询参数；受信策略接口见[共享模型选择](managed-model-selection.md)。连接管理的 `agent.connections.*` 全部用户专属 RPC，列表/历史通过 GET，秘密写入/登录/显式刷新仅 POST action；见[连接器契约](agent-connections.md)。模型目录只读走 GET `/api/agent/connections/models?id=...`、显式刷新与资源安装只经 POST action，`agent.packages.*` 与目录 RPC 均用户专属；见[模型目录契约](agent-model-catalog.md)。

| 文件 | 命令 | 导出 |
|---|---|---|
| `cli/help.js` | 帮助文本 | `HELP` |
| `cli/args.js` | 参数解析与两种输出；数组的人类摘要优先展示持久 Worker 编号，JSON 保留整数身份 | `option`、`exact`、`print` |
| `cli/worker-number.js` | 仅 CLI 的严格 Worker 编号解析，经 `worker.lookup` 获取真实整数 ID；格式化保留历史回退，不修改通用 `id()` | `resolveWorkerId(client,value)`、`workerLabel(task,fallback?)`、`inputNumber(inputId)` |
| `cli/print.js` | 树 / 会话 / 用量 / 分支谱系的渲染 | `printTree`、`printTranscript`、`transcriptStepText`、`printUsage`、`printBranchTree`、`printBranchShow`、`printBranchArchive` |
| `cli/commands/system.js` | `daemon` / `status` / `doctor` / `log` / `host start|stop|restart|status`；无 `--project` 时使用全局项目启动器，显式项目时保持单项目模式；`doctor` / `host status` 分列磁盘、daemon、Web 身份并只给显式更新提示 | `run` |
| `cli/commands/intent.js` | `order`（新输入的唯一入口），`--profile-file PATH` 从 owner-only 普通 JSON 文件读取完整运行覆盖 | `run` |
| `cli/commands/task.js` | `worker`（list / tree / inspect / spawn / message / transcript [--follow] / history / wait / integrate / auto-merge ID on\|off / reserve / accept / reopen / sync-parent / resolve-sync / resolve / resolve-divergence / resolve-child-divergence / unreserve / approve-merge / cancel / retry / cleanup / delete ID [--confirm --revision REV]） | `run`、`followTranscript`、`FOLLOW_INTERVAL_MS` |
| `cli/commands/hooks.js` | 项目 Hook 目录/模板与 Worker 挂载的用户专属 CLI，复用 `cli/private-json.js` 的有界、owner-only、no-follow 文件输入和 revision 校验；`order --defer` 由指令命令授权 | `run`、`runWorkerHook`、`runWorkerCompletion`；新增 `hooks signal save/remove` 与 `hooks management create/enable/disable`，无立即执行管理工具入口（接口以 [Hooks 接缝](hooks.md)、[时间信号与管理](hook-signals-management.md)和[自动链](completion-hooks.md)为准） |
| `cli/commands/progress.js` | `progress plan KEY[:LABEL]...` / `progress complete KEY`（只写当前 Agent 的 Worker） | `run` |
| `cli/commands/notice.js` | `notice list/post/answer/dismiss/read`（read 仅标已读；选择快照与重选已停用）；`post --worker` 接受整数或稳定 Worker 编号，Notice 本身的 ID 仍只接受整数 | `run` |
| `cli/commands/branch.js` | `branch tree / show / bind / archive` | `run` |
| `cli/commands/agent.js` | `agent show/models/set/reset` 配置 profile；`prompt/env` 查看最终组合和环境来源，`network show/set --file PATH/reset` 管理出站代理（[契约](outbound-network.md)），`init` 创建共享/本机补充；`--prompt` 只作旧版 `--append-prompt` 别名；`--config-mode lush|pi` 显式选择运行配置模式，`sources` / `resources` 分派到 `agent-sources.js`，`packages` 分派到 `agent-packages.js` | `run` |
| `cli/commands/agent-sources.js` | `agent sources list/show/models ID [--refresh]/refresh [ID]/save --file PATH/remove ID/login ID`（设备码 start/poll/cancel 与备用回调私密文件）与只读 `agent resources`；用户专属，凭证不进 argv/输出 | `runSources(args,client,{json?})`、`runResources(args,client,{json?})`（[目录契约](agent-model-catalog.md)） |
| `cli/commands/agent-packages.js` | `agent packages list/install SOURCE/remove ID/update ID`；用户专属，安装与启用分离 | `runPackages(args,client)`（兼容 context） |
| `cli/commands/config.js` | `config show / set / reset`：读 `system.status.settings`、写 `system.configure`；用户专属，agent 调用被拒 | `run` |

Worker 身份参数（含 `spawn --parent`、`notice post --worker`）接受原整数及严格 `Wn(-n)*`。新编号只解析一次，经只读 `worker.lookup {number}` 核验 `{id,worker_number}` 后，既有 RPC 的 id/parent/task 参数仍发送整数；wait/follow 后续读取复用固定整数。分页游标、Notice ID 不接受 Worker 编号，整数调用不产生额外 lookup。列表 `--brief` 同时保留整数 `id` 与可空 `worker_number`，分页仍按整数。原始输入提交的人类输出显示 `O<id>` 与关联 Worker 编号，JSON 不改写身份字段。历史树、分支展示的回退标识保持不变。测试在 `test/worker-number-cli.test.js`。

历史命令模块（`draft.js` / `plan.js` / `spec.js` / `candidate.js` / `sleep.js`）仍在源码里，但 `COMMANDS` 不再挂载它们；`lush help` 也不列出，执行会报 `unknown command`。`package.json` 与 `scripts/ops.js` 同样不保留退休快捷入口：draft / drafts、intent / intents、ladder、timeline、usage、merge、clear，以及旧 plan/spec 的 specs / approve / reject / propose 映射。移除快捷入口不删除历史数据；`worker.usage` RPC 等仍按各自白名单提供，不以旧快捷命令存在与否判断。

展示专用 CLI/RPC 模块与预览子进程已删除；`showcase.*` 不再有 handler 或命令实现。历史 DB 列／行不迁移、不重写，旧 `agent.json.roles.showcase` 仅在读取时忽略，不出现在配置选项或 Prompt 中，写入该角色会被拒绝。历史展示 worktree 不走普通 checkout 清理：cleanup 拒绝；关联目录仍存在（或快照损坏而无法确认归属）时 archive 在任何删除前拒绝，即使显式 discard 也不绕过。

## RPC：`src/rpc/protocol.js` + `src/rpc/`

处理器的统一签名：`(project, params, actor) => result | Promise<result>`。

| 文件 | 职责 | 导出 |
|---|---|---|
| `rpc/protocol.js` | framing（编码、解析、帧上限）；并 re-export `Dispatcher` 保持旧 import 可用 | `MAX_FRAME`、`encode`、`errorResponse`、`parseRequest`、`Dispatcher` |
| `rpc/registry.js` | 方法白名单、参数白名单、权限集合与统一校验。**唯一公开面**：未列入 `PARAMS` 的方法一律 `unknown method`。含用户专属连接模型目录 `agent.connections.models(.refresh)` 与资源安装 `agent.packages.*`，`order.submit` 预置可选 `profile` 覆盖参数 | `PARAMS`、`USER_ONLY`、`AGENT_ONLY`、`MANAGER_METHODS`、`assertAllowed(method, params, actor)` |
| `rpc/handlers/system.js` | 用户专属 `system.configure`、`system.stop_if_idle`（同步 idle 准入并关闭调度，见[服务重启](../reference/web-routes.md#服务重启)）；只读 `system.status`（兼容完整状态）与 `system.summary`（首页用持久 revision/索引聚合的无 Agent 全配置摘要）；`graph.get`；`agent.*`（含用户专属配置与环境文件，以及按需读取 version 2 Pi/Codex 软件安装状态的 `agent.status`（无账号查询），不纳入快照）；历史 `sleep.*` / `system.usage` 仍可被内部调用，但不在白名单 | `handlers` |
| `rpc/handlers/task.js` | `worker.*`：只读 `lookup {number}`（把界面编号解析为 `{id,worker_number}`，不改变原整数入口）/ `graph` / `list` / `activity` / `page` / `tree` / `inspect`（异步附加 指令/child 的实时 `parent_relation:{ahead,behind}` 与 `branch_archive`）/ `history` / `history_page` / `progress_history`（用户与普通 Agent 只读，倒序冻结计划默认10、最多100条）/ `diff` / 用户专属 `code_state` / `code_tree` / `code_file` / `usage` / `transcript*`、`spawn`、agent-only 的 `integrate` / `resolve_child_divergence` / `progress.*`，共享但按身份校验的 `accept`（用户验收指令 / 直接父 Agent 确认 child），以及用户专属的 `run_settings`（显式读取有效 Worker Profile；不进入普通读面）/ `auto_merge` / `reserve` / `unreserve` / `reopen` / `sync_parent` / `resolve_sync` / `resolve` / `resolve_divergence` / `approve_merge` / `cancel` / `retry` / `cleanup` / `delete_preview` / `delete`（确认与 revision 必填） | `handlers` |
| `rpc/handlers/quick-explanation.js` | 用户专属 `quick_explain.config/configure/start/followup/get/list`，窄参数与历史游标/页大小校验，不恢复旧解释接口 | `handlers` |
| `rpc/handlers/notice.js` | `notice.list/page/post/answer/dismiss/read/snapshot/rechoose`；snapshot/rechoose 映射 Project 同名方法，均用户专属；list 待决优先、其次未读生命周期 info；page 的 `unread` 仅筛新生命周期告知；read 幂等、不答复也不唤醒 | `handlers` |
| `rpc/handlers/branch.js` | `branch.history/tree/show/bind/archive`（`branch.history` / `branch.bind` / `branch.archive` 在 `USER_ONLY`）；history 只读 main 第一父链 | `handlers` |
| `rpc/handlers/input.js` | 历史 `input.*` / `draft.*`：源码保留，不在白名单 | `handlers` |
| `rpc/handlers/spec.js` | 历史 `spec.*` / `plan.*`：源码保留，不在白名单 | `handlers` |
| `rpc/handlers/candidate.js` | 历史 `candidate.*`：源码保留，不在白名单 | `handlers` |
| `rpc/dispatcher.js` | 合并 handler 表（查重名、查漏），校验后分派，按 Store 管理身份收窄管理 invocation 能力，统一应用安全输出过滤 | `class Dispatcher` |
| `rpc/public-result.js` | 递归隔离 Worker 私有 `retry_profile` 与字符串 `hooks` / `auto_merge` / `management` JSON；授权 Agent 配置/env 与显式 `worker.run_settings` 配置表面保留合法同名 env 键，不对普通 mutation 开例外 | `publicResult()` |

`rpc/handlers/hooks.js` 同时承载用户专属时间信号／管理配置与 Agent-only 的 `manager.query/start/retry`；专用方法只转发经 token 核验的 Actor，Project 再检查管理能力。`manager.*` 不进入 Web 动作白名单，接口回归在 `test/management-api.test.js` 与 `test/web/management-api.test.js`，契约见[时间信号与管理](hook-signals-management.md)。

快捷指令新增用户专属 `hooks.command_save/command_authorize/command_remove/command_run/command_import`，Project 签名与授权版本、旧配置边界以[快捷指令契约](shortcut-commands.md)为准；registry/handlers/hooks 负责严格顶层与嵌套白名单、UUID 指令身份、正整数版本与 revision，Web server 仅加入 POST action 白名单。CLI commands/hooks 内部新增 `hooks command list/save/authorize/revoke/remove/run/import` 分派，复用私有文件与 Worker 编号解析，不新增导出或立即执行管理 Agent 入口。回归为 `test/shortcut-command-api.test.js`、`test/web/shortcut-command-api.test.js`，原 hooks-api 矩阵同时覆盖新增方法和引用定义。

Hook 新增用户专属 RPC/HTTP 白名单、参数和 Project 映射以 [Hooks 接缝](hooks.md) 为准：`hooks.list/save/remove`、`worker.hooks/hook_attach/hook_update/hook_remove`，只读 GET `/api/hooks` 与 `/api/worker/ID/hooks`；`worker.hook_update` 的完整 `hook` 编辑与 `enabled` 互斥，旧启停签名兼容，命令示例和执行授权见[命令增补](hooks.md#通用命令与-main-推送示例w133--用户决定-319)；`order.submit` 显式 `defer:boolean` 才可转为预约。追加用户专属 `worker.completion` 与 CLI `worker completion`，最高级别、revision 与方法映射见[自动链接缝](completion-hooks.md)。

## 开发与构建脚本：`scripts/`

| 文件 | 职责 | 导出 / 命令 |
|---|---|---|
| `scripts/ops.js` | `package.json` 便捷命令分派到现行 CLI；只保留可用别名，不恢复退休命令 | 命令行入口，无导出；其余命令透传 `main` 校验 |
| `scripts/measure-read-performance.js` | 临时 fixture 的同进程读面 / DOM stub / 事件循环重复采样，逐样本保留既有预算，代码及 OS / Bun / Git 身份与显式 JSON 输出；无 CI / 生产改动 | `parseOptions(args)`、`summarize(values)`、`collectEnvironment(root?,env?)`、`buildReport(samples,environment,startedAt,finishedAt)`、`writeReport(report,output)`、`THRESHOLDS`；`bun run measure:read-performance [--samples N] [--output PATH]`，契约见[本地读取性能报告](../contributing/read-performance.md) |

根 `.gitattributes` 固定 `src/`、`bin/`、`package.json` 的 LF 检出，避免 autocrlf 改变代码身份。Lush 不提供客户端安装包或远端部署产物。

## 测试：`test/`

测试文件必须自给自足（自己的 fixture / world / DOM stub），不要靠别的文件先跑过。

`bun run test` 并行运行全部现有 Web/core 测试，不使用路径忽略模式；`test:all` 为同一完整入口，`test:serial` 保留原生 `bun test` 供聚焦串行诊断。质量 CI 执行测试与文档检查；真实浏览器专项需相应系统浏览器，不能用 DOM stub 代替。

数据规模边界只在负责该边界的后端测试完整验证；HTTP / DOM 层用小规模数据验证参数、游标、刷新和交互。批量造库使用测试事务，不关闭生产持久化或安全设置。Web 资源测试只保留模块可加载、CSP、启动落点、Agent 标识与减动效契约，不锁定精确颜色、字体或 CSS 排版。

当前测试按分区落位：

| 分区 | 文件 |
|---|---|
| Worker 中心主链 | `test/project/order.test.js`、`merge-queue.test.js`、`parent-delivery.test.js`（父自有队列顺序/执行位/暂停重排/取消与精确恢复）、`delivery-compatibility.test.js`（重复交付/代码依赖/旧 v2 审计与 Git/DB 窗口/源漂移）、`delivery-review.test.js`（拒绝非法 sender 无副作用、busy 挂起/取消真实自动唤醒、父前进后精确恢复读模型）、`task-signals.test.js`、`task-centered-graph.test.js`、`lifecycle.test.js`、`scheduling.test.js`、`preempt.test.js`、`progress.test.js`、`progress-history.test.js`（形状变化/用户输入交付边界/重复与重启/冻结计时/RPC分页与权限）、`test/web/progress-history-api.test.js`（HTTP游标/inspect首屏/关闭开关/窄路由）、`recovery.test.js`、`limits.test.js`、`agents.test.js`、`status.test.js` |
| Worker 彻底删除入口 | `test/worker-delete-api.test.js`（用户权限、确认/revision 与 CLI 两步预检）、`test/web/worker-delete-api.test.js`（登录/Origin/参数边界与真实临时 Git 项目 HTTP→RPC→资源清理联调）；后端与 DOM 回归由各自分区维护 |
| 公开面契约 | `test/core-api.test.js`（RPC 白名单）、`test/help-guard.test.js`（帮助与命令面）、`test/web/core-api.test.js`、`test/worker-api.test.js`（Worker 权限/严格参数、迭代 envelope）、`test/worker-cli.test.js`（命令映射/非法参数/帮助）、`test/web/worker-api.test.js`（HTTP→Dispatcher 接缝）、`test/web/dom-iteration.test.js`（共享迭代动作） |
| Git / worktree | `test/workspaces/{naming,merge,cleanup,genealogy,anchor,archive,branch-diagnostics,branch-first,safety,task-squash}.test.js`（task-squash 核验精确凭据、双 ref 事务、guard、dirty/drift 与失败保留现场）；`safety` 直接验证通用 Git 安全门、历史展示 worktree 保留与 DB 附属数据只读兼容 |
| 服务重启 | `test/service-restart.test.js`、`test/web/service-restart.test.js`、`test/integration/service-restart.test.js`（idle 准入、鉴权/路由、真实进程所有权） |
| main 版本迭代 | `test/workspaces/version-history.test.js`（SHA-256/Unicode/配置与环境隔离）、`test/project/version-history.test.js`（真实第一父链/多轮交付/历史证据/伪标题/分页/安全大小/无 main）、`test/web/version-history-api.test.js`（RPC 权限/窄参数/认证/Origin/多项目隔离） |
| Web 读面与安全 | `test/web/{security,assets,read-models,project-route,core-studio,multi-project,launcher}.test.js`；assets 以一次模块图加载冒烟验证资源/CSP，并保留启动与供应资源契约 |
| Web DOM | `test/web/dom-*.test.js`（各自 `boot()`）；模型来源真实 Firefox 专项：`bun run ./test/web/check-model-sources-browser.js`（1440/900/640/390/320px、双主题、右侧操作列、重置倒计时无裁剪、信息无重叠、详情→编辑→返回）；需 Firefox/geckodriver，仅临时 fixture、不连接用户 daemon |
| 选择快照停用 | `test/choice-snapshot-api.test.js`（RPC/CLI 不再开放）、`test/web/choice-snapshot-api.test.js`（单项目/工作台拒绝旧入口）、`test/web/choice-snapshot-flow.test.js`（真实 HTTP→RPC→问卷答复不再快照，历史与代码不变）；Runtime 与 DOM 分区覆盖正常问卷及历史资源保护 |
| Notice 记录与提醒 | `test/project/{notice-page,notice-info,lifecycle-notice,notice-lifecycle-type,questionnaire}.test.js`、`test/web/{notice-records,notice-notifications,lifecycle-notice-api,overview-lifecycle-notices,dom-lifecycle-notices,settings,questionnaire}.test.js`；真实 Firefox 独立临时 fixture：`bun run ./test/web/check-notice-banner-browser.js`（精确桌面/390px 视口、WebDriver 原生触摸）与 `bun run ./test/web/check-notice-interaction.js`（CSP、键盘/PointerEvents）；两者需 Firefox/geckodriver，不连接用户 daemon |
| 执行详情代码阅读 | `test/workspaces/code-reader.test.js`（真实临时 Git 工作区、基线/净变化、ignored/链接/外部程序/大文件/历史降级、受阻路径明确失败、长转义路径的字节分页及真实 RPC 帧预算）、`test/workspaces/code-posix.test.js`（真实 openat/readlinkat、换链竞态、FD 回收/CLOEXEC 与 Darwin loader 契约）、`test/web/code-reader-api.test.js`（用户权限、窄参数、认证、Origin、多项目路由） |
| 执行过程阅读 | `test/transcript*.test.js`、`test/web/{transcript-reader,dom-transcript-reader,dom-transcript-view,dom-results}.test.js` |
| Agent 状态与旧存档 | `test/agent/status.test.js`（假 Pi/Codex 软件版本、路径、安全错误与单飞）；`test/project/{agent-usage,agent-usage-provider,codex-usage-history}.test.js`（退役旧查询/采样、只读存档、配置与历史不改写）；`test/web/{agent-status-api,agent-usage-api,dom-agent-status,dom-agent-usage}.test.js`（用户鉴权/项目路由、version 2 软件诊断、按需只读存档与迟到响应）。旧 `usage-query/usage-settings/codex-usage-parsing/usage-auth-codex` 独立 mock 测试仅验证内部兼容适配，不重新开放旧产品查询 |
| 项目出站网络 | `test/agent/{network,network-accounts}.test.js`（私有设置、快照、真实 HTTP/HTTPS CONNECT 与 TLS/取消/压缩、全部账号请求链路）、`test/project/network.test.js`（单飞/子进程环境）、`test/web/{network-api,network-cli-flow,dom-agent-network}.test.js` 与 `test/agent-network-cli.test.js`（安全权限/路由、真实 CLI→RPC→HTTP 私有配置联调、仅写认证与迟到保护） |
| 托管账号连接与设备码登录 | `test/agent/connections{,-device}.test.js`（固定协议、一次兑换、间隔/限流、取消与迟到防护）、`test/project/agent-connections-manager.test.js`（真实私有文件与项目准入）、`test/web/{agent-connections-api,codex-device-login-flow,dom-agent-connections}.test.js`（权限/安全投影、真实 HTTP→RPC→Manager 联调、页面自动确认与离页清理）；上游均 mock，不读取真实账号 |
| 运行设置与 Agent | `test/runtime-settings.test.js`、`test/config*.test.js`、`test/agent-settings.test.js`、`test/soft-budget.test.js` |
| 本地性能报告契约 | `test/read-performance.test.js`（参数 / 统计 / 原样本预算 / 输出不覆盖 / Git 身份与降级；不在通用套件重复运行大规模测量） |
| 通用命令与 main 推送示例 | `test/project/hooks-command.test.js`、`hooks-command-invocation.test.js`（真实临时 bare remote、连续触发、冻结等待、失败/unknown 禁重放、输出/进程组/凭证及 invocation 排他）；`test/web/hooks-command-integration.test.js`（真实 HTTP→RPC→Runtime→临时 Git remote，默认关闭、同源 revision、编辑/副本/模板隔离、失败停用及删除不重装）；`test/web/dom-hooks-command.test.js`（命令授权、同源编辑与安全结果、迟到响应、独立 revision 与停用复制） |
| 定时信号与管理跨层联调 | `test/web/hooks-management-integration.test.js`：浏览器时间转换→HTTP→真实 RPC→受控 Pi bridge→安全生命周期入口；无 Git/Input 副作用、配置保留、精确重复收据、私有投影与返回后的持久等待。仅临时项目／可控进程，不调用真实模型；接口与 DOM 分别见 `management-api.test.js`、`dom-hooks-management.test.js` |
| 测试环境隔离 | `test/helpers.test.js`（子进程 HOME/XDG 与全局/系统 Git 配置隔离、合成 hook/签名/环境污染及退出回收；生产 Git 环境不变） |
| 文档 | `test/docs-check.test.js`、`test/docs-search.test.js`、`test/markdown.test.js`、`test/mermaid-docs.test.js`、`test/web/docs.test.js` |
| 历史兼容与安全 | `test/project/order-compatibility.test.js` 覆盖旧类型只读投影、父类型、名称/路径/原话不变、混合类型唯一索引、父候选、派生、调度告知、历史落地证据与旧入口拒绝；`test/input-routes.test.js` 仅保留旧配置格式校验；`test/{butler,explainer}-provider.test.js` 保留无工具/无凭证隔离；`test/web/dom-merge.test.js` 保留旧 Notice 审批语义；历史记录读取、删除共享引用与交付恢复由各现行分区覆盖。旧 Candidate 命令、快速路由匹配、休眠批量交付面板和项目统计的成功路径测试已移除；拒绝旧公开入口由 core-api / help-guard 覆盖 |

`.github/workflows/code-reader-posix.yml` 仅手动触发，独立运行代码读取器的 Linux/macOS 聚焦回归，覆盖最低支持 Bun 1.2.0 和当前固定 Bun 1.4.2；无 native 包或编译步骤。触发方式见[贡献指南](../contributing/README.md#ci-触发方式)。Linux 本地通过不等于 macOS 实测，Darwin loader mock 也不能替代 macOS job 的结果。

`test/session-fixture.js` 提供纯文件读取的 `sessionFixture(extra?)` 与 `sessionFile(root,taskId,lines,name?)`，每例独立 Config/临时目录，不初始化 SQLite/Project；会话读取保留 UTF-8、截断、缓存、token 与链接拒绝覆盖。HTTP 执行记录直接创建现行 Worker 行，不为只读投影创建仓库或 worktree。退休流程成功路径与重复接口矩阵已移除，拒绝旧入口、安全权限和真实 Git 交付覆盖仍保留。

`test/helpers.js`、`test/dom-stub.js` 是被多个文件共用的**公共面**：保持公共签名兼容，改签名会同时影响所有分区。`helpers.env(extra)` 与 `git(root,...args)` 为测试子进程隔离 HOME/XDG、全局/系统 Git 配置及继承的 `GIT_*`；`extra` 可显式注入受控配置，不修改进程级环境或生产 Git 行为。直接自建环境/spawn 的测试需自行隔离。

---

[← 上一篇：Web 前端](modules-web.md) · [返回模块地图总览](modules.md)
