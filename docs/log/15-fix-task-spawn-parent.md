# 15 · 派活不再跑出 task 树：`task spawn` 的父 task 缺省取 `$LUSH_TASK_ID`

> 现象：Web UI 里建的 `task#19` 下面多了一个不属于它这棵树的 `task#20`。查下去不是 Web UI 的问题——`POST /api/tasks` 建的就是 #19 本身；是 #19 的 agent 用 `lush task spawn 8 --goal '…'` 派活时没带 `--parent-task-id`，而 `task.spawn` 的缺省是「根 task」，于是这次委托悄悄离开了它的树（`lush task tree 19` 里根本看不到 #20，只有事后 `task list` 才露出来）。agent 自己发现后 `task cancel 20` 并带 `--parent-task-id 19` 重建为 #22。

## 根因：两处漂移叠在一起

- **命令形式漂移**：`src/agent/guide.js` 的 CLI_HOWTO 与 8 处 `templates/**/*.md` 教的是 `lush task spawn <SID> '<目标>'`（goal 作位置参数），而声明树（`src/cli/tree/task.js`）只收一个位置参数、goal 必须写成 `--goal`。照提示词敲的第一条命令直接 exit 2，agent 只能去读 help，再改成 `--goal` 重试。
- **父 task 缺省漂移**：`task message --from` 与 `notice post --task` 缺省都取 `$LUSH_TASK_ID`，唯独 `task spawn` 不取——缺省即根 task（`src/core/service_manager/tasks.js` 的 `taskSpawn(sid, goal, parentTaskId = null)`）。agent 环境里 `LUSH_TASK_ID=19` 明明就在（`src/agent/pi.js` 注入），却没有任何地方要求它用，于是「改了 --goal 之后」的那条命令必然建出游离根 task。

内置运行时不受影响：`AgentTools` 的 `task_spawn` 用当前 task 当父（`src/agent/tools.js`）；只有外部 agent（pi）走 CLI 这条路。

## Done

- [x] **父 task 缺省取 `$LUSH_TASK_ID`**（`src/cli/tree/task.js` 的 `delegatingTask()`）：agent 直接 `lush task spawn <子服务SID> --goal '<目标>'` 派出去的子 task 一定挂在自己的树里，与 `task message --from` / `notice post --task` 同一套约定。根 task 的正规入口是 `lush call SID GOAL --detach`；`--parent-task-id` 仍可显式覆盖。
- [x] **身份坏掉就大声报错**：`$LUSH_TASK_ID` 有值但不是合法 task id 时抛 `UsageError`（退出码 2，提示显式传 `--parent-task-id` 或 unset 以建根 task），不再静默降级成根 task——静默降级正是这个 bug 的形态。
- [x] **提示词改回正确形式**：`src/agent/guide.js` 的 CLI_HOWTO 与 8 处模板正文（`lush-root/system_prompt.md`、`project-manager/system_prompt.md`、`project-manager/spawn_prompt.md`、`project/system_prompt.md`、`project/spawn_prompt.md`、`dev-task/system_prompt.md`、`dev-task/spawn_prompt.md`、`worktree-service/spawn_prompt.md`）统一成 `--goal`，并在 guide 里写明「位置参数只收 SID / 父 task 缺省是 $LUSH_TASK_ID」。
- [x] **help 与文档**：`task spawn` 的 cover / notes / `--parent-task-id` 说明，以及 `docs/reference/cli.md` 的 `task spawn` 行。
- [x] **测试**（`test/task_spawn.test.js` + `test/cli.test.js`）：声明层（有 / 无 / 非法 `$LUSH_TASK_ID`、`--parent-task-id` 覆盖）、RPC 层（带父 → `parent_task_id` 与 `root_task_id` 都指向父、出现在父的 `task tree` 里；不带父 → 根 task）、真 daemon + 真 CLI 端到端（一个挂在 sid 2、被 notice 阻塞住的活动父 task，在 `LUSH_TASK_ID=<父>` 的环境里 `lush task spawn 3 --goal` → 子 task 落在父的树里；非法身份 exit 2）。

## 验收

- `just test`：179 项通过（基线 175 + 本轮的 4 项）。
- 真 daemon + 真 CLI（临时 home）：`LUSH_TASK_ID=<活动父 task> lush --json task spawn <直接子服务 SID> --goal …` 返回 `parent_task_id` / `root_task_id` 都是父 task id，`lush task tree <父>` 的 children 里有它；`LUSH_TASK_ID=nope` 时退出码 2 且 stderr 引述 `$LUSH_TASK_ID`。
- 现场数据（默认 home 的库）复核：task 19（根，sid 2）→ task 20（**根**，sid 8，游离）→ 21（属于 20）→ 22（属于 19）→ 23（属于 22）；#19 的 pi session 日志里那三条 `lush task spawn` 命令与 agent 自己写进 service state 的 `spawn_note` 一致。

## 备注

- `guide.js` 与 `templates/**/*.md` 属于 daemon 启动时读入的提示词面，**改完必须重启 daemon 才生效**（`just daemon-restart` / `lush daemon restart`），只重启你实际在用的那个 home。
- 用户 shell 里若 `LUSH_TASK_ID` 已被 export（例如从 agent 会话里掉出来），`lush task spawn` 也会按「子 task」建；要建根 task 用 `lush call SID GOAL --detach`，或 unset 后重试。
