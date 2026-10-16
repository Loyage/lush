# 当前项目维护暂停（W173／用户决定 #422）

本章规定持久“全部中断／全部继续”的当前契约：仅恢复本次暂停影响的工作，保留原父子等待关系，不以请求接受冒充实际停止。

## 行为

- 仅当前 canonical 项目，daemon 保存权威状态，Host 只路由；不影响其他项目、设备策略或自动合并授权，不自动重启。
- 全部中断先持久关闭新 Agent 调用准入，再发送安全暂停信号；Pi 安全点收尾，无安全点后端自然返回，不强杀工具。重启后维护门仍有效。
- queued／waiting／awaiting／待验收关系保留，消息与输入仍接收；所有 Agent（包括管理、源侧修复）受门控制。未开始自动写动作等待，已开始 Git／Hook 安全收尾，正常在途工具不被全局写门拒绝。未知副作用不重放。
- 全部继续仅恢复本次影响的调用及既有 queued／新增待执行工作，再过原准入门；不批量开始原个人暂停／待开始／失败／终态／待验收工作，不覆盖运行设置。重复幂等，未认领可撤销，认领后等真实退出，不重叠 invocation。
- 父等待子交付关系不改，成功通知聚合／失败和显式消息仍按原唤醒规则；不无差别唤醒静息父，也不禁止被中断父继续自己的工作。冻结、依赖、同步及待决门保持。
- 崩溃、硬停止及调用超时仍保留失败现场和用户检查／重试，不以维护模式恢复未知调用。

## 中断完成提醒（W216／D508）

固定 `batch_id`、`completion_state`、`completion_notice_id` 与动态 `ready_to_restart` 分开。真实调用退出才发纯告知，项目再等所有屏障；全局手动中断只汇总确认的来源批次，不自动重启／继续。协议与容量／未知边界见[中断完成](interrupt-completion.md)。

## 接口

用户专属无参数 `system.interrupt_all`／`system.resume_all` 转发 `Project.interruptAll()`／`resumeAll()`，返回 `maintenanceView()`。Web 固定项目 `POST /api/action` 复用认证、Origin、JSON 与白名单；普通／管理 Agent 不可直调，不提供通用跨项目 RPC。

summary／status 同源提供 maintenance 并纳入 revision：

```js
{
  version: 1,
  paused: true,
  phase: 'pausing', // running | pausing | paused
  ready_to_restart: false,
  active_calls: 2,
  pending_operations: 1,
  affected_count: 2,
  blockers: ['等待当前调用安全退出']
}
```

远端 Runner 的未释放 Run、未知／未准备完成工作区、未结算执行／对象／父同步／回收收据，以及中央停止请求，均计入动态屏障；没有本地 running Map 项不代表远端已退出。维护期间没有本地 invocation 的孤立租约会请求受控停止，无法确认则仍不允许安全重启。普通远端调用继续等待既有安全边界；每 Worker 的中断完成信号也要求其远端收据已结算。daemon 恢复只撤销旧 Run 准入并保留未知，不重放工具或模型；显式重试先核验停止、原安装／代次和已接收 HEAD，未知操作收据不能以“进程已空”代替精确对账。

paused 是维护门而非所有 Worker 状态；affected_count 不含原个人暂停。pending_operations 为非负在途计数、不等同精确独立作业数。ready_to_restart 必须核验真实 running Map／模型请求、Git 排队／busy、写门及交付／Hook／同步／验收屏障；不是 paused 或 UI 推断。restart 入口仍原子重检。原因有界固定，不含秘密或原始错误，编号只用明确 worker_number。

## 界面

项目概览提供中断／继续，不放在共享横幅。中断应用内确认安全点与持久门，继续带 agent-call／agentHelp；禁用由 help-host 解释。缺字段／离线不伪造未暂停或就绪。成功只表示请求接受，ACK 与刷新失败分开、不重发 mutation。

