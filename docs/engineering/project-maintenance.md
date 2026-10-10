# 当前项目维护暂停（W173／用户决定 #422）

本章固定“全部中断／全部继续”的实现接缝；验证记录见末节，不以契约替代测试。用户选择持久维护暂停、仅恢复本次暂停影响的工作、恢复原父子等待关系。

## 行为

- 仅当前 canonical 项目，daemon 保存权威状态；Host 只路由。不影响其它项目、设备设置、自动化授权和自动合并开关，不自动重启服务。
- 全部中断先持久关闭新 Agent 调用准入，再向当前调用发送既有安全暂停信号。Pi 在安全点收尾，无安全点后端自然返回，不强杀工具。不把请求接受说成已经停止。
- 暂停状态在后台重启后仍有效。queued、waiting、awaiting 与待验收关系尽量原样保留，不对整棵树无差别改 paused；消息与新指令仍持久接收，但不能启动新调用。
- 所有 Agent（含管理 Agent 和源侧分歧修复）受维护准入门控制；新消息、问卷答复、自动选择、定时／管理／生命周期 Hook 不得突破准入。尚未开始的自动后台写动作等待维护解除；已经开始的 Git／Hook 等操作安全收尾，不撤销精确交付收据、不重放未知副作用。允许当前调用正常收尾所需写操作和消息，不靠全局 assertWritable 拒绝在途工具。
- 原先单独 paused／待开始、failed、cancelled、completed、awaiting_acceptance 的工作不被批量启动或重试。仅恢复本次暂停的调用，queued 工作和暂停期间新增待执行工作重新通过既有调度门；不覆盖已保存运行设置、个人暂停意愿和已终结状态。重复操作幂等；全部继续也可撤销仍未认领的批量暂停，认领后的调用等真实退出再准入，不重叠调用。
- 原本等待子 Worker 的父级保持 waiting；子级交付后按既有成功通知聚合／显式消息／失败通知规则唤醒。父级自身被中断的开发工作可以恢复，不新增“有子级一律禁止运行”约束，不无差别唤醒静息父级。子级冻结／排队／待决、同步和代码依赖仍按既有门禁。
- 维护期间只能阻止未知旧调用的自动重放，不改变崩溃恢复语义。真实崩溃、硬停止、调用超时仍保留失败与用户显式检查／重试流程。

## 接口

用户专属、无参数 RPC：

| RPC | Project | 返回 |
|---|---|---|
| `system.interrupt_all {}` | `interruptAll()` | `maintenanceView()` 安全读面 |
| `system.resume_all {}` | `resumeAll()` | 同上 |

Web 复用当前项目 `POST /api/action`，固定项目 URL 与原认证／Origin／JSON／参数白名单；Agent 和管理 Agent 均不得调用。无需 Host 全局批量入口。

`system.summary` 与 `system.status` 增加 `maintenance`，暂停变更与动态就绪变化纳入概览 revision。投影为：

```js
{
  version: 1,
  paused: true,                 // 项目维护门，非所有 Worker 的 status
  phase: 'pausing',              // running | pausing | paused
  ready_to_restart: false,       // 当前观测；restart 入口仍原子重检
  active_calls: 2,               // 含真实仍未释放调用／在途模型请求
  pending_operations: 1,        // 非负在途后台操作计数，不代表精确独立作业数
  affected_count: 2,             // 本次批量暂停影响的调用，不含原来个人暂停
  blockers: ['等待当前调用安全退出'] // 有界固定安全原因，不含错误原文／秘密
}
```

未暂停 phase 为 running；暂停但还有调用或后台工作为 pausing，真正静息为 paused。ready_to_restart 独立复核真实 running Map、模型请求、Git 排队／busy、项目写门、交付／Hook／同步／验收等在途工作；不是进度、status='paused' 或 UI 推测。只在真正满足原空闲重启门时为 true。阻塞诊断使用固定原因，相关 Worker 若展示编号只使用显式 worker_number。

## 界面

项目概览内提供两个按钮与同源状态说明，不放在所有页面上方的共享横幅，不在全局无项目页面伪装可用。全部中断有一次应用内确认，说明当前项目、子 Worker、安全点和持久维护门；全部继续带 `agent-call` 与 `agentHelp()`。禁用原因由 `.help-host` 承载。请求成功只表示接受，失败保留可重试入口；刷新失败不得自动重发成功 mutation。页面初次加载／离线／旧 daemon 缺少 maintenance 时，不假造未暂停或可重启，明确不可用。现有重启按钮继续原串行服务控制，不被暂停按钮自动触发。

