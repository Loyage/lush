# 25 · 交棒：解析 task 结算后让出 SID 0，派出去的子树成为根 task

> 目标：修掉 [22](./22-intensions.md) 留下的一个**结构性**问题——用户输入收口成一条串行队列之后，解析 task 会在派完活之后一直等到**整棵子树跑完**才结束，而它占着 SID 0，于是整条输入队列跟着一起等。文档当时写的是「长活不该把 SID 0 占住：解析器派完活就该结算」，但机制从来不允许：解析 task 有活动子 task 时不能 complete，它只能 park 在 `waiting`。

## 怎么发现的

用户的直觉问题是「现在为什么任务无法并行」。现场（`bun run` 那个 home）是这样的：

```text
bun run intents      # #6 [queued] 如果有非常大的代码文件，删除之
bun run task-inspect 23
  task #23 · waiting · lush[0]        ← 解析 #5 的那个根 task
  └── #24(10, waiting) └── #25(11, waiting) └── #26(16, running)
```

#5 的解析 task **在 22:51:20 就结算了它那一行**——`task inspect 23` 里它自己的话是「intent 已 settle（resolution: arranged → task 24）。子 task #24 在跑，待它结算后我会被唤醒并拿到结果」——但它得等到 #26 那条开发链整个跑完才会终态，而 `drain` 只在解析 task 到终态时才推进队列（`afterTaskSettled`），所以 #6 一直停在 `queued`。

链条是三处硬规则叠出来的：

1. `intent settle` 只关掉 intension 那一行（`core/intensions.js` 的 `close`），不碰 task；
2. 解析 task 有活动子 task 时不能 `complete`（`core/tasks/rules.js`）；
3. 于是 agent 结束本轮后被 park 成 `waiting`（`service_manager/tasks.js` 的 `taskParkReason` → `children`），而 `waiting` 也是活动 task（`core/lifecycle.js` 的 `ACTIVE_TASK_STATUS`）——`drain` 的 `canParse` 因此一直是 false。

顺带一个观察：改动之前（`call SID GOAL` 时代）两条互不相干的请求可以各在一条 service 上开根 task 真并行；收口之后**跨输入**的并行本来就是被设计掉的，这一轮要修的不是那个，而是「解析器不该陪着子树走」。

## 先说清三条约束（决定了形状）

- **终态 task 不能有活动子 task** 是 task 层的不变量（`complete` 拒绝、`fail` / `cancel` 级联、`delete` 也依赖它），不能为了这一轮把它戳个洞——否则「completed 的 task 底下还挂着活的活」会渗进树、删除、trace 的每一处。所以解析 task 要结束，就得先**不拥有**那批子 task。
- **`resolution.task_ids` 是输入 → 工作的唯一记录**。它记的是解析 task 结算那一刻的直接子 task，文档里本来就叫它们「这棵工作子树的根」——所以「交棒」不是发明新概念，而是让那句话变成字面事实。
- **顺序必须能被结构保证，而不是靠提示词**。解析器先 settle 再派活的写法不该让节点又被占住，所以除了结算处，park 决策那里也留了一道兜底。

## Done

