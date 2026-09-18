# 16 · worktree 的回收改成「service 的析构」：先回收对应的节点，再由这次回收删掉 worktree 与分支

> 需求：worktree 的回收不该是「谁拿着路径就去 `git worktree remove`」，而该像析构函数——`worktree` 的回收入口是它对应的 **service**：先回收那个节点，节点被回收这件事再触发目录与分支的删除；也就是给这个 service 一份「析构 prompt」。
>
> 上一轮（[12](./12-worktree-reclaim.md)）把回收做成 project 的第二道 notice + 由 project 亲自 `git worktree remove` / `git branch -d`。这一轮把执行者挪到 worktree 的持有者（dev-task）身上，并把「析构」写成 service 侧明确的一段契约与步骤。本轮**只改提示词与文档**，不加运行期机制。

## 先说清三条约束（决定了设计长什么样）

- **子 task 只能挂在直接子服务上**（`src/core/tasks/rules.js`：「service N is not a child of service M」）。project 的 children 只有 dev-task，worktree-service 是**孙**节点，所以 project 不能直接给 worktree-service 派 task；merge 门走完时 dev-task 的那个 task 也已结束，同样不能再派。
- **service 不能删掉自己的 cwd 之后再干活**。worktree-service 的 cwd 就是那个 worktree；`pi` 的 bash 工具每次执行前 `fs.access(cwd)`（`dist/core/tools/bash.js`），实测删除 cwd 后 `construct` 直接 `ENOENT`。所以「worktree-service 自己删掉 worktree，然后如实汇报」会被自己的 cwd 掐死。
- **析构者要站在能干活的地方**：dev-task 的 cwd 是 `$LUSH_HOME`，它可以用 `git -C <worktree>` / `git -C <repo>` 干任何事，且不会被自己删掉的目录卡住。

于是：**析构的契约（要删什么、什么条件下才允许删）写在被回收的节点（worktree-service），析构的执行写在持有它的节点（dev-task）**，入口仍然是「回收 service」，顺序是「先 stop 节点，再删它占的资源」。

## Done

- [x] **`worktree-service.system_prompt` 增加「析构契约」（第 8–11 条）**：析构 = 删除这个 worktree 与它的分支，是**用户**的决定、由 dev-task 执行；它绝不自己删、不 push / rebase / reset --hard、不 stop 自己；被 stop 后不再接 task（只能由回收方 `lush service start`）。回收方执行前先核对它的 state，所以每次接到 task 都要把 **path / 分支 / 主仓库 / HEAD commit** 刷新进持久 state（第 1 条同步改了），state 是「删哪个目录、删哪个分支、删到哪个 commit」的唯一依据；回收要成立必须 worktree 干净（`git status --porcelain` 无输出）且分支已合并（`merge-base --is-ancestor` 成功），所以不许在 worktree 里留未提交草稿；`--force` 需要用户明确同意。result 里补上 `service`（自己的 SID）、`repo`、`head`。
- [x] **`dev-task.system_prompt` 增加「回收（析构）」一节**：goal 以「回收」开头（`回收：worktree=… branch=… repo=… target=… force=…`）的 task 是回收任务，不是开发任务——不新建 worktree、不新派开发工作。步骤：a) `lush service children` 找到 path 匹配的 worktree-service 子节点，`lush service inspect` 核对它 state 里的 path / 分支 / 主仓库 / HEAD 与现场一致；b) 真跑自检（`status --porcelain`、`merge-base --is-ancestor`、`rev-parse HEAD`）；c) 自检不通过且 force 不是 true → 什么都不删，写 `destructible: false` + 原因 + 证据；d) 通过（或 force）→ **先** `lush service stop <worktree-service SID>`（service 被回收，记录保留）**再** `git -C <repo> worktree remove <path>` [--force] + `git -C <repo> branch -d <branch>`（`-d` 拒绝就报告，绝不用 `-D`）；e) result 写 `reclaimed` / `kept` / `destructible` / `reason` / `service` / `head` / `evidence`。开发阶段的 result 同步补上 `service`（自己的 SID）与 `worktree_service`（子节点 SID），project 回收时要靠这两个字段找节点。
- [x] **`project.system_prompt` 第 6 步重写**：notice 问用户（`reclaim` / `force` 不变）→ 答 yes 时**先回收对应的 service**：在结果里 `service` 指的 dev-task 节点上开 `lush task construct <dev-task SID> --goal '回收：worktree=… branch=… repo=… target=… force=…'`，结束本轮等它（它去 stop 那个 worktree-service 并删目录与分支）；拿到 result 后真删掉了才把 dev-task 节点也 `lush service stop`（整条链进终态、记录保留），只删了一部分或 `destructible: false` 则两个节点原样保留并把原因报告给用户；找不到 dev-task 节点（已 stop / 已删）时 project 自己按同一套步骤兜底。第 5 步的「唯一会动主工作树」改为「会动主工作树」，第 2 步补一句 dev-task 同时管开发与回收两阶段。
- [x] **两个 `construct_prompt` 同步**：`dev-task/construct_prompt` 说明同一个节点上再开一个「回收」task 就完成回收、创建方不要自己删 worktree；`worktree-service/construct_prompt` 说明它的回收由 dev-task 的回收 task 执行、派活时要提醒它把 path / 分支 / 主仓库 / HEAD 写进 state。
- [x] **文档**：`README.md` 的分派表、`docs/reference/templates.md` 的 project / dev-task / worktree-service 三条同步成本轮语义。
- [x] **验收**：`bun test` 全绿（模板 prompt 只改文本；`test/core.test.js` 的模板断言覆盖的关键词——project 的 `task construct` / `state`、dev-task 的 `task_construct`、worktree-service 的 `worktree` / `state` / `task_complete`——都还在）。模板 loader 重新加载五个模板通过（断言与 `service inspect --with prompt` 看到的都是内联后的正文）。

## 备注

- 只改了 `templates/**/*.md` 与文档，但 `templates/**/*.json` 的散文字段属于 fingerprint → 仍然要 `just daemon-restart`；已经存在的 service 是创建时快照的 prompt，老节点不会自动获得新契约（新开的 worktree-service 才有）。
- 顺序是刻意的：**先 stop 节点，再删它占的资源**。节点一进终态就不再接新 task，目录随后消失，不会出现「目录已经没了，节点还想往里写」的窗口；stop 是冻结不是删除，`service inspect` 之后仍能查到它这轮干了什么、什么被删了。
- 删目录与分支的仍然只有两条路径：用户答 yes 的回收（本轮这条），或用户明确要求彻底删时的手动 `service purge`。dev-task 的回收任务不删主工作树、不碰别人的 worktree 与分支，也不 push / rebase。
- 为什么不让 worktree-service 自己删：它的 cwd 就是待删目录，删完 `fs.access(cwd)` 就失败，连 `task_complete` 都跑不出去（实测 `ENOENT`）。要在「节点自己删」与「能如实汇报」之间二选一，本轮选了后者。
