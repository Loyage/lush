# 23 · 测试瘦身：删掉重复覆盖，把长耗时用例的固定睡眠换成条件等待

> 目标：`bun test` 的总墙钟时长有可测量的下降，且 **0 fail**；同时不拿有意义的行为覆盖换速度——每个行为至少留一条测试，纯格式化 / 校验类断言可以合并但不能整类消失。
>
> 本轮只动 `test/` 下的文件（`src/` 未改），改动前后都在 worktree `/Users/loyage/Documents/lush-trim-tests-1`（branch `trim-tests-1`）里用 `LUSH_HOME=$PWD/.lush LUSH_PROVIDER=mock bun test` 实测。

## Done

- [x] **基线（自己实测，不引用别人的数字）**：`bun test` → **208 tests / 0 fail / 14 files / 20.1s**；逐文件计时里 `cli.test.js` **13.39s**、`pi.test.js` 2.36s、`agent.test.js` 1.18s、`core.test.js` 1.01s、`runtime.test.js` 0.64s，其余 <0.4s。其中 `cli.test.js > task agents kill stops the worker and cancels its task` 一条就占 **6.72s**：假 pi 用 `PI_STUB_SLEEP: '3000'` 固定睡 3s，而这条用例实际上会跑三次假 pi（首轮被杀 + 队列重试 + 后面又一次 `intent submit`），于是 6.7s 里有 ~6s 是白等的固定睡眠。
- [x] **去掉固定睡眠（这是本轮最大的一笔）**：把那个假 pi 的 `Bun.sleep(PI_STUB_SLEEP)` 换成**门文件**（gate file）——stub 在 `PI_STUB_GATE` 指向的文件存在时循环 `await Bun.sleep(10)`，测试观察完 `status: running` 的 agent、确认 kill 的结果之后 `fs.rmSync(gate)` 放行。用例的意图（观察运行中的 agent → kill → 队列重试）一条没少，等待时间从固定的 3s×3 变成真实的进程调度时间：该用例 **6.72s → 0.95s**。
- [x] **清理收尾不再多付 100ms/次**：`cli.test.js` 的 `afterEach` 原本先 `lush daemon stop` 再 `forceStopDaemon`；`daemon stop` 在 CLI 里是 **100ms 一次的锁轮询**（`stopDaemon` 的 `Bun.sleep(100)`），13 条用例每条白付 ~120ms。优雅停机本身已由用例正文覆盖（MVP flow 与 restart 两条都显式 `daemon stop`），`afterEach` 只是清理，于是只留 `forceStopDaemon`（SIGKILL + 20ms 轮询），并保留 `expect(isLocked(home)).toBe(false)` 这条「不留后台 daemon」的断言。`cli.test.js` 三条连续跑稳定在 **6.5–6.8s**。
- [x] **超时用例改条件等待**：`pi.test.js > an interactive task nobody settles times out and fails` 原本 `await Bun.sleep(300)` 等一个 `timeout: 0.05` 的裁决，改成每 5ms 轮询 `runtime.isBusy(0)`，**316ms → 78ms**。
- [x] **删掉重复覆盖的用例（4 条，全部能指名覆盖者）**：
  - `runtime.test.js > a task can only wait on its own downstream work` —— 删。它的每一条断言都已被 `core.test.js > a task may only delegate to a direct child service`（`/only delegate downstream/`、`/cannot delegate to its own service/`）和 `core.test.js > a task may only wait on its own subtree, and never on itself`（`/not part of task/`、`/cannot wait on itself/`、成功 wait 返回 `completed`）逐条覆盖，只是换了 service 名字。
  - `identity.test.js > daemon text output > shows identity fields and the CLI view, hiding nested objects` —— 删，断言并入 `cli.test.js > daemon status reports which home and which code answer`（那条是**真 daemon** 跑同一个 `formatDaemon`）：`daemon_pid` 行、`fingerprint` 行、`cli.code_match` 行、`cli` 被摊平成 `cli.` 前缀而不是打印成对象、文本里没有 `{`。只有 fixture 专用的「行数 = 10」没有搬（那是那组固定输入的产物，不是行为）。
  - `core.test.js > pagination validation` —— 删，`taskHistory` 的 `after/limit`（`-1`、`0`、`1001`、非整数）断言并入 `core.test.js > tasks can be listed, inspected and deleted`（那里本来就有 `-1` 那一档）。
  - `core.test.js > view has no command section and ignores legacy snapshot fields` —— 删，`parent` / `children` / `call_prompt` 与 `view answers what the node is, what it may create and how its tasks read` 重复，唯一独有的「`command` 不是合法 section」断言搬进后者。
- [x] **让 `bun test` 真的 0 fail（- 环境泄漏）**：`intension.test.js > a task may not submit user input, and submit is words first` 只在第一个断言外面套了 `withEnv('19', …)`，后两条断言依赖「环境里没有 `LUSH_TASK_ID`」——在 agent 自己的 shell 里跑（`LUSH_TASK_ID` 必然存在）就会出现 `1 fail`，而同一个仓库在一个干净 shell 里是 0 fail。这不是新引入的失败，但既然验收命令就是 `bun test`，把后两条断言也放进 `withEnv(undefined, …)`：测试不再由环境决定断言什么。修完在**两种环境**下都是 0 fail。
- [x] **验收（改动后，同一 worktree、同一命令）**：`bun test` → **204 tests / 0 fail / 14 files / 12.0s**（干净环境）；在带 `LUSH_TASK_ID` 的 agent 环境里 **204 / 0 fail / 13.2s**。逐文件：`cli.test.js` **6.75s**（原 13.39s）、`pi.test.js` 2.52s、`agent.test.js` 1.29s、`core.test.js` 1.08s、`runtime.test.js` 0.33s、其余 ≤0.33s。总墙钟 **20.1s → 12.0s（-40%）**，用例数 208 → 204（减法只有上面那 4 条，做的是删除或合并，没有任何整类行为消失）。

## 备注

- `src/` 一行未改：加速全部来自测试侧的等待方式与清理方式，不需要加测试钩子，也没有改变任何运行时行为。
- 还剩什么没做（留作后续，不在本轮扩范围）：
  - `package.json` 的 `test` script 是裸的 `bun test`，不设 `LUSH_HOME` / `LUSH_PROVIDER`，会继承调用者的环境。本轮按约束手动传 `LUSH_HOME=$PWD/.lush LUSH_PROVIDER=mock`；这个「验收命令没有自隔离」的问题与本任务相关但不该顺手改，记在这里。
  - `cli.test.js` 里每条用例仍各起一次 daemon（`daemon start` 实测 ~130ms/次），把只读用例合并进同一个 daemon 生命周期还能再省一点，但会动到用例的隔离方式与 `afterEach` 结构，风险大于收益，未做。
  - `pi.test.js` 的 2.5s 主要是 ~10 次假 pi 子进程（每次 ~150–250ms 的 `bun` 启动），这是「pi 后端真的会起子进程」这条行为本身的开销，不牺牲覆盖降不下来。
