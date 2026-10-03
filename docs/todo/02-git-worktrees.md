# Git / Worktree 与交付安全审查

本文面向维护者，检查代码隔离、交付冻结、回收安全与多分支成本；保留原审查证据，并逐项记录后续复核与实施。当前入口为 `src/core/workspaces/` 与 `src/core/project/`；Candidate 为历史兼容，Showcase 已删除，不能把旧模块名单当成现行产品面。

## 当前复核（2026-10-02）

复核基线 `81257d12e3001214e7f03bc4ee2398f834e35ee3`；设计入口没有独立 Git 理念，按模块地图 / Runtime 分章、Git 边界、回收契约确认取舍，不自行改变批准、源侧解分歧或历史兼容边界。

| 条目 | 当前结论 | 本轮行动 / 后续 |
|---|---|---|
| G-01 | 原缺陷已修复 | branchResourceUsers 保留输入锚点 / verifier / 未收尾资源准入；不再套用已删除 Showcase 功能 |
| G-02 | 原最低核验已修复，且 Candidate 已无公开创建 / 调度入口 | 保留历史代码；不引入新 detached Candidate 验收产品 |
| G-03 | 外部并发已知限制，本轮完成侦测错误成功的加固 | ff-only 后复核真实目标 ref / 检出身份 / HEAD / clean；不 reset，不承诺消除外部 checkout 竞态 |
| G-04 | 已完成预检及部分失败续办 | 全子树删除前预检；逐项回写磁盘结果，并允许显式 `--continue` |
| G-05 | 历史兼容缺陷，本轮补显式清理与 invocation 收尾 | Candidate baseline 与普通 verifier 一样回收；不恢复旧自动调度 / verifier 产品入口 |
| G-06 | 已关闭 | 展示 / 图准入投影已删除，无现行成本路径 |

**验证**：Git 变更全部在测试临时仓库；未操作用户 daemon、外部工作区或密钥。定向 5 文件 **50 pass / 0 fail**（完整日志 `/tmp/lush-review-104/targeted-rerun.log`）；完整 `bun run test` **1108 pass / 1 fail / 1 error**，阻塞为缺少打包开发依赖 `@electron/asar`，完整日志 `/tmp/lush-review-104/full.log`，不宣称全套成功。首次定向 45 / 2 的失败来自新测试误用 decorate 前字段及依赖英文 Git 错误；修正断言后完整重跑通过，首次日志 `/tmp/lush-review-104/targeted.log`。

**剩余待决项**：G-03 保持「禁止外部并发 + 检测漂移」边界，或设计更强 checkout 隔离 / 协作锁（跨平台、行为变化均需确认）。

2026-10-03 核对 `8dbde1b`：G-04 已按 Notice #81 实现逐项结果回写、`{archived,failed,remaining}` 返回及显式 `branch archive --continue`，不再待决；现行契约见[工作区与分支回收](../engineering/cleanup.md)，回归见 `test/workspaces/archive.test.js` 与 `test/branch-archive-cli.test.js`。下文较早实施记录仅为历史。

## 原审查范围、基线与验证（历史证据）

