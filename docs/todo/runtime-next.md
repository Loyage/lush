# 运行时资源与异常恢复：下一批方案草案

本文回答“用户已选择优先调查的运行时工作包应怎样落地”，面向维护者与后续实现者。**这是方案草案，不是已批准实现**：用户 Notice #77 只批准本批调查与方案设计，预算数字、公共 API、平台依赖与支持政策仍须逐项确认。逐项事实与历史证据仍由[运行时专题](01-runtime-persistence.md)、[Git 专题](02-git-worktrees.md)与[安全专题](03-security-boundaries.md)维护。

- 草案基线：`16e3955`（父 Worker `lush/7ad50d4a9d/input-54`）。原始草案只读定位代码、工程契约与临时 fixture 量测。用户在 Notice #81 逐项确认全部推荐方案后，本批已在后续提交实现并合入开发分支；各节顶部“已实现”为落地后状态，**尚未进入 main**。未安装依赖、未启停用户服务。
- 已读：[执行过程理念](../design/agent-process.md)、[invocation](../engineering/invocation.md)、[Token 效率](../engineering/token-efficiency.md)、[身份与恢复](../engineering/identity-and-recovery.md)、[回收](../engineering/cleanup.md)、[模块地图](../engineering/modules.md) Runtime / CLI、RPC / 测试分章。
- 量测（临时 fixture，单进程，本机 Linux/Bun 1.4.2，非生产 SLA）：400 Run + 400 个 30 KB Artifact + 100 条 32 KB 未读消息时，`runsForTask` 读回 **400 行 / 1.69 MB**、`artifactsForTask` **400 行 / 12.1 MB**；`inspect` 只保留**最早的** 47 个 Run 与 6 个 Artifact（静默丢掉最新记录），响应 573 KB、耗时 23 ms；`unread` 一次读回 **100 行 / 3.21 MB** 并整体写入启动 JSON。脚本在 `/tmp/lush-r0706/probe.mjs`，非仓库交付。
- R-03 探针（`/tmp/lush-r03/`）：父进程持 stdio 管道并 `SIGKILL` 后，带 stdin-EOF 监护的孙进程停止写入且监护自身退出；无监护的 `detached` 对照继续写入（29→49 字节），复现“宿主强杀留下外部进程”。仅验证 Linux，未测 macOS。

## R-03 · 宿主死亡后的 agent 清理（已实现）

