# Process 模型

## 实体和接口

Process = 持久化 metadata + Context + Agent + 生命周期。字段包括 pid、parent_pid、original_parent_pid、children（反查）、type、status、created_at、updated_at、name、goal、template 快照。

`ProcessManager.load(pid)` 返回轻量句柄 `Process`，提供 `getParent()`、`getChildren()`、`createChild(template, {name, goal})`、`await call(prompt)`、`inspect()`。读取总是从 Repository 获取当前状态。每个 Process，包括 PID 0，都可以调用 Agent。

`ProcessManager` 的方法名与 JSON-RPC 方法名几乎一一对应（`updateState` ↔ `process.update_state`）；线协议字段保持 snake_case，JS 内部使用 camelCase。

PID 0 固定名 lush、类型 service、没有父节点，使用内置 lush-root template，daemon 可用时为 running。禁止用户 stop/kill/complete/reclaim PID 0；其生命周期由 daemon 管理。

## 生命周期

```text
Service: created -> running -> stopped / failed
                             stopped / failed -> running (start)
Task:    created -> running -> completed / failed / cancelled -> reclaimed
```

- spawn 通过 template 原子创建并启动，事件中同时记录 created 和 running。
- start：启动 created；重新启动 stopped/failed Service；running 上幂等。终态 Task 不可复活。
- stop：仅 Service；停止目标，不级联终止子节点。
- kill：Service -> stopped；活动 Task -> cancelled。已终止节点幂等。
- complete：仅 running Task，由 Agent 显式声明；可保存 result 到 state。
- fail：Core 提供的显式失败操作；provider 调用失败只使 invocation failed，不会自动使 Process failed。
- reclaim：仅 completed/failed/cancelled Task -> reclaimed，保留 metadata、Context、消息和事件。
- call / attach：只接受 running Process。call 成功不代表任务完成。历史通过 inspect / history 读取，不重新调用已结束任务。

用户或 Agent 只能修改结构化 Context state，不能随意覆写 pid、parent、type、status；生命周期必须通过专门 Core 操作验证。

## 孤儿收养（用户确认）

父节点进入终态（Service stopped/failed；Task completed/failed/cancelled）时，将其 **created/running 的直接子节点** 的 parent_pid 改为 0。保留 original_parent_pid 和 reparent 事件。已结束子节点仍属于原父节点。孙节点不变。子节点自己的状态、Agent 调用不受影响。

因此 task -> service 完全允许；Task 完成后，该 Service 能持续存在，由 PID 0 收养。restart 已停止的 Service 不自动取回已被收养的子节点。MVP 不实现 PID 0 的进一步孤儿监督策略。

stop/kill 会中断目标正在运行的 Agent 调用（abort 该 PID 的 AbortController），但不会中断被收养子节点独立的调用。嵌套 process.call 的等待者被取消时，子 invocation 继续运行（JS 中取消等待者只是停止 await，不传播到被等待的 promise），历史可通过 inspect 查询。

## ProcessTemplate

JSON 文件字段固定为七项，缺一或多一都报错：

```json
{
  "name": "coding-task",
  "type": "task",
  "singleton": false,
  "description": "完成编码目标",
  "spawn_prompt": "创建编码任务：process_spawn {template: \"coding-task\", name: <任务短名，必填>, goal: <编码目标，必填>}。",
  "system_prompt": "你是编码任务 Agent。只有完成目标时才调用 process.complete。",
  "child_templates": ["generic-task", "research-task", "generic-service"]
}
```

- `name`：模板名，也是 `process.spawn` / `lush process spawn` 的 template 参数。
- `type`：`task` 或 `service`，决定新 Process 的类型和可用生命周期。
- `singleton`：`true` 时，同一个父 PID 下最多只能有一个活动（created/running）实例；该实例停止、结束或 reclaim 后名额释放。不同父 PID 互不影响；`generic-*` 这类通用模板应为 `false`。
- `description`：一句话说明用途，出现在创建方的 `available_child_templates` 中。
- `spawn_prompt`：告诉创建方「如何创建这个模板、需要哪些参数」的 prompt，随 Context 一起注入创建方 Agent（`available_child_templates[].spawn_prompt`）。它只描述创建契约，不参与被创建实例自身的 Call。
- `system_prompt`：实例创建时快照进它自己的 Context，成为之后每次 `call` 的系统提示词。
- `child_templates`：该模板实例初始化后允许创建的子模板列表。