- HEAD：`99fcbc993640c057488532a19ca08814ab60b73e`，与指定基线一致；审查前工作树干净。
- 已读 [模块地图](../engineering/modules.md)、[Runtime 分章](../engineering/modules-runtime.md)、[接口与测试](../engineering/modules-interfaces.md)、[设计入口](../design/README.md)、[文档约定](../contributing/documentation.md)，并核对 [Git 边界](../engineering/git-boundary.md)、[回收](../engineering/cleanup.md)、[合并](../engineering/merge.md)、[验收闭环](../engineering/review-loop.md)。设计入口暂无 Git 专题，未自行增设产品原则。
- 方法：静态阅读 + 仓库现有测试 + 临时 fixture 确定性交错；所有 Git 写操作仅在测试临时仓库，无真实 daemon 连接、启停或密钥读取；未安装依赖、未 commit / merge / push 审查工作树。
- 已执行 `git rev-parse HEAD` / `git status --short`：基线一致、初始无改动。
- 已执行 `bun run test test/workspaces test/project/candidates.test.js test/project/showcase-eligibility.test.js test/project/showcase.test.js`：**78 pass / 0 fail，514 assertions**；`bun run docs:check`：53 篇 Markdown 检查通过。
- 已执行 `bun run /tmp/lush-audit-git-probes.js`：复现 G-01～G-06；使用 `test/helpers.js` 的 `fixture/repo/git`，mock provider、临时 Git 仓库、受控方法拦截；每例 `finally` 关闭项目并删除 fixture，临时脚本已删除。下列条目保留可重建的关键步骤与观测。
- 反例核验：已有测试覆盖脏主树拒绝合并、失败Worker已提交成果保留、Candidate 串行队列内只落冻结提交、迟到 verifier 不覆盖决策、Showcase 预览阻止清理；带双引号 worktree 路径探针正常，不列为缺陷。
- **不作为缺陷**：人工最终批准、分歧在子侧解决、显式 `archive --discard` 放弃代码、重启不自动重放未知副作用；以下问题与这些合理边界不同。

## G-01 归档准入漏掉实际使用输入工作区的活动Worker

**P1 · 已复现 · 预估 M · 已完成（2026-09-26，提交 `a8c1699`）；2026-10-02 复核：原缺陷修复保留**

- **当前依据**：`project/branches.js` 的 branchResourceUsers / archiveBranch 仍检查 branchless 输入锚点使用者、检验服务对象、running Map 与 cleanup busy。当前测试保留未收尾 invocation 用例并通过；不把最初目标里的所有并发原子性要求等同于已经完成，未知外部变化仍以 G-04 限制处理。

- **完成口径**：`branchResourceUsers()` 统一「谁在用这些 worktree / ref」：拥有分支的Worker、输入锚点下的 planner/worker/merger 与指令、引用被检验Worker或候选的 verifier、以这些分支为目标的进行中工作，以及 running 中未收尾或正在 cleanup 的Worker。任一活动使用者即拒绝且无副作用。回归：`test/workspaces/archive.test.js`（running planner、queued branchless worker、活动 verifier、终态未收尾四例）。
- **依据**：`src/core/project/branches.js`，`archiveBranch()`，170–186 行，仅按 `tasks.branch IN (...)` 查未终态Worker；`src/core/workspaces/worktree.js`，`ensure()`，127–132 行，planner 实际使用输入 anchor，而 Worker 本身没有 branch。归档前也没有 `running` / `busy` 收尾检查。
- **触发与影响**：让 mock planner 停在 `run()`（状态 running、branch=null），归档其输入分支；调用返回 `archived=true`，planner cwd 已被删除。尚未建分支的 worker、共享源目录的 verifier 同样需要关联准入，不能仅凭Worker branch 判断资源无人使用；会中断执行，`--discard` 情况下还可能删除活动产物。
- **建议与取舍**：归档安全门覆盖 input anchor、Worker依赖/后代、verifier 服务对象与实际工作区使用者，并在 Git 串行区间内重检；为待归档分支建立短期操作保留，避免排队后又准入新Worker。可复用 Showcase 的关联检查思路，但归档允许 failed/cancelled，不能照抄“全部成功”的产品条件。
- **验收**：running planner、未建分支的 queued worker、活动 verifier、已终态但 invocation 未收尾时均拒绝且目录/ref/状态不变；终态且无使用者仍可按现有规则归档。已有 archive 测试只覆盖已拥有 branch 的活动Worker，不能证明这些场景安全。

## G-02 Candidate 固定的是 HEAD，实际验收仍可读取脏文件树

**P1 · 已复现 · 预估 M · 已完成（2026-09-26，提交 `0dc36ef`）；2026-10-02 复核：历史最低核验保留，当前产品入口已下线**

