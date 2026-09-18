# 开发日志

> 历史层：每一轮工作做了什么、跑了哪些验收。**按时间追加，不改旧条目**（旧结论被后来的改动推翻时，在新条目里写清）；当前该做什么看 `## TODO`。

## TODO

MVP 范围内无未完成项。后续方向（本轮不实现）：Context compression/paging、外部工作工具、调度和权限。

## Doing

无。

## Done（按阶段）

- [01 · 从零到 MVP](./01-mvp-bootstrap.md)
- [02 · CLI 分层与 agent 后端](./02-cli-layout-and-agent-backends.md)
- [03 · 变量、硬删除与 dev-task](./03-variables-removal-and-dev-task.md)
- [04 · 孤儿监督与模板演化](./04-orphan-supervision-and-templates.md)
- [05 · 服务类型收敛与 task 层](./05-service-kinds-and-task-layer.md)
- [06 · 分层布局、文档重组与测试瘦身](./06-layered-layout-docs-and-tests.md)
- [07 · Web UI 的 Task 树视图](./07-web-ui-task-tree.md)
- [08 · 每个节点的三个查看接口与 description 重写](./08-service-view-and-descriptions.md)
- [09 · Notice：task 向用户汇报并等待答复的渠道](./09-agent-notices.md)

## 验收命令


```bash
bun test
```

验证环境为 macOS / Bun 1.4.2。OpenAI-compatible Provider 以本地 HTTP fixture 验证请求格式、Authorization、tool calls、tool results 和错误处理；pi 后端以本地假 pi 可执行文件 + 本地 HTTP fixture 验证命令行参数、会话目录、cwd、取消杀服务与错误处理，并用一个模拟 agent 的假 pi 跑通「通过 lush CLI 自建子服务」的端到端流程。未使用真实供应商 API key，也未宣称验证真实模型的推理能力。