# 分支谱系与收敛

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| `branch tree [--verbose]` | `branch.tree` | `{}` | 用户与 agent，只读 |
| `branch show BRANCH\|TASK_ID` | `branch.show` | `{branch}` | 用户与 agent，只读 |
| `branch import` | `branch.import` | `{}` | 用户专属 |
| `branch merge BRANCH` | `branch.merge` | `{branch}` | 用户专属 |
| `branch sync BRANCH` | `branch.sync` | `{branch}` | 用户专属 |
| `branch catchup BRANCH` | `branch.catchup` | `{branch}` | 用户专属 |

谱系是创建时显式写下的 `parent → child`，不是 commit graph 或任务树。`branch.import` 只登记已有本地分支，parent 为 unknown，不做推断。

## branch.tree / branch.show

节点字段包括 branch、parent / parent_relation、created_from_commit、task、worktree、present、head_commit、current、status。分支删除后历史行保留；只有 ref 的旧分支显示 untracked；只被 parent 提及的名称显示 placeholder。

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

## branch.catchup

反方向：把 parent 已有的提交快进进 child，也就是“让子分支跟上父分支”。它只在 child 没有任何独有提交时成立（`branchState` 的 `integrated` + `behind>0`），因此不会有 merge commit，也不会有冲突：child 有独有提交（`fast_forward`）该用 `branch.merge`，分歧该用 `branch.sync`，两种情况都会被拒绝。父分支一个字都不改；child 有 worktree 时在它里面 `git merge --ff-only <parent-tip>`，否则用带旧值的 `git update-ref` 推进 ref。顶端本来就一致时返回 `{caught_up:false, already_integrated:true}`，不改 ref。

子分支被未收拢的直接子分支或未结束的任务挡住时同样拒绝（与 `branch.merge` 同一套 blockers）。

## graph.get 的 fork 边

Web 分支图使用 `graph.get`。每条 fork edge 附加：

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
  "can_sync": false,
  "can_catchup": false
}
```

`can_merge` / `can_sync` / `can_catchup` 是三个可执行动作：子→父快进、分歧时建子侧 merger、父→子快进，都要求 `blockers` 为空。前端据此决定按钮是可用还是禁用（禁用的按钮照样画出来，并在 title 里写明原因）。

相关：[分支优先架构](../../engineering/branch-first.md)。
