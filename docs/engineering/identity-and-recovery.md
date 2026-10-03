# 项目身份与恢复

本文件管项目身份（路径、manifest、锁与 socket）以及启动 / 退出 / 重启恢复。

项目路径 canonicalize 后决定 `.lush` 和 socket。manifest 与数据库双重校验路径，拒绝跨项目复用。daemon.lock 按项目持有；socket 位于 uid 私有临时目录，权限 0600，目录 0700。

daemon 启动捕获全部运行源码 fingerprint；status 显示 project、home、socket、code_dir、fingerprint。start 遇到已运行 daemon 只报告，不换版本。

正常退出停止接收 RPC，取消正在执行的Worker、终止 agent 进程组、等待调用和 Git 队列结束，再关闭数据库和释放锁。queued / waiting / awaiting / paused 持久保留（paused 重启后仍停在暂停，不自动恢复）。重启发现 running 时记失败并取消其活动后代，不重放可能已有副作用的工作，并回收中断的检验对照检出；留待用户检查。用户仍须检查中断现场后再显式重试。

## agent 父死亡监护与 Run 记账

`src/agent/provider.js` 以 detached 进程组启动内部 `bin/lush-agent-guard`，daemon 持有其 stdin 管道；guard 在同组运行真实 pi/codex 并转发 stdout、stderr 与退出码。daemon 任意退出（含 SIGKILL）导致 stdin EOF 后，guard 终止自己的进程组；正常取消 / 收尾仍由 provider 的 abort / finally 清理。该机制用于 macOS/Linux，只清理本次启动的进程组，不按历史 PID 或进程名杀进程，也不保证清理自行脱离该组的外部进程。回归入口为 `test/agent/guard.test.js`。

`scheduling.invoke()` 在同一 SQLite 事务内建立 Run 并更新 Worker 的 running / 调用计数。`lifecycle.recover()` 事务性清除凭证、将所有遗留 running Run 标为 failed，并结算中断的新式 Worker；已完成 Run 与历史 Artifact 不重写。Run 的 `ended_at` 是恢复观察时间，不是实际子进程退出时刻，`invocation.recovered` 记录 `{observed_at,actual_exit_at:null}`。回归入口为 `test/project/recovery.test.js`。

不提供 exactly-once 文件副作用保证。SQLite 事务只能保护 Lush 记录，不能把任意模型工具与 Git 操作一起纳入事务。