全局项目管理底部由 `service-restart.js` 提供主入口「一键安全重启」，原「全部中断」「全部重启」「全部继续」收进「手动维护」展开区；项目行重启与独立界面重启保持。手动中断／继续先只读重核并确认固定名称／路径范围，逐项请求，不涉及 Host 自身服务，不自动串联后续步骤。各入口共享同一前台单飞，离页不继续后续写入。

### 一键安全重启（W249／D579）

此流程仅由仍打开的浏览器页面驱动，复用现有项目维护、后台重启和 Host 重启接口；不得新增跨项目调度、持久执行授权或在登录后重放写操作。

- 先只读重核 Host 能力与已登记在线项目，确认固定项目 ID／路径和原有维护暂停状态；后来上线的项目不加入，离线和未登记项目不启动。确认与按钮均标识 Agent 代价。
- 自动提交固定范围的安全中断，保存来源批次；单飞只读等待最多 15 分钟。每个来源必须仍在线、身份与批次相符、维护门关闭、完成证据有效且动态可重启。ACK 不能代替真实安全退出或新鲜就绪观测。
- 按固定范围逐个重启后台，真正停止仍由 daemon 的 `system.stop_if_idle` 原子重核安全屏障。所有后台重启成功后，才继续本次从非维护暂停转为暂停的项目；原有项目级维护暂停保持，不批量启动原个人暂停／待开始／失败 Worker。
- 继续阶段完成后最后重启当前界面服务；可能需要重新登录，但不需要再次点击全部继续。界面重启前项目可能已经恢复 Agent 调用，继续 ACK 不代表立即运行。
- 各关键阶段核对来源与固定批次。等待超时、不可达、身份／批次变化、未知或畸形证据、写入失败或结果未知时，立即停止后续步骤，报告各阶段已完成、失败／未确认和未执行范围；不得自动重试、强杀、回滚或继续已暂停项目。已经成功的写操作保留。现有无参数维护接口不提供批次条件原子写入，阶段核对不能锁住其它页面或 CLI 的并发维护操作；执行期间不要从其它入口同时中断／继续。
- 确认期间、等待期间离页或页面关闭后停止后续写入；已发出的请求仍可能生效，不能承诺撤销。流程不跨刷新恢复，用户应依报告核对现场，再用手动维护入口处理。

### W183 固定父基线兼容验证

历史源侧适配与测试结果保留在 Git／Worker 记录中；当前界面契约见上一节，不维护已失效的临时日志路径。

## 并行分区

长期入口见[Runtime](modules-runtime.md)、[Web](modules-web.md)、[接口](modules-interfaces.md)。实际派工文件范围通过 Worker 目标／消息约定，不要求每次修改同步模块清单。

## 验证要求

覆盖运行／排队／个人暂停／待开始／待验收、多级父子等待、撤销与真实退出、消息／失败唤醒、自动化／管理／修复、重启持久门／未知、运行设置保持、在途 Git／Hook 就绪、权限／参数／项目身份及 UI 失败／费用／缺字段。临时项目／设备根和可控 provider，不操作用户服务或真实模型。

## 实现与验证入口

- `src/core/project/maintenance.js` 保存门与参与者，调度在真实 provider 启动前复核；`system.stop_if_idle` 与同源动态就绪门一致。
- Runtime 专项：`test/project/project-maintenance.test.js`；授权／HTTP：`test/project-maintenance-api.test.js`、`test/web/project-maintenance-api.test.js`；交互：`test/web/dom-project-maintenance.test.js`。
- `test/web/project-maintenance-runtime-integration.test.js` 覆盖真实 HTTP／RPC／SQLite／Git 与受控 provider；`test/integration/project-maintenance.test.js`、`global-maintenance.test.js` 覆盖临时真实进程替换、持久门、来源隔离与显式继续。退出回收临时服务，不将 mock／DOM 当真实模型或浏览器验收。

### 项目概览内入口调整

当前入口仅概览；返回复用控件并保持单飞／焦点。确认期间离页不发送，已发送请求仍正确释放锁。

### W173 固定父基线兼容验证

历史合入、修复和通过数见 Git／Worker 交付记录；验证责任以[分层测试与交付](../contributing/README.md#分层测试与交付)为准，旧树结果不能证明当前代码树。
