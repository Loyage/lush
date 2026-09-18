# 总体架构

## 定位

Lush 管理 AI 活动，而不是 CPU、内存和 Unix 进程。逻辑 Process 是持久化实体；内存中的 Process 只是通过 PID 访问 Core 的句柄，不维护递归 children 对象图。

```text
lush CLI -- JSON-RPC / Unix socket --> lushd
                                       |
                                  ProcessManager <--- Agent Tools
                                    |       |              ^
                               Repository   AgentRuntime --|
                                    |       |       |
                                 SQLite  ContextBuilder  AgentBackend
                                              |         /          \
                                        Lush guide   pi (子进程)   内置 provider
                                                                    /        \
                                                                  Mock     OpenAI
```

## 模块边界

- `core/`：实体类型、生命周期、Process 句柄、统一业务 API、父子关系及孤儿收养。`core/orphans.js` 是 PID 0 的孤儿监督：孤儿池读模型、策略校验（`normalizeOrphanPolicy`）、上限 / TTL / busy 判定与一轮监督（`OrphanSupervisor`）；它只决定该冻结谁，真正的状态变更仍走 `ProcessManager`（冻结而非删除）。没有 socket / CLI / HTTP 知识。
- `persistence/`：`bun:sqlite` schema、事务、记录查询与恢复。数据库是事实来源，不缓存进程树。
- `template_loader.js` + `templates/`：仓库顶层 `templates/` 存放 JSON ProcessTemplate（name、type、singleton、description、spawn_prompt、system_prompt、child_templates、variables 八个必填字段，另有一个可选字段 agent），模板按 spawn 树分目录嵌套：`<name>.json` 的同级有一个同名文件夹 `<name>/`，里面放它能直接创建的模板（`templates/lush-root.json` + `templates/lush-root/project-manager.json` + `templates/lush-root/project-manager/project/dev-task.json`），loader 递归读取并校验，`child_templates` 写的是相对自己文件的路径（`project/dev-task.json` / `generic-task.json`），加载时解析成模板名（也接受直接写名字），因此白名单、快照与权限比对里只有名字，并**按层级顺序排列模板**：层级 = 从「没有其他模板能创建它」的模板出发的最长路径（`*` 与自引用不算边，环在走到的那条边上截断），同级按名称排序，因此结果与文件名无关；`available_child_templates` 于是呈现根在前的拓扑序（`lush-root` → `project-manager` → `project` → 它能创建的任务），而不是文件名序。创建时保存完整快照，模板文件后续变更不影响既有 Process（`singleton`、`type` 按当前加载的模板判定）。可选的 `agent` 声明该模板新建实例使用的 agent profile，`spawn --agent` 优先于它。
- `context/`：独立持久化 Context，以及 ContextBuilder。只读当前 Process 的对话、结构化 state、引用和直接亲属摘要，不注入全系统状态。
- `agent/`：Agent 后端，以及受限轮数的调用循环。默认后端是 `pi`：每次 call 起一个 `pi --print` 子进程，每个 PID 一个 pi session，pi 自己跑工具循环并通过 bash 调用 `lush` CLI 操作进程；`mock` / `openai` 是 Lush 内置运行时，agent 直接拿 `process_*` 工具。`profiles.js` 是 agent profile 的存储与逐字段解析（一个 agent 一个 `$LUSH_HOME/agents/<name>.json`，内置 default 为「纯净 pi」：不加载使用者的 extensions / skills / prompt templates / themes / AGENTS.md），`catalog.js` 把「进程选中了哪个 profile」在 call 时解析成 provider（缓存按解析后的字段做键，改文件即改行为，不用重启 daemon）。`guide.js` 是两种形态共用的 Lush 说明层（介绍 Lush 与如何操作它），`ContextBuilder` 按**该进程实际使用的后端**选择 tools / cli 版本。共享的快照字段（`singleton`、`type`）由当前模板决定，`child_templates` 白名单、variables 声明（哪些必填、哪些创建后仍可改、格式约束 pattern / max_length / single_line）与保留名 `path` 的工作目录校验、`name` 的进程名等价关系由 Core 强制执行，后端不参与授权。
- `rpc/`：newline-delimited JSON-RPC；参数和错误映射，不复制业务逻辑。
- `daemon/`：装配、单实例锁、socket 生命周期、信号和中断恢复；启动时建一个 `AgentCatalog`（默认 provider = 环境变量叠加内置 default profile），并把它绑给 `ProcessManager`（spawn 时校验 `--agent` / 模板 `agent`）与 `AgentRuntime`（call 时解析该 PID 的 profile）；按 `config.orphanPolicy` 决定是否起孤儿监督定时器（`sweepSeconds` 秒，unref，关闭时先清掉再关数据库）。
- `socket_io.js`：Bun socket 写入是有界的（单次 write 只接受有限字节），统一封装「写满队列 + drain 续写」，RPC 两端共用。
- `cli/`：命令树声明（每一层自带 help）、参数解析、RPC 客户端、输出格式、交互 attach、daemon 启动客户端。