- **当前依据**：Workspaces.ensure 的 Candidate 源 HEAD / dirt 检查与 invocation 结束前 assertCandidateVerification 的源 / baseline 核验仍在源码；当前 RPC 无 candidate/verify 创建入口，pump 不调度历史 verifier。旧 Candidate 测试文件已移除，下文回归名是历史证据，不是本轮执行命令。开始/结束检查不证明期间未变动，也不宣称实现了隔离验收；未来若恢复产品应重新确认独立检出方案。

- **完成口径**：采用「开始/结算核验」而非独立检出。`ensure()` 与结算前都调用 `assertCandidateVerification()`：锚点 worktree 必须 HEAD 等于固定提交且干净，对照检出必须停在 baseline 提交且干净；不符即 invocation 失败、候选标 failed，不记为该 commit 的通过证据。回归：`test/project/candidates.test.js`（开始前脏、运行中提交漂移、对照检出被改动）。
- **依据**：`src/core/workspaces/worktree.js`，`ensure()`，100–128 行，只核对源工作区 HEAD 等于 `candidate.commit_hash`，不检查脏树；`finish()`，209–225 行，对没有 `task.workspace` 的 verifier 直接返回。`src/core/project/verify.js`，`verificationEvidence()`，43–48 行，把 Candidate 元数据直接标为 `tested_commit`。
- **触发与影响**：冻结 Candidate 后将 anchor 的 `file.txt` 从已提交的 `base` 改成未提交的 `dirty candidate content`；mock verifier 确实读取并断言后者，再提交合规 pass evidence/report，Candidate 仍进入 **ready**，证据却绑定原 commit。接受时 clean 门槛能暂时阻止合并，但恢复干净文件后并不会让这份旧验收失效。
- **建议与取舍**：最低限度在开始、结算时核验两侧 HEAD、工作树及 Git 中间态，变化就降为未验证；更强方案为 Candidate 单独创建固定提交 detached worktree，避免与输入工作区共用。两次核验不能证明期间从未变动，隔离方案更可靠但增加磁盘与清理成本；具体方案需用户确认。
- **验收**：脏树不得被标成固定 commit 的通过证据；覆盖开始前脏、执行中提交漂移、测试恢复现场、对照 checkout 被改动；正常固定树仍通过。保留已有 Candidate 接受冻结与迟到结果保护，不把验收缺口误写成接受时偷换 commit。

## G-03 外部切换检出可让 fast-forward 落到错误分支并报告成功

**P1（按潜在影响）· 已复现（确定性交错）· 外部并发已知限制 · 本轮完成错误成功侦测（2026-10-02），更强隔离待决**

- **完成口径**：当前 v2 主路径已使用精确 Squash 凭据 + 双 ref 事务 + 工作区复核，不能继续用旧 ff-only 证据代指它。历史 mergeBranchUnsafe / catchupBranchUnsafe 及当前也使用的 fastForwardBranchUnsafe 则补统一后置核验：实际目标 ref 为固定落地 SHA，有检出时 symbolic-ref / HEAD 身份及 clean 一致，最后再次读目标 ref。失败不写 merged / caught_up，不自动回退/reset；错误现场可能仍包含被外部切换的分支接收提交，这一限制明确保留。
- **回归**：`test/workspaces/merge.test.js` 对 merge / catchup / fast-forward 各注入检查后 checkout、detached、落地后外部提交，9 例均拒绝错误成功并保留现场。此加固不能锁住外部 Git，也不能消除最后检查之后的变化；更强 checkout 隔离 / 协作锁是待决架构，不在本轮擅定。