- [x] **`repository.detachChildTasks(taskId)`**（`src/persistence/repository_tasks.js`）：把 `taskId` 名下**还没结束**的直接子 task 提升为各自的根 task（`parent_task_id=NULL`、`root_task_id=id`），连同它们的整棵子树一起改写 `root_task_id`，并在被提升的 task 上写一条 `detached` 事件（`{from_task_id, sid, goal}`，形状与 `delegated` 对齐）。被移动的只有「往上那一条边」：goal、状态、result、会话、下面的子树全都留在原地。已经在终态的子 task 不动——它们已经是历史，留在原来那个父 task 名下正是它们该在的地方。`deleteTaskRows` 里「父被删则子变根」的既有做法在注释里与它互相指认（那个还会连终态子 task 一起放手，因为父行要没了）。
- [x] **`core/intensions.js` 的交棒钩子**：`close()`（行变终态的唯一入口：settle / rejected / withdraw / completedTask / handedOver / 耗尽）里，只要这一行有 `parse_task_id` 就调 `handoff(manager, taskId)`。`handoff` 只在三种条件都成立时动手：是解析节点上的根 task、手上**没有**未决的 intension 行、并且真的有还在跑的子 task；动作就是 `detachChildTasks` + `resumeTask`（解析器可能正 park 在那批子 task 上，交棒之后它没得等了，得把它的 runtime 叫醒）。
- [x] **park 决策处的兜底**（`core/service_manager/tasks.js` 的 `taskParkReason`）：判断「还欠着什么」之前先调一次 `intensionHandoff`。正常路径在结算时就已经交棒了，这一步只兜住「先 settle、后派活」——那种写法下解析 task 也不该再等到子树跑完。于是规则是结构性的：**已下结论的解析 task 永远不会 park 在 children 上**。
- [x] **链路不断**（`src/persistence/repository_tasks.js` 的 `detachmentOf` + `core/tasks/trace.js`）：root task 的 `task.trace` 原本靠「父 task 上那条 `delegated` 事件」补上链路第一跳；交棒之后它没有父 task 了，所以改为读它自己的 `detached` 事件（同一个 `delegation()` 渲染路径，落在同一个 `kind: 'delegated'` 步上，`limit` / `total` 的算法不变）。`intent show` 那边的 `resolution.task_ids` 一直就有，两条路都能追。
- [x] **提示词**：`templates/lush-root/system_prompt.md` 的「安排」补两条（**先派活、最后结算**；只有结论依赖子 task 结果时才结束本轮等它们），「边界」那条「别把等人带进自己的 task」补上交棒；`src/agent/guide.js` 的通用规则里那条「你欠用户一个结论」改成「settle 也是交棒」。「结束：调 `intent_settle`；或者直接结束本轮」的原样保留——不 settle 直接结束仍然是合法的（那时它仍会在结束时给出结论，只是会陪子树走一段）。
- [x] **CLI 文案**：`lush task list --roots` 的说明从「用户直接开的」改成「解析 task，以及解析器交棒出来的工作树根」。
- [x] **文档**：`docs/concepts/intensions.md` 新增「交棒：解析器不陪着子树走」一节（含顺序要求与代价），「一条输入的一生」图与状态 / 不变量两处同步；`docs/concepts/service-model.md` 规则 0、规则 3 与「任务之间」的开头；`docs/engineering/architecture.md` 的 `core/tasks.js` / `core/intensions.js` 两条与数据流第 1 步；`README.md` 的入口流程图与「生命周期提示」。`docs/log/` 的历史条目按约定不改（22 里那句「长活不该把 SID 0 占住」现在才真正成立）。
- [x] **验收**：`bun test` **207 项通过**。`test/intension.test.js` 新增两条，用一个带闸门的 provider（worker 的 agent 不放到 `gate.resolve()` 就不作答，所以「子 task 还在跑」是事实而不是竞态）：
  - 解析器一轮里 `task_construct` + `intent_settle` → 子 task 成为根（`parent_task_id: null`、`root_task_id` 指向自己）、解析 task 已 `completed`、SID 0 上没有活动 task、`taskTrace` 第一跳仍是那次委派、`task inspect` 看得到 `detached` 事件，**并且第二条输入在那棵子树还在跑的时候就被解析完了**；
  - 解析器 park 在子 task 上时由外部（`intent settle <id>`）给它下结论 → 交棒 + 唤醒一起发生，解析 task 立刻结束，子 task 继续跑。

## 备注

- 交棒**只在解析器已经下结论时发生**。没有 settle 就结束本轮的解析器照旧等自己的子树（`completedTask` 要用子 task 推 `resolution.task_ids`），所以「需要汇总才等」这条代价被明确写进概念文档与提示词：那段时间 SID 0 与整条队列都在等它。
- 被提升的 task 与解析 task 之间不再有父子边，因此**不会再给解析 task 发消息、也不会唤醒它**。那批活是各自独立的树——这也是交棒的本意（`task_message` 只走直接父子边，所以对一个已交棒的 task 说「向父 task 汇报」会失败，这是正确的）。
- 一个 service 一个活动 task、以及跨输入仍然串行的**其余**部分不是本轮的范围：并发度仍然由服务树给（[service-model.md](../concepts/service-model.md) 规则 1），一条输入内部才谈得上并行。本轮把「解析器占住入口」这半个问题修掉，剩下的「一条输入 = 一棵子树」是设计。
- 改了 `core/` 运行期代码、提示词与 CLI 文案 → fingerprint 会变，照例 `bun run daemon-restart`；老的解析 task 不受影响（它们已经在跑），行为差异出现在下一次结算。