## 调用数据流

1. CLI RPC 或另一个 Agent 的 `process.call` 进入 `ProcessManager.call(pid, prompt)`。
2. Runtime 验证 Process 为 running；同一 PID 已有调用则返回 busy，不等待锁；不同 PID 可并行。
3. 持久化 agent_calls 记录和 user message。ContextBuilder 生成模板 system prompt、共享 Lush 说明层、当前 metadata、父节点、直接子节点摘要、持久 Context 和对话（包括本次 prompt）。内置后端直接用这些 messages；外部后端（pi）拿到同样的 system prompt / 说明层 / `LUSH_CONTEXT` 与工作目录，由 Lush 拼成命令行参数。
4. Provider 返回文本及结构化 tool calls。每个 assistant / tool 消息顺序持久化，工具经 Core 执行业务变更；随后刷新结构化 Context。pi 后端没有工具轮次：pi 在子进程内自己完成整个工具循环，Lush 只记录 user prompt 与最终文本（完整 pi session 落在 `$LUSH_HOME/pi-sessions/`）。
5. 没有工具调用时记录成功结果；异常记录 failed，中断记录 interrupted。一次调用结束不隐式结束 Process。

嵌套调用的祖先调用链禁止递归回入；其他交叉调用遇到 busy 立即失败，避免 A 等 B / B 等 A 的死锁。单次 invocation 有轮数上限和超时。同一个 Agent 回复的多个工具依次执行，避免同轮生命周期工具和变更工具竞态。多个客户端/父进程可同时调用不同 PID；单个父 Agent 的同轮多工具暂不并行。未来可以加入显式并行工具，不改变 Core API。

## 持久化

- `processes`：PID、当前 parent、original_parent、名称、类型、状态、目标、模板快照、时间戳。
- `contexts`：system_prompt、state JSON、artifacts/references JSON，与 Process 一对一。
- `messages`：按自增 ID 排序的完整 provider 协议消息，关联 PID 和 invocation。
- `agent_calls`：调用 prompt、状态、结果、错误、开始结束时间。
- `process_events`：创建、生命周期变化、收养、state 更新事件。

关系采用 `processes.parent_pid` 外键作为唯一事实，不增加重复 children 表。children 反查并加索引；禁止任意 reparent，只允许创建及系统向根收养，因此不能产生环。original_parent_pid 不变。

SQLite 开启 foreign_keys、WAL、busy_timeout。每个 Core 变更在同步短事务内完成，事务中不 await / 不调用模型。单 daemon / 单事件循环拥有数据库连接，不存在线程共享 SQLite。`bun:sqlite` 是同步 API，属于 MVP 限制：大查询/磁盘 IO 可能短暂阻塞事件循环，后续可替换为专用工作线程或 `bun:sqlite` 的异步接口，不改变 Repository 边界。

父进程结束及孤儿收养是同一事务。消息、事件、Context 和调用历史不会在 reclaim 时删除；唯一的物理删除路径是 `process.delete` / `process.purge`，它在一个事务里删掉目标 PID（或整棵子树）的全部行，只在父进程留一条 `child_deleted` 事件——详见 process-model.md 的「删除」。重启恢复先将 running 的调用标记 interrupted，然后恢复 PID 0 为 running；其他 Process 状态保留。启动阶段还会把旧快照中缺失的、当前版本仍需从快照读取的模板字段（`child_templates`、`variables`）从同名已加载模板回填一次，并记 template_backfilled 事件；同名模板不存在时跳过并记 WARNING，其他快照字段不变。旧版快照里遗留的 `process_type`、`allowed_child_templates`、`agent_command`、`initial_context` 不再被读取。未完成的工具消息保留用于审计，但 ContextBuilder 不把不完整调用协议重放给 Provider，而将中断/失败的历史显示为普通对话和审计摘要。

