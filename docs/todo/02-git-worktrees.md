# Git / Worktree 与交付安全审查

本文面向维护者，检查代码隔离、交付冻结、回收安全与多分支成本；仅列改进建议，不实施功能。入口为 `src/core/workspaces/` 与 `src/core/project/` 的分支、Candidate、Integration、Showcase 模块。

## 范围、基线与验证

- HEAD：`99fcbc993640c057488532a19ca08814ab60b73e`，与指定基线一致；审查前工作树干净。
- 已读 [模块地图](../engineering/modules.md)、[Runtime 分章](../engineering/modules-runtime.md)、[接口与测试](../engineering/modules-interfaces.md)、[设计入口](../design/README.md)、[文档约定](../contributing/documentation.md)，并核对 [Git 边界](../engineering/git-boundary.md)、[回收](../engineering/cleanup.md)、[合并](../engineering/merge.md)、[验收闭环](../engineering/review-loop.md)、[检验](../engineering/verification.md)。设计入口暂无 Git 专题，未自行增设产品原则。
- 方法：静态阅读 + 仓库现有测试 + 临时 fixture 确定性交错；所有 Git 写操作仅在测试临时仓库，无真实 daemon 连接、启停或密钥读取；未安装依赖、未 commit / merge / push 审查工作树。
- 已执行 `git rev-parse HEAD` / `git status --short`：基线一致、初始无改动。
- 已执行 `bun run test test/workspaces test/project/candidates.test.js test/project/showcase-eligibility.test.js test/project/showcase.test.js`：**78 pass / 0 fail，514 assertions**；`bun run docs:check`：53 篇 Markdown 检查通过。
- 已执行 `bun run /tmp/lush-audit-git-probes.js`：复现 G-01～G-06；使用 `test/helpers.js` 的 `fixture/repo/git`，mock provider、临时 Git 仓库、受控方法拦截；每例 `finally` 关闭项目并删除 fixture，临时脚本已删除。下列条目保留可重建的关键步骤与观测。
- 反例核验：已有测试覆盖脏主树拒绝合并、失败任务已提交成果保留、Candidate 串行队列内只落冻结提交、迟到 verifier 不覆盖决策、Showcase 预览阻止清理；带双引号 worktree 路径探针正常，不列为缺陷。
- **不作为缺陷**：人工最终批准、分歧在子侧解决、显式 `archive --discard` 放弃代码、重启不自动重放未知副作用；以下问题与这些合理边界不同。

## G-01 归档准入漏掉实际使用输入工作区的活动任务

**P1 · 已复现 · 预估 M · 已完成（2026-09-26，提交 `a8c1699`）**

- **完成口径**：`branchResourceUsers()` 统一「谁在用这些 worktree / ref」：拥有分支的任务、输入锚点下的 planner/worker/merger 与 say、引用被检验任务或候选的 verifier、以这些分支为目标的进行中工作，以及 running 中未收尾或正在 cleanup 的任务。任一活动使用者即拒绝且无副作用。回归：`test/workspaces/archive.test.js`（running planner、queued branchless worker、活动 verifier、终态未收尾四例）。
- **依据**：`src/core/project/branches.js`，`archiveBranch()`，170–186 行，仅按 `tasks.branch IN (...)` 查未终态任务；`src/core/workspaces/worktree.js`，`ensure()`，127–132 行，planner 实际使用输入 anchor，而 task 本身没有 branch。归档前也没有 `running` / `busy` 收尾检查。
- **触发与影响**：让 mock planner 停在 `run()`（状态 running、branch=null），归档其输入分支；调用返回 `archived=true`，planner cwd 已被删除。尚未建分支的 worker、共享源目录的 verifier 同样需要关联准入，不能仅凭任务 branch 判断资源无人使用；会中断执行，`--discard` 情况下还可能删除活动产物。
- **建议与取舍**：归档安全门覆盖 input anchor、任务依赖/后代、verifier 服务对象与实际工作区使用者，并在 Git 串行区间内重检；为待归档分支建立短期操作保留，避免排队后又准入新任务。可复用 Showcase 的关联检查思路，但归档允许 failed/cancelled，不能照抄“全部成功”的产品条件。
- **验收**：running planner、未建分支的 queued worker、活动 verifier、已终态但 invocation 未收尾时均拒绝且目录/ref/状态不变；终态且无使用者仍可按现有规则归档。已有 archive 测试只覆盖已拥有 branch 的活动任务，不能证明这些场景安全。

