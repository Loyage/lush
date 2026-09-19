# 从输入到交付：行动任务处理流程

这是一份面向使用者的流程说明。它回答三个问题：

1. 一条输入如何变成行动任务；
2. 任务“完成”和改动“已交付”为什么是两回事；
3. 普通改动、变更栈和合并冲突分别应该怎样处理。

如果只记一条原则，请记住：

> **任务树表示谁在做什么；交付队列表示哪些提交将进入哪个目标分支。**

## 一、完整流程总览

```text
用户输入
  ↓
Intent：原话 + planner
  ↓
Spec：planner 写出的拆解条目
  ↓
Scheduler：把一批 spec 编排成行动任务
  ↓
行动任务执行
  ├─ research / coordinator：形成结论或继续委派
  └─ worker：独立 worktree 中修改、测试、提交
  ↓
任务 completed
  ├─ 没有代码改动：流程结束
  └─ 有已提交改动：进入交付队列
  ↓
用户审阅 / 可选 verifier 检验
  ↓
批准交付
  ├─ 干净合并：进入目标分支
  └─ 内容冲突：resolver 解冲突 → 再审阅 → 落地
  ↓
安全回收 worktree / 分支
```

Web 中主要对应三个位置：

- **意图**：输入、planner、spec 和 scheduler 的进度；
- **行动任务**：任务树、运行状态、依赖、结果和执行过程；
- **项目概览 → 交付队列**：待审阅改动、变更栈、目标分支和冲突处理。

## 二、输入如何变成行动任务

### 1. 提交输入

单条需求可以立即提交：

```bash
lush say '给搜索增加键盘导航'
```

也可以先缓存多条，再一起交给一个 planner：

```bash
lush draft add '给搜索增加键盘导航'
lush draft add '补充无障碍提示'
lush draft commit
```

提交只表示“已经保存并开始规划”，不会等待开发完成。

### 2. Planner 写 spec

planner 负责理解原话并写拆解队列，不直接修改代码。它可能：

- 直接写 spec，交给 scheduler；
- 在影响面大、意图不明确时提出计划审批；
- 将了解类请求标记为 `explain`，只派 research，不创建代码 worktree。

若出现计划审批，在 Web 的意图卡片上选择“批准并开发”或“驳回”；CLI 对应：

```bash
lush plan approve PLANNER_ID
lush plan reject PLANNER_ID '调整理由'
```

### 3. Scheduler 创建行动任务

scheduler 把同一批 spec 编排成真实任务，并声明依赖：

- `code`：下游 worktree 基于上游提交创建；执行和交付都必须保持上游在前；
- `order`：只要求执行时等待上游结束，不影响交付顺序。

没有依赖的兄弟任务可以并行执行。被依赖挡住的任务保持 `queued`，不占 agent 槽。

## 三、怎样理解行动任务状态

任务状态描述的是 **agent 工作是否结束**：

| 状态 | 含义 | 使用者通常要做什么 |
|---|---|---|
| `queued` | 等依赖或并发槽 | 通常无需操作 |
| `running` | agent 正在执行 | 可追加说明，不要直接改它的 worktree |
| `waiting` | 等子任务完成 | 通常无需操作 |
| `awaiting` | 等用户决定 | 打开待决问题并回答 |
| `completed` | 本任务执行结束 | 检查结果；若有代码，再看交付队列 |
| `failed` | 执行失败 | 检查错误和现场，决定是否重试 |
| `cancelled` | 已取消 | 工作区仍可能保留，可检查后重试或人工处理 |

最容易误解的是：

```text
completed ≠ 已进入目标分支
```

worker 完成并提交代码后，通常是：

```text
任务状态：completed
交付状态：待审阅与批准
```

只有用户批准交付后，改动才会进入原来的目标分支。

## 四、完成后先审阅什么

打开 worker 详情，至少检查：

1. **结果**：agent 声称完成了什么；
2. **改动概览**：提交改了哪些文件，是否还有未提交内容；
3. **测试说明**：跑了哪些命令、有哪些风险；
4. **执行过程**：必要时查看工具调用和输出；
5. **目标分支**：这份改动最终准备进入哪里。

需要更直观的验证时，可以创建只读 verifier：

```bash
lush task verify TASK_ID
```

