# 01 · 从零到 MVP

> 定位讨论、Bun 取代 Nix/Python、骨架与 schema、RPC、CLI/daemon、Agent runtime 与工具、第一次完整演示。

- [x] 理解定位并确认生命周期歧义
- [x] 确认终态父节点的活动直接子节点交 PID 0；保留原父关系和事件
- [x] 确认 Task 显式完成、中断 invocation 不自动重放
- [x] 编写 README、architecture、process-model、rpc 和任务文档
- [x] 用 Bun 取代 Nix / Python：`package.json` + `bunfig.toml`，零第三方依赖，`bun:sqlite` 取代 `sqlite3`
- [x] 最小包骨架、入口（`bin/lush`、`bin/lushd`）、`bun test` 测试环境
- [x] SQLite schema / Repository / 重启恢复
- [x] ProcessManager、生命周期、Template、孤儿收养
- [x] persistence / Process / 收养 / 重开数据库 smoke test
- [x] JSON-RPC server / client；真实 Unix Socket smoke test
- [x] CLI、daemon 锁与启停、交互 attach
- [x] ContextBuilder、Mock / OpenAI-compatible Provider、Agent Runtime
- [x] 内部 Agent Tools 与自主 spawn，不借助 shell
- [x] 35 项测试通过：生命周期、持久化、Context、工具、并发、busy/递归保护、RPC、CLI/attach
- [x] 实际 SIGKILL + 重启验证：调用标记 interrupted，已提交的 spawn 不重放
- [x] 本地 HTTP fixture 验证真实 OpenAI-style 多轮工具请求，不使用真实 API key
- [x] 完整 examples/mvp_demo.js 演示通过，含恢复、孤儿收养和 reclaim 保留历史
- [x] Bun socket 写入是有界的：抽出 `socket_io.js` 处理部分写 + drain，RPC 两端可传 1 MiB 帧
- [x] 用 `AbortController` / `AsyncLocalStorage` 取代 asyncio task / shield / ContextVar
- [x] SIGKILL 遗留锁由 PID 存活检测回收；shutdown 回复先落盘再拆 socket
- [x] 本机 loopback base URL 自动补 `NO_PROXY`，避免代理劫持本地模型
- [x] README、协议、生命周期与已知限制最终核对

