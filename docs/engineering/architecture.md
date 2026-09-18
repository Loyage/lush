# 总体架构

## 定位

Lush 管理 AI 活动，而不是 CPU、内存和 Unix 服务。它有两层实体：**Service** 是被动的持久化节点（身份、变量、state、权限），**Task** 是挂在某个 service 上的一次工作（有 agent、会话与 result，可向下游派子 task）。内存中的 Service 只是通过 SID 访问 Core 的句柄，不维护递归 children 对象图。

```text
CLI / Web / future TUI
          |
     UI adapters
          |
 JSON-RPC / Unix socket
          |
        lushd
          |
 ServiceManager <--- Agent Tools
   |       |              ^
Repository AgentRuntime --|
   |       |       |
SQLite  ContextBuilder  AgentBackend
             |         /          \
       Lush guide   pi (子服务)   内置 provider
                                   /        \
                                 Mock     OpenAI
```

## 模块边界

- `core/`：实体类型、两套生命周期（`lifecycle.js`：service 的 created/active/stopped 与 task 的 created/running/waiting/completed/failed/cancelled）、Service 句柄、统一业务 API、父子关系及孤儿收养。`core/tasks.js` 是 task 层：派活规则（只向直接子 service、一个 service 一个活动 task、只能等自己树里的 task）、`waiting` 与唤醒、complete/cancel/fail 与「终态 task 没有活动子 task」的不变量、task 树读模型。`core/orphans.js` 是 SID 0 的孤儿监督：孤儿池读模型、策略校验（`normalizeOrphanPolicy`）、上限 / TTL / busy 判定与一轮监督（`OrphanSupervisor`）；它只决定该冻结谁，真正的状态变更仍走 `ServiceManager`（冻结而非删除，并取消它手上的 task）。没有 socket / CLI / HTTP 知识。
- `persistence/`：`bun:sqlite` schema、事务、记录查询与恢复。数据库是事实来源，不缓存服务树。
- `template_loader.js` + `templates/`：仓库顶层 `templates/` 存放 JSON ServiceTemplate（name、singleton、description、construct_prompt、system_prompt、child_templates、variables 七个必填字段，另有一个可选字段 agent），模板按 构造树分目录嵌套：`<name>.json` 的同级有一个同名文件夹 `<name>/`，里面放它能直接创建的模板（`templates/lush-root.json` + `templates/lush-root/project-manager.json` + `templates/lush-root/project-manager/project/dev-task.json` + `templates/lush-root/project-manager/project/dev-task/worktree-service.json`），loader 递归读取并校验，`child_templates` 写的是相对自己文件的路径（`project/dev-task.json` / `dev-task/worktree-service.json` / 同目录的 `generic-task.json`），加载时解析成模板名（也接受直接写名字），因此白名单、快照与权限比对里只有名字，并**按层级顺序排列模板**：层级 = 从「没有其他模板能创建它」的模板出发的最长路径（`*` 与自引用不算边，环在走到的那条边上截断），同级按名称排序，因此结果与文件名无关；`available_child_templates` 于是呈现根在前的拓扑序（`lush-root` → `project-manager` → `project` → 它能创建的任务），而不是文件名序。创建时保存完整快照，模板文件后续变更不影响既有 Service（`singleton` 按当前加载的模板判定）。可选的 `agent` 声明该模板新建实例使用的 agent profile，`construct --agent` 优先于它。三个散文字段（`description` / `construct_prompt` / `system_prompt`）可以写成 `@<相对路径>`，由 loader 相对声明文件读入旁边的 markdown 并内联（与 `child_templates` 同一条相对规则，引用不可读即 `-32602`，绝不退化成字面量），所以长提示词一个一个字地改而不用面对一行 `\n` 转义；这类 `.md` 与模板 JSON 一样属于提示词面，fingerprint 一并哈希。
- `context/`：独立持久化 Context，以及 ContextBuilder。只读当前 Service 的对话、结构化 state、引用和直接亲属摘要，不注入全系统状态。
- `agent/`：Agent 后端，以及受限轮数的调用循环。默认后端是 `pi`：每次 invocation 起一个 `pi --print` 子服务，**每个 task 一个 pi session**（id `lush-task-<task>`），pi 自己跑工具循环并通过 bash 调用 `lush` CLI 操作 Lush；`mock` / `openai` 是 Lush 内置运行时，agent 直接拿 `task_*` / `service_*` 工具。`profiles.js` 是 agent profile 的存储与逐字段解析（一个 agent 一个 `$LUSH_HOME/agents/<name>.json`，内置 default 为「纯净 pi」：不加载使用者的 extensions / skills / prompt templates / themes / AGENTS.md），`catalog.js` 把「服务选中了哪个 profile」在 call 时解析成 provider（缓存按解析后的字段做键，改文件即改行为，不用重启 daemon）。`guide.js` 是两种形态共用的 Lush 说明层（介绍 Lush 与如何操作它），`ContextBuilder` 按**该服务实际使用的后端**选择 tools / cli 版本。共享的快照字段（`singleton`）由当前模板决定，`child_templates` 白名单、variables 声明（哪些必填、哪些创建后仍可改、格式约束 pattern / max_length / single_line）与保留名 `path` 的工作目录校验、`name` 的服务名等价关系由 Core 强制执行，后端不参与授权。
- `rpc/`：newline-delimited JSON-RPC；参数和错误映射，不复制业务逻辑。
- `daemon/`：装配、单实例锁、socket 生命周期、信号和中断恢复；启动时建一个 `AgentCatalog`（默认 provider = 环境变量叠加内置 default profile），并把它绑给 `ServiceManager`（construct 时校验 `--agent` / 模板 `agent`）与 `AgentRuntime`（task 开始时解析该 SID 的 profile）；按 `config.orphanPolicy` 决定是否起孤儿监督定时器（`sweepSeconds` 秒，unref，关闭时先清掉再关数据库）。
- `socket_io.js`：Bun socket 写入是有界的（单次 write 只接受有限字节），统一封装「写满队列 + drain 续写」，RPC 两端共用。
- `ui/`：用户交互的统一应用边界。CLI / Web / 未来 TUI 都先进入 `UIClient`：命令型 adapter 走完整的 `execute(method, params)` 网关，常见交互走具名工作流，再由它独占 request transport（当前为 `RPCClient`）；任何 UI adapter 都不直接操作 socket。`ui/web/` 用 Bun HTTP 提供仅回环地址可访问的 service tree 与后台根 task 创建；`ui/cli.js` 把现有 CLI 接到统一入口，并保留 `cli/` 的兼容导入路径。
- `cli/`：CLI 的命令树声明（每一层自带 help）、参数解析、`UIClient` 调用、输出格式、交互 session、daemon 启动客户端。`call` 是顶层入口（在某个 service 上开一个根 task 并等待），`task` 组管工作，`service` 组管被动节点。

