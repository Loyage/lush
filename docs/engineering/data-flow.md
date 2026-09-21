# 数据流

本文件管从入口到 Project 的组件结构与校验归属这条边界。

```text
CLI / Web → UIClient → JSON-RPC / Unix socket → Project
                                                   ├── Store / SQLite
                                                   ├── scheduler → pi subprocess / mock
                                                   └── Workspaces → serialized Git operations
```

所有业务校验在 Project / Workspaces，RPC 只检查参数、身份与命令权限，UI 不直接操作数据库。

Web 的“上下文引用”仍走同一条输入链：页面选区或语义元素生成 versioned 引用 → `draft.add` / `input.submit` → Project 校验并把引用作为 Input 附件持久化。用户正文不掺入引用标记。planner 每次 invocation 开始时由 Project 按稳定 ID 解析当前任务、子树、交付分支等状态，并把“引用快照 + 当前状态 + stale 标志”放进 provider context；普通文字引用只有快照。
