# 分支谱系与收敛

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| `branch tree [--verbose]` | `branch.tree` | `{}` | 用户与 agent，只读 |
| `branch show BRANCH\|TASK_ID` | `branch.show` | `{branch}` | 用户与 agent，只读 |
| `branch import` | `branch.import` | `{}` | 用户专属 |
| `branch merge BRANCH` | `branch.merge` | `{branch}` | 用户专属 |
| `branch sync BRANCH` | `branch.sync` | `{branch}` | 用户专属 |
| `branch catchup BRANCH` | `branch.catchup` | `{branch}` | 用户专属 |
| `branch merge-plan BRANCH` | `branch.merge_plan` | `{branch}` | 用户与 agent，只读 |
| `branch merge-all BRANCH` | `branch.merge_all` | `{branch}` | 用户专属 |
| `branch merge-cancel BRANCH` | `branch.merge_cancel` | `{branch}` | 用户专属 |
| `branch archive BRANCH [--discard]` | `branch.archive` | `{branch, discard?}` | 用户专属 |

谱系是创建时显式写下的 `parent → child`，不是 commit graph 或任务树。`branch.import` 只登记已有本地分支，parent 为 unknown，不做推断。

## branch.tree / branch.show

节点字段包括 branch、parent / parent_relation、created_from_commit、task、worktree、present、head_commit、current、status。分支删除后历史行保留；只有 ref 的旧分支显示 untracked；只被 parent 提及的名称显示 placeholder。`status` 有 `active` / `archived` / `deleted` 三个取值：归档与回收都不删行。

**归档的节点不画在树上**（记录仍在库里）：`branch.tree` 会跳过 `status=archived` 的节点，把它们还在的后代接到最近的可见祖先上（没有就升为根），不会连带藏掉活着的后代。要看某条归档分支本身用 `branch.show`（它读的是完整记录，不受这层裁剪影响）。

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

## branch.archive

用户显式归档一条已登记分支：删掉它的 worktree 与本地 ref，但保留谱系行（`status` 标 `archived`，`deleted_at` 兼作归档时间）、任务行、消息、事件与 pi 会话文件。与 `branch.merge` / `branch.sync` 不同，它明知分支可能未合并也允许删，所以是用户专属写操作。参数 `discard`（布尔，缺省 `false`）：默认 worktree 脏时拒绝，只有 `discard:true` 才会连着未提交改动一起丢弃 worktree。

**归档的是一条子树**：传进来的 `branch` 是子树根，它的全部后代一起归档（已归档 / 回收过的后代跳过）。这样就不会留下一批「父分支已不在」的后代。

门槛：子树根必须已登记、不是 `archived` / `deleted`，当前检出分支不在子树里，且整棵子树与关联效果展示都没有未终态任务。`discard:false` 时，子树或终态展示里任一脏 worktree 都会在动任何东西之前失败（不会留下归档了一半的子树）。安全门通过后会停止关联的托管预览，并删除展示提交与基线提交的 detached worktree；展示任务、报告与执行记录保留。返回示例：

```json
{
  "branch": "lush/abc/7-api",
  "archived": true,
  "count": 2,
  "branches": [
    { "branch": "lush/abc/7-api", "worktree": "removed", "ref": "deleted", "tip": "...", "discarded": false },
    { "branch": "lush/abc/8-follow-up", "worktree": "removed", "ref": "deleted", "tip": "...", "discarded": false }
  ],
  "worktree": "removed",
  "ref": "deleted",
  "tip": "...",
  "discarded": false,
  "tasks": [{ "id": 7, "status": "completed" }],
  "sessions": [".lush/sessions/...jsonl"],
  "showcases": [{ "id": 12, "status": "completed", "worktrees": 2 }],
  "showcase_worktrees": 2
}
```

顶层的 `worktree` / `ref` / `tip` / `discarded` 描述的是**子树根**（调用方问的那一条），整棵子树逐条看 `branches`，`count` 是这次一共归档了几条分支。`showcases` 列出保留记录但已清理 detached worktree 的展示任务，`showcase_worktrees` 是实际存在并被删除的目录数。CLI 的 `lush branch archive BRANCH [--discard]` 非 JSON 输出由 `printBranchArchive` 打印，每条分支一行。

## branch.merge_plan / branch.merge_all / branch.merge_cancel