- **已实现（2026-10-02）**：按下面推荐方案落地 `bin/lush-agent-guard` + stdin EOF 监护；契约登记在[模块地图](../engineering/modules-runtime.md)，回归见 `test/agent/guard.test.js` 与[运行时专题 R-03](01-runtime-persistence.md#r-03--宿主被强杀后detached-agent-仍能继续修改工作区)。仅验证 Linux，未测 macOS。
- **推荐（零第三方依赖、macOS/Linux）**：daemon 以 `detached: true` 启动内部监护进程 `bin/lush-agent-guard`，其 stdin 是 daemon 持有的管道；监护在同一进程组内启动真正的 pi/codex，转发 stdin 之外的 stdout/stderr 与退出码；stdin 收到 EOF（daemon 任意退出，含 SIGKILL）即在有界时间内 `SIGKILL` 自己的进程组并退出。daemon 现有 `kill(-pid)` 与 preempt/`turn_end` 语义不变；监护只处理“宿主没了”这一种情况。
- **语义边界**：只清理自己启动的进程组，不按历史 PID 杀进程，不做进程名匹配，不写跨重启的 PID 表；daemon 正常 stop 仍先走现有 abort → finally 路径，监护只是兜底。监护不改变 stdout/退出码，`AgentPreempted` 与抢占标记文件（`<home>/preempt/`）不受影响。
- **平台依赖**：stdin EOF 与进程组在 macOS/Linux 可用；daemon 不承诺 Windows 本地运行（Windows 是远程客户端），因此不要求 `PR_SET_PDEATHSIG`。新增 `bin/` 入口属于公开面，需由父在模块地图登记后实现。
- **备选**：仅补文档并保留已披露限制；或 Linux 专用 `prctl(PR_SET_PDEATHSIG)`（不跨平台，不推荐）。
- **回归验收**：`test/agent/guard.test.js` 用伪 agent（写 pulse 的 bun 子进程）覆盖宿主 SIGKILL、SIGTERM、异常退出、包装命令提前退出；断言宿主死亡后写入在有界时间内停止、只清理自己的进程组、无残留 pulse 进程；`test/project/recovery.test.js` 继续证明不重放、不伪造成功；现有 preempt/超时/取消用例不回归。
- **旧兼容 vs 新保证**：旧的“重启不重放未知副作用”不变；新保证是“daemon 死亡后不再有脱离管控的同项目 agent 长时间写盘”，不保证精确的副作用回滚或 exactly-once。

## R-06 · 未读 inbox 的总量预算（已实现）

- **已实现（2026-10-02）**：按下面推荐方案落地 `Store.unreadPage` + `messages_page` 分批、用户消息优先 + FIFO、原文整体投递；回归见 `test/project/token-efficiency.test.js` 与[运行时专题 R-06](01-runtime-persistence.md#r-06--因果上下文已收敛但未读-inbox-没有总量预算)。
- **推荐**：读取端分批。`Store` 新增 `unreadPage(taskId, {limit, bytes})`，按 id 升序返回 `{messages, has_more, pending, bytes}`；`invoke` 只把这一批交给 provider，并在启动 JSON 增加 `messages_page:{delivered,has_more,pending,truncated_bytes}`，让 Agent 知道 inbox 未清空。
- **FIFO 与紧急消息**：不冲突，二者都要满足——默认 **FIFO（id 升序）**，但当预算被运行时信号占满而仍存在用户消息（`sender_id IS NULL`）时，**先纳入全部用户消息（仍按 id 升序），再用剩余额度按 FIFO 填充其它消息**；`messages_page.reordered:true` 如实标注本次顺序调整。理由：merge 回执不唤醒 Worker，若排在用户指令前面，用户指令要多花 N 次模型调用才能抵达。备选：严格 FIFO + 依赖重复唤醒（简单但可能让用户指令饿死）；或维持现状全量（拒绝）。
- **预算数字（待确认）**：`limit = 50` 条、`bytes = 262144`（256 KiB）为默认，可按 invocation 覆盖。单条上限仍是既有的 32000 字符；**超预算的单条原文整体投递、绝不截断或摘要**（`oversize:true`），宁可一次 invocation 只送一条。
- **消费与唤醒语义**：只有本批已投递的 id 在调用成功的同一事务里标 `consumed`；未投递原文保留。消费后若仍有可执行未读消息，`invoke` 的 finally 已会 `wake`，与本次分批一致，不新增唤醒通道；`has_more` 不改变等待/待决判定，`parkForQuestion` 仍只消费本轮已投递集合，二次投递由恢复路径自然完成。纯 `merge-v2` 回执仍不单独唤醒（现状）。
- **实现边界**：`store/messages.js`、`core/project/scheduling.js`（invoke）、`agent/provider.js`（`sessionFiles` 写 `messages_page`），不新增实体/表，不改 `hasActionableMessages` 的判定口径；文档更新 token-efficiency 与 modules-runtime。
- **回归验收**：新增 inbox 预算回归——大 inbox 首批与启动文件有界；第二批原文完整、无摘要；超长单条整体投递；仅交付项被消费；分批后 park/回答/失败重试/父子唤醒均无 lost-wakeup 且不再空转；记录 invocation 次数增加的代价。

## R-07 · 调度与详情读面的剩余全历史读取（已实现）

- **已实现（2026-10-02）**：按下面推荐方案的 additive 版落地：`Store.runsPage` / `artifactsPage` 最新窗口 + `before` 游标；`inspect.runs` / `artifacts` 改最新 50 条并附 `runs_page` / `artifacts_page`；新增只读用户 RPC `worker.runs_page` / `worker.artifacts_page` / `worker.artifact`。落地细节、回归与剩余限制见[运行时专题 R-07](01-runtime-persistence.md)。Web 未新增路由（无消费者），保留旧字段与历史行。
- **现状（历史）**：调度依赖与直接孩子已按 ID 限定（前一轮修复）。剩余问题在 `inspect`：`runsForTask`/`artifactsForTask` 先全表读取再 `bounded()` 截断，且**保留最旧、静默丢弃最新**，没有 `has_more`。
- **推荐（additive）**：Store 新增 SQL 级窗口 `runsPage(taskId,{before,limit})` / `artifactsPage(taskId,{before,limit})`，读**最新**窗口（`ORDER BY id DESC LIMIT n+1` 后再升序返回）。`inspect` 的 `runs`/`artifacts` 字段保留，但改为最新窗口，并附 `runs_page`/`artifacts_page:{has_more,cursor,limit,truncated}`；新增只读用户方法 `worker.runs_page` / `worker.artifacts_page`（`before?`/`limit` 1..200，默认 50）供继续读取。Artifact 窗口的 `payload` 只投影前 8192 字节并标 `payload_truncated`，新增只读 `worker.artifact(id)` 读取完整 payload（既有 512 KB 上限不变）。
- **备选**：只修窗口与元数据、不新增方法（旧证据只能查库，Web/CLI 无法继续读）；或维持现状（已证明会丢最新证据，不推荐）。
- **性质**：字段保留 + 内容改为“最新窗口”是行为修正而非删除；旧客户端仍能渲染，但需在文档明确“首屏是最近记录，历史要分页”。不做数据迁移、不重写历史 payload。
- **回归验收**：固定活动 DAG，历史扩到 1k/1w 条时，`inspect` 的 SQL 读取行数与响应字节有上界且包含最新 Run/Artifact；继续分页游标稳定、无重复无跳过；单 Artifact 完整读取与 512 KB 上限；`pass`/`unknown` 验收投影与 Candidate 历史读面不回归；附读取行数/字节对照记录。（已实现，回归见运行时专题。）

## G-04 · 子树归档的部分失败与显式续办（已实现）

- **已实现（2026-10-02）**：逐条磁盘结果回报、`{archived,failed,remaining}` 返回与 `branch archive --continue` 已落地；回归见 `test/workspaces/archive.test.js`、`test/branch-archive-cli.test.js` 与 [Git 专题](02-git-worktrees.md)。
- **推荐（不新增实体）**：`archiveBranches` 增加 `onOutcome` 回调，每条分支的实际磁盘结果（worktree removed / ref deleted / discarded / reason）**逐条**回报；`Project.archiveBranch` 在同一路径上按回报更新该分支与 Worker 行（`workspace=null`、`branch.archived` 事件），使库与磁盘一致。发生未预期失败时不抛掉已完成部分，而是返回 `{archived:[...], failed:[{branch,reason}], remaining:[...]}`，并写一条 `branch.archive` 事件记录 `targets/completed/failed`。
- **显式续办**：子树根已 `archived` 而仍有活动后代时，允许 `branch.archive {branch, continue:true}`（CLI `branch archive BRANCH --continue`）从 `branches.parent` 事实重算剩余活动后代并继续；没有未完成后代时给出明确“无剩余”结果，不重复归档、不报“already archived”错误。已知拒绝条件（locked / prunable / 已初始化 submodule / 主检出 / 脏工作区未 `--discard`）仍在**任何删除前**整树预检。
- **备选**：持久预约/新实体（不必要，现有事件 + `branches` 谱系 + `tasks.workspace` 已能表达事实）；或维持“抛错 + 手动逐条”，但必须仍修掉库/磁盘不一致。
- **回归验收**：已锁定后代仍在删除前整树拒绝；第二遍注入失败时逐条结果与磁盘一致、已完成分支不再是 `active`、失败项可 `--continue`；续办幂等、不重复删除、不做 force 绕过锁；已有“脏后代零副作用”与 subtree 用例保留。

## S-05 · RPC 连接的输入与回包预算（已实现）

- **已实现（2026-10-02）**：每连接在途/待写预算、暂停读取与高水位断开、未执行/结果未知错误区分已落地；回归见 `test/rpc-budget.test.js` 与 [HTTP 参考](../reference/http.md)。
- **现状**：单帧 1 MiB 与逐连接串行有效；但连接可无限堆积已入队帧（每帧都会**先执行**）与未写出回包（`createWriter.queue` 无字节预算）。
- **推荐**：每连接 `inFlight` 计数与待写字节预算。`MAX_IN_FLIGHT = 32`（低水位 8）与 `MAX_PENDING_OUTPUT_BYTES = 8 MiB`；达到高水位即 `socket.pause()`（Bun listen socket 已确认提供 `pause/resume`），降回低水位再 `resume()`。高水位持续 30 秒仍不收敛（对端不读）则关闭连接。
- **“未执行”与“结果未知”必须分开**：**暂停读取时尚未解析的帧从未执行**，恢复后正常处理；无法继续时用专用错误码回复这些帧 `connection queue full; request was not executed`（可安全重试）。**已派发但回包未送达**只发生在强制关闭，语义是“结果未知”，客户端不得自动重试修改类方法——现有 `RPCClient` 的超时文案已要求先检查，回包丢失时保持同一口径。
- **正常最大回复**：单帧上限 1 MiB 不变；`MAX_PENDING_OUTPUT_BYTES` 远大于一次最大帧，正常大响应（含分页后的 `inspect`）完整交付；预算只约束“对端持续不读”的积压。R-07 分页与 S-05 预算相互独立，不互相替代。
- **实现边界**：`rpc/server.js`、`socket_io.js`（字节计量与 `highWater` 回调）、`rpc/client.js`（错误码文案）；不改 RPC 白名单、不自动重放、不加全局背压开关。文档更新参考/http 与 invariants。
- **回归验收**：可控慢 socket 下，不读响应的连接内存与排队量有界；超限帧被拒且**未执行**（无副作用断言）；恢复 drain 后正常请求继续；关闭语义区分未执行/结果未知；正常 1 MiB 级大响应完整交付。

## 已确认的选择（Notice #81，2026-10-02）

用户逐项选择了以下推荐项，本批已按此实现：R-03 内部 guard 进程兜底；R-06 用户消息优先 + FIFO、50 条 / 256 KiB；R-07 新增分页方法 + 最新窗口；S-05 暂停读取 + 高水位断连（32 帧 / 8 MiB）。数字先作为固定默认，未公开为可配置 API；后续若需调整需另议。

## 明确不做

不丢未投递消息、不以摘要冒充原文、不自动重放结果未知的修改、不按历史 PID 盲杀进程、不用 force 清理用户现场、不迁移或重写历史数据、不新增跨项目实体；预算数字、公共 API、依赖与平台支持须先取得用户确认再实现。
