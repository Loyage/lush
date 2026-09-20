# 分支谱系（Branch Genealogy）

本文件管「branch 之间的创建 / 派生关系」：数据结构、写入时机、`recorded` 与 `unknown` 的区别、删除与归档后的处理，以及 `lush branch *` 的用法。

## 它是什么，不是什么

- **是**：`branch B` 由 `branch A` 创建出来这条**语义关系**，在创建那一刻显式写下。
- **不是** commit graph。谁是 merge 进来的、哪个 commit 在哪条分支上，那是 Git 的事，谱系不看、也不画。
- **不是**任务树。`Task A → Task B` 是派活关系；`branch(A) → branch(B)` 是代码血缘。一个 task 可以基于**别的** task 的分支创建（`code` 依赖），所以这两个维度只通过 `branches.task_id` 关联，不互相推导。
- **不是** git ref 的镜像。谱系是历史事实：ref 被删了，记录还在。

核心对象与关系：

```text
Input ──(anchor_branch)──> Branch ──(parent)──> Branch
                              │
Task ──(task_id)──────────────┤
                              └──(worktree)──> .lush/worktrees/<id>-<name>
```

输入分支没有 `task_id`（它通过 `inputs.anchor_branch` 属于输入），任务分支的 `task_id` 指向任务自己；两种分支都遵守同一个谱系不可变规则。输入分支本身可推进，用来聚合任务子分支。

## 为什么不用 Git 事后推断

Git 不保存「B 是从 A 创建的」这种关系：`merge-base`、reflog、commit 图都只能给出**看起来合理**的猜测。所以 runtime 在自己创建分支的那一刻记录，而不是事后推测；也没有任何后台任务会去「补全」parent。

## 数据模型

表 `branches`（SQLite，与任务同一份 `<project>/.lush/project.db`；schema 是公共面，改动要同步 [模块地图](modules.md)）：

| 列 | 含义 |
|---|---|
| `branch` | 分支短名（PK），如 `lush/<项目哈希>/7-auth-ui` |
| `parent` | 创建时所在的父分支短名；`NULL` 表示没有 parent 记录 |
| `parent_relation` | `recorded` = 创建时记下；`inferred` = 由 import 的启发式推断（当前 `branch import` **不猜**，所以不会写入）；`unknown` = 没有 parent 记录 |
| `created_from_commit` | 创建分支那一刻父分支（或冻结基线）指向的 commit SHA——parent 之后往前走也查得到当时的起点 |
| `task_id` | 创建它的 task id；故意没有外键。输入聚合分支为 `NULL`（通过 `inputs.anchor_branch` 关联） |
| `worktree` | 对应的 worktree 路径（创建时写入；现在还在不在由读模型的 `worktree_exists` 回答） |
| `status` | `active` / `archived` / `deleted`；只有回收（`dropBranch` / `dropAnchor`）与归档（`archiveBranch`）两条路径写它，见下 |
| `created_at` / `deleted_at` | 写入与标记删除的时间；归档复用 `deleted_at`（都表示「这条分支什么时候从磁盘上消失」），不另加列 |

创建与状态写入都在 Git 边界里，没有第二套分支创建机制；谱系行的写入口只有下面这些：

1. **创建**：`Workspaces#anchor`（输入分支）与 `Workspaces#ensure`（任务 worktree）在 `git worktree add -b <branch> <dir> <commit>` **之前**先落库。输入分支的 `parent` 是用户提交时指定的本地分支；普通任务的 parent 是输入分支，`code` 下游的 parent 是上游任务分支，branch-sync merger 的 parent 是待同步 child。任务 `target_branch` 与这个直接 parent 一致。
2. **回收**：`Workspaces#dropBranch`（任务分支）与 `Workspaces#dropAnchor`（兼容命名：输入分支）在 compare-and-delete 成功后标 `deleted`，不删谱系行。
3. **归档**：`Workspaces#archiveBranch`（经 `Project#archiveBranch`）删掉 worktree 与本地 ref 后标 `archived`，同样不删行。它明知分支可能未合并也允许删，保留任务行、消息、事件与 pi 会话文件，是显式放弃代码的路径——与回收的区别见 [工作区与分支回收](cleanup.md)。

