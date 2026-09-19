# 界面与传输

本文件管 CLI 分页、Web 轮询与 CSP、RPC 信任边界与 `system.status` 字段。

CLI 的 task list / history 支持 cursor 分页；task inspect 返回完整任务结果和有界的相关记录。Web 复用 UIClient，轮询快照，采用 textContent 呈现模型输出，不插入 HTML；输入表单和 notice 答复在轮询时保留。

Web 只监听 127.0.0.1，校验 Host / Origin / Sec-Fetch-Site，修改操作要求 JSON；HTTP 只能访问显式允许的方法，不能代理任意 RPC。检验报告在 `/api/task/<id>/report` 以独立文档返回，只允许内联样式/脚本与 `data:` 图片（`default-src 'none'`），因此报告里的脚本不能回调本地 API；非 verifier 任务或不存在的报告不会被当文件读出去。RPC 以本机用户为可信边界；agent token 只约束正常的 agent 调用，不是本机攻击者隔离。`system.status` 报告运行中的 agent 列表与 `agents_total` / `agents_idle`（每个活动 task 一个 agent，含已 park 的），`task.inspect` 报告该 agent 的 id、唤醒次数与上次动手时间。

相关：[数据流](data-flow.md)。