## G-02 Candidate 固定的是 HEAD，实际验收仍可读取脏文件树

**P1 · 已复现 · 预估 M · 已完成（2026-09-26，提交 `0dc36ef`）**

- **完成口径**：采用「开始/结算核验」而非独立检出。`ensure()` 与结算前都调用 `assertCandidateVerification()`：锚点 worktree 必须 HEAD 等于固定提交且干净，对照检出必须停在 baseline 提交且干净；不符即 invocation 失败、候选标 failed，不记为该 commit 的通过证据。回归：`test/project/candidates.test.js`（开始前脏、运行中提交漂移、对照检出被改动）。
- **依据**：`src/core/workspaces/worktree.js`，`ensure()`，100–128 行，只核对源工作区 HEAD 等于 `candidate.commit_hash`，不检查脏树；`finish()`，209–225 行，对没有 `task.workspace` 的 verifier 直接返回。`src/core/project/verify.js`，`verificationEvidence()`，43–48 行，把 Candidate 元数据直接标为 `tested_commit`。
- **触发与影响**：冻结 Candidate 后将 anchor 的 `file.txt` 从已提交的 `base` 改成未提交的 `dirty candidate content`；mock verifier 确实读取并断言后者，再提交合规 pass evidence/report，Candidate 仍进入 **ready**，证据却绑定原 commit。接受时 clean 门槛能暂时阻止合并，但恢复干净文件后并不会让这份旧验收失效。
- **建议与取舍**：最低限度在开始、结算时核验两侧 HEAD、工作树及 Git 中间态，变化就降为未验证；更强方案为 Candidate 单独创建固定提交 detached worktree，避免与输入工作区共用。两次核验不能证明期间从未变动，隔离方案更可靠但增加磁盘与清理成本；具体方案需用户确认。
- **验收**：脏树不得被标成固定 commit 的通过证据；覆盖开始前脏、执行中提交漂移、测试恢复现场、对照 checkout 被改动；正常固定树仍通过。保留已有 Candidate 接受冻结与迟到结果保护，不把验收缺口误写成接受时偷换 commit。

## G-03 外部切换检出可让 fast-forward 落到错误分支并报告成功

**P1（按潜在影响）· 已复现（确定性交错）· 外部并发边界的加固建议 · 预估 L**

- **依据**：`src/core/workspaces/merge.js`，`mergeBranchUnsafe()`，76–87 行，先 `symbolic-ref` 校验再执行独立 `git merge --ff-only`；`catchupBranchUnsafe()`，105–115 行结构相同。Lush 队列只串行自身请求，不能锁住外部 checkout。
- **触发与影响**：建立 main、同起点 unrelated、领先的 feature；在 parent 身份检查后、真正 merge 前由测试拦截插入 `git checkout unrelated`。结果返回 `parent=main, merged=true`，实际 main 未变、unrelated 收到 feature commit；这不是内容冲突，也不是未检出 ref 的 CAS 路径。[使用说明](../../README.md)已要求不要让其它程序同时修改正在合并的工作树；本项违反该使用前提，属于防御性加固，不应称为遵守前提时仍必现的合并缺陷。
- **建议与取舍**：先补实际 parent ref、HEAD 与落地 commit 的后置核验，异常保留详细现场而不写成功，不自动 reset “修复”用户目录；它只能防止错误成功，不能单独消除错误分支被触碰。更强选择包括拒绝推进用户持有的 checkout、明确协作锁协议或重新设计可证明的 ref/index 更新流程，行为/架构取舍需用户确认，不能声称再加一次检查就消除了竞态。
- **验收**：对 merge 与 catchup 均注入“检查后切分支/转 detached/外部推进”，不得把未实际推进的目标记为 merged；无用户修改丢失、失败现场可检查。未检出父分支 CAS 及 Candidate 固定 commit 测试继续通过。

## G-04 子树归档遇到锁定后代会部分完成且无法原入口重试

**P2 · 已复现 · 预估 M**

