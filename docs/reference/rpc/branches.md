# 分支谱系与收敛

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| `branch tree [--verbose]` | `branch.tree` | `{}` | 用户与 agent，只读 |
| `branch show BRANCH\|TASK_ID` | `branch.show` | `{branch}` | 用户与 agent，只读 |
| `branch import` | `branch.import` | `{}` | 用户专属 |
| `branch merge BRANCH` | `branch.merge` | `{branch}` | 用户专属 |
| `branch sync BRANCH` | `branch.sync` | `{branch}` | 用户专属 |
| `branch archive BRANCH [--discard]` | `branch.archive` | `{branch, discard?}` | 用户专属 |

谱系是创建时显式写下的 `parent → child`，不是 commit graph 或任务树。`branch.import` 只登记已有本地分支，parent 为 unknown，不做推断。

## branch.tree / branch.show

节点字段包括 branch、parent / parent_relation、created_from_commit、task、worktree、present、head_commit、current、status。分支删除后历史行保留；只有 ref 的旧分支显示 untracked；只被 parent 提及的名称显示 placeholder。`status` 有 `active` / `archived` / `deleted` 三个取值：归档与回收都不删行。

## branch.merge

只允许 `parent_relation=recorded` 的 direct child 合回 parent，只执行 fast-forward。返回示例：

```json
{
  "child": "lush/abc/7-api",
  "parent": "lush/abc/input-3",
  "status": "integrated",
  "ahead": 2,
  "behind": 0,
  "merged": true,
  "new_head": "..."
}
```

若父子分歧，返回 `status:"diverged", needs_sync:true`，不修改 ref。若 child 还有未收拢的直接子分支则拒绝，并列出 blockers。

## branch.sync

仅在 direct edge 为 diverged 时可调用。它从 child tip 创建一个 `role=merger` 的独立子分支，让 agent 合入冻结的 parent commit、解决冲突并测试。返回 task；完成后用户先把 merger 分支 FF 回 child，再把 child FF 回 parent。

同一 child 已有活动或待落地 sync task 时返回该 task，不重复创建。

## branch.archive

用户显式归档一条已登记分支：删掉它的 worktree 与本地 ref，但保留谱系行（`status` 标 `archived`，`deleted_at` 兼作归档时间）、任务行、消息、事件与 pi 会话文件。与 `branch.merge` / `branch.sync` 不同，它明知分支可能未合并也允许删，所以是用户专属写操作。参数 `discard`（布尔，缺省 `false`）：默认 worktree 脏时拒绝，只有 `discard:true` 才会连着未提交改动一起丢弃 worktree。

门槛：分支必须已登记、不是 `archived` / `deleted`、不是当前检出分支，且该分支与全部后代分支都没有未终态任务。返回示例：

```json
{
  "branch": "lush/abc/7-api",
  "archived": true,
  "worktree": "removed",
  "ref": "deleted",
  "tip": "...",
  "discarded": false,
  "tasks": [{ "id": 7, "status": "completed" }],
  "sessions": [".lush/sessions/...jsonl"]
}
```

CLI 的 `lush branch archive BRANCH [--discard]` 非 JSON 输出由 `printBranchArchive` 打印。归档后该分支的任务仍出现在分支图上，节点标「已归档」，且不再提供归档动作。

## graph.get 的 fork 边

Web 分支图使用 `graph.get`。每个 branch 节点带 `origin` / `title` / `source_id` / `created_at`、汇总的 `status` 与 `tasks` 计数，另带 `worktree` / `worktree_state` 与 `deleted`；归档分支的 `status` 固定为 `archived`，带 `archived` / `archived_at`（复用 `branches.deleted_at`，不新增列），`tasks.branch` 指向它的任务节点带 `archived: true` 且仍留在图上。每条 fork edge 附加：

```json
{
  "kind": "fork",
  "from": "branch:main",
  "to": "branch:lush/abc/input-3",
  "status": "fast_forward",
  "ahead": 4,
  "behind": 0,
  "blockers": [],
  "can_merge": true,
  "can_sync": false
}
```

相关：[分支优先架构](../../engineering/branch-first.md)。
