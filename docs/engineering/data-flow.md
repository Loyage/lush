# 数据流与组件边界

```text
CLI / Web
   │
   ▼
RPC Dispatcher ── identity / parameter / capability checks
   │
   ▼
Project facade
   ├── Intent + Plan services
   ├── deterministic Plan Compiler
   ├── two-lane Dispatcher → provider subprocess
   ├── Run / Artifact store
   ├── Integration service → serialized Git boundary
   ├── Review Candidate service → verifier / final approval
   └── read-model projections → CLI / Web
```

- SQLite 是 Intent、Task/WorkItem、Run、Artifact、Candidate、Decision/Notice 与 Event 的事实来源。
- Git ref/worktree 是代码事实来源；`branches` 保存创建谱系和恢复信息。
- RPC 只做参数、身份与权限校验；业务校验在 Project / Workspaces。
- UI 不直接操作数据库或 Git。
- 模型负责语义理解、实现、验证与冲突解决；Plan 编译、并发准入、状态转换和可安全自动化的中间集成由代码负责。
- Web 的上下文引用仍走同一条输入链：页面选区或语义元素生成 versioned 引用 → `draft.add` / `input.submit` → Project 校验并作为 Input 附件持久化。用户正文不掺入引用标记；planner 每次 invocation 再按稳定 ID 解析当前任务、子树或分支状态，得到“引用快照 + 当前状态 + stale 标志”。