verifier 会在改动 worktree 和目标分支对照检出上运行同一场景，并生成 HTML 报告。verifier 完成不等于自动批准合并。

## 五、怎样阅读交付队列

交付队列按 `target_branch` 分组。每一项以原 worker ID 作为稳定身份，并显示：

- `source_task_id`：本次真正要落地的分支来源；
- `phase`：目前处于哪个交付阶段；
- `ready`：单独选择该项时能否立即落地；
- `selectable`：是否可以连同 code 上游一起编入批次；
- `blockers`：现在不能执行的具体原因。

常见阶段：

| 阶段 | 含义 | 下一步 |
|---|---|---|
| `awaiting_review` | 普通改动等待审阅 | 审阅后批准交付 |
| `review_required` | 上次合并中断，结果不确定 | 检查 Git 历史和工作树，再重新批准 |
| `conflict_decision` | 合并发生内容冲突 | 选择“开始解冲突”或“暂不处理” |
| `resolving` | resolver 正在工作 | 等待完成，不要重试原任务 |
| `resolution_ready` | resolver 已完成且仍可快进 | 审阅 resolver 结果并批准落地 |
| `resolution_stale` | 目标分支已前进，旧 resolver 不能原样落地 | 明确废弃旧结果并重新解冲突 |

### `ready` 与 `selectable` 的区别

假设：

```text
#12 基础改动
  ↓ code
#18 下游改动
```

在 #12 尚未落地时：

- #12：`ready=true`；
- #18：`ready=false`，blocker 是“先落地 #12”；
- #18：仍可能 `selectable=true`，因为可以把 #12 和 #18 一起加入同一个批次。

Web 勾选 #18 时会自动带上 #12，运行时按 `#12 → #18` 交付。`order` 依赖不会产生这种合并顺序。

## 六、普通交付流程

### Web

1. 回到项目概览；
2. 找到目标分支分组；
3. 审阅任务详情；
4. 勾选单项，或选择“合并本分支全部可交付”；
5. 在确认框检查实际顺序；
6. 确认执行。

### CLI

先查看队列：

```bash
lush task ladder
```

审阅详情：

```bash
lush task inspect 12
```

批准单项或同一目标分支的一批任务：

```bash
lush task merge 12
lush task merge 12 18 23
```

原 worker ID 是稳定入口。如果它已经有完成且仍有效的 resolver，`task merge 原任务ID` 会自动落地 resolver，而不是重新做一次冲突合并。

### 批量交付的保证与边界

批量执行前会统一检查：

- 所有条目属于同一个目标分支；
- 当前工作树正检出该目标分支；
- 主工作树和每个任务 worktree 都干净；
- 分支仍停在被审阅的 `head_commit`；
- code 上游已落地，或也在本批中；
- resolver 结果确实包含原任务提交。

预检失败时，一项都不会落地。

预检通过后仍可能在真实 merge 时出现内容冲突。此时批次会停止：此前成功的项目保留，冲突项进入处理流程，后续项目不执行。批量交付不是跨多个 Git merge 的原子事务。

## 七、内容冲突怎样处理

### 1. 第一次批准发生冲突

运行时会真实尝试 merge。若出现内容冲突：

1. 记录冲突文件；
2. 执行 `merge --abort`；
3. 确认主工作树恢复干净；
4. 原任务进入冲突阶段；
5. 创建专用 resolver task；
6. Web 显示“开始解冲突 / 暂不处理”。

主工作树不会停留在半合并状态。

### 2. 开始解冲突

选择“开始解冲突”后，resolver 才会获得 worktree 和 agent 槽。它会：

- 以目标分支当前顶端为基线；
- 合入原任务已审阅提交；
- 只处理冲突和必要的一致性问题；
- 提交 merge 结果并运行测试。

resolver 工作期间，原任务不能从旁重试。

### 3. 审阅并落地 resolver

resolver 完成后，原任务仍是交付队列中的稳定条目，但 `source_task_id` 会指向 resolver。再次批准原任务即可落地 resolver。

落地有两道守卫：

1. resolver 结果必须包含原任务已审阅提交；
2. 只能 `--ff-only` 落地。

因此最终进入目标分支的树，就是 resolver 测试过的树。

### 4. 为什么同一目标分支会被冻结

