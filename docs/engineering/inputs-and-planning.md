# 输入和规划

本文件管输入如何选择父分支、创建输入分支、落库并被规划，以及 `inputs.flow`。

## 提交顺序

`input.submit {content, branch?, references?, direct?}` 与 `draft.commit {ids?, branch?}` 先分配永不复用的 input id，再走 Git 串行队列：

1. 校验项目是 Git worktree 根；
2. `branch` 必须是精确存在的本地 `refs/heads/*`；省略时使用当前检出分支；
3. 从该分支已提交的顶端创建 `lush/<项目哈希>/input-<id>`；
4. 在 `.lush/worktrees/input-<id>` 检出；
5. 事务写 Input、根 planner Task、关联行与 `input.anchor` 事件；
6. planner 在输入 worktree 中运行。

创建失败时整条输入不落库；已建的 ref / worktree 尽力回滚，草稿保持未提交。

## 输入分支

数据库为兼容已有项目继续使用 `anchor_branch` / `anchor_commit` / `anchor_workspace` / `anchor_target_branch` 字段：

- `anchor_branch`：可推进、可聚合子任务的输入分支；
- `anchor_commit`：它创建时冻结的 fork commit；
- `anchor_workspace`：planner 读取代码、输入分支接收子分支 FF 的 worktree；
- `anchor_target_branch`：用户提交时指定的直接父分支。

输入分支不再只是只读快照。它先聚合 worker 子分支，最后由用户从分支图批准合回 `anchor_target_branch`。

提交时父分支 worktree 的未提交修改不会进入输入分支；若父分支正被某个 worktree 检出，这份差异写入 `input.anchor.dirty_source`。因此 planner 与 worker 看到的永远是一个已提交、可重现的 commit。

## 任务分支

- 普通 worker：从 `anchor_commit` 创建，谱系 parent 与 `target_branch` 都是输入分支；
- `code` 下游：从上游任务已审阅 commit 创建，parent 与 target 都是上游任务分支；
- merger：从发生分歧的 child tip 创建，target 是该 child；它把冻结的 parent commit 合到子侧；
- verifier：只读，不创建可交付分支。

并行 sibling 仍从相同冻结起点创建，互不偷看。它们逐个合入输入分支；第一个可以直接 FF，后续 sibling 若因聚合分支已前进而分歧，就先走子侧同步，再 FF。

## 规划与 flow

每条输入保留独立 planner 身份。默认提交会调用规划模型；显式 `direct: true` 不调用模型，而是在同一事务中将 flow 设为 develop，创建一条 worker spec 并编译为一个根 worker，再将 planner 标为 completed（calls / agent_wakes 都是 0）。`input.direct` 事件区分这种占位与真实规划结果，原始输入、引用、输入分支和 Work DAG 仍完整保留。草稿批量提交不支持 direct，仍必须经过规划；直接执行不放宽人工合并批准。

planner 的 cwd 是输入 worktree，不是主工作树；父分支之后前进、主工作树脏或用户切换分支都不会改变分析上下文。

`inputs.flow`：

- `develop`：可以产生 worker / coordinator / research；
- `explain`：只允许 research，runtime 在 spawn 层硬拒绝 worker / coordinator；
- `NULL`：在判定前按 develop。

`explain` 同样创建输入分支，因为 flow 要等 planner 读取输入后才能判定。清理时，未推进的 explain 输入分支可直接回收；已经推进的输入分支只有在 tip 已进入父分支时才回收。

相关：[分支优先架构](branch-first.md) · [分支谱系](branch-genealogy.md) · [意图层](intent-layer.md)
