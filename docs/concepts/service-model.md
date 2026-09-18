# Service 与 Task 模型

> 概念层：Lush 里有什么、它们的不变量是什么。接口细节见 [reference/](../reference/)（命令、RPC、模板字段），模块划分见 [engineering/architecture.md](../engineering/architecture.md)。

Lush 里只有两类东西：

- **Service** 是被动的节点：身份（模板的 `system_prompt`）、父子关系、变量、持久 state、权限（能创建哪些子模板）。它自己**不会运行任何 agent**，平时只保存状态；节点本身也没有「完成」这回事。
- **Task** 是一次工作，挂在某个 service 上。只有 task 有自己的 agent、自己的会话、自己的 result。用户在一个 service 上 `call` 就创建了一个 **根 task**；这个 task 的 agent 要干活，就向自己的**下游**（子 service）派**子 task**，于是形成一棵 task 树——`lush task tree` 看到的就是「一件事如何在服务之间协作做完」。

```text
lush call 2 '实现登录'         → task #1 挂在 implement-login[2]
  task #1 的 agent（在 [2]）派活
    └── task #2 挂在 dev-task[3]        （[3] 是 [2] 的子服务）
          └── task #3 挂在 worktree-service[4] （真正动手改代码的叶子）
```

## Service（被动节点）

字段：`sid`、`parent_sid`、`original_parent_sid`、`children`（反查）、`status`、`name`、`goal`、`template` 快照、`variables`（值 + 模板声明）、`context`（system_prompt / state / artifacts / references）。

- `ServiceManager.load(sid)` 返回轻量句柄 `Service`：`inspect()`、`getParent()`、`getChildren()`、`createChild(template, {...})`、`call(goal)`（= 在它上面开一个根 task）。
- 生命周期只有三态：

```text
created → active ⇄ stopped
```

  - `construct` 原子创建并进入 `active`（`created` → `active` 记在同一事务里）。
  - `stop`：置为 `stopped`。它的**活动子节点**交给 SID 0 收养（`parent_sid = 0`，保留 `original_parent_sid`）。同一个节点上还有活动 task 时 `stop` 会被拒绝（提示先 `task cancel`）——停止一个节点不能悄悄杀掉正在跑的 agent。
  - `start`：`stopped` / `created` → `active`；重启不会自动取回已被收养的子节点。
  - `delete` / `purge` 见下节「删除」。
- **权限**：创建子服务的模板必须来自该服务创建时快照的 `child_templates`（`*` 表示全部）。这是唯一的能力边界，和 task 无关。
- **SID 0**（`lush-root`，`singleton`）是入口、路由器与孤儿管理者；它只能创建 `project-manager`，不能 stop / delete / purge，其生命周期由 daemon 管理。

## Task（工作单元）

字段：`id`、`sid`（挂载的 service）、`parent_task_id`、`root_task_id`、`goal`、`status`、`result`、`error`、`state`（这一次工作的草稿）、`created_at` / `started_at` / `finished_at`。

```text
created → running ⇄ waiting | awaiting → completed / failed / cancelled
```

- `created`：行已建、agent 还没开始（交互式交接会停在这里）。
- `running`：它的 agent 正在跑（一次 invocation）。
- `waiting`：task 已让出本次运行，agent 不在跑——它在等子 task 或等输入（父 / 子 task 的消息）；有东西进收件箱时被唤醒。
- `awaiting`：同样的“让出本次运行”，但它在等**用户**：它上报了一条 `wait: true` 的 notice，回答还没回来。状态从 notice 推得（`notices.status='open' AND wait=1`），所以“这个 task 还在跑吗”不能只看 agent——还有它欠着的 notice。
- `completed` / `failed` / `cancelled`：终态。

规则（这些规则保证 task 树始终是一棵可观察的树）：

