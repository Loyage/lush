# 运行时、调度与持久化改进建议

本文供维护者筛选生命周期可靠性、SQLite 一致性与运行成本的后续工作；只记录审查建议，不实施功能。实现范围为 `src/core/project/`、`src/persistence/`、`src/daemon/`、`src/agent/`，不评价 Git 合并策略、公网或 Web UI。

## 范围、基线与验证

- HEAD 与指定基线完全一致：`99fcbc993640c057488532a19ca08814ab60b73e`；开始时工作区干净，唯一交付为本文，无提交、合并或推送。
- 已阅读 [开发约定](../../AGENTS.md)、[文档约定](../contributing/documentation.md)、[模块地图](../engineering/modules.md)、[Runtime 分章](../engineering/modules-runtime.md)、[接口与测试分章](../engineering/modules-interfaces.md)、[执行过程理念](../design/agent-process.md)、[Token 效率](../engineering/token-efficiency.md)。
- 方法：静态调用链检查、已有回归、临时 SQLite fixture、受控进程/竞态门；没有真实模型调用，没有接触真实项目 `.lush`、密钥或用户 daemon。实验进程和临时文件已清理。
- 已执行 `git rev-parse HEAD`、`git status --short`；`bun run doctor --project <临时 fixture>` 返回当前 worktree 身份、mock provider、该临时项目无 daemon，退出码 0。
- 已执行 `bun run test test/project/scheduling.test.js test/project/recovery.test.js test/project/lifecycle.test.js test/project/questionnaire.test.js test/project/token-efficiency.test.js test/soft-budget.test.js test/task-clear.test.js test/task-delete.test.js`：37 通过、0 失败。
- 已执行 `bun run test test/integration/shutdown.test.js test/usage-attribution.test.js test/project/specs-queue.test.js`：9 通过、0 失败；`bun run test test/project/agents.test.js`：4 通过、0 失败；合计 50 项通过，不代表全套测试。
- 已执行 `bun run /tmp/lush-runtime-audit.BmwTjp/repro.js` 与 `bun run /tmp/lush-runtime-audit.BmwTjp/process-repro.js`：分别 5 项 fixture 复现、2 项受控进程复现通过；脚本不作为仓库交付，关键重建步骤见各条。
- Worker 已执行 `bun run docs:check`：53 篇 Markdown 检查通过；`git diff --check` 通过。估算 S/M/L 表示小/中/大型工作，非工期承诺；汇总后的复核记录见[审查索引](README.md)。

## R-01 · 清空跨越异步回收后，会删除期间新接收的数据

**P1 · 已复现 · M**

- **证据**：`src/core/project/lifecycle.js` 的 `clear()` / `reclaimThenPurge()`（126–146 行）只在首次检查活动任务，随后两次 `await`；`src/persistence/store/tasks.js` 的 `purge()`（43–55 行）最终无条件清全表，并不使用开始时的对象集合。
- **最小复现**：空 fixture 中依次执行 `const p=project.clear(); project.draft('新输入'); await p`，草稿先成功返回且可读，随后数量从 1 变成 0；不需要模拟 Git、损坏数据库或运行 agent。
- **触发与影响**：多个客户端在清空回收期间提交草稿/输入或重试。RPC 仅同连接串行，不同连接并发；新草稿丢失已复现，新任务被清除及收尾异常是同一无条件 purge 的进一步风险，未做破坏性端到端试验。
- **现有保护/反例**：调用开始时的活动任务、正在收尾 invocation、busy worktree 确实会拒绝清空；这些回归已通过，但不能保护 `await` 后的新写入。
- **建议与取舍**：需确认清空语义：A，短期维护门暂拒新写入并说明可重试；B，只清请求时快照，事务内重新校验其状态/引用，保留新输入。不得跨异步 Git 工作持有 SQLite 写事务；定向删除同样应复查异步后的状态。
- **验收**：给回收设置可控等待门，同时发送 draft、submit、retry；每个成功返回的新增对象必须保留，或入口明确拒绝，不能返回成功后被无条件删除；原有安全门继续通过。

## R-02 · 陈旧 daemon 锁的回收存在双持有竞态

**P1 · 已复现（锁原语） · L**

