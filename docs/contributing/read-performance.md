# 本地读取性能报告

本文面向维护者，说明 `scripts/measure-read-performance.js` 的本地采样与报告契约。它不启动 daemon、不调用模型、不读用户项目会话；全部数据来自临时 SQLite / 日志 fixture。不是生产 SLA、真实 socket RPC 或浏览器性能验收。

## 运行与保存

```bash
bun run measure:read-performance
bun run measure:read-performance --samples 10 --output /tmp/lush-read-report.json
bun run measure:read-performance --help
```

- 默认 **5** 次采样；`--samples N` 接受 1～50 的整数。`--samples 1` 可作快速诊断，但没有重复采样证据。
- 每次采样完整测量 20 / 1,000 / 10,000 Worker，以及 64 KiB / 2 MiB / 12 MiB 的合成日志（实际文件按整条记录取整）。每个数据集重建独立 fixture，完成或失败后关闭数据库并删除目录。
- 采样在同一个 Bun 进程中串行执行；后续采样可能受 JIT、系统缓存、后台负载影响。日志的 cold / warm 仅指该 fixture 的首次 / 重复 `readUsage`，**不是清空操作系统缓存后的磁盘冷读**。
- stdout 是一个完整 UTF-8 JSON 报告，日志诊断写 stderr。`--output PATH` 额外保存完全相同的 JSON；相对路径按当前目录解析，父目录必须存在。文件独占新建，已有文件拒绝覆盖；需保留每次报告或显式选择新文件名。
- 正常完成且所有既有预算通过时退出 0；预算失败仍输出 / 保存带 `ok:false` 的完整报告并退出 1。参数、测量或输出 I/O 错误写 stderr 并退出 1，不伪造完整报告。`--help` 不执行测量。

## 报告 version 1

| 字段 | 含义 |
|---|---|
| `started_at` / `finished_at` | 包含身份采集及测量的 UTC 时间区间；不包含报告写盘耗时 |
| `environment` | Bun、platform / arch、OS type / release / version，以及脚本所在代码检出的 Git version / HEAD commit / dirty；不是调用者选定项目的提交 |
| `environment.warnings` | Git 不可用、不是 Git 检出等身份读取失败；对应字段为 null，不冒充干净或已知提交 |
| `measurement_scope` | 同进程 dispatcher 投影、DOM stub 渲染、同进程事件循环延迟的分层说明 |
| `sampling` | 样本数、nearest-rank 分位数方法、fixture / 缓存边界和摘要字段语义 |
| `task_sets` / `log_sets` | 保留原数据集 / 标量字段；所有 `*_ms` 标量现在是中位数，非耗时字段取首个样本（原样本可逐项核对） |
| 每个数据集的 `statistics` | 对每个耗时字段返回 `{count,min,median,p95,max}`；保留未四舍五入的毫秒值 |
| `samples` | 全部原始样本：`{sample,task_sets,log_sets}`，sample 从 1 开始；包含每次耗时、字节、分页与截断事实 |
| `thresholds_ms` / `ok` / `violations` | 原有阈值、逐样本核验结果及带样本编号的失败原因 |

中位数：奇数样本取中间值，偶数样本取中间两值平均。p95：升序排序后取第 `ceil(0.95 * count)` 项（从 1 计数）。少于 20 次时 p95 通常等于最大值，不据此声称稳定的尾延迟。

Git 身份只读、固定为脚本代码目录，清除继承的 `GIT_*`、禁用全局 / 系统配置与 fsmonitor 程序。报告不含用户名、主机名、用户会话正文、凭证或完整 Git status 输出。需要比较干净提交时，先提交改动并选择不在检出内的输出路径；`dirty:true` 明确说明提交不能完整代表所测代码。

## 既有预算保持不变

**每个原始样本都检查**，不以中位数 / p95 隐藏单次超限：

- 各 Worker 数据集 overview ≤ 100ms，stub render ≤ 50ms。
- 大日志 cold ≤ 100ms，warm ≤ 10ms，事件循环 timer delay ≤ 150ms。
- 大日志读取 ≤ 8 MiB；公开分页 limit 必须为 1～200，shown 与 limit 一致，大于窗口时保留截断、继续读取和 UI 分页提示。

`other_rpc_timer_delay` 是保留的旧阈值名，实际是同进程事件循环 timer delay，不是竞争 socket RPC 的延迟。旧预算仍影响该本地命令的退出码；本改进不增加新的耗时阈值、CI 作业或报告上传门禁，也不删除 / 放宽已有阈值。

## 比较与限制

比较两份报告时，先确认代码提交与 dirty、OS / Bun / Git、样本数、数据规模和 measurement scope，再看中位数、p95 / 最大值以及原样本。不在不同机器之间把单次差异直接判为生产退化。

现有 `legacy_ms` 是 snapshot alias 的同进程读取，不是旧版本基线；stub 没有 CSS 布局 / 真实帧率，timer delay 没有并发 socket 客户端。真实 RPC / 浏览器、10 万行历史、内存分配和跨平台生产延迟仍需独立测量。自动归档 / CI / 新门禁不在本报告范围，不用本报告冒充已完成。

[返回贡献指南](README.md)