1. **一个 service 同时只有一个活动 task**：service 是单线程的工作台。下游正忙时 `task_construct` 会被拒绝；先结束本轮等它（子结算会唤醒你），或换一个下游节点。所以**并行的正确表达方式是「一批活拆成多件、每件一个子 service」，而不是在一个节点上并发多个 task**——并发度是服务树给的。project 节点因此把「等人答复」挪出节点占用：阶段 1 只报结果、用 `wait: false` 的 notice（纯记录，不占用节点），阶段 2 才由用户的答复触发；而默认的 `wait: true` notice 会把那个 task 停在 `awaiting`，在用户处理前它一直占着这个节点。
2. **子 task 只能挂在自己的直接子 service 上**：task 树因此永远沿 service 树向下生长，不会成环；消息也只能走直接父子边，所以通话关系同样不会成环。
3. **终态 task 没有活动子 task**：`complete` 要求子 task 都已结束且收件箱没有未读消息（否则报错）；`fail` / `cancel` 会把整棵子树一起取消。
4. **阻塞在 task 上，不在 agent 里**：agent 的工具里没有“等待”原语。结束一輪 invocation 后，task 层决定“投递队列里 的输入 / park 等输入（waiting 等子 task、awaiting 等用户的 notice）/ 完成”。
5. 需要新的下游节点时先 `service_construct`（受 `child_templates` 限制）建子服务，再向它派 task。

### agent 与 task

- 每个 task 有**自己的 agent 会话**：`agent_calls` / `messages` 都带 `task_id`，pi 的 session-id 是 `lush-task-<id>`（外部 agent 的环境里有 `LUSH_SID` 与 `LUSH_TASK_ID`）。
- 运行期 agent 的编号是 `TASK.N`（N 是本次 daemon 内该 task 的第几个 agent），见 `lush task agents list|show|kill`。`kill` 会取消它服务的 task——被强杀的 agent 没有答案可记。
- 一个 task 最多被 invoke `LUSH_TASK_CALLS` 次（默认 12）：首次运行 + 每次被唤醒（子 task 结算、收到消息）。超了就把 task 记为 `failed`，避免无限自旋。
- 一輪 invocation 结束后 task 层按顺序判断：收件箱有未读输入 → 合成一条 user 消息（`[Lush] 你有新的输入：…`）重新 invoke；无输入但还欠着什么 → 置 `waiting`（子 task 还没结算）或 `awaiting`（自己上报的 `wait` notice 还没被处理）、等输入再唤醒；都没 → 本次回答就是 result。park 期间不吃调用超时。
- 收件箱（`task_inbox`）里的输入有三种：直接父 / 子 task 发来的消息（`task_message`）、“某个子 task 已结算”的报告（`child_settled`），以及“用户处理了我上报的 notice”（`notice_settled`，见下节）；**都不打断正在跑的 invocation**，在两次 invocation 之间才交给 agent。
- provider 失败、调用超时、轮数用尽 → task `failed`（`error` 里是原因）；daemon 重启时未结束的 task 记为 `failed`（`error = daemon restarted`），不会自动重放。

### 任务之间：持续通话（task_inbox）

`task_construct` 只能派一次性 goal；之后的交流走收件箱：

- **只走 task 树的直接边**：一个 task 只能给它的直接父 task 或它的直接子 task 发消息（`task_message`），和“只能向下游、直接子 service”同一条边界。
- **异步、入队**：消息先落到接收方的 `task_inbox` 行（`delivered_at IS NULL`），在它两次 agent invocation 之间才交给它的 agent——正在跑的 invocation 不会被打断。接收方停在 `waiting` / `awaiting` 时会被立即唤醒。
- **子 settlement 也是输入**：子 task 进入终态时，task 层向父 task 的收件箱写一条 `child_settled`，父被唤醒并带上子 task 的状态与 result。所以“父等子、子报父”和“父子互发消息”是同一条队列、同一套唤醒语义。
- **完成要求收件箱已清空**：有未读输入时 `task_complete` 会被拒绝；结束本轮，输入会在下一次 invocation 前交给你。
- 读模型：`lush task inbox TASK_ID`（/ RPC `task.inbox`）；发：`task_message` 工具 或 `lush task message TASK_ID --body '...'`（RPC `task.message`）。
- 代价：`waiting` / `awaiting` 只由“有活动子 task / 有未决 notice / 收到输入”触发，一个既无子 task、又无未决 notice、也无输入的任务会直接完成；它不提供“原地等回信”的阻塞原语（但 notice 给了“等人”的那一种）。