## 并行分区

- Runtime child：`src/core/`、必要 persistence 附属存储、`test/project/project-maintenance.test.js` 及其它 runtime 回归；实现 Project 方法、持久门、安全中断／恢复、自动动作与重启恢复、summary/status/revision，同步维护 `modules-runtime.md`。不改 RPC、Host、CLI、Web assets 或本文。
- Interfaces child：`src/rpc/registry.js`、`src/rpc/handlers/system.js`、`src/ui/web/server.js` 与专属接口测试（`test/project-maintenance-api.test.js`、`test/web/project-maintenance-api.test.js`），维护 `modules-interfaces.md`。不改 core、assets、本文；使用上述稳定方法和投影，不旁路 core 门禁。
- UI child（原并行分工；后续按用户要求将入口移入项目概览）：`src/ui/web/assets/`、`test/web/dom-project-maintenance.test.js` 等 DOM 回归，维护 `modules-web.md`。不改 server/core/rpc 或本文；消费 snapshot 的 status.maintenance（按实际 snapshot 装配定位）、调用上述 action。
- W173：本文、其它设计／工程／使用文档、模块总索引、跨区真实临时 HTTP/RPC/SQLite/Git／可控 provider 联调、全量测试和派生 Worker 检查确认。

## 验证要求

实际覆盖运行／排队／原个人暂停／待开始／待验收、父等待子交付、多级子树、显式消息与失败唤醒、未认领撤销及已认领真实退出屏障、维护期间新指令与自动化、管理 Agent／源侧修复、重启持久门和崩溃未知、重复请求、运行设置保持、Git／Hook 在途就绪、RPC/HTTP 权限／参数／项目身份、UI 费用标识／确认／失败／离线／缺字段。测试使用临时项目与设备根、可控 provider，不重启用户服务、不调用真实模型。

## 实现与验证入口

- `src/core/project/maintenance.js` 保存项目门与本次运行者身份，`scheduling.js` 在调度和异步准备后的真实 provider 开始前复核。暂停期间个人暂停优先，不无差别重启静息父级；已开始 lifecycle Hook 的后续未开始动作以精确附属标记等待，不重放已成功动作或未知副作用。
- `src/rpc/handlers/system.js` 的 `system.stop_if_idle` 保留原检查与报错，并同步复核同源 `maintenanceView().ready_to_restart`。UI 用 `assets/project-maintenance.js` 的概览区域消费该投影，保持请求确认与后续状态刷新分离。
- `test/project/project-maintenance.test.js` 覆盖 Runtime 与真实 Git／Shell Hook；`test/project-maintenance-api.test.js`／`test/web/project-maintenance-api.test.js` 验证授权与固定项目路由；`test/web/dom-project-maintenance.test.js` 验证交互与未知／离线状态。
- `test/web/project-maintenance-runtime-integration.test.js` 使用真实 HTTP／Unix RPC／SQLite／Git 与可控 provider 联调按钮、多级子树、安全暂停后后台重建、运行设置与未读输入只恢复一次；`test/service-restart.test.js` 验证就绪与原子停机门一致。
- `test/integration/project-maintenance.test.js` 使用真正的临时 daemon 与受监督 Host 进程（离线 MockProvider），分别替换后台与 Host PID，验证维护门与 queued 父子工作跨重启保留、原待开始不启动、显式继续才运行，并核对其它项目 PID 不变。测试退出停止临时服务、删除临时项目与设备根。
- W173-2 与 W173-3 接口／UI 已合入并确认；W173-1 Runtime 已合入并确认。父最终完整 `bun run test --timeout 30000` **3073 pass / 0 fail**（396 文件），日志 `/tmp/lush-w173-logs/full-final.log`；维护组合 **75 pass / 0 fail**，日志 `/tmp/lush-w173-logs/integrated-first.log`；真实进程专项 **1 pass / 0 fail**，日志 `/tmp/lush-w173-logs/real-process-first.log`。文档检查通过，仅既有篇幅警告，日志 `/tmp/lush-w173-logs/docs-final.log`。首轮全量同样通过（3072 项），新增进程专项后完整复跑为最终数。
- UI child 的 Firefox 源码／构建版双主题与 1440／390／320px 验证通过，日志 `/tmp/lush-w173-3-logs/repair-*`。未连接真实模型或重启用户服务；安全点行为沿用 Pi 既有原子认领协议，无安全点后端需自然收尾。