注入创建方 Agent 的 `available_child_templates` 只列**此刻真能创建成功**的模板：按创建时快照的 `child_templates` 过滤权限、排除 `lush-root`，并剔除 `singleton: true` 且本 PID 下已有活动实例的模板（否则调用方只会白撞一次 `process.spawn` 的拒绝）。它是派生视图，不代替权限本身：完整白名单仍在 `child_templates`，被占位的那个实例就在 `children` 里。

限制针对 template 名称，而非 task/service。`["*"]` 表示允许全部已加载模板；`[]` 禁止创建子节点。父节点必须 running。自身模板快照中的 `child_templates` 决定后续创建权限，外部文件修改不会悄悄改变已有进程能力。子节点 goal 由创建参数指定，未指定时使用名称；模板不携带初始 Context，新实例的 state、artifacts、references 一律从空开始。ContextBuilder 提供父节点摘要。

模板快照是创建时的完整副本（含 `singleton`、`spawn_prompt`），外部改模板文件不会改变已有 Process。`singleton` 与 `type` 按当前已加载模板判定；唯一例外是 `child_templates`：daemon 启动时会把旧快照中缺失的该字段从同名已加载模板回填一次（幂等，记 template_backfilled 事件，不改其他字段），同名模板已不存在时跳过并记日志。旧快照里遗留的 `process_type`、`allowed_child_templates`、`agent_command`、`initial_context` 键不再被读取。

仓库顶层 `templates/` 内置 `lush-root.json`（PID 0 专用，任何节点都不能用它 spawn 子进程，即使 `child_templates` 含 `*`）以及 `generic-service`、`generic-task`、`research-task`、`project-manager`、`project` 示例。其余模板需自行编写，放入 `templates/` 或 `$LUSH_HOME/templates/`；用户目录模板不能覆盖仓库模板名称；loader 检查 `type`、`singleton`、必填字段和列表中的模板引用。

### 创建参数（spawn args）

模板不再有初始 Context 字段；创建时可以额外传一个 `args` JSON 对象（`process.spawn` 的 `args` 参数 / `lush process spawn ... --args '<json>'`），它原样存入新实例的 `state.params`（不会覆盖 agent 自己写的 state 顶层字段）。模板的 `spawn_prompt` 必须写清楚需要哪些键。

`args.path` 有通用约定：给了就必须是**已存在的绝对目录**，否则 spawn 直接报错（-32602）；它同时是该进程 agent 的工作目录（pi 的 cwd），没给时用 `$LUSH_HOME`。

`project` 模板就是靠这个约定工作的：它是 `project-manager` 的子模板、`singleton=false`，创建时必须提供 `args.path`，否则报 `requires spawn args: args.path`。哪些模板必须带 `path` 目前写死在 `src/core/process_manager.js` 的 `REQUIRED_SPAWN_ARGS`（MVP 过渡方案，将来应由模板自己声明参数）。

## Agent 后端

Process 的 agent 由 daemon 的 `LUSH_PROVIDER` 决定，模板只描述身份与能力（`system_prompt` / `spawn_prompt` / `child_templates`），不绑定具体模型：

- `pi`（默认）：每次 call 起一个 `pi --print` 子进程，每个 PID 一个 pi session。模板 `system_prompt` 通过 `--system-prompt` 替换 pi 默认提示词，随后追加共享的 Lush 说明层（`src/agent/guide.js`）和 `LUSH_CONTEXT` 数据。pi 用自己的 read/bash/edit/write 工具，并通过 bash 调用 `lush` CLI 操作进程。取消调用会杀掉子进程。
- `mock` / `openai`：Lush 内置运行时，agent 直接拿到 `process_*` 工具，共享说明层切换到 tools 版本，模板 `system_prompt` 作为第一条 system message。

两种形态共用同一份 Lush 语义：一次 call 不等于 Task 完成，只有 Task 能 complete，singleton 限制、`child_templates` 白名单和 `args` 校验都由 Core 强制执行，与 agent 后端无关。

## Agent 和 Context

Context 持久化保存 system_prompt、state、artifacts、references、messages。父信息和 children summary 构建时从当前树获取（不是可能过期的持久副本）。Agent 工具 `process.self/parent/children/inspect` 可按需查详情。

Process 不持有供应商 SDK；Runtime 根据配置使用 Agent 后端：内置 Provider 是 `{ name, contextMode:'tools', async call(messages, tools, signal, invocation) }`，外部后端（`pi`）是 `{ name, contextMode:'cli', async call(messages, tools, signal, invocation) }`，只用 `invocation`（pid、prompt、system_prompt、guide、context、cwd）。所有后端共用一个实例（pi 每个 PID 用自己的 session 目录），调用消息和状态严格按 PID 分离，后续可按模板选择后端。祖先调用链通过 `AsyncLocalStorage` 传播。
