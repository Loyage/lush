# RPC 与 CLI

## 传输

Unix Domain Socket：`$LUSH_HOME/lush.sock`。每行一个 UTF-8 JSON-RPC 2.0 对象，以 LF 分隔。最大帧 1 MiB；不支持 batch；支持无 id 的 notification（执行但不回复），CLI 始终使用 request。同一连接逐条处理，不同连接并发。响应 id 与请求一致。拒绝 NaN / Infinity。

```json
{"jsonrpc":"2.0","id":1,"method":"process.call","params":{"pid":2,"prompt":"当前目标是什么？"}}
{"jsonrpc":"2.0","id":1,"result":{"pid":2,"call_id":1,"output":"..."}}
```

错误：`{"jsonrpc":"2.0","id":1,"error":{"code":-32004,"message":"process not found: 99"}}`。

| code | 含义 |
|---|---|
| -32700 | JSON parse error |
| -32600 | invalid request / batch / frame |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | unexpected internal error（详情只写 daemon log） |
| -32004 | process/template not found |
| -32009 | lifecycle conflict / busy / call cycle |
| -32010 | template policy denied |
| -32020 | provider / invocation error |
| -32021 | invocation interrupted |

## 方法

所有 params 为具名 object，无未知字段。PID 为非负 integer（不接受 boolean）。

| RPC | params | result |
|---|---|---|
| system.status | {} | daemon_pid, root_pid, provider, process_count, active_calls |
| system.shutdown | {} | stopping |
| process.list | {} | metadata 数组 |
| process.tree | {} | metadata 数组（客户端格式化树） |
| process.inspect | pid | metadata、Context metadata、Agent 状态、近期调用 |
| process.parent | pid | parent metadata 或 null |
| process.children | pid | children metadata 数组 |
| process.spawn | parent_pid, template, name?, goal? | 新 Process metadata |
| process.call | pid, prompt | pid, call_id, output |
| process.start/stop/kill/reclaim | pid | 更新后的 metadata |
| process.update_state | pid, patch | 更新后 state（顶层 merge） |
| process.complete | pid, result? | 更新后的 metadata |
| process.history | pid, after=0, limit=100 | 按 id 升序 messages、next_after |

inspect 的 Context 包含 system_prompt、state、artifacts、references、message_count；调用和事件各取最近 20 条，避免无界响应。完整消息使用 history 分页读取。元数据含 template 的完整创建时快照。

## Agent Tools

Provider tool 名称采用 OpenAI-compatible 安全字符：`process_self`、`process_spawn` 等；Runtime 映射成以下 Core 操作。Mock `/tool process.spawn {...}` 也接受逻辑点号名称。

| Tool | 参数 | 语义 |
|---|---|---|
| process.self | {} | inspect 当前 Process |
| process.parent | {} | 当前父节点 |
| process.children | {} | 当前直接子节点 |
| process.inspect | pid | inspect 指定节点 |
| process.spawn | template, name?, goal? | 当前节点创建 child |
| process.call | pid, prompt | 调用另一节点；禁止递归和 busy |
| process.update_state | patch | 修改自身持久 state |
| process.complete | result? | 完成自身 Task |

工具错误作为带 code/message 的 tool result 回给 Agent；Provider 可以修正。未知工具拒绝。不通过 shell 执行 lush，不允许 Agent 伪造当前 PID。complete 后本轮可返回最终文本，但后续副作用工具被拒绝。

## CLI

```text
lush daemon start|stop
lush status
lush ps
lush tree
lush inspect PID
lush call PID PROMPT
lush attach PID
lush spawn PARENT TEMPLATE [--name NAME] [--goal GOAL]
lush start|stop|kill|reclaim PID
lush history PID [--after ID] [--limit N]
```

`--json` 为全局标志（放在子命令前），输出机器可读 result。其他情况下 ps/tree 显示表/树，call 显示文本，inspect/history 显示 JSON。spawn 打印 PID。错误写 stderr 并返回非零。

attach 是持续 RPC 对话，不是独占接管锁，也不是历史终态的只读模型对话。进入前验证 running；`/exit`、`/quit`、EOF 退出。不改变 Process 状态。Ctrl-C 退出客户端，不保证取消 daemon 中的调用；需要 `stop/kill` 明确中断。

daemon start 后台用 `process.execPath` 启动 `src/daemon/main.js`（detached，日志 `$LUSH_HOME/daemon.log`）并等待 RPC ready。已启动时幂等。daemon stop 发 system.shutdown 并等待锁释放。根进程不能用 `lush stop 0` 停止。启动参数来自环境：LUSH_HOME、LUSH_PROVIDER=mock|openai、LUSH_API_KEY、LUSH_BASE_URL、LUSH_MODEL、LUSH_CALL_TIMEOUT（默认 120 秒）、LUSH_MAX_ROUNDS（默认 12）。客户端超时为调用超时 + 10 秒，可用 LUSH_RPC_TIMEOUT 覆盖。

实现细节：Bun socket 单次 `write()` 只能接受有限字节，RPC 两端都用 `socket_io.js` 的写队列处理部分写与 drain；`system.shutdown` 的回复在拆连接之前写出，然后才唤醒 daemon 拆除流程。