resolver 的结果基于目标分支某个确定顶端。如果这期间继续向同一分支合并其它任务，resolver 可能失效。因此在冲突解决前：

- 同一目标分支的其它交付被冻结；
- 不同目标分支不受影响；
- 忽略 resolver、resolver 失败/取消、resolver 成功落地都会解除冻结。

## 八、resolver 过期和合并中断

### Resolver 过期

外部 Git 操作仍可能让目标分支前进。若 resolver 已不能快进落地，交付队列显示 `resolution_stale`。

此时不要反复批准旧 resolver。打开原任务，确认后选择重新尝试；运行时会：

1. 把旧 resolver 标成 `superseded`；
2. 保留旧分支和 worktree 作为恢复点；
3. 基于最新目标分支重新开一轮冲突处理。

### Daemon 在 merge 期间中断

未知副作用的 merge 不会自动重放。任务进入 `review_required`。请先检查：

```bash
git status
git log --oneline --decorate -n 20
```

恢复干净、确认历史后，再明确批准一次。Lush 不会替你 reset、stash 或猜测上一次 merge 是否已经完成。

## 九、随其它分支一起落地的提交

某个分支可能已经包含另一项待交付提交，例如外部 Git 操作或集成分支把它带了进来。每次成功交付后，Lush 会对照目标分支祖先关系：

- 已经进入目标分支的其它普通 worker 自动标为 `merged`；
- 记录 `merge.included` 事件；
- 不再留下实际上已经交付的“待合并”条目。

这只是让数据库与 Git 事实收敛，不会删除原分支或 worktree。

## 十、交付后的回收

确认改动已经进入目标分支后，可以回收：

```bash
lush task cleanup TASK_ID
```

只想删除 worktree、保留分支作为恢复点：

```bash
lush task cleanup TASK_ID --keep-branch
```

回收不会强制删除。分支被改过、工作区脏、提交尚未进入目标分支时，Lush 会拒绝或保留现场，并说明原因。

## 十一、遇到提示时该做什么

| 看到的提示 | 含义 | 建议动作 |
|---|---|---|
| 等依赖 | 上游行动任务尚未结束 | 等待；不要手工唤醒 |
| 等你决定 | task 发出了 notice | 打开待决问题并回答 |
| 待审阅与批准 | worker 已提交，但尚未交付 | 审阅 diff/测试，再批准 |
| 先把基线任务落地 | code 上游尚未进入目标分支 | 同批选择完整栈，或先合上游 |
| 当前检出其它分支 | 主工作树不在目标分支 | 先确保干净，再 `git switch 目标分支` |
| 合并被冻结 | 同目标分支存在未解决冲突 | 先处理对应 resolver |
| 正在解冲突 | resolver 活动中 | 等待完成，或明确取消 resolver |
| 解冲突结果待落地 | resolver 已完成 | 审阅后批准原任务 |
| 解冲突结果已过期 | 目标分支已前进 | 废弃旧结果并重开一轮 |
| 需复查 | merge 曾被中断 | 检查 Git 状态和历史后重新批准 |
| working tree is dirty | 主树或任务 worktree 有未提交修改 | 人工确认并提交、stash 或恢复；Lush 不代做 |

## 十二、一套推荐的日常操作

```bash
# 1. 提交需求
lush say '实现搜索键盘导航，并补测试'

# 2. 看规划和行动任务
lush intent list
lush task tree

# 3. 任务完成后看交付队列
lush task ladder
lush task inspect TASK_ID

# 4. 可选：创建对照检验
lush task verify TASK_ID

# 5. 明确批准同一目标分支的一项或一批改动
lush task merge TASK_ID
lush task merge UPSTREAM_ID DOWNSTREAM_ID

# 6. 若出现冲突，在 Web 点击“开始解冲突”，完成后再次批准原任务

# 7. 交付后回收磁盘状态
lush task cleanup TASK_ID
```

相关参考：

- [输入、规划与缓存](reference/rpc/inputs.md)
- [任务与拆解](reference/rpc/tasks.md)
- [合并与交付队列](reference/rpc/merge.md)
- [检验与审阅读模型](reference/rpc/inspect.md)
- [磁盘回收与清空](reference/rpc/maintenance.md)