## 调用数据流

1. CLI RPC `call`（或 agent 工具 `task_construct`）进入 `ServiceManager.constructTask(...)`：它校验节点是否 active、这一个 service 上是否已有活动 task、目标是否是自己的直接子 service，然后建 task 行并在后台启动它的 run。
2. Runtime 打开这次 invocation：同一个 task 不会有第二个 invocation；一个 service 同时最多一个活动 task（task 层已保证），不同 service 的 task 可真并行。
3. 持久化 agent_calls（带 `task_id`）和 user message。ContextBuilder 生成模板 system prompt、共享 Lush 说明层、`LUSH_CONTEXT`（service + task + 子 task + 可创建模板）与**这个 task 自己**的对话。内置后端直接用这些 messages；外部后端（pi）拿到同样的 system prompt / 说明层 / `LUSH_CONTEXT` 与工作目录（`path` 变量），由 Lush 拼成命令行参数。
4. Provider 返回文本及结构化 tool calls。每个 assistant / tool 消息顺序持久化，工具经 Core 执行业务变更（派子 task、等子 task、改 state/变量、建子服务）。pi 后端没有工具轮次：pi 在子服务内自己完成整个工具循环，Lush 只记录 user prompt 与最终文本（完整 pi session 落在 `$LUSH_HOME/pi-sessions/`，按 task 命名）。
5. agent 给出最终回答后，task 层按顺序决定：收件箱有未读输入（父子消息 / 子 task 结算）→ 合成一条 user 消息继续 invoke；无输入但有活动子 task → 进入 `waiting` 等输入；都没 → 这个回答就是 task 的 result（记为 completed，最多 `LUSH_TASK_CALLS` 次）。异常记录 failed，取消记录 cancelled。

