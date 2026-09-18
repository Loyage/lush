# 架构：一个项目，一棵棵任务树

## 实体

- **Project**：不是全局注册表里的记录，而是 daemon 的不可变作用域：canonical 目录 + `.lush/project.json` + SQLite 中的项目绑定。
- **Input**：用户原话，逐字持久化，关联一个根 planner Task。入口调用只做短事务和安排调度，不等待 agent。
- **Task**：goal / role / parent_id / input_id / status / result / error / invocation 次数；worker 另有工作区和 integration 状态。父子关系只在创建时指定，不能变更。
- **Agent**：与 task 终身一对一的身份（`<role>#<task-id>`）。task 创建时它就存在，跨唤醒复用同一个 pi session，记录累计唤醒次数与上次动手时间；但 RPC 凭证每次唤醒重新签发，库里只存 SHA-256，且只在该次 invocation 运行期间可解析。
- **Message**：持久化收件箱，用户、直接父子 task、子任务结算与 notice 答复共享同一通道。
- **Notice**：task 请求用户做决定；答复/忽略入收件箱。
- **Event**：创建、调用、状态转换、消息和 Git 生命周期审计。

没有 Service，也没有为创建 task 而先构造的被动节点。

## 数据流

```text
CLI / Web → UIClient → JSON-RPC / Unix socket → Project
                                                   ├── Store / SQLite
                                                   ├── scheduler → pi subprocess / mock
                                                   └── Workspaces → serialized Git operations
```

所有业务校验在 Project / Workspaces，RPC 只检查参数、身份与命令权限，UI 不直接操作数据库。

### 输入和规划

`input.submit` 在一个事务中写 Input、根 planner Task、关联字段和创建事件，然后通过 microtask 启动调度。

每条输入有自己的 planner；不会复用长期被占用的单个根任务。调度器保留一个规划槽，执行任务使用另外 N 个槽。因此一个规划任务派活后等待，不会阻碍其他输入被规划。规划本身不是无限并发，以免大量输入造成不受控模型调用。

每条输入还带一个流程判定（`inputs.flow`，未判定按 develop 处理）：`develop` 照常拆解出 worker/coordinator/research；`explain` 只解答、不产出代码，根 planner 直接把结论写进 result，必要时只派 research。runtime 在 `Project.spawn` 层硬校验 `explain` 子树只允许 research，因此了解类输入不会创建 worktree、不会产生待合并改动。判定与改判由根 planner / 用户经 `input.flow` 写入；改判只影响之后的 spawn，不追溯已建子任务。

### 一次 invocation

1. 按任务 ID 从 queued 中挑选，不超过对应槽限制。
2. 在 `running` Map 中占位并签发本次 invocation 的 token（库里只写 hash），再异步准备 worker worktree；将 task 标为 running。
3. 读取此次未消费消息、当前任务/子任务和最近任务摘要，启动 provider。
4. pi 收到项目/任务/token 环境变量、固定代码路径下的 lush CLI、独立 session 和输入文件。在 cwd 中运行工具循环；Lush 不在 argv 中传入巨大的项目快照。
5. provider 正常返回后消费**启动时读到的消息**，记录结果。运行期间到达的消息留给下次。
6. 依次判定：还有未读消息 → queued；有未决 notice → awaiting；有活动子任务 → waiting；否则校验 worker 提交并 completed。
7. 释放 running 占位并作废 token，再次检查未读消息，防止 child settled 与 parent park/清理之间丢唤醒。

waiting / awaiting 不占 agent 槽，也不运行 sleep/poll 子进程。最终输出是 task result；不提供可被 agent 提前调用的 complete 命令。

### 多级协作

agent 只能从自己的 task 派生子任务、给直接父/子发消息、给自己发 notice。用户可以给任意活动 task 追加输入。子任务结算发送状态、结果与错误给父 task；父 task 重新入队后自己决定继续派活或汇总。

最大层数、活动任务数上限、调用次数上限和 invocation 超时限制失控分派。默认 maxDepth=8、活动任务上限=1000、maxCalls=24。

## 生命周期不变量

