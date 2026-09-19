# 数据流

本文件管从入口到 Project 的组件结构与校验归属这条边界。

```text
CLI / Web → UIClient → JSON-RPC / Unix socket → Project
                                                   ├── Store / SQLite
                                                   ├── scheduler → pi subprocess / mock
                                                   └── Workspaces → serialized Git operations
```

所有业务校验在 Project / Workspaces，RPC 只检查参数、身份与命令权限，UI 不直接操作数据库。
