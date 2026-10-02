# 分支谱系与收敛

当前公开的分支接口如下；`branch.import` / `branch.merge` / `branch.sync` / `branch.catchup` / `branch.summary` / 一键合并与合并编排已下线，不再有 RPC / CLI / Web 入口。

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| 无 CLI 命令；Web「版本迭代」 | `branch.history` | `{cursor?, limit?}`（默认 50，1..100） | 用户专属，只读 |
| `branch tree [--verbose]` | `branch.tree` | `{}` | 用户与 agent，只读 |
| `branch show BRANCH\|TASK_ID` | `branch.show` | `{branch}` | 用户与 agent，只读 |
| `branch bind BRANCH COMMIT` | `branch.bind` | `{branch, commit}`（本地分支的固定 HEAD） | 用户专属 |
| `branch archive BRANCH [--discard]` | `branch.archive` | `{branch, discard?}` | 用户专属 |

谱系是创建时显式写下的 `parent → child`，不是 commit graph 或Worker树。`branch.bind` 确认一条非 main 的本地分支及当前固定 HEAD，为它新建静息 `owner` 根 Worker；重复绑定、错误 HEAD、缺失 ref、相关旧Worker仍活动或已归档/删除的历史记录均拒绝。已有旧 Worker 与 `branches.task_id` 均不改写；`branch.tree/show` 当前所有者投影显示新 owner，但旧 Worker 仍可按 id 查看。只有绑定后，新 say 才能挂到那条分支；owner 不接受任意消息或运行不受限 Agent。daemon 启动时已有本地 main ref 则自动确保同一个静息根；无 ref 时不会凭空造 main。

## branch.history

只读项目 `refs/heads/main` 的第一父链，最新提交在前。返回 `branch/tip/commits/cursor/has_more`；每项包含完整和短 SHA、父提交、摘要、作者名、提交时间、`association` 与关联的 Worker/原始 Input。完整字段见[版本迭代契约](../../engineering/version-history.md)。没有 main 时 `tip:null,commits:[]`，读取失败明确报错。

只匹配完整 SHA 的成功交付事件：`task.merge_integrated` 仅在事件明确提供整数 `parent_id` 且该父 Worker 属于 main 时关联。缺失、null、字符串、布尔值或浮点类型的父 ID 均保守未关联，不回退Worker当前目标。旧 `merged` 事件要求 `parent=main`，或明确 `legacy:true`、Worker 属于旧协议（`task_kind` 为空）且Worker固定目标为 main。新 say/child 等不能借 legacy 标记回退目标。历史 no-ff 事件只有源 SHA 时，不猜为 main 的合并落点。不凭提交标题、当前 Worker HEAD 或时间猜测；无证据显示未关联，多次交付分别保留。

分页游标带本 daemon 实例的签名，固定首屏 main tip 和第一父链上的下一提交；main 前进或改写后仍读取该已取样历史，不混入新提交。daemon 重启、换项目/实例、修改游标或对象清理后须刷新，不能把任意 SHA 伪造成游标。请求不接受 branch/ref/cwd，HTTP 拒绝未知/重复查询字段。

Git 读取共享 15 秒截止时间，stdout 上限 4 MiB；每页最多 100 次提交，关联审计最多 1000 条，Worker 目标最多 16,384 字符、原始 say 最多 131,072 字符，JSON 响应最多 512 KiB。超过界限明确报错，不静默截断；页总量超限时可降低 limit。

## branch.tree / branch.show

节点字段包括 branch、parent / parent_relation、created_from_commit、task、worktree、present、head_commit、current、status。分支删除后历史行保留；只有 ref 的旧分支显示 untracked；只被 parent 提及的名称显示 placeholder。`status` 有 `active` / `archived` / `deleted` 三个取值：归档与回收都不删行。

**归档的节点不画在树上**（记录仍在库里）：`branch.tree` 会跳过 `status=archived` 的节点，把它们还在的后代接到最近的可见祖先上（没有就升为根），不会连带藏掉活着的后代。要看某条归档分支本身用 `branch.show`（它读的是完整记录，不受这层裁剪影响）。

## branch.bind

