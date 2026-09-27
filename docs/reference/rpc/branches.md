# 分支谱系与收敛

当前公开的分支接口只有下面四条；`branch.import` / `branch.merge` / `branch.sync` / `branch.catchup` / `branch.summary` / 一键合并与合并编排已下线，不再有 RPC / CLI / Web 入口。

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| `branch tree [--verbose]` | `branch.tree` | `{}` | 用户与 agent，只读 |
| `branch show BRANCH\|AP_ID` | `branch.show` | `{branch}` | 用户与 agent，只读 |
| `branch bind BRANCH COMMIT` | `branch.bind` | `{branch, commit}`（本地分支的固定 HEAD） | 用户专属 |
| `branch archive BRANCH [--discard]` | `branch.archive` | `{branch, discard?}` | 用户专属 |

谱系是创建时显式写下的 `parent → child`，不是 commit graph 或 AP 树。`branch.bind` 确认一条非 main 的本地分支及当前固定 HEAD，为它新建静息 `owner` 根 AP；重复绑定、错误 HEAD、缺失 ref、相关旧 AP 仍活动或已归档/删除的历史记录均拒绝。已有旧 AP 与 `branches.ap_id` 均不改写；`branch.tree/show` 当前所有者投影显示新 owner，但旧 AP 仍可按 id 查看。只有绑定后，新 say 才能挂到那条分支；owner 不接受任意消息或运行不受限 Agent。daemon 启动时已有本地 main ref 则自动确保同一个静息根；无 ref 时不会凭空造 main。

## branch.tree / branch.show

节点字段包括 branch、parent / parent_relation、created_from_commit、AP、worktree、present、head_commit、current、status。分支删除后历史行保留；只有 ref 的旧分支显示 untracked；只被 parent 提及的名称显示 placeholder。`status` 有 `active` / `archived` / `deleted` 三个取值：归档与回收都不删行。

**归档的节点不画在树上**（记录仍在库里）：`branch.tree` 会跳过 `status=archived` 的节点，把它们还在的后代接到最近的可见祖先上（没有就升为根），不会连带藏掉活着的后代。要看某条归档分支本身用 `branch.show`（它读的是完整记录，不受这层裁剪影响）。

## branch.bind

用户选定本地 `BRANCH` 与当时的 `HEAD COMMIT` 后，`branch.bind` 为非 main 且尚无新 AP 所有者的分支创建独立、永不执行不受限 provider 的静息 `ap_kind='owner'` 根 AP。它是新 say 挂在非 main 分支上的唯一入口；无绑定的新 say 直接拒绝，不会猜祖先。

## branch.archive

用户显式归档一条已登记分支：删掉它的 worktree 与本地 ref，但保留谱系行（`status` 标 `archived`，`deleted_at` 兼作归档时间）、AP 行、消息、事件与 pi 会话文件。它明知分支可能未合并也允许删，所以是用户专属写操作。参数 `discard`（布尔，缺省 `false`）：默认 worktree 脏时拒绝，只有 `discard:true` 才会连着未提交改动一起丢弃 worktree。

**归档的是一条子树**：传进来的 `branch` 是子树根，它的全部后代一起归档（已归档 / 回收过的后代跳过），不会留下一批「父分支已不在」的后代。

门槛：子树根必须已登记、不是 `archived` / `deleted`，当前检出分支不在子树里，且整棵子树都没有未终态 AP。`discard:false` 时，子树里任一脏 worktree 都会在动任何东西之前失败（不会留下归档了一半的子树）。返回示例：

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
  "aps": [{ "id": 7, "status": "completed" }],
  "sessions": [".lush/sessions/...jsonl"]
}
```

顶层的 `worktree` / `ref` / `tip` / `discarded` 描述的是**子树根**（调用方问的那一条），整棵子树逐条看 `branches`，`count` 是这次一共归档了几条分支。CLI 的 `lush branch archive BRANCH [--discard]` 非 JSON 输出由 `printBranchArchive` 打印，每条分支一行。

被归档分支名下的 AP 节点也不再画进分支树（它们是记录：`branch show` / `branch.archive` 事件 / AP 详情）。

## graph.get 的 fork 边

Web 分支图使用 `graph.get`。每个 branch 节点带 `origin` / `title` / `source_id` / `created_at`、汇总的 `status` 与 `aps` 计数，另带 `worktree` / `worktree_state` 与 `deleted`；归档分支的 `status` 固定为 `archived`，带 `archived` / `archived_at`（复用 `branches.deleted_at`，不新增列），`aps.branch` 指向它的 AP 节点带 `archived: true`。每个 `kind:'ap'` 节点另带「待你决断」的 notice：`notice` 是 `status='open'` 的最新一条（按 id 最大，没有则 null），`notice_count` 是 open notice 的总数；answered / dismissed 都不算。分支图把这条 notice 画在 AP 行里并就地处理（走 `notice.answer` / `notice.dismiss`）。**归档节点仍在 `graph.get` 的返回里**（读模型不藏事实），但前端不再把它们画进分支树：`graphLayout` 跳过 `archived` 的 branch 节点与它们名下的 AP，把它们还在的后代接到最近的可见祖先上，并给这种后代标上 `父分支已归档`（中性色，不是红色的「分支缺失」）。`missing` 只留给「谁都没归档、ref 真的不见了」那条 fork 边。每条 fork edge 附加：

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

`can_merge` / `can_sync` / `can_catchup` 是只读诊断字段，描述这条边当前是否可快进 / 需子侧收敛 / 可跟上父分支；新 say / child 的代码落地不经过这些旧入口，而由运行中的直接父 Agent `ap.integrate` 或用户 `ap.approve_merge` 按固定提交推进。

待决 notice 也进分支图的重拉判断：快照指纹（`graphFingerprint`）与渲染指纹（`graphRenderKey`）都把 open 的 notice 算进来，所以新 notice 出现、被答复 / 忽略后，分支图会自动重拉重画。

### branch 节点的 diagnostics

未归档分支另带 `diagnostics`（归档分支为 `null`）：

- `changes.status='ok'`：`base_commit` / `head_commit` 固定本次比较的两端，`files_total` / `added` / `deleted` / `binary_files` 是完整汇总；`files` 内各项为 `{path,added,deleted,previous_path?}`，二进制行数为 `null`。列表有界且由 `truncated` 标记，具体限额见[模块接缝](../../engineering/modules.md#分支诊断增量读面)。
- `changes.status='unavailable'`：`reason` 为 `missing_head` / `missing_baseline` / `read_failed`，不返回虚假的零计数。
- `latest_commit`：`{commit,committed_at,subject}`，时间为提交者时间、摘要最多 240 字符；读取失败或无 ref 时为 `null`。
- `working_tree.status`：`clean` / `dirty` 时带 `path` 与 `files_total` / `staged` / `unstaged` / `untracked` / `conflicts`；总数按文件去重，分类可重叠。`not_checked_out` 表示无实际检出，`unknown` 表示工作区读取失败或检出发生变化。

只读、不写库；每次重新读取工作区状态，固定提交的差异与摘要有界缓存。

相关：[分支优先架构](../../engineering/branch-first.md) · [分支合并](../../engineering/merge.md)。