阻塞在 task 上，不在 agent 里：agent 的工具没有“等待”原语。父子消息与子 task 结算都进同一个 `task_inbox`，只在两次 invocation 之间交给 agent，所以不会打断正在跑的工作；消息只走 task 树的直接边，与“只能向下游、直接子 service”同一条边界，所以通话关系不可能成环。单次 invocation 有轮数上限和超时（task 停在 `waiting` 等输入期间超时不计）。同一个 Agent 回复的多个工具依次执行，避免同轮生命周期工具和变更工具竞态。多个客户端/父服务可同时调用不同 SID；单个父 Agent 的同轮多工具暂不并行。未来可以加入显式并行工具，不改变 Core API。

## 持久化

- `services`：SID、当前 parent、original_parent、名称、状态（created / active / stopped）、目标、模板快照、时间戳。
- `contexts`：system_prompt、state JSON、artifacts/references JSON，与 Service 一对一。
- `tasks`：id、sid（挂载的 service）、parent_task_id、root_task_id、goal、status（created / running / waiting / completed / failed / cancelled）、result、error、state、时间戳。
- `messages` / `agent_calls`：按自增 ID 排序的完整 provider 协议消息与调用记录，关联 SID、`task_id` 和 invocation。
- `service_events` / `task_events`：节点与 task 各自的创建、状态变化、收养、state 更新事件。

关系采用 `services.parent_sid` 外键作为唯一事实，不增加重复 children 表。children 反查并加索引；禁止任意 reparent，只允许创建及系统向根收养，因此不能产生环。original_parent_sid 不变。

SQLite 开启 foreign_keys、WAL、busy_timeout。每个 Core 变更在同步短事务内完成，事务中不 await / 不调用模型。单 daemon / 单事件循环拥有数据库连接，不存在线程共享 SQLite。`bun:sqlite` 是同步 API，属于 MVP 限制：大查询/磁盘 IO 可能短暂阻塞事件循环，后续可替换为专用工作线程或 `bun:sqlite` 的异步接口，不改变 Repository 边界。

父服务结束及孤儿收养是同一事务。唯一的物理删除路径是 `service.delete` / `service.purge`（连带挂载在它上面的 task）与 `task.delete`（只删 task 行，call 行与消息作为 service 历史保留），详见 [concepts/lifecycle-and-orphans.md](../concepts/lifecycle-and-orphans.md) 的「删除」。重启恢复先把 running 的调用标记 interrupted，把未结束的 task 记为 failed（daemon restarted），再把 SID 0 恢复为 active；其他节点状态保留。启动阶段还会把旧快照中缺失的、当前版本仍需从快照读取的模板字段（`child_templates`、`variables`）从同名已加载模板回填一次，并记 template_backfilled 事件；同名模板不存在时跳过并记 WARNING，其他快照字段不变。旧版快照里遗留的 `service_type`、`allowed_child_templates`、`agent_command`、`initial_context` 不再被读取。未完成的工具消息保留用于审计，但 ContextBuilder 不把不完整调用协议重放给 Provider，而将中断/失败的历史显示为普通对话和审计摘要。

## 运行与限制

