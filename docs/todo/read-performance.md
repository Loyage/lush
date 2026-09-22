# 控制快照与日志读取成本

本条面向 Web 读模型与会话投影维护者，目标是让运行成本不随全部历史数据线性放大。入口为 `src/ui/client.js`、`src/ui/web/assets/refresh.js`、`src/core/project/status.js` 与 `src/core/transcript.js`。

## 状态与优先级

- 优先级：P2。
- 状态：已完成（2026-09-22）。
- 依据：有界首页读接口、revision 短路、两类历史游标页与 JSONL 字节预算/增量缓存均已落地；小/中/大数据测量及阈值见本文末尾。

## 快照轮询

兼容的 `UIClient.snapshot()` 与 `/api/snapshot` 继续保留完整历史能力；常规前端已改走 `UIClient.overview(revision)` / `/api/overview`。它只返回全部活动任务与最近 50 个已结束任务，`revision` 未变化时仅返回 `{unchanged,revision}`，不重复取数或重画。`system.summary` 不携带完整 Agent 配置，设置页打开时才读取 `/api/agent/config`。

历史任务通过 `task.page` / `/api/tasks?before=` 从最近向前翻页；事件历史通过 `task.history_page` / `/api/task/<id>/history-page` 每页 100 条。任务详情、diff、usage 与 transcript 仍只在点开详情时请求。任务栏与事件时间线都明确写出当前窗口、总量和“尚未加载”，不把局部数据表现为全量。分支图原有“变化后至少 3 秒才重拉、最长 10 秒陈旧”约束保持不变。

## 日志读取上限

`recordsOf()` 现在以 Buffer 按 64 KiB 分块读取，跨全部 session 文件按实际 UTF-8 字节执行 8 MiB 逻辑窗口；单文件大于预算时也只读取 8 MiB。缓存键包含文件路径并核对 dev/inode/大小/mtime/ctime，保存已解析完整行与 Buffer 尾片：追加只读新后缀，截断、替换或同尺寸改写会重建。未换行尾部（包括被切开的多字节字符）不解析，补齐后只产生一次记录。`readUsage()` 对文件签名未变化的轮询直接复用聚合结果；读取不再调用同步整文件 `readFileSync()`，最大单次连续块为 64 KiB。

## 验收标准

- [x] 建立小、中、大历史任务数据集，记录快照大小、请求耗时与渲染成本。
- [x] 首页常规轮询不再读取全部历史任务。
- [x] 大日志请求的实际读取字节数受预算约束，包括单文件超过预算的情况。
- [x] 增量读取与全量解析结果一致，追加或截断后无重复和遗漏。
- [x] 日志读取期间其它 RPC 仍保持可接受响应，阈值在测量后确定。
- [x] 截断和分页状态在 UI 中明确显示，不把局部数据表现为全部历史。

## 测量与证据

复验命令：`bun run measure:read-performance`。脚本使用临时项目，历史任务为 20 / 1,000 / 10,000 条；日志为约 64 KiB / 2 MiB / 12 MiB，并用真实 `renderTree()` 的 DOM stub 计渲染成本。2026-09-22 在 Bun 1.4.2、darwin/arm64 的一次结果：

| 数据集 | 有界首页 JSON | 兼容全量 JSON | 首页读 | 首页渲染 |
|---|---:|---:|---:|---:|
| 20 tasks | 16,419 B | 57,777 B | 3.219 ms | 28.941 ms |
| 1,000 tasks | 35,806 B | 473,092 B | 5.038 ms | 1.908 ms |
| 10,000 tasks | 35,951 B | 4,244,135 B | 26.229 ms | 2.883 ms |

| 日志 | 文件大小 | 冷读 | 未变化热读 | 实际读取 | timer 延迟 |
|---|---:|---:|---:|---:|---:|
| 小 | 68,102 B | 3.781 ms | 0.081 ms | 68,102 B | 3.903 ms |
| 中 | 2,099,144 B | 9.310 ms | 0.055 ms | 2,099,144 B | 9.330 ms |
| 大 | 12,586,852 B | 15.042 ms | 0.115 ms | **8,388,608 B** | 15.067 ms |

阈值据此留出环境抖动余量：有界首页读取 ≤100 ms、首页渲染 ≤50 ms、8 MiB 冷日志读取 ≤100 ms、未变化 usage ≤10 ms；以零延迟 timer 模拟同线程其它 RPC 的最坏排队，允许 ≤150 ms。当前大日志排队 15.067 ms。回归覆盖在 `test/transcript.test.js`（单超大文件预算、UTF-8 半字符/半行、追加、截断、增量与全量一致、聚合热缓存）和 `test/web/read-models.test.js`（兼容 snapshot、有界 overview/revision、任务与事件分页）。

[返回待办索引](README.md)
