# 分支谱系（Branch Genealogy）

本文件管「branch 之间的创建 / 派生关系」：数据结构、写入时机、`recorded` 与 `unknown` 的区别、删除后的处理，以及 `lush branch *` 的用法。

## 它是什么，不是什么

- **是**：`branch B` 由 `branch A` 创建出来这条**语义关系**，在创建那一刻显式写下。
- **不是** commit graph。谁是 merge 进来的、哪个 commit 在哪条分支上，那是 Git 的事，谱系不看、也不画。
- **不是**任务树。`Task A → Task B` 是派活关系；`branch(A) → branch(B)` 是代码血缘。一个 task 可以基于**别的** task 的分支创建（`code` 依赖），所以这两个维度只通过 `branches.task_id` 关联，不互相推导。
- **不是** git ref 的镜像。谱系是历史事实：ref 被删了，记录还在。

核心对象与关系：

```text
Task ──(task_id)──> Branch ──(parent)──> Branch
                       │
                       └──(worktree)──> .lush/worktrees/<id>-<name>
```

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
| `task_id` | 创建它的 task id；**故意没有外键**，`task clear` 清空 tasks 后这条记录仍然有效 |
| `worktree` | 对应的 worktree 路径（创建时写入；现在还在不在由读模型的 `worktree_exists` 回答） |
| `status` | `active` / `deleted`（`deleted` 只由回收路径写入，见下） |
| `created_at` / `deleted_at` | 写入与标记删除的时间 |

写入只有两个入口，都在 Git 边界里，没有第二套分支创建机制：

1. **创建**：`Workspaces#ensure` 在 `git worktree add -b <branch> <dir> <commit>` **之前**先落库（与 `workspace` / `base_commit` 同一套「先落库再动 git」的约定）。`parent` 是这次真正分叉出来的分支：有 `code` 依赖时是**上游任务的分支**（stacked），解冲突任务是**目标分支**，其余是当时检出的分支；`created_from_commit` 就是拉起 worktree 用的那个 commit。
2. **删除**：`Workspaces#dropBranch` 在 `update-ref -d` 成功后调 `markBranchDeleted`，只把 `status` 改成 `deleted`，**不删行**。

`recordBranch` 是幂等的（`ON CONFLICT DO NOTHING`）：崩溃重试撞见已创建的分支不会重写 parent，**merge 也永远不改谱系**——`B` 合并进 `main` 之后，`parent(B)` 还是原来的 `A`。

## 查询

纯逻辑在 `src/core/genealogy.js`（`buildForest` / `parentOf` / `childrenOf` / `ancestorsOf` / `descendantsOf` / `rootOf` / `chainOf`），不碰 git、不写盘、不渲染；读模型在 `src/core/project/branches.js`，把 store 记录与只读 git（`for-each-ref` / `symbolic-ref` / `worktree list --porcelain`）合成节点表。CLI 只是这份数据的一个 viewer，Web 以后可以复用同一份 JSON 画别的形状。

约定：

- **没有记录、但有 ref** 的本地分支也画出来，标 `[?]`（untracked）——旧项目第一次跑不会是一片空白。
- **有记录、但 ref 已不在** 的节点标 `[deleted]`，子分支照旧挂在它下面。
- `*` 是当前检出分支；`parent: unknown` 表示**没有** parent 记录，不是「推断不出来所以随便填了一个」。

## CLI

```bash
lush branch tree [--verbose]        # 谱系树；--verbose 每节点给出 task / worktree / fork / parent
lush branch show BRANCH|TASK_ID     # 一条分支的 parent、fork commit、task、worktree、祖先链、子分支
lush branch import                  # 把现有本地分支登记成记录（只记存在与 worktree，不推断 parent）
```

`branch show` 接受分支短名，也接受纯数字的 task id（分支名形如 `lush/<哈希>/<id>-<name>`，手打太长）。RPC 是 `branch.tree` / `branch.show` / `branch.import`；前两个只读、agent 也能调，`branch.import` 会写 store，因此是用户专属（`USER_ONLY`）。

### 已有分支怎么办

引入这个功能之前就存在的分支**没有** parent 记录。runtime 不会去猜一个「看起来合理」的 parent 当成事实，所以：

- 默认视图把它们标成 `[?]` untracked 根节点；
- `lush branch import` 只把它们登记成 `parent=NULL`、`parent_relation='unknown'`，外加「现在检在哪个 worktree」这条事实，绝不写入 merge-base 猜出来的 parent；已记下的记录不会被覆盖。

要真的引入启发式推断时，写进去的关系必须是 `parent_relation='inferred'`，与 `recorded` 在数据和视图上都分得开。

### 分支被删除之后

谱系表示**历史上的创建关系**，不因为 ref 消失就丢：

```text
main
└── A
    └── B [deleted]      ← B 的 ref 没了，记录还在
        └── C            ← C 当初从 B 创建这条事实仍然查得到
```

`dropBranch` 会把 `status` 标成 `deleted`；外部（用户自己 `git branch -D`）删掉的分支，读模型按 ref 现状显示 `[deleted]`，不会去改库。

## 并发与一致性

没有裸 JSON read-modify-write：记录写在 SQLite 里，创建路径本来就串行（`Workspaces#exclusive` 把所有 git 变更排队），import 用一次事务批量插入。多进程也不会出现「一个进程覆盖另一个」的窗口。

相关：[Git 边界](git-boundary.md)、[工作区与分支回收](cleanup.md)、[批准合并](merge.md)。
