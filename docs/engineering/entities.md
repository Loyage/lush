# 实体

本文件管固定七个实体的字段、身份与关联边。

<a id="project"></a>- **Project**：不是全局注册表里的记录，而是 daemon 的不可变作用域：canonical 目录 + `.lush/project.json` + SQLite 中的项目绑定。
<a id="input"></a>- **Input**：用户原话，逐字持久化，关联一个根 planner Task，以及提交那一刻锚下来的代码：`anchor_branch` / `anchor_commit` / `anchor_workspace` / `anchor_target_branch`。入口调用做一次 Git 锚点（不等待 agent）加一个短事务，然后安排调度。
<a id="task"></a>- **Task**：goal / role / parent_id / input_id / status / result / error / invocation 次数；worker 另有工作区和 integration 状态。父子关系只在创建时指定，不能变更。verifier 另带 `verifies_task_id`（指向被检验的 worker）与 `baseline_workspace` / `baseline_commit`（目标分支的临时对照检出）；merger 另带 `resolves_task_id`（指向合并冲突的那个 worker）。两者都用关联边而不是父子边，所以「终态任务没有活动后代」这条不变量不被破坏。
<a id="agent"></a>- **Agent**：与 task 终身一对一的身份（`<role>#<task-id>`）。task 创建时它就存在，跨唤醒复用同一个 pi session，记录累计唤醒次数与上次动手时间；但 RPC 凭证每次唤醒重新签发，库里只存 SHA-256，且只在该次 invocation 运行期间可解析。
<a id="message"></a>- **Message**：持久化收件箱，用户、直接父子 task、子任务结算与 notice 答复共享同一通道。
<a id="notice"></a>- **Notice**：task 请求用户做决定；答复/忽略入收件箱。
<a id="event"></a>- **Event**：创建、调用、状态转换、消息和 Git 生命周期审计。

分支谱系（`branches` 表）不是第七个实体：它没有生命周期、不参与调度、不会被唤醒，只是分支创建时刻的一条**元数据记录**（`branch` / `parent` / `created_from_commit` / `task_id` / `worktree`）。它与 Task 通过 `task_id` 关联，但那个关联**故意没有外键**：`task clear` 清空 tasks 之后，谱系必须留下（见 [分支谱系](branch-genealogy.md)）。输入锚点的分支同样进去：它们是分支，不是实体；`task_id` 为空，`parent` 指向提交时的检出分支。

相关：[生命周期不变量](invariants.md)。