用户选定本地 `BRANCH` 与当时的 `HEAD COMMIT` 后，`branch.bind` 为非 main 且尚无新 Worker 所有者的分支创建独立、永不执行不受限 provider 的静息 `task_kind='owner'` 根 Worker。它是新 say 挂在非 main 分支上的唯一入口；无绑定的新 say 直接拒绝，不会猜祖先。

## branch.archive

用户显式归档一条已登记分支：删掉它的 worktree 与本地 ref，但保留谱系行（`status` 标 `archived`，`deleted_at` 兼作归档时间）、Worker行、消息、事件与 pi 会话文件。它明知分支可能未合并也允许删，所以是用户专属写操作。参数 `discard`（布尔，缺省 `false`）：默认 worktree 脏时拒绝，只有 `discard:true` 才会连着未提交改动一起丢弃 worktree。

**归档的是一条子树**：传进来的 `branch` 是子树根，它的全部后代一起归档（已归档 / 回收过的后代跳过），不会留下一批「父分支已不在」的后代。

门槛：子树根必须已登记、不是 `archived` / `deleted`，当前检出分支不在子树里，且整棵子树都没有未终态Worker。`discard:false` 时，子树里任一脏 worktree 都会在动任何东西之前失败（不会留下归档了一半的子树）。返回示例：

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
  "sessions": [".lush/sessions/...jsonl"]
}
```

顶层的 `worktree` / `ref` / `tip` / `discarded` 描述的是**子树根**（调用方问的那一条），整棵子树逐条看 `branches`，`count` 是这次一共归档了几条分支。CLI 的 `lush branch archive BRANCH [--discard]` 非 JSON 输出由 `printBranchArchive` 打印，每条分支一行。

被归档分支名下的 Worker 记录仍可从 `branch show` / `branch.archive` 事件 / Worker详情查询；Worker 图默认隐藏，可显式显示。

## graph.get 的 fork 边

`graph.get` 作为只读 RPC 保留完整 Git 谱系；Web 已删除旧分支视图及 `/api/graph` HTTP 路由，Worker 卡片改用 [`worker.graph`](tasks.md) 的精简诊断。每个 branch 节点带 `origin` / `title` / `source_id` / `created_at`、汇总 `status` 与 `tasks` 计数，以及 `worktree` / `worktree_state` / `deleted`。**归档节点仍在 RPC 返回里**，其 `status='archived'`，带 `archived` / `archived_at`，对应 Worker 带 `archived:true`。Worker 节点还保留 `notice` / `notice_count` 的只读待决摘要。每条 fork edge 附加：

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

`can_merge` / `can_sync` / `can_catchup` 是只读诊断字段，描述这条边当前是否可快进 / 需子侧收敛 / 可跟上父分支；新 say / child 的代码落地不经过这些旧入口，而由运行中的直接父 Agent `worker.integrate` 或用户 `worker.approve_merge` 按固定提交推进。

Web 待决操作在 Worker 图、Worker 详情与「待我处理」进行，不再有分支图重拉或定位入口。

### branch 节点的 diagnostics

未归档分支另带 `diagnostics`（归档分支为 `null`）：

- `changes.status='ok'`：`base_commit` / `head_commit` 固定本次比较的两端，`files_total` / `added` / `deleted` / `binary_files` 是完整汇总；`files` 内各项为 `{path,added,deleted,previous_path?}`，二进制行数为 `null`。列表有界且由 `truncated` 标记，具体限额见[模块接缝](../../engineering/modules.md#分支诊断增量读面)。
- `changes.status='unavailable'`：`reason` 为 `missing_head` / `missing_baseline` / `read_failed`，不返回虚假的零计数。
- `latest_commit`：`{commit,committed_at,subject}`，时间为提交者时间、摘要最多 240 字符；读取失败或无 ref 时为 `null`。
- `working_tree.status`：`clean` / `dirty` 时带 `path` 与 `files_total` / `staged` / `unstaged` / `untracked` / `conflicts`；总数按文件去重，分类可重叠。`not_checked_out` 表示无实际检出，`unknown` 表示工作区读取失败或检出发生变化。

只读、不写库；每次重新读取工作区状态，固定提交的差异与摘要有界缓存。

相关：[分支优先架构](../../engineering/branch-first.md) · [分支合并](../../engineering/merge.md)。
