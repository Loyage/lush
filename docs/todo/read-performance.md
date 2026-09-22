# 控制快照与日志读取成本

本条面向 Web 读模型与会话投影维护者，目标是让运行成本不随全部历史数据线性放大。入口为 `src/ui/client.js`、`src/ui/web/assets/refresh.js`、`src/core/project/status.js` 与 `src/core/transcript.js`。

## 状态与优先级

- 优先级：P2。
- 状态：已完成（2026-09-22）。
- 依据：真实 `UIClient.overview()` 有界读接口、持久 revision 短路、两类历史游标页与 JSONL 字节预算/增量缓存均已落地；10k 回归、小/中/大数据测量及强制阈值见本文末尾。

## 快照轮询

兼容的 `UIClient.snapshot()` 与 `/api/snapshot` 继续保留完整历史能力；常规前端走 `UIClient.overview(revision)` / `/api/overview`。它只返回全部活动任务与最近 50 个已结束任务，`revision` 未变化时仅返回 `{unchanged,revision}`，不重复取数或重画。revision 由 SQLite 触发器维护的 `meta.overview_revision` 提供 O(1) 持久游标，再叠加运行中 agent 与并发配置；task layer/status 的精确数量由同一写边界维护在技术表 `overview_task_counts`，首页不再为统计扫历史索引。`system.summary` 走独立 `summary()`，只读持久计数与有界/覆盖索引查询，不调用 `status(false)`，也不打开完整 Agent 配置，设置页才读取 `/api/agent/config`。`task.ladder` 只取至多 50 个 pending 原任务、它们仍有效的 resolver 与直接依赖头，不再读取历史 tasks 全表。

历史任务通过 `task.page` / `/api/tasks?before=` 从最近向前翻页；事件历史通过 `task.history_page` / `/api/task/<id>/history-page` 每页 100 条。任务详情、diff、usage 与 transcript 仍只在点开详情时请求。任务栏与事件时间线都明确写出当前窗口、总量和“尚未加载”，不把局部数据表现为全量。分支图原有“变化后至少 3 秒才重拉、最长 10 秒陈旧”约束保持不变。

## 日志读取上限

`recordsOf()` 以 Buffer 按 64 KiB 分块读取，跨全部 session 文件按实际 UTF-8 字节执行 8 MiB 硬预算；单文件大于预算时也不会越界。缓存键包含文件路径并核对 dev/inode/大小/mtime/ctime，保存已解析完整行、Buffer 尾片，以及至多 4 KiB 的文件头和旧追加边界守卫：文件变长且版本变化时先比对守卫，纯追加只读有界守卫和新后缀，同 inode 上 truncate 后在两次轮询之间快速长回超过旧 offset 也会重建，不会混入旧记录或漏掉新前缀。守卫也计入实际 I/O，替换重建时宁可把可投影窗口缩小这几 KiB，也不突破 8 MiB。未换行尾部（包括被切开的多字节字符）不解析，补齐后只产生一次记录。`readUsage()` 对文件签名未变化的轮询直接复用聚合结果。

## 验收标准

- [x] 建立小、中、大历史任务数据集，记录快照大小、请求耗时与渲染成本。
- [x] 首页常规轮询不再读取全部历史任务。
- [x] 大日志请求的实际读取字节数受预算约束，包括单文件超过预算的情况。
- [x] 增量读取与全量解析结果一致，追加或截断后无重复和遗漏。
- [x] 日志读取期间其它 RPC 仍保持可接受响应，阈值在测量后确定。
- [x] 截断和分页状态在 UI 中明确显示，不把局部数据表现为全部历史。

## 测量与证据

复验命令：`bun run measure:read-performance`。脚本使用临时项目，历史任务为 20 / 1,000 / 10,000 条，通过真实 `Project` + RPC `Dispatcher` + `UIClient.overview()` / `snapshot()` 路径（不再伪造空 ladder），并用真实 `renderTree()` 的 DOM stub 断言“列表已截断”和“加载更早”控件；日志为约 64 KiB / 2 MiB / 12 MiB。任何耗时、读取预算或 UI 有界性阈值失败都会设置非零退出码。2026-09-22 在 Bun 1.4.2、darwin/arm64 的一次结果：

| 数据集 | 有界首页 JSON | 兼容全量 JSON | 首页读 | 首页渲染 |
|---|---:|---:|---:|---:|
| 20 tasks | 16,554 B | 58,282 B | 10.180 ms | 0.880 ms |
| 1,000 tasks | 35,941 B | 473,597 B | 6.266 ms | 6.119 ms |
| 10,000 tasks | 36,086 B | 4,244,640 B | 17.158 ms | 1.375 ms |

| 日志 | 文件大小 | 冷读 | 未变化热读 | 实际读取 | timer 延迟 |
|---|---:|---:|---:|---:|---:|
| 小 | 68,102 B | 1.114 ms | 0.413 ms | 68,102 B | 1.229 ms |
| 中 | 2,099,144 B | 3.322 ms | 0.056 ms | 2,099,144 B | 3.337 ms |
| 大 | 12,586,852 B | 15.838 ms | 0.110 ms | **8,388,608 B** | 15.861 ms |

阈值据此留出环境抖动余量：有界首页读取 ≤100 ms、首页渲染 ≤50 ms、8 MiB 冷日志读取 ≤100 ms、未变化 usage ≤10 ms；以零延迟 timer 模拟同线程其它 RPC 的最坏排队，允许 ≤150 ms。当前大日志排队 15.861 ms。回归覆盖在 `test/transcript.test.js`（单超大文件预算、UTF-8 半字符/半行、纯追加、同路径 truncate 快速长回、替换后 usage 聚合与热缓存）和 `test/web/read-models.test.js`（10k 真实 overview、设置配置隔离、兼容 snapshot、UI 截断标记、任务与事件分页）。

[返回待办索引](README.md)
