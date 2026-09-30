# 分支优先架构

Git 分支与 worktree 承载代码事实，Task / Agent 承载执行与交付确认。新 say 直接拥有输入分支，子提交由父 Agent 确认，main/owner 需用户批准，见[当前流程](../task-flow.md)和[Task RPC](../reference/rpc/tasks.md)。

## 核心不变量

1. 用户提交 say 时显式选择一个本地父分支（默认当前检出分支，Web 可选）。
2. runtime 立即从父分支已提交的顶端创建 `lush/<project>/<id>-<name>` 与独立 worktree。Agent 在这个 worktree 中工作，因此之后父分支前进、其它 worktree 有未提交内容，都不会改变它看到的代码。
3. 子 Task 分支是父 Task 分支的直接子分支；`target_branch` 永远等于谱系中的直接父分支。
4. 代码只沿 recorded direct-parent 边推进，且只做 fast-forward。父分支只接受能快进的固定提交；runtime 不在父分支上创建 no-ff merge commit，也不在父分支的 worktree 留冲突中间态。
5. 新 say / child 的落地由运行中的直接父 Agent `task.integrate` 确认固定子提交；父是 main/owner 时由用户 `task.approve_merge` 按固定 commit + baseline 批准。请求未解决时父分支受交付锁保护。
6. 父子已经分歧时，在子侧创建一个解分歧子 Task（`task.resolve_child_divergence` / `task.resolve_divergence`）：它从子侧固定提交出发，吸收冻结的父提交、解决冲突并测试；之后由 runtime 校验产物同时包含两端固定提交，再 fast-forward。
7. 一条分支还有未收拢的直接子分支，或仍有会在它下面产码但尚未建分支的活动 task 时，不能提前合入父分支。这样不会把并行工作的某一部分静默遗漏。
8. `branches.parent` 与 `created_from_commit` 只在创建时写入；merge 不改谱系。分支当前能否 FF 由 Git commit 图实时计算，不持久化猜测。

## 分支流

```text
main（用户选择 / 默认检出）
└── say #7 search-page
    ├── child #9 api
    └── child #10 ui
```

落地顺序从叶子向根：`9 → 7`、`10 → 7`，然后 `7 → main`（main 需用户按固定提交批准）。兄弟子分支先落地会让父分支前进，尚未落地的子提交需要子侧解分歧后重新确认。

## 连线状态

`graph.get` RPC 对每条 `parent → child` fork 边实时给出以下诊断（Web 已移除旧分支图，Task 卡片改用 `task.graph` 的精简关系状态）：

- `fast_forward`：parent 是 child 的祖先，可直接把 child 合回 parent；
- `diverged`：两边都有独有提交，必须先在子侧同步；
- `integrated`：child 已经是 parent 的祖先（或顶端相同），成果已进入父分支；
- `missing`：至少一个 ref 不存在；
- `unknown`：没有可信的 recorded parent，禁止写操作。

`ahead` / `behind` 以 child 相对 parent 计算。连线还列出 child 尚未收拢的直接子分支；有 blocker 时即使 commit 图本可 FF，也不能向上落地。

## Task 与 Branch 的边界

- Task：goal、role、agent session、消息、notice、执行状态、结果与审计事件。
- Branch：父分支、fork commit、worktree、当前 tip、ahead/behind、是否可合并、是否已进入父分支。
- `tasks.head_commit` 仍表示 agent 交付时审阅过的提交。分支之后可能通过子分支聚合而前进；向上落地前必须证明 branch tip 仍包含该 reviewed commit。
- main 是静息的 `task_kind='main'` 根 Task；其它本地父分支需 `branch.bind` 显式绑定 `owner`，新 say 才能挂上去。

相关：[分支谱系](branch-genealogy.md) · [Git 边界](git-boundary.md) · [批准合并](merge.md)