- **证据**：`src/daemon/locking.js` 的 `DaemonLock.acquire()`（46–65 行）先读旧 PID/检查存活，再按路径 `rmSync`；检查与删除不是同一个原子操作。
- **最小复现**：临时目录写入确认不存在的 PID；进程 A 在第 62 行删除前暂停，B 完整回收旧锁并获得新锁，再恢复 A。两进程均成功从 `acquire()` 返回且仍存活，最终锁文件只记录 A；只包装 A 的文件删除加门，没有运行双 daemon。
- **触发与影响**：异常退出留锁后，两个启动入口并发恢复。两个宿主可能同时操作同项目数据库/任务，进程内 Git 串行和 invocation Map 不再互斥；完整双 daemon 的后果未在真实环境执行。
- **现有保护/反例**：首次 `linkSync` 原子创建及发现活 PID 后拒绝都是有效保护；漏洞仅在 stale-owner 检查和按路径删除之间，增加一次 PID 读取仍留下 TOCTOU。
- **建议与取舍**：先确认零依赖、平台支持要求，再选择可用的内核锁，或有可证明互斥性的陈旧锁回收协议；不能把重试次数提高当作修复，也不能靠强杀未知 PID 清场。
- **验收**：固定上述交错并执行多进程压力测试，任何时刻至多一方获锁；崩溃后仍能恢复，旧持有者释放不能删除新锁，PID 复用时不误杀。

## R-03 · 宿主被强杀后，detached agent 仍能继续修改工作区

**P1（按潜在影响）· 已复现（真实 provider + 伪 agent）· 已知限制的加固建议 · M**

- **证据**：`src/agent/provider.js` 的 `spawnAgent()`（30–64 行）使用 `detached:true`、stdin ignore，清理仅在宿主收到 abort 或执行 finally 时发生；`src/daemon/main.js` 的 `serve()`（27–34 行）依赖 finally 调用 shutdown。
- **最小复现**：临时宿主通过实际 `PiProvider` 启动只向临时文件写 pulse 的伪 Pi；SIGKILL 宿主后，子进程仍存活且 pulse 持续增加。实验末手动清理该已知进程组，未使用真实模型或用户 daemon。
- **触发与影响**：daemon 崩溃/被强杀时，已启动的 agent 或工具可能继续写文件、消耗模型费用；新 daemon 将任务标失败后，用户显式重试还可能与旧进程同时写同一目录。
- **现有保护/反例**：正常 stop 会杀进程组，集成回归已通过；重启清空 token hash 能阻止旧进程调用 RPC，却不能撤销其文件系统权限。[项目身份与恢复](../engineering/identity-and-recovery.md)已明确披露 SIGKILL 可能留下外部进程，因此本项是已知限制的加固机会，不是新发现的承诺违约；“重启不自动重放”本身是正确边界。
- **建议与取舍**：为普通 agent 增加独立的父进程死亡监护，可参考 `src/core/preview-runner.js` 的 stdin EOF 监护（1–31 行）；跨平台使用监护进程或 OS 生命周期机制需确认，不能只持久化 PID 后盲杀。
- **验收**：覆盖 SIGTERM、SIGKILL、异常退出、包装命令提前退出；只清理自己启动的 agent/孙进程，宿主死亡后写入在有界时间内停止，恢复仍不得自动重放任务。

## R-04 · 恢复只结算 Task，遗留 Run 永远显示 running

**P2 · 已复现 · M**

- **证据**：`src/core/project/lifecycle.js` 的 `recover()`（248–264 行）修复 Task/凭证/合并状态，但没有修复 `agent_runs`；`src/persistence/store/runs.js` 的 `startRun()` / `finishRun()`（107–118 行）是独立写入；`src/core/project/scheduling.js` 的 `invoke()`（113–115 行）建 Run 与改 Task 也不在同一事务。
- **最小复现**：fixture 创建 Run 并把 Task 置 running，模拟新宿主空 running Map 后执行 recover：Task 为 failed，Run 仍为 running、`ended_at=null`。
- **触发与影响**：任何未走 finally 的中断都可能造成持久状态不一致；`src/core/usage-attribution.js` 的 `usageAttribution()`（5–10、26–30 行）把无 ended_at 的区间延伸到 Infinity，后续历史时间匹配可能重叠并变 unknown。
- **现有保护/反例**：正常调用收尾会 finishRun，Task 不重放及 inbox 修复测试也通过；新增显式 run 身份的用量记录不依赖时间猜测，不能说所有用量归因都已错误。
- **建议与取舍**：恢复时事务性关闭遗留 running Run，记录“恢复时确认中断”，不要伪造准确的实际停止时刻；同时原子化 Run 建立与 Task 准入状态。兼容历史展示，不迁移或重写已完成 Run。
- **验收**：在 startRun 后、Task 更新后、park 后注入崩溃快照，恢复后不存在无主 running Run；重复恢复幂等，不重放任务，未送达消息仍保留，后续重试区间不会被旧 Run 无限覆盖。

## R-05 · 暂时达到活动任务上限，被当成永久计划编译错误

**P2 · 已复现 · M**