- 状态：queued / running / waiting / awaiting / completed / failed / cancelled。
- 一个 task 同时只有一个 invocation，且只有一个 agent 身份；身份跨唤醒不变，凭证只在该 invocation 活动期间有效，重启后全部作废。
- 终态 task 没有活动子 task。失败和取消会先自底向上取消活动后代，再结算自身。
- 父子边只由已有父 task 的创建操作建立，不允许环或任意 reparent。
- 消息只有在一次调用成功返回后才消费，失败后可以在明确重试时再次交付。
- 取消、notice 答复与 completion 的核心状态变更都在同步短事务中完成；事务内不等待模型或 Git。
- 重试必须是用户显式动作，且父 task 不能已终态。
- 不删除任务历史；工作区清理与任务终态是不同操作。
- `explain` 输入的子树只允许 research；runtime 在 spawn 层拒绝 worker/coordinator，保证了解类输入不产生待合并改动。

## Git 边界

所有 runtime 管理的 Git 操作使用 argv 数组、不经 shell 插值，共享异步串行队列。排队等待 Git 不阻塞事件循环、输入提交或已有 RPC。

worker 创建时记录项目 HEAD 与目标分支，创建 `.lush/worktrees/<id>-<name>` 和 `lush/<project-hash>/<id>-<name>` 分支（`name` 是 spawn 时 planner 给的英文短名，见 `src/core/naming.js`）。每个 worker 是独立修改集，不自动继承其他未合并任务成果。

结果提交后进入 `integration=pending`。用户 `task.merge` 检查项目/worker 干净、原目标分支、已审阅的 commit 未变化，再持久化批准事件和 `merging`，执行 merge。成功 `merged`；失败尝试 abort 并回到 pending，完整错误保留。中断的 merging 恢复为 review，不猜测 Git 操作是否完成。

工作区清理不强制删除；即使 failed/cancelled task 的 integration=none，也检查其 commit 是否已包含在项目 HEAD 中，防止删除未交付成果。分支作为廉价恢复点保留。

Lush 无法锁住用户的编辑器或外部 Git 进程；合并期间不要并发修改主工作树。Agent 工具也不是 OS 沙箱，目录/角色约束不能阻止恶意 shell 命令。

## 项目身份与恢复

项目路径 canonicalize 后决定 `.lush` 和 socket。manifest 与数据库双重校验路径，拒绝旧库与跨项目复用。daemon.lock 按项目持有；socket 位于 uid 私有临时目录，权限 0600，目录 0700。

daemon 启动捕获全部运行源码 fingerprint；status 显示 project、home、socket、code_dir、fingerprint。start 遇到已运行 daemon 只报告，不换版本。

正常退出停止接收 RPC，取消正在执行的任务、终止 agent 进程组、等待调用和 Git 队列结束，再关闭数据库和释放锁。queued / waiting / awaiting 持久保留。重启发现 running 时记失败并取消其活动后代，不重放可能已有副作用的工作；留待用户检查。SIGKILL 可能留下外部进程，需要用户检查后重试。

不提供 exactly-once 文件副作用保证。SQLite 事务只能保护 Lush 记录，不能把任意模型工具与 Git 操作一起纳入事务。

## 界面与传输

CLI 的 task list / history 支持 cursor 分页；task inspect 返回完整任务结果和有界的相关记录。Web 复用 UIClient，轮询快照，采用 textContent 呈现模型输出，不插入 HTML；输入表单和 notice 答复在轮询时保留。

Web 只监听 127.0.0.1，校验 Host / Origin / Sec-Fetch-Site，修改操作要求 JSON；HTTP 只能访问显式允许的方法，不能代理任意 RPC。RPC 以本机用户为可信边界；agent token 只约束正常的 agent 调用，不是本机攻击者隔离。`system.status` 报告运行中的 agent 列表与 `agents_total` / `agents_idle`（每个活动 task 一个 agent，含已 park 的），`task.inspect` 报告该 agent 的 id、唤醒次数与上次动手时间。

## 源码布局

| 路径 | 职责 |
|---|---|
| `config.js` | 项目发现、配置、绑定 |
| `persistence/store.js` | schema、事务、事实读写 |
| `core/project.js` | 任务树、调度、生命周期、消息/notice |
| `core/workspaces.js` | Git worktree、批准合并、安全回收 |
| `agent/guide.js` | 项目开发与各角色的 agent 指令 |
| `agent/provider.js` | pi 进程与 mock 后端 |
| `rpc/` | JSON-RPC framing、参数/身份校验、socket |
| `daemon/` | 单实例锁、装配与停止 |
| `cli/` | CLI 和 daemon 启停客户端 |
| `ui/` | 统一客户端与本地 Web |

维护时优先保持这些小模块，不重新引入通用 Service 管理或电脑级能力体系。
