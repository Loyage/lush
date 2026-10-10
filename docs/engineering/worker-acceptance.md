# 验收即归档（W169／用户决定 #418）

本文是统一验收、归档语义的实施契约，优先于旧的“仅验收／验收并归档”、四档自动链与验收后单独归档描述。本次实际验证见末节，不能将契约或测试冒充用户业务质量验收。

## 用户含义与保留范围

“验收”表示对该 Worker 的工作不再有异议，授权删除其 worktree、本地分支 ref 等开发资源，同时保留可查阅的 Worker、指令、消息、Notice、事件、结果、会话与相关运行文件。它不是质量证明，也不是彻底删除 Worker；不撤销已合并代码或改写 Git 历史。

- 成功交付只有一个“验收”动作，用户与直接父 Agent 确认 child 都采用相同语义。页面就地说明“验收即归档并回收开发资源”，不再提供仅验收、验收并归档两套入口，也不额外发第二次 branch.archive 请求。
- 失败、取消、历史特殊分支的收起操作称“清理资源”，不伪装为成果验收；保留原失败／取消结果与现有显式丢弃确认能力。
- 验收严格阻止脏工作区，不默许丢弃未提交改动；消息（含暂存输入）、待决、后代、冻结、同步、实际 invocation 退出及交付检查不放宽。
- 归档范围继续沿用受检的分支子树，不删除 canonical 检出或其他 Worker 仍使用的共享资源。已验收／已回收的子 Worker 不阻止父级验收。无代码改动也需回收其开发资源。

## 运行时与失败语义

`acceptTask` 是统一动作的权威入口。Git 操作串行执行，资源检查与删除过程中复核身份、消息和授权；不能在仍活跃的 invocation 中删检出，也不能通过嵌套排队造成 Git gate 死锁。

只有回收成功才宣称此次统一验收完成并发出 `task.accepted`／`worker.accepted`。受检回收使用 `task.acceptance_started`、`task.acceptance_failed` 审计；旧已验收记录补办成功写 `task.acceptance_reclaimed`，不重写旧验收事件。`branch.archive.outcomes` 留逐资源移除事实。资源删除部分失败时逐资源保留磁盘事实、诊断及可继续的审计，不把 partial/unknown 冒充成功；恢复依据精确持久收据，不靠目录不存在猜测，不因 daemon 重启自动重放未知删除。显式重试须能续办失败范围而不重新删除已完成资源。

inspect／graph 同源增加 `acceptance_recovery:boolean`：仅据当前轮未完成验收的精确持久 started/failed 审计投影，不凭目录缺失猜测。true 只表示可显示显式续办候选，实际请求仍复核安全门；根资源已删除而后代失败时不应被普通已归档过滤隐藏或由 workspace 缺失禁用。

历史 `completed` 不能仅凭状态推断已验收；历史真实验收但尚未归档的记录允许显式补办资源回收，不改写旧事件。无需新核心实体。内部 branches.archived 与历史事件名可保留，公开说明解释它是验收后的资源状态，而非另一个成功流程步骤。

## 自动链兼容

用户明确授权旧“自动到验收”直接采用新语义，包括已有 Worker 和设备默认流程。新界面只有关闭／合并／验收三个最高环节；验收包含资源回收，启用须说明删除范围与安全限制。

旧存储/API 的 `archive` 值继续兼容作为 `accept` 的等价授权，不机械改写历史记录；公开读面宜规范为 `accept`，旧私有执行收据与未知结果仍须尊重，不得因此绕过恢复检查或重复执行。旧自动归档已授权行为保留。旧已验收未回收的 accept 授权可安全补办回收；失败/unknown 不自动重试。

child 的配置仍锁定、默认自动合并，由直接父 Agent 检查确认；不把子 Worker 提升为自动验收，不继承父授权。Agent 不可修改结束级别。`worker.accept` 参数继续为 id，`branch.archive` 保留低层／特殊现场清理兼容入口，CLI 文案解释统一语义。

## 分区与验证

- Runtime child：`src/core/project/iteration.js`、`branches.js`、`completion.js`、`hooks.js`、必要调度接缝、`src/core/workspaces/`、`src/core/hooks.js`、`src/core/device-automation.js` 及对应 runtime／device tests。负责统一入口、串行回收、幂等／部分失败恢复、自动链读面与旧值兼容。不修改 assets、CLI/RPC/Host、文档。
- UI child：`src/ui/web/assets/` 与 DOM tests；统一验收按钮、清理入口、三档自动链（兼容旧 archive 读值）、设备默认与帮助／授权确认、历史过滤说明。请求仅 worker.accept；不修改 backend 或文档。
- W169：CLI／RPC／Host 接缝、提示词、文档、真实临时 HTTP/RPC/Git 联调、全量回归与子 Worker 检查验收。分区文件发生接缝需求先消息，不互改。

