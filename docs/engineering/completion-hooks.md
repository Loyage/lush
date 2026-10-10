# 合并—验收自动链（验收即归档）

W169／用户决定 #418 统一验收与归档，当前权威边界见[统一验收](worker-acceptance.md)。验收表示对 Worker 工作不再有异议，授权回收 worktree/ref 并保留完整运行历史；脏现场阻止验收。它不是业务质量评审或彻底删除 Worker。

W162／决定 #402 的新指令结束流程仍为设备唯一默认值，只有实际创建的新指令复制授权；设备接口见[用户工作台契约](user-workspace.md)。不改变项目绑定、Host 职责或 child 权限。

## 级别与授权

- 新配置展示 `off | merge | accept`，高档包含前面的环节。`accept` 包含安全资源回收，没有独立待归档的成功环节。
- 旧存储及 API 的 `archive` 等价于 `accept`，读面规范化，不机械改写旧记录或收据。用户决定 #418 明确允许旧自动验收授权直接采用新语义，包括已有 Worker 和设备默认值。
- 自动验收只复用既有安全检查，代替用户确认，不调用质量评审 Agent，也不保证业务质量。
- child 的流程 Hook 整体对用户只读，默认锁定自动合并，由直接父 Agent 检查确认；不从父级继承验收授权。用户指令即使挂在另一 Worker 下，仍可配置自己的结束流程。
- 请求冻结／挂起、同步、自动动作执行中或结果未知时不能修改当前链；允许的显式提高只补办后续步骤，不重做已完成交付。Agent 不可设置级别。

## 串行与失败保护

1. `worker.delivery_ready`：安全点请求合并，沿用父队列、冻结、源侧固定基线修复和 Git gate。无代码改动经过交付核验后跳过空 Squash。
2. `delivery.integrated`：至少 accept 的授权执行统一 `acceptTask`，核验实际退出、后代、消息（含暂存输入）、待决、同步、共享使用者、分支提交和清洁度；受检回收成功后才记录本次 `task.accepted` 并触发 `worker.accepted`。

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

## RPC／CLI／设备默认

- `worker.completion {id,level,expected_revision}` → `setTaskCompletion`，用户专属、严格参数白名单、worker.hooks 的不透明 revision。
- CLI 推荐 `worker completion ID off|merge|accept --revision REV`；旧 archive 兼容等价 accept，不放宽权限、冻结或 stale revision。
- `worker.auto_merge` 和 auto-merge 挂载旧开关继续相同权限；on 不降级高级授权，off（允许时）关闭未来链，不撤回已发请求。
- 设备 `completion_defaults:{enabled,level}` 用 Host `/api/host/automation` 保存，关闭记住所选值。只影响之后实际创建的新指令（包括预约／定时发射），不改变已有 Worker 的配置或 child 默认流程。旧 hooks.completion_defaults 用户 API 保留兼容。
- 选择验收授权须解释删除分支子树 worktree/ref、完整历史保留、脏现场阻止、自动验收不是质量评审；可能启动分歧 Agent 的配置按钮仍带 Agent 代价标识。

## 告知

- off：原手动收尾提醒。
- merge：成功合并后仅提示待验收，并解释验收包含归档回收。
- accept（及旧 archive）：成功自动合并、验收和回收只留审计，不发成功告知或“待归档”提醒。
- 失败、unknown、待决仍可见；提醒按 Worker／轮次／阶段／授权持久去重，自定义 notify 的明确授权不受影响。读取不发射动作，不重发提醒。

## 验证与分区

W169 Runtime child 负责 core/project、workspaces、device-automation 和 runtime/device tests；UI child 负责 assets 与 DOM；父负责 CLI/RPC/Host、提示词、文档、HTTP/RPC/Git 联调及全量测试，具体边界见[统一验收](worker-acceptance.md)。

验证必须覆盖手动／父 Agent／自动验收、无代码回答、旧 accept/archive、历史已验收补办、权限锁定、消息／待决／脏现场／后代／冻结／同步／共享资源阻塞、部分删除失败、重启 unknown、成功静默、单动作 UI 和迟到保护。使用临时项目与设备根，不重启用户服务或调用真实模型。

历史 W137 的四档默认流程交付及固定基线适配属于旧协议验证，不是本次统一验收的验证依据；原用户决定 #325 的未来创建时复制授权、#402 的设备唯一默认和 child 只读边界保留。