`recordBranch` 是幂等的（`ON CONFLICT DO NOTHING`）：崩溃重试撞见已创建的分支不会重写 parent，**merge 也永远不改谱系**。写操作只允许 child 合回这个 recorded direct parent；导入的 unknown parent 只能看，不能据此合并。

## 查询

纯逻辑在 `src/core/genealogy.js`（`buildForest` / `parentOf` / `childrenOf` / `ancestorsOf` / `descendantsOf` / `rootOf` / `chainOf`），不碰 git、不写盘、不渲染；读模型在 `src/core/project/branches.js`，把 store 记录与只读 git（`for-each-ref` / `symbolic-ref` / `worktree list --porcelain`）合成节点表。CLI 只是这份数据的一个 viewer，Web 以后可以复用同一份 JSON 画别的形状。

约定：

- **没有记录、但有 ref** 的本地分支也画出来，标 `[?]`（untracked）——旧项目第一次跑不会是一片空白。
- **有记录、但 ref 已不在** 的节点标 `[deleted]`，子分支照旧挂在它下面；`branches.status` 区分它是被回收（`deleted`）还是被归档（`archived`），`branch show` 与 Web 分支图都会报出来。
- `*` 是当前检出分支；`parent: unknown` 表示**没有** parent 记录，不是「推断不出来所以随便填了一个」。

## CLI

```bash
lush branch tree [--verbose]        # 谱系树；--verbose 每节点给出 task / worktree / fork / parent
lush branch show BRANCH|TASK_ID     # 一条分支的 parent、fork commit、task、worktree、祖先链、子分支
lush branch import                  # 把现有本地分支登记成记录（只记存在与 worktree，不推断 parent）
lush branch archive BRANCH [--discard]  # 归档：删 worktree 与本地 ref，保留任务、事件与会话；--discard 才会丢弃未提交改动
```

`branch show` 接受分支短名，也接受纯数字 task id。RPC 另有用户专属 `branch.merge`（ff-only 合回直接父分支）、`branch.sync`（分歧时创建子侧 merger）与 `branch.archive`（归档，允许未合并）；交互主入口是 Web 分支图。

### 已有分支怎么办

引入这个功能之前就存在的分支**没有** parent 记录。runtime 不会去猜一个「看起来合理」的 parent 当成事实，所以：

- 默认视图把它们标成 `[?]` untracked 根节点；
- `lush branch import` 只把它们登记成 `parent=NULL`、`parent_relation='unknown'`，外加「现在检在哪个 worktree」这条事实，绝不写入 merge-base 猜出来的 parent；已记下的记录不会被覆盖。

要真的引入启发式推断时，写进去的关系必须是 `parent_relation='inferred'`，与 `recorded` 在数据和视图上都分得开。

### 分支被删除或归档之后

谱系表示**历史上的创建关系**，不因为 ref 消失就丢：

```text
main
└── A
    └── B [deleted]      ← B 的 ref 没了，记录还在
        └── C            ← C 当初从 B 创建这条事实仍然查得到
```

`dropBranch` 会把 `status` 标成 `deleted`；外部（用户自己 `git branch -D`）删掉的分支，读模型按 ref 现状显示 `[deleted]`，不会去改库。

归档同理：`archived` 是 `status` 的第三个取值，不删行、不动子分支的 `parent` 指针；归档过的节点照旧画出来（Web 分支图显示「已归档」），子分支仍挂在它下面。所以「ref 已不在」与「行已被删」是两回事，读模型永远按 `branches` 行与 git 现状合并出节点。

## 并发与一致性

没有裸 JSON read-modify-write：记录写在 SQLite 里，创建路径本来就串行（`Workspaces#exclusive` 把所有 git 变更排队），import 用一次事务批量插入。多进程也不会出现「一个进程覆盖另一个」的窗口。

相关：[Git 边界](git-boundary.md)、[工作区与分支回收](cleanup.md)、[批准合并](merge.md)。
