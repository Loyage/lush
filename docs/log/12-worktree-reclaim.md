# 12 · worktree 合并后的资源回收（第二次 notice）

> 上一轮让 worktree-service 用 notice 问用户「是否合并」，project 执行合并。合并成功后 worktree 与它的分支就闲置了，但没人收尾——它们一直留在磁盘上。这一轮把「回收」也做成一道用户抉择：合并成功后由 project 再发一条 notice 问是否删除 worktree 与分支，同意才动手。

## Done

- [x] **`project` 的 prompt 增加第 6 步：合并后的回收**。合并成功（第 5 步）后，用 notice 问用户是否回收这次开发的 worktree 资源——删掉 worktree 目录与它的分支，默认阻塞等待答复。`fields` 为 `[{reclaim: choice(yes|no), required}, {force: boolean, default false}]`，body 写清 worktree 路径、分支、已合并到哪个 commit。`reclaim` 为 `yes` 时执行 `git -C <path> worktree remove <worktree>` 与 `git -C <path> branch -d <branch>`；worktree 有未提交改动 / 未跟踪文件时，**只有 `force` 为 true 才加 `--force`**，否则停下来把原因报告给用户；`branch -d` 拒绝就报告，不用 `-D` 强删。`reclaim` 不是 `yes` 时保留 worktree 与分支，只报告它们还在哪里。原来的收尾步骤顺延为第 7 步。
- [x] **第 5 步末尾不再笼统禁止删除**：原来写「绝不删 worktree」，现在回收有了明确的授权路径（第 6 步 + 用户同意），所以第 5 步只保留「绝不 force push、绝不 rebase 别人的分支」。
- [x] **`dev-task` / `worktree-service` 同步**：dev-task 仍只转达 `merge` / `worktree` / `branch` 等字段，并明确「合并后的回收由 project 在用户同意后执行，你不要删 worktree」；worktree-service 的第 5 步从「新建 / 删除 worktree 都是 dev-task 的决定」改为「新建是 dev-task 的决定；**回收是用户决定、project 执行**，你都不要自己删」。
- [x] **文档**：`README.md` 的分派表补上「合并成功后再问用户是否回收 worktree 与分支」，`docs/reference/templates.md` 的 project / dev-task 两条同步。
- [x] **验收**：`bun test` 174 项通过（模板 prompt 不改行为，只改文本；`core.test.js` 的模板断言覆盖的 `task spawn` / `task message` 等关键词仍在）。模板 loader 重新加载五个模板通过。

## 备注

- 这一轮只改模板 prompt 与文档，但 `templates/**/*.json` 在 fingerprint 里 → 仍要 `just daemon-restart`。
- 回收**只由 project task 执行**：dev-task 在合并前就已经结束（它的终态早于 project 的合并），无法再收消息，所以回收不能下发回 dev-task——这也是把它放在 project 第 6 步的原因。
- 两次 notice 是刻意的两道门：第一道决定「要不要把改动并进主树」，第二道决定「要不要删掉 worktree 与分支」；合并失败、用户拒绝合并、或回收被拒时，worktree 与分支都原样保留并报告位置。