## 运行与限制

数据目录 0700，socket 0600；单实例锁保证同一 `$LUSH_HOME` 只有一个 daemon，持锁后才清理 stale socket。Bun 未暴露 `flock`，所以锁是原子创建的 `daemon.lock` 文件（先写临时文件再 `link()` 占位，读者不会看到空锁），内容为 daemon PID，通过进程存活检测判断归属，因此 SIGKILL 遗留的锁可被下一次启动接管。SIGTERM / SIGINT 或 daemon.stop 停止接收连接并取消 Agent 调用，记录中断后关闭数据库。不自动重试网络请求和工具。内置 Provider 请求使用 Bun `fetch` + `AbortSignal`：逻辑调用取消后不再执行其结果和工具，底层请求也会被中断；pi 后端在取消（kill/stop/超时/daemon 退出）时直接 SIGKILL 对应的 pi 子进程，因此 daemon 退出不必等 pi 干完。运行期 agent 在 `AgentRuntime` 里有自己的空间（id `PID.N`，不落库）：普通 call 的 pi 由 provider 在 spawn 后回传 OS pid，`call --interactive` 的 pi 由终端上报 `process.call_os_pid`，所以 \`process agents kill\` 对两者都能直接 SIGKILL；daemon 重启后这个空间为空（活的 agent 本来就没剩），持久记录留在 `agent_calls` 与磁盘上的 session。CLI 的 stop 等待的是 Core 锁释放。进程树恢复不等于恢复模型内部执行现场，也不重放 pi 的会话。

pi 子进程的限制：`LUSH_CALL_TIMEOUT`（默认 900 秒）是单次 call 的硬上限，超时后 pi 会被杀掉并记 invocation timeout；pi 继承 daemon 的环境（包括代理变量与它自己的配置目录），Lush 只额外注入 `LUSH_HOME` / `LUSH_PID` 并把仓库 `bin/` 前置到 PATH；一 PID 一 session 意味着并行 call 同一 PID 依旧被 busy 保护（包括 `--interactive` 持有的那次调用），而不同 PID 的 pi 进程可并行；agents 空间里的 `PID.N` 已为正好的并行 agent 留好编号，但今天一个 PID 同时最多一个活 agent。`LUSH_MAX_ROUNDS` 只对内置运行时有意义。

Service 是长期逻辑存在，不等于无限循环的后台 Agent；MVP 由 call 驱动。PID 0 会按配置的孤儿监督策略回收孤儿：父节点进入终态时按 `LUSH_ORPHAN_ADOPT` 收养（默认）/ 不收养 / 连同子节点一起冻结，收养后的孤儿按 `LUSH_ORPHAN_LIMIT`（活动孤儿上限，超出时从最旧开始冻结）与 `LUSH_ORPHAN_TTL`（闲置超时）回收，daemon 在 `LUSH_ORPHAN_SWEEP` 秒的定时器上（仅当 limit>0 或 ttl>0 时启用，unref）跑一轮，也可用 `lush process orphans [--sweep]` 查看/手动触发；有调用在跑的孤儿永不被冻结。默认值是 adopt + 不限 + 不超时，即不显式配置就不回收——配置入口是 daemon 启动时读的环境变量，改配置要重启。回收是冻结（Service → stopped、Task → cancelled，记录全留），物理删除仍只有 delete / purge。

Context 是单独资源边界，而不是消息数组别名。当前持久上下文不自动压缩、不使用 token scheduler；完整历史会增长，达到 RPC 大小上限时可按页读取历史。未来可在 ContextBuilder / Repository 边界加入 compression、paging、inheritance、sharing 和调度，不改变 Process 语义。

没有跨模型副作用的 exactly-once 保证：若工具已提交但 daemon 在 tool message 写入前崩溃，事件/实体变更仍在，但模型历史可能不完整。恢复标记 interrupted，要求人工 inspect 而不是自动重放。pi 后端同理：pi 会话文件里可能有已执行的 bash 副作用，而 Lush 只把 invocation 标为 interrupted。