- **证据**：`src/core/project/tasks.js` 的 `materializeSpec()`（72–95 行）在活动任务达到 1000 时抛错；`src/core/project/specs.js` 的 `compilePlans()`（14–41 行）捕获所有错误后直接 dropSpec，依赖它的 spec 也会被丢弃。
- **最小复现**：fixture 放置 999 个活动任务与一个已完成 planner，后者有两个合法 research spec；调用 compilePlans，第一项 planned，第二项 dropped，原因是 `计划编译失败：too many active tasks`。
- **触发与影响**：多个大输入或大量等待任务叠加；后续容量释放也不会继续编译被 dropped 的合法需求，需要重新组织计划，已支付的规划成本无法直接复用。
- **现有保护/反例**：1000 上限是合理资源边界，编译事务回滚和失败事件也确实存在；问题不是静默丢记录，而是把可恢复背压与结构错误放在同一永久失败分支。
- **建议与取舍**：需确认采用保留 pending、容量释放再准入，还是显式失败但提供无模型重编译入口；无论哪种，都应区分容量不足和非法依赖，不取消上限，也不让一批阻塞其他可执行工作。
- **验收**：在 999/1000 边界编译多批 DAG，容量恢复后合法项可继续或可明确重试，无重复 Task/依赖边；非法/已 dropped 的依赖仍不能运行。

## R-06 · 因果上下文已收敛，但未读 inbox 没有总量预算

**P2 · 已复现（输入规模） · M**

- **证据**：`src/persistence/store/messages.js` 的 `unread()`（4 行）读取全部未读消息；`src/core/project/scheduling.js` 的 `invoke()`（104、135–138 行）整批传给 provider；`src/agent/provider.js` 的 `sessionFiles()`（13–23 行）原样序列化 messages，没有总字节上限。
- **最小复现**：等待中的任务通过公开 `project.message()` 接收 100 条各 32,000 字符的合法消息；unread 一次返回全部 3,200,000 字符。未调用模型，因此不把实际 token/费用或模型超限当成已测结果。
- **触发与影响**：长 invocation 中积累追问，或失败/恢复后 inbox 堆积；下一轮启动文本可能远大于模型上下文并造成重复读取成本。Coordinator 合并成功回执也没有消息总数预算。
- **现有保护/反例**：单消息大小限制、子任务结果 2000 字符摘要、直接子任务 50 条上下文及只消费已投递消息都有效；Pi soft_budget 是响应后的一次提醒，不能约束首次 prompt，不应强改成硬停。
- **建议与取舍**：在读取端按消息数与字节预算分批，保留未投递原文和明确 has_more；预算、紧急消息优先级及是否允许摘要需要用户确认。禁止直接截断后把未读全集标 consumed，避免省 token 变成丢消息。
- **验收**：大 inbox 下首批读取/启动文件有界，每条消息最终按协议投递且仅投递项被消费；park、回答、失败重试、coordinator 合并唤醒均保持无 lost-wakeup，并量测 invocation 数增加的取舍。

## R-07 · 首页有界读之外，调度与单任务详情仍随全历史增长

**P2 · 已复现（读取规模；延迟待量测） · M**

- **证据**：`src/core/project/scheduling.js` 的 `pump()`（53–59 行）无条件 `depMap()`；`src/persistence/store/deps.js` 的 `depMap()`（24–35 行）已有 taskIds 参数但此处未用。`src/core/project/tasks.js` 的 `inspect()`（130–148 行）先 summaries 全表再筛直接孩子，Run/Artifact 也是全量读取后 bounded。
- **最小复现**：1500 个终态任务、1499 条历史依赖、零 queued 任务；记录 Store.all 返回规模：空闲 pump 仍取 1499 条边，inspect 一个无子任务叶子仍取 1500 条任务摘要。
- **触发与影响**：长期使用、频繁消息/结算 kick 或详情读取；同步 SQLite 查询和 JS 全量组装与历史量绑定，可能拖延取消/唤醒/超时回调。这里只确认读取规模，尚无生产延迟或 OOM 结论。
- **现有保护/反例**：overview 的聚合计数、分页和输出 bounded 不是失效；它们不能给上述数据库读取/JSON 解析提供内存上界，不能用返回包很小证明热路径廉价。
- **建议与取舍**：pump 先取待准入 ID，仅查这些任务依赖；inspect 按 parent_id 查询直接孩子。Run/Artifact 的 SQL 级预算及继续读取接口是公共 API 选择，需确认兼容策略，保留历史原文而非删记录。
- **验收**：固定相同活动 DAG，把历史扩至 1千/1万/10万，记录读取行数、分配量和延迟；空闲 pump 不读历史依赖，叶子 inspect 不扫描其他任务；大 Run/Artifact 有可继续读取且不误导为完整的有界窗口。