`branch.merge_plan BRANCH` 是只读面：返回目标分支的整棵后代子树，`items[]` 按「叶子在前」排序（`depth` 降序，其次创建时间、名字），每条给 `status`（`fast_forward` / `diverged` / `integrated` / `missing` / `unknown`）、`action`（`merge` / `sync` / `skip`）、`ready` 与 `blockers`；`order` 是要执行的分支名序列（含此刻被未收拢子分支阻塞、但叶子先合后会自动就绪的父分支）。`active_run` 是当前进行中的运行（没有则 null），`frozen` 表示目标是否已被冻结。目标分支不必先 `branch import`：不存在记录但本地有 ref 时，`branch.merge_all` 会按 `branch.import` 同一口径补一条根记录。

`branch.merge_all BRANCH` 在用户确认这份计划后开始：把运行写入目标分支的 `merge_run`，异步逐条 ff-only 收拢；分歧时自动建子侧 merger 并暂停，merger 结算后自动继续。返回 `{target_branch, status, plan, run}`；没有可执行项时返回 `{status:"empty"}` 且不写运行。同目标已有运行在跑时拒绝。

`branch.merge_cancel BRANCH` 清除运行、取消正在等待的 merger，并释放冻结；已落地的合并不回滚。三个方法均为用户专属写操作（`merge_plan` 只读）。冻结语义见[分支合并](../../engineering/merge.md#一键合并)。

归档后的分支不再出现在分支图上（它们是记录：`branch show` / `branch.archive` 事件 / 任务详情）：归档分支名下的任务节点也不再画出来，免得掉到目标分支或兜底分组里冒充成活着的工作。

## graph.get 的 fork 边

Web 分支图使用 `graph.get`。每个 branch 节点带 `origin` / `title` / `source_id` / `created_at`、汇总的 `status` 与 `tasks` 计数，另带 `worktree` / `worktree_state` 与 `deleted`；归档分支的 `status` 固定为 `archived`，带 `archived` / `archived_at`（复用 `branches.deleted_at`，不新增列），`tasks.branch` 指向它的任务节点带 `archived: true`。每个 `kind:'task'` 节点（含意图层的 planner / scheduler）另带「待你决断」的 notice：`notice` 是 `status='open'` 且 `kind` 为 `question` / `plan` 的最新一条（按 id 最大，没有则 null），`notice_count` 是这类 open notice 的总数；`kind='info'`（`status='sent'`）与 answered / dismissed 都不算。分支图把这条 notice 画在任务行里并就地处理（`question` 走 `notice.answer` / `notice.dismiss`，`plan` 走 `plan.approve` / `plan.reject`）。**归档节点仍在 `graph.get` 的返回里**（读模型不藏事实），但前端不再把它们画进分支树：`graphLayout` 跳过 `archived` 的 branch 节点与它们名下的任务，把它们还在的后代接到最近的可见祖先上，并给这种后代标上 `父分支已归档`（中性色，不是红色的「分支缺失」）。`missing` 只留给「谁都没归档、ref 真的不见了」那条 fork 边。每条 fork edge 附加：

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

待决 notice 也进分支图的重拉判断：快照指纹（`graphFingerprint`）与渲染指纹（`graphRenderKey`）都把 open 且 kind 为 question / plan 的 notice 算进来，所以新 notice 出现、被答复 / 忽略后，分支图会自动重拉重画；`kind='info'` 的纯提醒与 answered / dismissed 不算。

### branch 节点的 diagnostics

未归档分支另带 `diagnostics`（归档分支为 `null`）：

- `changes.status='ok'`：`base_commit` / `head_commit` 固定本次比较的两端，`files_total` / `added` / `deleted` / `binary_files` 是完整汇总；`files` 内各项为 `{path,added,deleted,previous_path?}`，二进制行数为 `null`。列表有界且由 `truncated` 标记，具体限额见[模块接缝](../../engineering/modules.md#分支诊断增量读面)。
- `changes.status='unavailable'`：`reason` 为 `missing_head` / `missing_baseline` / `read_failed`，不返回虚假的零计数。
- `latest_commit`：`{commit,committed_at,subject}`，时间为提交者时间、摘要最多 240 字符；读取失败或无 ref 时为 `null`。
- `working_tree.status`：`clean` / `dirty` 时带 `path` 与 `files_total` / `staged` / `unstaged` / `untracked` / `conflicts`；总数按文件去重，分类可重叠。`not_checked_out` 表示无实际检出，`unknown` 表示工作区读取失败或检出发生变化。

统计口径及界面说明见[分支诊断](../../task-flow-3-delivery.md#分支诊断高级)。只读、不写库；每次重新读取工作区状态，固定提交的差异与摘要有界缓存。

相关：[分支优先架构](../../engineering/branch-first.md)。
