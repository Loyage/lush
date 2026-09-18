# 20 · 并行项目开发：开发与合并拆成两个阶段，worktree 由 project 串行建

> 目标：**并行的项目开发**。让一批互不依赖的工作同时在各自的 git worktree 里推进，而不是一件做完再做下一件。
>
> 上一轮的形状（[10](./10-worktree-merge-gate.md) / [12](./12-worktree-reclaim.md) / [16](./16-worktree-service-destructor.md)）把「是否合并」做成 worktree-service 侧**阻塞**的 notice：一次开发的几路都停在那里等用户拍板，而它们的祖先（dev-task、project）因为「有未结束的子 task 就不能 complete」也一直停在 `waiting`——于是**project 这个节点在整批开发 + 人答复的全部时间里不可派活**。并行开发能并发多少，就被人什么时候回话卡住了。
>
> 本轮**只改提示词与文档**（`templates/**/*.md`、`templates/lush-root/project-manager/project.json` 的 description）与一条测试断言，不加运行期机制、不动 Core。形状变成两阶段：**阶段 1 开发**（机器节奏、并行、不阻塞）+ **阶段 2 合并与回收**（人的节奏、串行）。

## 先说清三条约束（决定了形状）

- **一个 service 同时只有一个活动 task**（`src/core/tasks/rules.js:57`）。并行的表达方式因此不是「一个节点上跑多个 task」，而是**一批活拆成多件、每件一个子 service**。project 的 children 只有 dev-task，dev-task 的 children 只有 worktree-service——所以「每一路 = 一个 dev-task + 一个 worktree-service + 一个 worktree」，这是并行的单位。
- **`waiting` 也算活动 task**（`ACTIVE_TASK_STATUS = ['created','running','waiting']`，`src/core/lifecycle.js:18`）。一个 park 在子 task 上的 project task 照样占着节点；阻塞的 notice 更是如此。要腾出节点，就必须让阶段 1 的 task 真的**结束**，而不是停在等输入。
- **git 的两件事并发度不同**：`git worktree add` / `branch -d` 会写同一个仓库，多路各自建会撞分支名与目录；`git merge` 更是「主工作树」这一个资源的操作，天然串行。所以**建 worktree 与合并都归 project**（它本来就是一个 task 一个 task 串行跑的），并行的只有真正花时间的部分——在各 worktree 里改代码与跑验证。

## Done

- [x] **`project.system_prompt` 重写成两阶段协议**（入口看 goal 开头）：
  - **阶段 1 · 开发**（goal 不以「合并」/「回收」开头）：拆分（明显多条才拆）→ 为每件起**唯一短名**（查 `git -C <path> worktree list`、`git -C <path> branch --list`、children 里 dev-task 的 name，三处都空才用）→ **自己串行 `git worktree add <目录> -b <分支>`** 并 `test -d` 确认 → 建 dev-task 节点 → `task_construct` 派活（**一次可派多个**，goal 里带上 `worktree=<目录> branch=<分支>（已由你建好，直接复用）`）→ 结束本轮；子 task 全部结算后把待决清单（name / 分支 / worktree / 改动 / 验证 / 结论）写进持久 state 的 `worktrees` 键，用 **`wait: false` 的 notice** 报给用户（body 里给出答复语法），再 `task_complete` 收尾。
  - **阶段 2 · 合并与回收**（goal 以「合并」/「回收」开头，语法 `合并：<name>=yes|no[@<目标分支>] … 回收：<name>=yes …`）：先读 state 与各 worktree-service 节点的 path / 分支 / 主仓库 / HEAD 核对现场；在主工作树里**逐件串行** `git merge --no-ff`（冲突停下报告、绝不 force / rebase）；回收则给对应 dev-task 开「回收」task（互不相干的 worktree 可一次派多个），拿它的 result 决定是否把 dev-task 也 stop。
  - 「工作目录只读」这句删掉，改成「你不改工作树里的源文件；你只在主工作树里做 git 的 plumbing（`worktree add` / `merge` / `branch -d`），而且都是串行的」——建 worktree 本来就写 `.git` 元数据与分支引用。