- **依据**：`src/core/workspaces/merge.js`，`mergeBranchUnsafe()`，76–87 行，先 `symbolic-ref` 校验再执行独立 `git merge --ff-only`；`catchupBranchUnsafe()`，105–115 行结构相同。Lush 队列只串行自身请求，不能锁住外部 checkout。
- **触发与影响**：建立 main、同起点 unrelated、领先的 feature；在 parent 身份检查后、真正 merge 前由测试拦截插入 `git checkout unrelated`。结果返回 `parent=main, merged=true`，实际 main 未变、unrelated 收到 feature commit；这不是内容冲突，也不是未检出 ref 的 CAS 路径。[使用说明](../../README.md)已要求不要让其它程序同时修改正在合并的工作树；本项违反该使用前提，属于防御性加固，不应称为遵守前提时仍必现的合并缺陷。
- **建议与取舍**：先补实际 parent ref、HEAD 与落地 commit 的后置核验，异常保留详细现场而不写成功，不自动 reset “修复”用户目录；它只能防止错误成功，不能单独消除错误分支被触碰。更强选择包括拒绝推进用户持有的 checkout、明确协作锁协议或重新设计可证明的 ref/index 更新流程，行为/架构取舍需用户确认，不能声称再加一次检查就消除了竞态。
- **验收**：对 merge 与 catchup 均注入“检查后切分支/转 detached/外部推进”，不得把未实际推进的目标记为 merged；无用户修改丢失、失败现场可检查。未检出父分支 CAS 及 Candidate 固定 commit 测试继续通过。

## G-04 子树归档遇到锁定后代会部分完成且无法原入口重试

**P2 · 已复现 · 预估 M · 已完成预检与显式续办（2026-10-02，Notice #81）**

- **完成口径**：archiveBranches 在第一遍读一次 NUL 分隔 worktree metadata；任一后代 locked / prunable（含缺目录注册）或包含已初始化 submodule 时，全子树在任何删除前拒绝。`discard_worktree` 仅授权丢未提交修改，不能绕过上述安全门；不使用双 force，不扩大删除范围。NUL 解析保留路径 / 原因中的空白、引号和换行。
- **回归与剩余项**：`test/workspaces/archive.test.js` 覆盖 locked（带换行原因）、prunable、initialized submodule，显式 discard 也拒绝，父目录/ref/状态/指针/审计不变。第二遍外部锁变化或 I/O 失败仍可能半归档；当前已逐项回写 outcome、Worker 指针与审计，并以显式 `--continue` 续办，不自动回滚或绕过锁。下列原证据保留，不把预检修复夸大为跨目录原子删除。

- **依据**：`src/core/workspaces/cleanup.js`，`archiveBranches()`，42–85 行，第一遍只收集 tip/路径并检查 clean，第二遍逐条 remove/ref-delete/标 archived；`src/core/project/branches.js`，`archiveBranch()`，174–177、186–213 行，根已 archived 时拒绝，Worker指针与事件仅在整批 Git 成功后更新。
- **触发与影响**：父、子 worktree 都干净，提前 `git worktree lock <child>`；归档父分支先删除父目录/ref 并标 archived，再在子目录报 locked。观测父 archived、子 active；重试父直接报 `already archived`，一次已知、可预检的状态造成半棵树归档和审计/指针更新遗漏。
- **建议与取舍**：预检识别 locked / prunable / submodule 等已知拒绝条件；仍需承认外部变化、I/O 失败使跨目录删除无法天然原子，持久保留逐项 outcome，允许用户显式继续未完成部分。不要通过双 force 绕过锁，也不要以回滚名义重建可能冲突的用户目录；继续操作入口的交互需确认。
- **验收**：已锁定后代在任何删除前拒绝；第二遍注入失败时返回完整已完成/保留项，Worker路径与审计符合磁盘事实，用户可安全继续。已有“脏后代零副作用”测试保留，另补锁定与部分失败测试。

## G-05 Candidate verifier 的 baseline 不在正常完成与手动清理路径中

**P2 · 已复现 · 预估 S · 本轮完成历史兼容回收（2026-10-02）**

