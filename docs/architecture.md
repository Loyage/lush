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
                                 SQLite  ContextBuilder  AgentProvider
                                                        /           \
                                                      Mock         OpenAI
```

## 模块边界

- `core/`：实体类型、生命周期、Process 句柄、统一业务 API、父子关系及孤儿收养。没有 socket / CLI / HTTP 知识。
- `persistence/`：`bun:sqlite` schema、事务、记录查询与恢复。数据库是事实来源，不缓存进程树。
- `templates/`：读取并校验 JSON ProcessTemplate；创建时保存完整快照，模板文件后续变更不影响既有 Process。
- `context/`：独立持久化 Context，以及 ContextBuilder。只读当前 Process 的对话、结构化 state、引用和直接亲属摘要，不注入全系统状态。
- `agent/`：Provider 接口、工具定义及分发、受限轮数的 Agent 调用循环。Process 每次使用自己的 Context；不需要为每个 Process 常驻模型连接。
- `rpc/`：newline-delimited JSON-RPC；参数和错误映射，不复制业务逻辑。
- `daemon/`：装配、单实例锁、socket 生命周期、信号和中断恢复。
- `socket_io.js`：Bun socket 写入是有界的（单次 write 只接受有限字节），统一封装「写满队列 + drain 续写」，RPC 两端共用。
- `cli/`：RPC 客户端、输出格式、交互 attach、daemon 启动客户端。

## 调用数据流

1. CLI RPC 或另一个 Agent 的 `process.call` 进入 `ProcessManager.call(pid, prompt)`。
2. Runtime 验证 Process 为 running；同一 PID 已有调用则返回 busy，不等待锁；不同 PID 可并行。
3. 持久化 agent_calls 记录和 user message。ContextBuilder 生成模板 system prompt、当前 metadata、父节点、直接子节点摘要、持久 Context 和对话（包括本次 prompt）。
4. Provider 返回文本及结构化 tool calls。每个 assistant / tool 消息顺序持久化，工具经 Core 执行业务变更；随后刷新结构化 Context。
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

父进程结束及孤儿收养是同一事务。消息、事件、Context 和调用历史不会在 reclaim 时删除。重启恢复先将 running 的调用标记 interrupted，然后恢复 PID 0 为 running；其他 Process 状态保留。未完成的工具消息保留用于审计，但 ContextBuilder 不把不完整调用协议重放给 Provider，而将中断/失败的历史显示为普通对话和审计摘要。

## 运行与限制

数据目录 0700，socket 0600；单实例锁保证同一 `$LUSH_HOME` 只有一个 daemon，持锁后才清理 stale socket。Bun 未暴露 `flock`，所以锁是原子创建的 `daemon.lock` 文件（先写临时文件再 `link()` 占位，读者不会看到空锁），内容为 daemon PID，通过进程存活检测判断归属，因此 SIGKILL 遗留的锁可被下一次启动接管。SIGTERM / SIGINT 或 daemon.stop 停止接收连接并取消 Agent 调用，记录中断后关闭数据库。不自动重试网络请求和工具。Provider 请求使用 Bun `fetch` + `AbortSignal`：逻辑调用取消后不再执行其结果和工具，底层请求也会被中断，因此 daemon 退出不必等待网络超时；CLI 的 stop 等待的是 Core 锁释放。进程树恢复不等于恢复模型内部执行现场。

Service 是长期逻辑存在，不等于无限循环的后台 Agent；MVP 由 call 驱动。没有自动监督孤儿的策略，PID 0 目前只负责收养和提供统一 Agent 入口。

Context 是单独资源边界，而不是消息数组别名。当前持久上下文不自动压缩、不使用 token scheduler；完整历史会增长，达到 RPC 大小上限时可按页读取历史。未来可在 ContextBuilder / Repository 边界加入 compression、paging、inheritance、sharing 和调度，不改变 Process 语义。

没有跨模型副作用的 exactly-once 保证：若工具已提交但 daemon 在 tool message 写入前崩溃，事件/实体变更仍在，但模型历史可能不完整。恢复标记 interrupted，要求人工 inspect 而不是自动重放。
