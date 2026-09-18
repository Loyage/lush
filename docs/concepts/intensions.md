# Intension：用户输入与解析

> 概念层：Lush 的入口是什么、它和 task 的边界在哪、冲突怎么变成问题。命令与 RPC 的细节见 [reference/cli.md](../reference/cli.md) / [reference/rpc.md](../reference/rpc.md)，模块划分见 [engineering/architecture.md](../engineering/architecture.md)。

Lush 里只有两类东西（[service-model.md](./service-model.md)）：**被动的 Service 节点**与会干活的 **Task**。人不能直接说"在某条 service 上开一个 task"——那样"用户输入"这件事就没有地方承载：谁来判断这条输入该去哪、和现在已经开着的活冲不冲突？所以人说的话先是一条 **intension**。

## 一条输入的一生

```text
lush intent submit '给 lush 加一列 intension 队列视图' --sid 11
        │
        ▼  intensions 行（status=queued，content 逐字保存，sid 是提示不是命令）
        ▼  drain：SID 0 空着就把这条行交给它
   SID 0 上的解析 task（status=parsing，attempts=1）
        │  读一次 intent.context：这条输入 + 对目标的机械体检 + 模板树 + 服务树 + 队列
        ├── 没冲突 → task_construct 派给直接子节点（project-manager …），或自己回答
        │              → intent settle（或直接把结论说完）→ status=settled
        ├── 有冲突 → notice(kind=decision，带选项表单) → status=awaiting
        │              你 lush notice answer 之后，答复作为解析 task 的下一次输入回来
        │              → 拿到你的选择再安排 / 排队 / 放弃
        └── 解析 task 死了 → attempts+1，回到 queued；连续 3 次失败才 status=rejected
```

- **content 永远是用户的原话**，逐字保存；解析 task 的 goal 就是这段原话，没有包装、没有前缀（所以你也可以直接对 agent 说一句工具命令，例如 `/tool notice {...}`）。解析器要看的是"用户原话 + 我手上这条是哪条 + 现在架构长什么样"，后面这些它自己读。
- **`sid` 只是提示**：写错一个不存在的 SID 会立刻报错（那是笔误），但该不该用它由解析器判断。大多数用户根本不知道 SID。
- **intension 不是 task**：它是"用户说过什么、处理到哪一步"的记录；task 是解析之后安排出来的工作。一条 intension 最多对应一个解析 task，两者用 `parse_task_id` 互指。

## 串行是设计的一部分

解析发生在 SID 0 的一个**根 task** 里，而 Lush 的规则是「一个 service 同时只有一个活动 task」（[service-model.md](./service-model.md) 的规则 1）。所以：

- 同一时刻只有一条 intension 在被解析，其余按先来后到停在 `queued`；
- 解析 task 停在你身上（awaiting）时，整条队列都在等你；
- 长活不该把 SID 0 占住：解析器派完活就该结算，剩下的时间属于那棵 task 子树。

这也意味着**根 task 只有一种**：intension 队列派发出来的解析 task。Lush 里其他所有 task 都是某个 task 的子 task（向下游委托），`lush task tree` 因此总能从一条用户输入追到底。`lush intent submit` 是唯一能创建根 task 的路径；`task construct` 必须带父 task（agent 环境里的 `$LUSH_TASK_ID`）。

## 冲突：机械的与语义的

"冲突"不是一个开关，而是两层：

| | 例子 | 谁发现 | 结果 |
|---|---|---|---|
| **机械冲突** | 目标正忙、singleton 已存在、模板权限不允许、节点已停 | Lush 自己的守卫（`core/tasks/rules.js`、`core/service_manager/nodes.js`）会直接报错 | 解析器撞到报错就知道这是冲突，把它变成一条给用户的问题——不许自己造替代方案绕过 |
| **语义冲突** | 与架构设计不符（要某节点做模板外的事、要在同一节点并行、要长驻能力却只给一次性活）、与在跑的 task 目标重合 | 解析器读 `intent.context` 判断 | 同上：`notice` 报给你，选项里通常有「排队等它结束 / 改派其他节点 / 取消已有 task 后重试 / 放弃这次请求」 |

`intent.context` 是这条判断的事实来源，一次读给全：

```text
intension   这条输入（原话、指定的 service、第几次解析）
precheck    对目标的机械体检：是否存在 / 状态 / 是否被收养的孤儿 / 活动 task / 队列里的重复
architecture 当前加载的模板树（能力边界、singleton、子模板）+ 服务树（状态、父节点、活动 task）
parser     SID 0 自己忙不忙、队列里还有谁、用户还欠着哪些 notice
```

它是**派生读模型**（和 `task.trace` 一样没有新表）：所有事实都来自 `services` / `tasks` / `intensions` / `notices` 与当前加载的模板。人和解析器读的是同一份，所以"它为什么说有冲突"随时可以复核（`lush intent context <id>`）。

## 状态与不变量

```text
queued → parsing ⇄ awaiting → settled / rejected
  ▲        │
  └────────┘  解析 task 结束而没结算，或被 defer / 被重启回收
```

- `queued`：排队中（`blocked_by_task_id` 非空表示用户选了"等某个 task 结束"，那个 task 结算前不会被重新解析）。
- `parsing`：正在解析（解析 task 的状态可以是 running / waiting——它可能在等自己派出去的子树）。
- `awaiting`：解析器上报了一条 `wait` notice，在等你裁决冲突。状态跟着 notice 走，和 task 的 awaiting 同一个道理。
- `settled` / `rejected`：终局。`resolution` 记着它派了哪些 task（`task_ids`，是解析 task 的直接子 task，也就是这棵工作子树的根）或为什么没做；`response` 是给用户看的结论。
- **不变量**：一条行只能被结算一次；解析 task 结束（完成 / 失败 / 取消 / 被人手工完成）时它手上的行一定会被处置——完成就把结论记进去，失败就回到队列重试（`attempts` 上限 3 次，超了才 `rejected`）。**用户的输入不会因为一次解析翻车而消失。**
- 解析器的**最终回答就是这条输入的结论**：没显式 `settle` 也能收尾（`completedTask`），早期只 settle 了个空结论的，收尾时的回答会补进去（只补空，不改已记录的结论）。

## 和其他机制的关系

- **notice**：冲突裁决、结果汇报都走它。解析器上报的 notice 会带上 `intension_id`，所以 `lush intent show` 能看到这条输入问过什么、答过什么。
- **task**：解析器用 `task_construct` 向下游派活；`resolution.task_ids` 是那层委托的入口，`lush task tree <id>` 看整件事怎么协作完成。
- **孤儿监督**：仍然是 SID 0 的职责（它不是解析任务的一部分，而是它作为根服务的长期角色）。
- **手动管理**：`lush service construct` / `stop` 这类**节点**操作仍然可以直接用——它调整的是架构，不引入工作；解析器因此可以假设"架构是有人管的"，自己只负责把输入变成工作。