- **完成口径**：Candidate 创建 / 验收已没有当前公开入口，旧 verifier 不自动调度；但已有 baseline 仍可从显式 worker.cleanup 回收。Workspaces.release 同时识别 verifies_task_id / review_candidate_id；invoke finally 同样识别两者（供历史内部调用），失败保留路径供检查重试。沿用既有派生 baseline 的单 force 回收，不增加 Showcase 回收、不恢复旧重启自动清理/调度。
- **回归**：`test/workspaces/cleanup.test.js` 覆盖历史 Candidate 成功 / 失败 / 取消的 invocation 收尾；三个终态下显式 cleanup 锁失败保存路径、解锁重试后删除、重复 cleanup 报 absent。旧 worker verifier 与 Showcase 保留安全测试亦在全量运行中通过。
- **原恢复说明已过时**：当前 recover 不自动恢复旧 verifier，也不自动删除旧 Candidate baseline；下文“重启可回收”仅描述原审查版本，不能据此建议重启真实 daemon。

- **依据**：`src/core/project/scheduling.js`，`invoke()` 的 finally，197–203 行，只给 `verifies_task_id` 回收 baseline；`src/core/workspaces/cleanup.js`，`release()`，112–145 行，也只识别此字段。Candidate verifier 使用 `review_candidate_id`，但 `ensure()` 同样创建 `baseline_workspace`。
- **触发与影响**：G-02 的 verifier 完成后 baseline 目录仍在，再 `workspaces.cleanup(id)` 返回 worktree/branch 均 absent、reason=null，目录仍在、指针未清。多版本验收积累完整 checkout，用户清理结果还误导为没有资源。
- **现有保护**：`src/core/project/lifecycle.js`，`recover()`，258–263 行，会回收非 Showcase 的终态 baseline，故并非永远不可回收，也不建议为此重启真实 daemon；问题在长运行会话与显式 cleanup。
- **建议与取舍**：以资源/角色统一识别两类 verifier，复用 `removeBaseline()` 的失败保留指针逻辑；保持 Showcase 基线保留与预览保护，不扩大 force 删除范围。
- **验收**：Candidate 验收成功、失败、取消后 baseline 及时消失；清理失败保存路径并可显式重试；重复 cleanup 幂等且报告真实资源结果；旧 worker verifier 与 Showcase 生命周期不回归。

## G-06 图读取重复执行完整 Showcase 准入（随功能删除关闭）

**已关闭：预约展示、效果展示与图准入投影整体删除，不再执行下述历史调用；2026-10-02 复核确认，无需实施旧优化方案。**

- **当前依据**：模块地图明确 Showcase 已整体删除，当前 graph 不再执行 showcaseEligibility，也不存在其工作区实现。原 20 分支 Git 调用测量是旧功能证据，不用来推断当前 Worker 图成本。

以下保留原始成本测量记录，不是当前待实施方案。

- **依据**：`src/core/project/graph.js`，`graph()`，218–255 行，每个节点串行调用 `showcaseEligibility()`；`src/core/project/showcase.js`，同名函数，10–64 行，每次重新扫描 branches/inputs/tasks，并执行 `showcaseSnapshot()`。`src/core/workspaces/showcase.js`，47–85 行，对每个分支重新枚举远端默认分支、校验 ref、列 worktree。
- **实验与影响**：临时仓库创建 20 条已登记、有实际树变化、无Worker的分支；21 个图节点一次读取发起 **230 次 Git**、约 **2.31 s**，同实例热读仍 **226 次 / 2.08 s**。其中 `for-each-ref` 与 `worktree list` 各 21 次；这是本机探针，不是生产 SLA 或 200 分支外推结论。图读取并发时会叠加进程与重复 DB 扫描。
- **建议与取舍**：图用一次 refs/worktrees/Worker关系快照批量计算展示资格，按固定 commit 缓存纯 Git 结果，合并同项目并发图请求；真正 start/retry 继续在写队列内执行完整实时准入。也可改为分支详情按需判定，但会改变交互，需用户确认。
- **验收**：增加 20/200 分支冷热读测量与 Git 命令计数，固定枚举不随分支数重复；批量读失败仍区分 unknown 与不合格，活动Worker/脏树变化不能被缓存长期隐藏。已有 diagnostics 缓存测试通过，不等于整个 graph 已有成本界限。
