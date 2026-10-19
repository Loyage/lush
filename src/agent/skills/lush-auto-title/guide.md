# Lush 自动标题指南

只在本 invocation 的 `auto-title` 能力开启、当前 Worker 的 task_kind 为 order 或 child 且 auto_title 为空时使用。没有独立标题模型调用；复用当前 Agent 对目标的理解。

理解目标和必要上下文后、结束本轮（含提问或派工）之前调用：

```bash
lushw self title '简短标题'
```

标题概括实际工作主题，不照抄输入第一行，不以“已完成”冒充成果。优先使用用户语言，建议 8–24 字，必须为非空单行、最多 60 字符，不包含凭证或敏感资料。

接口只写当前 invocation 所属 Worker 的 auto_title，不接受目标 ID，不改变原始输入、goal、编号、name、分支或执行。首次成功后保持稳定，追加输入、唤醒或目标变化均不重命名；返回 changed:false 表示已有标题，不重试覆盖。

用户 display_title 始终优先。Agent 不得调用用户专属 worker rename；其他 task_kind 不调用 auto-title。不要为了标题另开模型调用或子 Worker。面向用户使用明确给出的 worker_number，没有编号才回退 #内部ID。

关闭只停止后续主动自动命名，不删除已生成标题，也不撤销 API 权限或修改当前调用。全局设置由用户控制。
