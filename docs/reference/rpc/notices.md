# 待决问题

本节管 notice：`notice.list` / `notice.post` / `notice.answer` / `notice.dismiss`，也就是向用户请求决定的通道。

| CLI | RPC | 参数 |
|---|---|---|
| `notice list` | `notice.list` | `{}` |
| `notice post 'title' --task ID --body 'body'` | `notice.post` | `{task, title, body?: ''}` |
| `notice answer ID 'answer'` | `notice.answer` | `{id, answer}` |
| `notice dismiss ID` | `notice.dismiss` | `{id}` |

notice 向用户请求决定时使用自由文本答复，没有预定义字段表单。notice 是需要用户回复的决策请求；普通结果汇报直接使用 task result。列表优先返回未决项，同组按新到旧排列；最多 200 条并受 RPC 字节预算限制。合并冲突的那条 notice 由 runtime 自己发：它是「要不要开一个解冲突任务」的请示。

`notice.answer` 把答复作为消息送给 owner task 并唤醒它。`notice.dismiss` 在 owner 从未被唤醒过（`agent_wakes=0`，即 runtime 预置的解冲突任务）时会**直接取消该任务**，而不是唤醒 agent 去做用户刚拒绝的事。合并冲突那条 notice 的请示与答复语义见 [合并](merge.md)。