实际验证手动／父 Agent／自动验收、无改动回答、旧 accept/archive、已验收未清理补办、dirty／消息／待决／后代／共享资源／冻结／同步阻塞、删除部分失败及重启 unknown、保留运行会话与结果、UI 单动作失败保护、迟到响应和费用标识。全部测试使用临时项目／设备根，不重启用户 daemon/Host。

## W169 验证记录

W169-1、W169-2 均由 runtime 合入 W169，并由父 Agent 检查代码、交付事实和测试后确认。Runtime 固定父 `0f46fbb` 的源侧适配保留源提交 `2df9449`，修复 `db4ae2f`；UI 固定父 `15a1255` 的适配保留源提交 `a4288bb`，修复 `d12ef84`。双方未发现改名或架构迁移；旧自动级别／挂载／删除顺序测试已适配为统一语义。

- 最终完整 `bun run test --timeout 30000`：**3010 pass / 0 fail**，389 文件，日志 `/tmp/lush-w169-logs/full-final.log`。
- 真实 HTTP/RPC/SQLite/Git 与 UI 联调：**27 pass / 0 fail**，日志 `/tmp/lush-w169-logs/acceptance-integrated-final.log`。新增 `test/web/unified-acceptance-runtime-integration.test.js` 验证单次验收无改动回答、dirty 拒绝后再次显式验收、会话／结果／事件保留、已删除根但后代失败的真实恢复标记和图上续办；读取／渲染不发射删除。首轮两个测试误把 history 数组读成 events 对象，修正测试后完整重跑通过，原日志 `/tmp/lush-w169-logs/acceptance-integrated.log`。
- 父复跑 DOM／事件读面：**992 pass / 0 fail**，日志 `/tmp/lush-w169-logs/ui-integrated-dom.log`。
- Firefox 工作台 fixture 的源码与真实构建资源均通过双主题、1440/390/320px、CSP、设备默认选择与失败草稿保护等检查，日志 `/tmp/lush-w169-logs/browser-ui-source.log`、`browser-ui-compiled.log`。它不是连接真实模型的业务验收；验收请求及资源回收使用上面的真实临时 HTTP/RPC/Git + DOM 联调。
- 文档检查通过，仅既有篇幅警告。Runtime 首轮全量曾遇到未改动的 Appearance 跨进程测试时序失败，后续 child 与父各自完整全量均通过；相关外观代码未修改。

未调用真实模型、未回收用户现有 Worker 资源、未重启用户服务；当前 daemon 仍运行旧代码，Agent 确认派生 Worker 在当前 daemon 中仍保留 worktree，不绕过权限另行删除。合入目标分支并在安全空闲点更新 daemon 与 Host 后，新统一验收语义才对实际服务生效。运行历史保留不承诺备份、安全擦除或 Git 对象永久保留。

### 固定父基线修复（交付 15152／尝试 15155）

W169 源侧合入固定父 `2497d09780845e5c90721eed835d1e68f9b4f59a`，保留原源 `cec27abc8661a5158b3f3ffa581e66dd7c705e4e`；共同祖先为 `edde636`。父侧只新增成功一次性 Hook 挂载退役及对应测试／文档，无改名、公共模型迁移或模块拆分。Git 无文本冲突，语义检查确认验收后通知仍执行且审计保留，自定义一次性挂载删除不影响持久内置 auto-merge／auto-accept；预约创建默认测试同时采用父侧 retiredHook 审计和本需求 accept 规范值。强化 `completion-guards.test.js` 验收后通知退役回归，保留双方意图，不修改父分支。

修复组合专项 **297 pass / 0 fail**，日志 `/tmp/lush-w169-logs/repair-integrated.log`；完整 `bun run test --timeout 30000` **3013 pass / 0 fail**，390 文件，日志 `/tmp/lush-w169-logs/repair-full-final.log`。文档检查通过（既有篇幅警告）。本轮未重跑真实浏览器，父侧无 Web assets 变更；此前 Firefox 源码／构建验证保留。仍未重启用户服务或调用真实模型。
