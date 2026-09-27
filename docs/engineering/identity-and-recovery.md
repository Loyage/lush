# 项目身份与恢复

本文件管项目身份（路径、manifest、锁与 socket）以及启动 / 退出 / 重启恢复。

项目路径 canonicalize 后决定 `.lush` 和 socket。manifest 与数据库双重校验路径，拒绝跨项目复用。daemon.lock 按项目持有；socket 位于 uid 私有临时目录，权限 0600，目录 0700。

daemon 启动捕获全部运行源码 fingerprint；status 显示 project、home、socket、code_dir、fingerprint。start 遇到已运行 daemon 只报告，不换版本。

正常退出停止接收 RPC，取消正在执行的任务、终止 agent 进程组、等待调用和 Git 队列结束，再关闭数据库和释放锁。queued / waiting / awaiting 持久保留。重启发现 running 时记失败并取消其活动后代，不重放可能已有副作用的工作，并回收中断的检验对照检出；留待用户检查。SIGKILL 可能留下外部进程，需要用户检查后重试。

不提供 exactly-once 文件副作用保证。SQLite 事务只能保护 Lush 记录，不能把任意模型工具与 Git 操作一起纳入事务。