- [x] **`project.json` 的 `description` 同步**：从「自身工作目录保持只读」改为「为每件工作串行建好独立 worktree、创建 dev-task 并派下去，让它们并行开发；汇总报给用户后按答复串行合并与回收」——它出现在 `service list` / `tree` 与父节点的 `available_child_templates` 里，是别的 agent 判断「这活归谁」的依据。
- [x] **`dev-task.system_prompt`**：新增「worktree 从哪来」一段——父节点会在 goal 里带 `worktree=<目录> branch=<分支>`，**直接复用、不要再 `git worktree add`**（多路并行时由 project 统一建，才不会撞名）；只有 goal 没给、且没有明确例外时才自己建（独立使用时的兜底）。第 5 步把「把用户的合并决定向上转达」改成「阶段 1 不合并、也不问用户」：`merge` 一律是 `null`，结构化 result 原样向上转达，是否合并由用户在 project 的阶段 2 答复。回收（析构）一节不变。
- [x] **`worktree-service.system_prompt`**：把「关于合并（重要）」那道**阻塞人工门**换成「不做合并决定、也不阻塞等人」——做完并验证过就如实 `task_complete`（`merge: null, target: null` + worktree / 分支 / repo / base / head / commits / verification / changed_files），并明确「一次开发有好几路并行，谁都不该被一个人的答复拖住」。析构契约（8–11）与 state 四项刷新不变。
- [x] **两个 `construct_prompt` 与 project 的 `construct_prompt` 同步**：`dev-task` 说明 worktree 通常由 project 建好、goal 里会带 `worktree=`；`worktree-service` 说明 path 通常由 project 事先用 `git worktree add` 建好，dev-task 只负责把这对值绑到节点上；`project` 的构造方新增一句：它按 goal 分两阶段，所以「并行开发」的用法是把整批独立工作一次性写进一个 goal，收到待决清单后再回一条「合并 / 回收」goal。
- [x] **测试**：`test/core.test.js` 新增一条断言（project 的 `阶段 1` / `阶段 2` / `worktree add` / `合并：` / `wait: false`；dev-task 的 `worktree=`、串行、`不要再 git worktree add`、`merge: null`；worktree-service 有 `merge: null` 且不再出现 `--kind decision`——即不再自己问用户）。既有断言（dev-task 的 `variables` / `detail` / `parent` / `task_construct`，worktree-service 的 `path` / `worktree add` / `service_construct` / `worktree` / `state` / `task_complete`）全部保留。
- [x] **文档**：`README.md` 的分派表、`docs/reference/templates.md` 的 project / dev-task / worktree-service 三条、`docs/concepts/service-model.md` 的规则 1（补一句「并行的正确表达方式是一批活拆成多件」与「project 为什么把等人的环节挪出节点占用」）。
- [x] **验收**：`bun test` 185 项通过（新增 1 条断言用例）。

## 实测依据

动手前用脚本化 provider 跑过 fan-out（临时用例，未留在仓库）：

- 父 task 一轮里派 4 个子 task → 4 个子 agent **全部在任何一个返回之前进入调用**（总耗时 215ms，顺序执行是 80+120+160+200 = 560ms 起），父子互不阻塞。
- 父 task 的 invocation 数 = **1 + 子结算唤醒次数**（4 个子 task 错峰结算 → 父被 invoke 5 次）。
- `maxCalls=3` + 4 个错峰子 task → `failed: task exceeded 3 agent calls`，而 `fail` 会 `cascade` 到整棵子树（`src/core/tasks/rules.js:130`）——**`LUSH_TASK_CALLS` 太小会把整批并行开发一起取消**。默认 12 对「N 路开发 + 逐件合并 + 回收」偏小，批量并行时要用 `LUSH_TASK_CALLS ≈ 4N+8`（上限 100，`src/config.js`）重启 daemon。

## 备注

- 只改 `templates/**/*.md` 与文档 → 仍属 fingerprint 覆盖范围，要 `just daemon-restart` 才生效；**已存在的 service 是创建时快照的 prompt**，老的 project / dev-task / worktree-service 实例不会自动获得新契约，新开的才有。
- 并行度的上限仍然由两个默认值决定，本轮没动它们：`LUSH_TASK_CALLS`（父 task 的唤醒预算）与「一个 service 一个活动 task」（同一节点不能同时接两批活）。要把这两条也放开，属于「模板声明并发度」那一类 Core 改动，本轮不做。
- pi 侧 notice 等待受 `LUSH_RPC_TIMEOUT` / `LUSH_CALL_TIMEOUT` 约束（`pauseTimer` 只对内置运行时生效，`docs/log/10` 已记录）。本轮把阶段 1 的阻塞等待去掉之后，长任务不再因为「等你回答」而被 900 秒超时杀掉——这也顺带绕开了那个未解耦的问题。
- 阶段 2 是用户显式触发的（`lush call`）：合并与回收都动主工作树，本来就需要人先拍板；把它做成一个独立 task，而不是让阶段 1 一直活着等人，是这一轮的核心取舍。
