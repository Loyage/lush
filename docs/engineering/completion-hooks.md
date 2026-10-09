# 合并—验收—归档自动链

本页固定追加需求及用户决定 #202 的实现契约。设计见 [Worker Hooks](../design/hooks.md)，通用挂载见 [Hooks 接缝](hooks.md)。这是实现边界，不能用文档代替交付验证。

## 用户决定

- 选择当前 Worker 的最高自动级别：`off | merge | accept | archive`；高档包含前面的步骤。
- 自动验收只复用现有安全校验并代替用户确认，不调用质量评审 Agent，不保证业务效果符合用户预期。
- 设置不继承。派生 child 的合并—验收—归档流程 Hook 整体对用户只读：默认锁定自动合并、由直接父 Agent 检查确认，用户不能关闭、提高或重设自动级别。用户直接创建的指令即使挂在另一个 Worker 分支下，仍可配置自己的自动链。
- 开发中可预设；请求已冻结或自动动作正在执行时不可改当前链。已合并待验收、已验收未归档时，允许显式提高级别补办后续步骤。
- 自动成功环节不生成普通完成告知；仅提醒下一个人工环节。失败、受阻和待决仍可见；审计 Event、执行结果与原始历史保留。

## 串行与安全

1. `worker.delivery_ready`：请求合并，沿用现有安全点、父自有队列、分歧修复、Git gate 和交付事实。
2. `delivery.integrated`：自动级别至少为 accept 时再尝试验收，沿用 `acceptTask` 的运行退出、后代终态、消息、待决、同步、分支和未交付改动检查。授权来自用户保存的级别，不伪装为父 Agent 评审。审计仍保留 accepted_by 的 user/parent 边界，可额外写 `via:'completion_hook'`。
3. `worker.accepted`：级别 archive 时再尝试归档。沿用 `archiveBranch` 的子树范围，删除 worktree/ref、保留 Worker、会话和 Git 历史；不启用 discard_worktree，不绕过清洁度、当前检出、活动后代或冻结限制。

三个内置 Hook 展示明确的先后条件，不能用一轮 agent.returned 提前验收或归档。无代码改动时可通过既有交付校验明确记为“无需合并”后进入下一步，不创建空 Squash；这不是将任意 integration:none 当作已交付。

