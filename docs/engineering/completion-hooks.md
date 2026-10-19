# 合并—验收自动链（验收即归档）

W169／用户决定 #418 统一验收与归档，当前权威边界见[统一验收](worker-acceptance.md)。验收表示对 Worker 工作不再有异议，授权回收 worktree/ref 并保留完整运行历史；脏现场阻止验收。它不是业务质量评审或彻底删除 Worker。

W269／D619 将新指令结束流程默认值改为项目独立策略，只有实际创建的新指令复制授权。旧设备配置留存但不参与新建；自动选择仍为设备唯一策略。不改变项目绑定、Host 职责或 child 权限，精确设置字段见[项目自动化接口](../reference/rpc/hooks.md#新指令默认流程)。

## 级别与授权

- 新配置展示 `off | merge | accept`，高档包含前面的环节。`accept` 包含安全资源回收，没有独立待归档的成功环节。
- 旧存储及 API 的 `archive` 等价于 `accept`，读面规范化，不机械改写旧记录或收据。用户决定 #418 明确允许旧自动验收授权直接采用新语义，包括已有 Worker 和设备默认值。
- 自动验收只复用既有安全检查，代替用户确认，不调用质量评审 Agent，也不保证业务质量。
- child 的流程 Hook 整体对用户只读，默认锁定自动合并，由直接父 Agent 检查成果并保留供追加需求，尽量随父级安全批量验收；不从父级继承验收授权。用户指令即使挂在另一 Worker 下，仍可配置自己的结束流程。
- 请求冻结／挂起、同步、自动动作执行中或结果未知时不能修改当前链；允许的显式提高只补办后续步骤，不重做已完成交付。Agent 不可设置级别。

## 串行与失败保护

1. `worker.delivery_ready`：通过统一 `request_merge` 工具在安全点请求合并，沿用父队列、冻结、源侧固定基线修复和 Git gate。目标 `integrate_deliveries` 在固定事务选定普通串行／归并策略；无代码改动经过交付核验后跳过空 Squash。
2. `delivery.integrated`：至少 accept 的授权执行统一 `acceptTask`，核验实际退出、后代、消息（含暂存输入）、待决、同步、共享使用者、分支提交和清洁度；可按[父级批量验收](worker-acceptance.md)纳入已交付的派生 child，不连带验收独立指令；受检回收成功后才记录本次各 Worker 的 `task.accepted` 并触发 `worker.accepted`。

自动验收通过同一系统工具分发接入 `accept_worker`；操作身份与安全读面见[工具契约](hooks.md#系统工具与持久操作)。先持久提交，临时调用／输入／待决／后代／冻结／脏现场等删除前阻塞保留 waiting，解除后在安全点重新核验同一操作，不制造新的授权或删除成功事实。只有完整预检通过才领取资源回收；开始副作用后的失败／unknown 仍禁止自动重放。手动验收仍即时返回原准入错误，不变成隐式排队。

资源回收沿用分支子树范围，不启用 discard_worktree，不删除仍使用的检出或 canonical 资源。预检新输入可以中止验收，真正删除期间新请求须明确拒绝且保留客户端输入以便重试，不能吞掉已持久的消息。

删除部分失败时逐资源落事实并保留诊断、未完成范围和可显式续办的入口。已落地的代码不撤销；部分回收不等于成功验收。失败／unknown 不自动重试，重启只有精确成功凭据可收口，不能仅凭目录不存在推断成功。旧验收事实不改写，旧已验收未回收的明确授权可受检补办；旧失败/unknown 收据继续阻止自动重放。

级别跨轮保存，执行授权和轮次独立；追加输入、新一轮开发不复用旧成功或失败收据。暂存输入不阻止其追加前已固定的合并收口，但阻止验收和删除。详见[消息准入](../reference/rpc/tasks.md#追加消息的准入与失败处理)。

## 持久化与安全读面

复用 `tasks.auto_merge` 的 version 1 附属 JSON 和事件，不新增核心实体。旧 enabled:true 且无 level 仍读为 merge，false/缺失为 off；child 不从父复制级别。普通 RPC 读面去除私有字符串 auto_merge/hooks 和完整 profile，保留安全对象。

`autoCompletionView(task)` 返回同源 `completion`：

```js
{
  level: 'accept', // off | merge | accept；旧 archive 规范化
  min_level: 'off', // child 为 merge
  locked: false, editable: true, reason: null,
  phase: 'accept', // merge | accept | null；last_execution.phase 可保留历史 archive
  state: 'waiting', // idle | waiting | running | succeeded | failed | unknown
  last_execution: null // 或安全 id/phase/status/created_at/finished_at/error 摘要
}
```

inspect、graph、worker.hooks 同源。内置挂载为不可移除的 `auto-merge` 与 `auto-accept`，统一最高环节授权；child 的两项 locked:true、editable:false。旧 auto-archive 及 archive_worker 仅作历史兼容，不向新界面提供独立归档开关。accept_worker 为 builtin_only，不能自定义安装；旧 archive_worker 也不能作为绕过安全门的自定义动作。

## RPC／CLI／项目默认

- `worker.completion {id,level,expected_revision}` → `setTaskCompletion`，用户专属、严格参数白名单、worker.hooks 的不透明 revision。
- 项目「成果自动合并与验收」只管理未来用户新建 Worker 的项目默认，不列出现有 Worker 授权或运行记录。具体授权及真实操作在对应 Worker 自动化查看；父目录保留功能节点和草稿，迟到响应不能覆盖失活页面或新项目，未知保存结果不得自动重发。
- `worker.completion_page {before?,limit?}` / `GET /api/automation/completion/workers` 为用户专属窄只读目录：默认 25、最多 50 个，按 Worker 内部 ID 倒序，游标严格小于 `before`；涵盖 work 层所有状态的 order（含旧 say）／child，不受常规 Worker 活动预览或终态分页范围限制。返回 `{version:1,workers,cursor,has_more,limit}`，每项只含编号、标题／有界目标、种类、状态、集成、归档布尔、预约状态及同源 `hooks:{worker_id,revision,mounted_features,completion,mounts}`；mounts 仅自动合并／验收的 id、动作类型与安全 operation。无私有配置、路径、原始输出或授权身份，读取不安装、不推进动作。
- 上述窄目录 API 继续只读兼容，但项目设置页不再消费它。Worker 内的操作快照只认同源 operation，不从级别高亮、last_execution 或 Agent 返回推断成功；读取失败及证据不兼容必须说明，历史协议不迁移。
- CLI 仅接受 `worker automation completion ID off|merge|accept --revision REV`；旧 archive 仅在后端 RPC／持久历史兼容等价 accept，CLI 已拒绝，不放宽权限、冻结或 stale revision。
- `worker.auto_merge` 和 auto-merge 挂载旧开关继续相同权限；on 不降级高级授权，off（允许时）关闭未来链，不撤回已发请求。
- 项目 `completion_defaults:{enabled,level}` 与 `mount_scopes.completion` 用 hooks.automation_settings 保存，旧 hooks.completion_defaults 同源兼容；实际创建事务冻结挂载，未挂载默认不执行，旧缺少挂载字段保留原内置能力，显式开启通过原安全门同时挂载。完整范围与权威投影见[项目自动化接口](../reference/rpc/hooks.md#新指令默认流程)；设备默认写入拒绝。默认只影响未来实际创建的新指令，不改变已有 Worker 或 child 流程；持久化于项目 meta 的 versioned JSON，旧设备及旧项目历史值均不自动导入。
- 选择验收授权须解释删除分支子树 worktree/ref、完整历史保留、脏现场阻止、自动验收不是质量评审；可能启动分歧 Agent 的配置按钮仍带 Agent 代价标识。

## 告知

- 待验收告知是独立功能。用户新建 order 默认开启、child 默认关闭，可在对应 Worker 独立改开关；不改变合并／验收授权。项目默认只复制给以后新建的用户指令。
- 只在真实进入 awaiting_acceptance 的安全交付边缘生成；单纯 waiting/task.idle 不发成功收尾提醒。手动／自动合并和无代码交付共用同一来源；child 文案明确“待父确认”。
- `task.acceptance_notice_observed` 按 Worker／completionRound 持久去重，记录来源 Event 与是否生成 Notice；关闭后再开启不补发，读取、轮询和重启不补历史。info Notice 绑定真实 source_event_id，不需要答复、不唤醒 Agent。
- accept（及旧 archive）授权的中间待验收与成功回收保持静默，只留审计；失败、unknown、待决及自定义 notify 不受关闭影响。原自动链受阻提醒仍按授权／阶段去重。

## 验证与分区

统一验收入口和回收／部分失败以[验收契约](worker-acceptance.md)为准；长期定位见[模块地图](modules.md)，验证责任见[贡献指南](../contributing/README.md#分层测试与交付)。

验证必须覆盖手动／父 Agent／自动验收、无代码回答、旧 accept/archive、历史已验收补办、权限锁定、消息／待决／脏现场／后代／冻结／同步／共享资源阻塞、部分删除失败、重启 unknown、成功静默、单动作 UI 和迟到保护。使用临时项目与设备根，不重启用户服务或调用真实模型。

历史 W137 的四档默认流程交付及固定基线适配属于旧协议验证，不是本次统一验收的验证依据；未来创建时复制授权和 child 只读边界保留；#402 的设备默认作用域已由 D619 的项目独立策略替代。