数据目录 0700，socket 0600；单实例锁保证同一 `$LUSH_HOME` 只有一个 daemon，持锁后才清理 stale socket。Bun 未暴露 `flock`，所以锁是原子创建的 `daemon.lock` 文件（先写临时文件再 `link()` 占位，读者不会看到空锁），内容为 daemon 的 OS PID，通过进程存活检测判断归属，因此 SIGKILL 遗留的锁可被下一次启动接管。SIGTERM / SIGINT 或 daemon.stop 停止接收连接并取消 Agent 调用，记录中断后关闭数据库。不自动重试网络请求和工具。内置 Provider 请求使用 Bun `fetch` + `AbortSignal`：逻辑调用取消后不再执行其结果和工具，底层请求也会被中断；pi 后端在取消（kill/stop/超时/daemon 退出）时直接 SIGKILL 对应的 pi 子进程，因此 daemon 退出不必等 pi 干完。运行期 agent 在 `AgentRuntime` 里有自己的空间（id `TASK.N`，不落库）：daemon 起的 pi 由 provider 在 spawn 后回传 OS PID，`call --interactive` 的 pi 由终端上报 `call.os_pid`，所以 \`task agents kill\` 对两者都能直接 SIGKILL（并取消它服务的 task）；daemon 重启后这个空间为空（活的 agent 本来就没剩），持久记录留在 task 行、`agent_calls` 与磁盘上的 session。CLI 的 stop 等待的是 Core 锁释放。服务树恢复不等于恢复模型内部执行现场，也不重放 pi 的会话。

pi 子进程的限制：`LUSH_CALL_TIMEOUT`（默认 900 秒）是单次 invocation 的硬上限，超时后 pi 会被杀掉并把 task 记为 failed；pi 继承 daemon 的环境（包括代理变量与它自己的配置目录），Lush 只额外注入 `LUSH_HOME` / `LUSH_SID` / `LUSH_TASK_ID` 并把仓库 `bin/` 前置到 PATH；**一 task 一 session**，所以两个 task 的 pi 服务可并行（同一 task 不会再开第二个），而一个 service 同时最多一个活动 task。`LUSH_MAX_ROUNDS` 是单次 invocation 的轮数上限，`LUSH_TASK_CALLS`（默认 12）是一个 task 最多被 invoke 几次（首次 + 唤醒），两者都只对内置运行时/唤醒逻辑有意义。

Service 是被动节点，不等于后台循环的 Agent；一切由 task 驱动。SID 0 会按配置的孤儿监督策略回收孤儿：父节点进入终态时按 `LUSH_ORPHAN_ADOPT` 收养（默认）/ 不收养 / 连同子节点一起冻结，收养后的孤儿按 `LUSH_ORPHAN_LIMIT`（活动孤儿上限，超出时从最旧开始冻结）与 `LUSH_ORPHAN_TTL`（闲置超时）回收，daemon 在 `LUSH_ORPHAN_SWEEP` 秒的定时器上（仅当 limit>0 或 ttl>0 时启用，unref）跑一轮，也可用 `lush service orphans [--sweep]` 查看/手动触发；有调用在跑的孤儿永不被冻结。默认值是 adopt + 不限 + 不超时，即不显式配置就不回收——配置入口是 daemon 启动时读的环境变量，改配置要重启。回收是冻结（一律 → stopped，记录全留），物理删除仍只有 delete / purge。

Context 是单独资源边界，而不是消息数组别名。当前持久上下文不自动压缩、不使用 token scheduler；完整历史会增长，达到 RPC 大小上限时可按页读取历史。未来可在 ContextBuilder / Repository 边界加入 compression、paging、inheritance、sharing 和调度，不改变 Service 语义。

没有跨模型副作用的 exactly-once 保证：若工具已提交但 daemon 在 tool message 写入前崩溃，事件/实体变更仍在，但模型历史可能不完整。恢复标记 interrupted，要求人工 inspect 而不是自动重放。pi 后端同理：pi 会话文件里可能有已执行的 bash 副作用，而 Lush 只把 invocation 标为 interrupted。

## 源码的分层布局

`src/` 按模块分目录（`core/` / `persistence/` / `agent/` / `context/` / `rpc/` / `daemon/` / `cli/`），再往下的约定是：**一个语义单元写成 `x.js` + 同名目录 `x/`**，`x.js` 只做转发（通常 6~15 行），`x/` 里是按职责切开的层。这和 `templates/` 的布局是同一个把戏——目录本身就是结构。

```text
src/core/service_manager.js        # 入口：re-export
src/core/service_manager/
  index.js   组装：类本体（构造函数 + orphanPolicy getter）+ Object.assign(五个方法层)
  read.js    SID 0 初始化、读模型、变量
  nodes.js   construct、状态机、孤儿监督、删除
  agents.js  profile 解析与 agent 动词
  tasks.js   task 动词
  notices.js notice 动词（agent → 用户）
```

同样的模式用在 `agent/runtime.js`（runner / space / task / interactive）、`cli/format/service.js`（inspect / agents / tasks）、`core/tasks.js`（internal / rules / read）、`persistence/repository.js`（index / rows / state / calls / tasks / notices / removal）、`persistence/database.js`（connection / schema）。

两条实现约定：

- **导入路径不随拆分变化**：入口文件保留原名（`'./tasks.js'`、`'../agent/runtime.js'` 照旧），所以调用方不需要知道内部怎么分层。
- **宽接口用方法层合并，不用继承链**：每个层导出一个普通对象，`Object.assign(Class.prototype, layerA, layerB, ...)` 合到同一个原型上，表面仍是一个扁平对象（RPC 的 `service.*` / `task.*` 方法、CLI 的调用点都直连它）。构造函数的字段与 getter 留在类体里——`Object.assign` 复制的是 getter 的值，不是 getter 本身。