后续级别不得重新合并已落地成果或重复验收。每个阶段持久化领取和收据；安全准入改变时停止并说明，不覆盖用户新输入，不并发删除仍在使用的工作区。冻结期间由 Worker 暂存的追加输入也属于未读输入，必须阻止自动验收和归档；不能因 provider 尚未收到就视为没有需求。已固定的合并可先收口，再由 runtime 在整体解冻与调用实际退出后投递下一轮；见[追加消息](../reference/rpc/tasks.md#追加消息的准入与失败处理)。自动动作不能借 actor:null 获得额外用户权限，执行时仍须验证当前保存的用户授权和对应轮次。

级别跨轮保存，与本轮执行状态分开；重开/追加开发时不能复用旧轮成功或失败收据推进新成果。派生 child 的流程 Hook 整体锁定，最高级别及旧开关入口都拒绝用户设置（含同值写入）。旧 `worker.auto_merge` 开关继续原权限和门禁；on 不降级已有高级别，off（允许时）关闭整条未来自动链，不撤回已发请求。历史 version 1 交付不改造成新自动链，旧配置不回填；已有 child 的保存级别及执行收据不重写，仅锁定后续配置权限。

明确失败与未知结果不自动重试。归档有部分副作用或重启途中断时保留逐分支事实与 unknown/failed 诊断，不能因重启再次发射删除；需要用户检查现场并显式恢复。只有精确成功凭据可收口，不能仅凭目录不存在推断成功。

## 持久化与安全读面

不新增核心实体或 Host 调度。复用 `tasks.auto_merge` 的附属 JSON：保留 `{version:1,enabled,locked}`，可增 `level` 与内置自动链的私有执行/提醒收据。旧 enabled:true 的有效新式配置读为 merge，false/缺失读为 off；未设置高级别不自动升级。新 child 不从父复制 level。

RPC 出口递归去除普通 Worker 结果的字符串 `auto_merge`，防止 raw mutation 泄漏内置执行／提醒收据；保留对象形式的安全投影和授权配置/env 字典中的合法同名键。

`autoMergeView` 保留 `{enabled,locked,editable,reason}`，其门禁仍只描述旧开关。新增 `autoCompletionView(task)`，公开 `completion`：

```js
{
  level: 'accept',
  min_level: 'off', // child 为 merge
  locked: false, // child 为 true，表示整组流程 Hook 对用户只读
  editable: true, reason: null, // child 为 false，并给出流程锁定原因
  phase: 'merge', // merge | accept | archive | null
  state: 'waiting', // idle | waiting | running | succeeded | failed | unknown
  last_execution: null // 或安全 id/phase/status/created_at/finished_at/error 摘要
}
```

`worker.inspect`、`worker.graph` 和 `worker.hooks` 返回同源 `completion`；不适用的历史 Worker/main/owner 为 null。Hook revision 必须覆盖真实级别与执行授权变化，不只哈希旧 enabled 布尔值。

内置挂载保持 `auto-merge`，新增不可移除 `auto-accept`、`auto-archive`，分别是 delivery_ready、delivery.integrated、worker.accepted 节点。统一用最高级别配置，不提供三份独立且可矛盾的开关。child 的三个内置挂载均 locked:true、editable:false、removable:false；通用自定义 Hook 的权限不因本限制扩大或收紧。最近执行与阻塞原因走同源安全投影。

动作目录可用 `accept_worker`、`archive_worker` 描述两个内置动作，必须标 `builtin_only:true`；首期仅最高级别授权，不开放任意自定义组合安装这两个动作。前端表单排除 builtin_only，后端也必须拒绝直接安装，不能只藏 UI。原四个自定义动作不变。

## 项目新指令默认值（W137 / 用户决定 #325）

自动化页面增加「结束后自动处理流程」配置，项目专属，默认关闭。用户保存 `enabled:boolean` 和 `level:'merge'|'accept'|'archive'`；关闭时仍记住所选默认环节。仅在新指令 Worker 实际创建时复制授权到其 `auto_merge`，包括预约／定时发射；选择快照与重选功能已停用，不恢复该创建路径。不改已有 Worker、不从父继承、不改变 child 锁定合并及父 Agent 验收，不适用于管理 Worker。重新开启默认不补办已有成果。模板挂载不是创建，新指令以实际创建时的默认为准。

- `hooks.list` 增加 `completion_defaults:{version:1,enabled,level,revision}`，独立不透明 revision，不影响模板或 daemon 自动选择 revision。
- 用户专属 RPC / Web POST action `hooks.completion_defaults {enabled,level,expected_revision}` → `Project.setCompletionDefaults(enabled,level,expectedRevision)`，返回完整 `hooksList()`。参数严格白名单，不提供 device scope。
- Runtime `Project.completionDefaults()` 为只读投影；`Project.newOrderCompletionConfig()` 返回新指令私有附属配置（启用高级别时包含独立用户授权身份与当前轮次收据），实际创建事务内调用。项目默认用 versioned meta 保存，变更审计不泄漏私有执行收据，不执行 Git、不唤醒已有 Agent。
- UI 分开显示启用开关与默认最高环节，保存才生效；归档授权确认删除 worktree/ref 范围与历史保留，启用提示未来分歧可能调用源 Agent。失败保留编辑值，迟到响应不覆盖其他页面；旧服务缺失字段显示不可用，不冒充已关闭。
- Runtime 子分区负责 completion.js、hooks.js、order.js 及项目测试；Web 子分区负责 render-hooks.js／必要 assets 和 DOM 测试；父负责 RPC／HTTP 接入、文档与组合验证。

### W137 验证记录

两个子分区已由 runtime 合入 W137 并由父 Agent 检查验收。真实临时 HTTP/RPC/SQLite/Git 联调与相关回归 83 项通过；覆盖关闭、合并、验收、归档默认，修改默认不撤销已有授权，预约创建时取值、当时尚可用的重选新指令（现已随父侧停用）、child 待父验收、独立修订与项目隔离、私有收据出口以及 DOM 失败／迟到保护。

最终完整运行 `bun run test --timeout 30000`：**2393 pass / 0 fail**，313 文件；日志 `/tmp/lush-w137-logs/full.log`，专项 `/tmp/lush-w137-logs/integrated.log`。文档检查通过，仅既有篇幅警告。未操作用户的默认配置、重启用户 daemon/Host 或调用真实模型；真实浏览器未验证。初次子分区因父自身提交触发旧 daemon 的目标分支监测而失败，用户恢复后经源侧固定父基线修复交付，保留原提交；没有以失败调用冒充成功。

### 固定父基线适配

交付 11900／尝试 11922 在 W137 源工作区吸收固定父提交 `d1c0eea`，保留源提交 `139b51a`；共同祖先为 `443c37e`。增量检查发现父侧停用选择快照／重选路径、将 child 流程 Hook 整体改为用户只读，另新增详情模块预览限高。删除本需求的重选创建接入及失效测试，更新默认值文档，合并 HTTP 白名单以保留新默认配置且不恢复旧重选接口；保留 child 整组锁定与详情预览。无整体改名或其他架构迁移。

修复专项 **111 pass / 0 fail**；完整 `bun run test --timeout 30000` **2387 pass / 0 fail**，314 文件，日志 `/tmp/lush-w137-logs/repair-focused.log` 与 `/tmp/lush-w137-logs/repair-full.log`。文档检查通过（既有篇幅警告）。新增回归确认项目归档默认不能改变 child 的三个只读流程 Hook，所有级别写入均被拒绝。真实浏览器／模型仍未验证，未修改父分支或用户配置／服务。

## RPC / HTTP / CLI

用户专属新增：

- `worker.completion {id,level,expected_revision}` → `setTaskCompletion(taskId,level,expectedRevision)`。
- `level` 严格为 off/merge/accept/archive，expected_revision 使用当前 worker.hooks 的不透明 revision。
- 返回更新后的 `taskHooks(id)`：`{version:1,worker_id,revision,completion,mounts}`。
- Web 加入 POST `/api/action` 窄白名单；不新增通用 RPC 代理或 GET 写操作，读取复用现有 Hooks / inspect。
- CLI：`worker completion ID off|merge|accept|archive --revision REV`，用户专属；ID 可经 worker.lookup 解析 W 编号，Hook/模板身份及 RPC id 不变。

不允许 Agent 修改最高级别；原 `worker.auto_merge`、hook_update 的 auto-merge 入口须保持与新级别一致，不能留下绕过锁定或冻结的旁路。补设不隐式授权清理脏工作区或重新开始 Agent。

## 告知策略

- off：保留原手动流程告知。
- merge：自动合并期间无成功告知，完成后只提示待验收。
- accept：合并、验收期间无成功告知，完成后只提示待归档。
- archive：三个自动成功阶段都不告知，完成情况在 Hooks/详情/历史可查。
- 无需合并的情况以同一串行边界计算下一人工环节。
- 若用户手动完成下一环节，提醒随真实状态推进，不重复通知已完成的环节。
- 实际失败、无法继续或 unknown 给出一次安全诊断；待决问卷、分歧处理及已有告知历史不删除。自定义 notify 的显式授权不因自动链而失效。
- 提醒按 Worker、轮次、阶段与授权身份持久去重。读取和客户端轮询不触发阶段，也不重发提醒。

## 实施分区与验证

- Runtime：新增 `src/core/project/completion.js`（Project 装配），及 hooks/merge-queue/iteration/scheduling/lifecycle/messages/branches 的必要接缝、auto_merge 附属收据；测试 `test/project/completion*.test.js` 和相关原回归。不改 RPC/CLI/Web assets/文档。
- 接口：registry、handlers/hooks、CLI hooks/task/help、Web server 白名单及接口测试；按上文固定方法透传，不承担运行时策略。
- Web：hook-controls/render-hooks/hook-form、必要图摘要与样式、DOM 测试；最高级别选择，三个节点结果，旧服务 completion 缺失时保守保留旧自动合并控制，不伪装高级别可用。
- 父 Worker：契约与使用文档、跨区适配、真实临时 HTTP/RPC/SQLite/Git 联调与全量回归。

`test/web/completion-runtime-integration.test.js` 使用真实临时 HTTP/RPC/SQLite/Git 验证四档串行链、成功静默／下一人工环节、补办、去重、child 整组流程锁定和私有收据出口。Runtime 另由 `completion*.test.js` 验证安全准入、部分归档及 unknown 恢复；真实浏览器、桌面与实际模型仍另行验收。

至少实际验证四档级别、顺序与去重、无代码成果、已合并／已验收补办、设置不继承、child 整组流程锁定（包括缺失／旧 unlocked 配置、同值写入、旧开关与挂载入口）、旧开关一致性、权限与 stale revision、后代/未读/待决/脏现场/冻结阻塞、并发追加输入、部分归档与重启 unknown 不重放、成功静默及下一人工提醒、失败诊断保留、迟到响应与 Agent 代价标识。测试使用临时项目和可控 provider，不重启用户服务、不调用真实模型。
