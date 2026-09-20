# 分支谱系

本节管 `branch.tree` / `branch.show` / `branch.import`：**显式记录**的分支创建关系（谁从谁派生），既不是 commit graph，也不是任务树。概念、数据模型与边界见[分支谱系](../engineering/branch-genealogy.md)。

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| `branch tree [--verbose]` | `branch.tree` | `{}` | 只读，用户与 agent 都可 |
| `branch show BRANCH\|TASK_ID` | `branch.show` | `{branch}`（纯数字时按 task id 查它的分支） | 只读，用户与 agent 都可 |
| `branch import` | `branch.import` | `{}` | 用户专属（写 store） |

`branch.tree` 返回：

```json
{
  "generated_at": "…", "git": true, "error": null,
  "current_branch": "main", "truncated": false, "count": 7,
  "roots": [ { "branch": "main", "parent": null, "parent_relation": "unknown", "children": [ … ] } ]
}
```

每个节点的字段：`branch`（分支短名）、`parent` / `parent_relation`（`recorded` / `inferred` / `unknown`；`parent` 为 `null` 表示没有记录）、`created_from_commit`（创建时的起点，parent 之后往前走也查得到）、`task_id` / `task_role` / `task_name` / `task_goal`（关联的 task，已被 `task clear` 清空时为 `null`，但 `task_id` 留着）、`worktree` / `worktree_exists`、`created_at`、`status`（`active` / `deleted`）、`tracked`（store 里有没有这条记录）、`present`（Git ref 现在还在不在；git 不可用时为 `null`）、`head_commit`、`current`（是不是当前检出分支）、`deleted`（`present === false`）、`children`。

读取是只读 git：`rev-parse --git-dir` / `symbolic-ref --short HEAD` / `for-each-ref refs/heads` / `worktree list --porcelain`，不 checkout、不 merge、不改 ref、不写 store。非 Git 项目不报错，只给出 store 里的记录（`git: false` 加 `error`）；节点数超过 500 截断并置 `truncated`。

`branch.show` 在此基础上多返回 `parent`（规范化的 parent 名）、`root`、`ancestors`（根在前、不含自己）、`chain`（`ancestors` + 自己）、`children`（直接子分支）、`descendants`（全部后代）。分支既没有记录、也不是本地分支时报 `branch X is neither recorded nor a local branch; 'lush branch import' registers existing branches`。

`branch.import` 对每条没有记录的本地分支写一行 `parent=NULL` / `parent_relation='unknown'` / `created_from_commit=NULL` / `task_id=NULL`，外加当前 worktree（如果有）。它**不**推断 parent，也**不**覆盖已有记录，可重复执行（第二次 `imported: 0`）。返回 `{imported, branches, local, recorded}`。
