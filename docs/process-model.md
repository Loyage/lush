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

JSON 文件字段：

```json
{
  "name": "coding-task",
  "process_type": "task",
  "description": "完成编码目标",
  "system_prompt": "你是编码任务 Agent。只有完成目标时才调用 process.complete。",
  "allowed_child_templates": ["generic-task", "research-task", "reviewer-service"],
  "initial_context": {"state": {}, "artifacts": [], "references": []}
}
```

限制针对 template 名称，而非 task/service。`["*"]` 表示允许全部已加载模板；`[]` 禁止创建子节点。父节点必须 running。自身模板快照决定后续创建权限，外部文件修改不会悄悄改变已有进程能力。子节点 goal 由创建参数指定，未指定时使用名称；不自动继承全部父 Context。ContextBuilder 提供父节点摘要。

内置模板：lush-root、generic-service、generic-task、coding-task、research-task、reviewer-service。lush-root 为 PID 0 专用，任何节点都不能用它 spawn 子进程（即使允许列表含 `*`）。用户目录模板不能覆盖内置名称；loader 检查类型、必填字段和允许列表中的模板引用。

## Agent 和 Context

Context 持久化保存 system_prompt、state、artifacts、references、messages。父信息和 children summary 构建时从当前树获取（不是可能过期的持久副本）。Agent 工具 `process.self/parent/children/inspect` 可按需查详情。

Process 不持有供应商 SDK；Runtime 根据配置使用 AgentProvider（`{ name, async call(messages, tools, signal) }`）。MVP 所有 Process 共用一个无会话 Provider 实例，但调用消息和状态严格按 PID 分离，后续可按模板选择 Provider。祖先调用链通过 `AsyncLocalStorage` 传播，替代 Python 版 ContextVar。