### 调用链：一次协作排成一条时间线（task.trace）

`task.tree` 看结构（谁挂在谁下面），`task.inbox` 只看入边（我收到了什么）。**调用链**补上第三个视角：一个 task 的整棵子树里，**谁在什么时候对谁做了什么**。

- 一步（entry）只有四种：`delegated`（某 task 在子 service 上开了子 task，带上它给的 goal）、`message`（与直接父 / 子 task 的往来，**两个方向都在同一条链上**）、`child_settled`（某个子 task 结算的报告，带上 status / result）、`notice_settled`（用户处理了某 task 上报的 notice，答复从那一步起走进这条链）。
- 范围是选中 task 的**整棵子树**，且“任一端在子树内”的行都算——委派与消息用的是同一条规则：所以它发给父 task 的消息也在链上（只按接收方过滤就会恰好丢掉这条出边），子树根那次“被委派”（事件写在子树外的父 task 上）也在链上。对根 task 来说，这就是“这活是怎么协作做完的”的时间视角。
- 它是**派生读模型**：没有 trace 表，步骤就是 `task_inbox` 与 `task_events` 已有的行（`task_construct` 是唯一不进收件箱的交互，从父 task 的 `delegated` 事件合并进来）。没有新写入路径，也不会与它们不同步。
- 两个代价，都是有意为之：**删除是边界**——`task delete` 会把该 task 的事件与两个方向的 inbox 行一起删，所以调用链是运行期观察视图，不是审计日志（父 task 上的 `delegated` 事件会活下来，被删子 task 发出的结算报告则消失）；**读是有界的**——只取最近的 `limit` 步（默认 200，上限 1000），`total` / `truncated` 说明被截掉多少。
- 入口：`lush task trace TASK_ID [--limit N]`（RPC `task.trace`）；Web UI 的任务页在详情卡下面给出同一个链，每个端点可点击跳转。

### Notice（task 找人的渠道）

Task 的下游是子 service，但有些事情没有下游——自己处理不了、只有人能决定，或结果必须交给用户。这时 agent 用 `notice` 上报：

- 一条 notice 记录**汇报者身份**（`task_id` + 它所在 service）、`kind`（`report` / `decision` / `blocked`）、`title` / `body`，以及它声明要用户填的 `fields` 表单；用户填的那份存在 `answer` 里。
- 上报**不阻塞**：`notice` 工具 / `notice.post` 立即返回新建的 notice。`wait: true`（默认）的含义是“把它挂靠到汇报者身上”——汇报者本轮结束后进入 **`awaiting`**，用户 `answer` / `dismiss` 时，task 层向它的收件箱写一条 `notice_settled` 并把答复（或 `dismiss` 的 note）作为它的下一次输入送回去；`wait: false` 是纯记录：不改变 task 状态，也不会有答复回来（适合不需要回复的结果汇报）。
- notice **不超时**：无人处理就一直 `open`，直到用户处理，或上报它的 task 被 cancel / fail（那时未决 notice 会被一并 `dismiss`，note 里写清原因）。已 `completed` 的 task 的未决 notice 保留，因为那是留给人读的结果（`wait: true` 的 notice 不可能与 `completed` 并存：那个 task 在答复回来之前根本不会被当成跑完）。
- 用户侧的入口是 `lush notice list|show|answer|dismiss`、Web UI 的 Notice 页与 `bun run notices`；agent 侧分两条路：内置运行时（mock / openai）用 `notice` 工具，外部 agent（pi）用 `lush notice post`（RPC `notice.post`），两者语义一致：上报即返回，答复通过收件箱回到 agent。

## 相关文档

每个 task 有自己的 agent 后端与 Context；见 [agents.md](./agents.md)。
孤儿收养、监督与删除见 [lifecycle-and-orphans.md](./lifecycle-and-orphans.md)；命令总览见 [reference/cli.md](../reference/cli.md)。