- **依据**：`src/core/workspaces/cleanup.js`，`archiveBranches()`，42–85 行，第一遍只收集 tip/路径并检查 clean，第二遍逐条 remove/ref-delete/标 archived；`src/core/project/branches.js`，`archiveBranch()`，174–177、186–213 行，根已 archived 时拒绝，任务指针与事件仅在整批 Git 成功后更新。
- **触发与影响**：父、子 worktree 都干净，提前 `git worktree lock <child>`；归档父分支先删除父目录/ref 并标 archived，再在子目录报 locked。观测父 archived、子 active；重试父直接报 `already archived`，一次已知、可预检的状态造成半棵树归档和审计/指针更新遗漏。
- **建议与取舍**：预检识别 locked / prunable / submodule 等已知拒绝条件；仍需承认外部变化、I/O 失败使跨目录删除无法天然原子，持久保留逐项 outcome，允许用户显式继续未完成部分。不要通过双 force 绕过锁，也不要以回滚名义重建可能冲突的用户目录；继续操作入口的交互需确认。
- **验收**：已锁定后代在任何删除前拒绝；第二遍注入失败时返回完整已完成/保留项，任务路径与审计符合磁盘事实，用户可安全继续。已有“脏后代零副作用”测试保留，另补锁定与部分失败测试。

## G-05 Candidate verifier 的 baseline 不在正常完成与手动清理路径中

**P2 · 已复现 · 预估 S**

- **依据**：`src/core/project/scheduling.js`，`invoke()` 的 finally，197–203 行，只给 `verifies_task_id` 回收 baseline；`src/core/workspaces/cleanup.js`，`release()`，112–145 行，也只识别此字段。Candidate verifier 使用 `review_candidate_id`，但 `ensure()` 同样创建 `baseline_workspace`。
- **触发与影响**：G-02 的 verifier 完成后 baseline 目录仍在，再 `workspaces.cleanup(id)` 返回 worktree/branch 均 absent、reason=null，目录仍在、指针未清。多版本验收积累完整 checkout，用户清理结果还误导为没有资源。
- **现有保护**：`src/core/project/lifecycle.js`，`recover()`，258–263 行，会回收非 Showcase 的终态 baseline，故并非永远不可回收，也不建议为此重启真实 daemon；问题在长运行会话与显式 cleanup。
- **建议与取舍**：以资源/角色统一识别两类 verifier，复用 `removeBaseline()` 的失败保留指针逻辑；保持 Showcase 基线保留与预览保护，不扩大 force 删除范围。
- **验收**：Candidate 验收成功、失败、取消后 baseline 及时消失；清理失败保存路径并可显式重试；重复 cleanup 幂等且报告真实资源结果；旧 worker verifier 与 Showcase 生命周期不回归。

## G-06 图读取重复执行完整 Showcase 准入，少量分支已产生大量 Git 子进程

**P2 · 已复现（成本测量） · 预估 M**

- **依据**：`src/core/project/graph.js`，`graph()`，218–255 行，每个节点串行调用 `showcaseEligibility()`；`src/core/project/showcase.js`，同名函数，10–64 行，每次重新扫描 branches/inputs/tasks，并执行 `showcaseSnapshot()`。`src/core/workspaces/showcase.js`，47–85 行，对每个分支重新枚举远端默认分支、校验 ref、列 worktree。
- **实验与影响**：临时仓库创建 20 条已登记、有实际树变化、无任务的分支；21 个图节点一次读取发起 **230 次 Git**、约 **2.31 s**，同实例热读仍 **226 次 / 2.08 s**。其中 `for-each-ref` 与 `worktree list` 各 21 次；这是本机探针，不是生产 SLA 或 200 分支外推结论。图读取并发时会叠加进程与重复 DB 扫描。
- **建议与取舍**：图用一次 refs/worktrees/任务关系快照批量计算展示资格，按固定 commit 缓存纯 Git 结果，合并同项目并发图请求；真正 start/retry 继续在写队列内执行完整实时准入。也可改为分支详情按需判定，但会改变交互，需用户确认。
- **验收**：增加 20/200 分支冷热读测量与 Git 命令计数，固定枚举不随分支数重复；批量读失败仍区分 unknown 与不合格，活动任务/脏树变化不能被缓存长期隐藏。已有 diagnostics 缓存测试通过，不等于整个 graph 已有成本界限。
