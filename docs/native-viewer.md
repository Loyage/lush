# 终端观看入口已移除

W358／D731 将 CLI 收敛为管家日常核心与自定义自动化，删除用户专属的 `worker watch`／`worker wait`，不保留兼容别名。Web 不再复制已失效的终端观看命令；原生观看器及专属验证脚本一并移除。

需要持续阅读时，使用 Worker「打开工作台」中的执行记录、搜索与分段原文。Web 阅读器和底层 `worker.transcript*` 读面保持不变，不启动新的 Agent，也不重放历史工具。

单次 CLI 查询仍保留：

```bash
bun run lush worker transcript W195 --project /path/to/project
```

开发 Worker 使用 `lushw self transcript`／`lushw children transcript ID`，受有效 invocation 和直接亲缘约束；不提供轮询等待。

精确入口见[CLI 契约](reference/api.md)，读取与覆盖边界见[执行记录阅读器](engineering/transcript-reader.md)。
