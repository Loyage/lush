# 中断完成信号与批次就绪

本章固定中断 Hook、项目完成证据和全局提醒的安全边界。原暂停／恢复行为见[项目维护暂停](project-maintenance.md)，用户入口见[Hooks](../hooks.md)。

## 两层事实

- `worker.interrupted`（中断完成信号）：用户中断本次 invocation 已生效且调用真实退出。请求接受、输入抢占、撤销／继续、异常或崩溃均不算完成；单 Worker 完成不代表项目可重启。
- `project.interrupted`（项目中断完成）：当前维护批次精确确认安全收尾，并通过真实调用、模型请求、Git、Hook、交付及资源回收等原空闲屏障。挂在 main／owner，不创建全局调度身份。
- 两个新节点只允许一次性或持续 `notify`；维护期间可执行纯 `info` 告知，不放行 Agent、消息或命令，普通 Hook 仍受维护门控制。

“全部中断”先同事务固定批次／调用身份并安装绑定本次调用的一次性告知，再关闭维护准入、请求暂停。重复请求复用批次，信号按精确来源去重；成功一次性挂载自动移除，告知和审计保留。容量不足必须原子拒绝，不关闭维护门或发出半批暂停请求，不静默漏通知。

## 公开证据与恢复

`system.interrupt_all`、`system.summary`、`system.status` 的同源 `maintenance` 增加：

| 字段 | 含义 |
|---|---|
| `batch_id` | 当前批次 UUID 或 null，不能以 Worker／Notice 整数代替 |
| `completion_state` | `pending`、`completed`、`cancelled`、`unknown` 或 null |
| `completion_notice_id` | 已确认完成的来源 info Notice 整数 ID，或 null |

项目完成 Notice 关联 main，完成证据持久保存。原 `paused`、`phase`、`ready_to_restart` 等字段保留；批次完成与动态就绪分离，新操作可能使旧通知不再代表当前可重启，重启入口必须原子重核安全门。旧状态无批次时返回 null，不回填假成功证据。

继续／撤销使批次 cancelled，不能让旧结果匹配新批次；失败、取消或崩溃未知现场不发成功告知。未确认的 pending 批次重启后为 unknown，不自动重放未知副作用。读取投影无执行或写入副作用。

## 全局提醒

Host `/api/host/projects` 的 `summary.maintenance` 只白名单投影 `paused`、`phase`、`ready_to_restart` 及三个新字段，保留兼容 `maintenance_paused`；缺失／畸形字段不提供完成证据，旧 daemon 仍可显示在线。Host 不保存 Worker 权威事实，不启动离线后台。

浏览器确认固定登记在线范围、逐项提交并保存批次 ACK，随后单飞有界只读观察（请求 10 秒、间隔 2 秒、总计最多 15 分钟）。全部就绪要求每个固定项目在线、路径身份匹配、`paused=true`、批次与 ACK 一致、`completion_state=completed`、告知 ID 合法且动态 `ready_to_restart=true`；不纳入后来上线项目，也不以 ACK 代替新鲜观测。

部分失败／超时、移除、不可达、旧后台、批次变化／撤销或 unknown 不报全部完成，不自动重发写操作。离页停止观察，代次保护忽略旧响应；就绪后继续观察以撤下再次忙碌的提醒。提醒遵守页面告知偏好，不自动重启／继续；关闭页面不承诺推送，来源 Notice 留存。
