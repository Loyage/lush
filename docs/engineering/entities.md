# 实体

本文件管固定七个实体的字段、身份与关联边。

<a id="project"></a>- **Project**：不是全局注册表里的记录，而是 daemon 的不可变作用域：canonical 目录 + `.lush/project.json` + SQLite 中的项目绑定。
<a id="input"></a>- **Input**：用户原话，逐字持久化，关联根 planner，以及提交时创建的可推进输入分支：`anchor_branch` / 初始 `anchor_commit` / `anchor_workspace` / 用户指定父分支 `anchor_target_branch`。字段名保留 anchor 是数据库兼容，不代表分支只读。
<a id="task"></a>- **Task**：goal / role / parent_id / input_id / status / result / error / invocation 次数；worker 另有工作区和 integration 状态。父子关系只在创建时指定，不能变更。verifier 另带 `verifies_task_id`（指向被检验的 worker）与 `baseline_workspace` / `baseline_commit`（目标分支的临时对照检出）；merger 另带 `resolves_task_id`（指向合并冲突的那个 worker）。两者都用关联边而不是父子边，所以「终态任务没有活动后代」这条不变量不被破坏。
<a id="agent"></a>- **Agent**：与 task 终身一对一的身份（`<role>#<task-id>`）。task 创建时它就存在，跨唤醒复用同一个 pi session，记录累计唤醒次数与上次动手时间；但 RPC 凭证每次唤醒重新签发，库里只存 SHA-256，且只在该次 invocation 运行期间可解析。
<a id="message"></a>- **Message**：持久化收件箱，用户、直接父子 task、子任务结算与 notice 答复共享同一通道。
<a id="notice"></a>- **Notice**：task 请求用户做决定，分 `question` / `plan` / `info` 三类。`question` / `plan` 是待决问题，落库 `status='open'`，会进「待决」计数并让 owner 任务停在 `awaiting`，答复/忽略后转 `answered` / `dismissed`。`info` 是任务结算时自动落下的纯提醒：`status='sent'`，只告知「这一时刻、这条分支发生了什么、是否已合入父分支、是否需要你处理」，不请求答复、不阻塞也不唤醒任务；所有「待决」口径（`system.status.notices`、`awaiting` 判定、plan 查询、`graph.get` 任务节点的 `notice` / `notice_count` 等）都靠 `status='open'` 把它天然排除在外。
<a id="event"></a>- **Event**：创建、调用、状态转换、消息和 Git 生命周期审计。

Branch 是代码状态的核心聚合对象，但不新增业务实体：Git ref/worktree 是事实，`branches` 表只保存不可变创建谱系（branch / parent / fork commit / owner）。Task 负责执行审计，Branch 决定基线、直接父分支、可 FF 性与逐层交付。输入分支 `task_id` 为空，通过 `inputs.anchor_branch` 关联；Task 被 clear 后谱系仍保留。

相关：[生命周期不变量](invariants.md)。
