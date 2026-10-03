# 分支优先架构

Git 分支与 worktree 承载代码事实，Worker / Agent 承载执行与交付确认。新指令直接拥有输入分支，当前 version 2 由父 Worker 自有队列的 runtime 串行 Squash，父 Agent 只在交付后检查并确认 child 成果；见[当前流程](../task-flow.md)和[Worker RPC](../reference/rpc/tasks.md)。

## 核心不变量

1. 用户提交指令时显式选择一个本地父分支（默认当前检出分支，Web 可选）。
2. runtime 立即从父分支已提交的顶端创建 `lush/<project>/<id>-<name>` 与独立 worktree。Agent 在这个 worktree 中工作，因此之后父分支前进、其它 worktree 有未提交内容，都不会改变它看到的代码。
3. 子 Worker 分支是父 Worker 分支的直接子分支；`target_branch` 永远等于谱系中的直接父分支。
4. 代码只沿 recorded direct-parent 边交付。当前 version 2 将固定源树 Squash 为父分支上的一条提交；历史 version 1 只做 fast-forward。runtime 不在父分支上创建 no-ff merge commit，也不在父分支的 worktree 留源侧冲突中间态。
5. 当前指令 / child 请求由父自有队列处理（含 main/owner），不额外调用父 Agent、不创建 merge Worker、不改 `parent_id`。真实安全点固定源提交并入队，取得父执行位后才固定尝试基线；落地、父开发、同步及向上交付互斥。历史 version 1 仍用 `worker.integrate` / `worker.approve_merge` 固定提交确认。
6. 当前交付分歧时唤醒原 Worker，在源侧吸收固定父提交、保留原源提交、解决冲突并测试；期间保留父执行位，挂起释放，恢复重新排队并固定新基线。历史 version 1 仍派独立解分歧子 Worker，再核验两端固定提交并 fast-forward；旧 version 2 在途重挂只凭明确预约／审计恢复，不删历史。
7. 一条分支还有未收拢的直接子分支，或仍有会在它下面产码但尚未建分支的活动 Worker 时，不能提前合入父分支。这样不会把并行工作的某一部分静默遗漏。
8. `branches.parent` 与 `created_from_commit` 只在创建时写入；merge 不改谱系。分支当前能否 FF 由 Git commit 图实时计算，不持久化猜测。

## 分支流

```text
main（用户选择 / 默认检出）
└── order #7 search-page
    ├── child #9 api
    └── child #10 ui
```

落地顺序从叶子向根：`9 → 7`、`10 → 7`，然后 `7 → main`；当前 version 2 各项由父 runtime 串行 Squash，main 不需另行批准。兄弟先落地会让父分支前进，后续请求取得执行位时固定新基线，需要时回源侧修复。完整协议见[分支合并](merge.md)。

## 连线状态

`graph.get` RPC 对每条 `parent → child` fork 边实时给出以下诊断（Web 已移除旧分支图，Worker 卡片改用 `worker.graph` 的精简关系状态）：

- `fast_forward`：parent 是 child 的祖先，可直接把 child 合回 parent；
- `diverged`：两边都有独有提交，必须先在子侧同步；
- `integrated`：child 已经是 parent 的祖先（或顶端相同），成果已进入父分支；
- `missing`：至少一个 ref 不存在；
- `unknown`：没有可信的 recorded parent，禁止写操作。

`ahead` / `behind` 以 child 相对 parent 计算。连线还列出 child 尚未收拢的直接子分支；有 blocker 时即使 commit 图本可 FF，也不能向上落地。

## Worker 与 Branch 的边界

- Worker：goal、role、agent session、消息、notice、执行状态、结果与审计事件。
- Branch：父分支、fork commit、worktree、当前 tip、ahead/behind、是否可合并、是否已进入父分支。
- `tasks.head_commit` 仍表示 agent 交付时审阅过的提交。分支之后可能通过子分支聚合而前进；向上落地前必须证明 branch tip 仍包含该 reviewed commit。
- main 是静息的 `task_kind='main'` 根 Worker；其它本地父分支需 `branch.bind` 显式绑定 `owner`，新指令才能挂上去。

相关：[分支谱系](branch-genealogy.md) · [Git 边界](git-boundary.md) · [批准合并](merge.md)