### 项目概览内入口调整

- 按 W173 用户追加要求，入口仅放在项目概览标题下方，移除共享页面横幅中的维护区域。切至 Worker 列表或详情不显示；回到概览复用控件，保持单飞请求与键盘焦点；确认期间离开概览不发送请求，已发送请求离页后仍释放单飞状态并只刷新一次。
- 专项 **55 pass / 0 fail**，全量 **3094 pass / 0 fail**（398 文件），日志 `/tmp/lush-w173-logs/overview-targeted-final.log`、`/tmp/lush-w173-logs/overview-full.log`。Firefox 源码／构建版双主题与 1440／390／320px、列表／详情不显示及返回概览验证通过，日志 `/tmp/lush-w173-logs/overview-browser-{source,compiled}-final.log`。只改 UI 与说明，不变更暂停／父子恢复协议，不重启用户服务。

### W173 固定父基线兼容验证

- 交付 15680／尝试 15683：保留源提交 `606b3d18b7147a6522b76e977685687ab84d33db`，从共同祖先 `ff2ea9f2a7d8a10c75216c2f8d3c41ac535236ac` 检查双方提交、含改名增量及已接收的维护 Squash 等价树后，合入固定父提交 `5d025d8c6890585b01f3a478985ee4f7a7aade45`。父侧无模块改名或公共 RPC／数据模型迁移；新消息导航增加 `openNotice(id,{record:true})` 与 `#notices-<id>`，保持来源记录只读、不自动已读。维护入口无需修改该调用接口。
- 保留父侧消息新标签链接、info 蓝色与移除「处理消息」按钮；解决已交付维护文件的重复添加冲突，保留新概览控件／离页单飞逻辑，并移除 Git 无文本冲突却恢复的旧共享横幅。浏览器追加验证消息记录页不显示维护入口、输入保留、导航不产生 mutation，返回概览仍正常操作。
- 本次完整 **3095 pass / 0 fail**（398 文件），日志 `/tmp/lush-w173-logs/repair-15683-full.log`；Firefox 源码／构建版双主题和 1440／390／320px 通过，日志 `/tmp/lush-w173-logs/repair-15683-browser-{source,compiled}.log`；文档检查仅既有篇幅警告。未重启用户服务或调用真实模型。

- 交付 15581／尝试 15584：保留源提交 `64e3f602830d00df7692adb44101fea8c92a09c1`，从共同祖先 `774a1107bd76f004a55bf0cba59f16dfc840ceed` 检查双方提交与含改名增量后，在 W173 工作区合入固定父提交 `ff2ea9f2a7d8a10c75216c2f8d3c41ac535236ac`。父侧变化是全局导航精简、详情吸顶／阅读位置保持和静息文案；没有公共接口、数据模型或模块迁移，也没有文本冲突。
- 保留父侧原生上级工作台链接、隐藏项目内全局导航、正文阅读锚点和静息投影；维护就绪仍只依赖真实调用／操作屏障，不依赖静息文案。补充 DOM 与浏览器断言，确保维护区域不会恢复被移除的全局摘要或破坏上级链接。
- 完整 `bun run test --timeout 30000` **3092 pass / 0 fail**（398 文件），日志 `/tmp/lush-w173-logs/repair-15584-full-final.log`。默认 5 秒上限的首轮有一项 Hook 用例耗时约 5.4 秒，延长上限的专项与完整复跑通过；首轮串行跨文件组合还有 DOM 观察器遗留异常，进程重启专项单独通过，标准隔离全量无该异常。失败日志分别为 `repair-15584-full.log`、`repair-15584-integrated.log`，均在同一日志目录保留。
- 隔离 Firefox 源码／构建版维护控件及父侧详情吸顶／阅读保持检查均通过，覆盖双主题与 1440／390／320px；日志 `/tmp/lush-w173-logs/repair-15584-browser-{source,compiled,detail}.log`。未重启用户服务或连接真实模型。
