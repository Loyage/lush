# 合并—验收—归档自动链

本页固定追加需求及用户决定 #202 的实现契约。设计见 [Worker Hooks](../design/hooks.md)，通用挂载见 [Hooks 接缝](hooks.md)。这是实现边界，不能用文档代替交付验证。

## 用户决定

- 选择当前 Worker 的最高自动级别：`off | merge | accept | archive`；高档包含前面的步骤。
- 自动验收只复用现有安全校验并代替用户确认，不调用质量评审 Agent，不保证业务效果符合用户预期。
- 设置不继承。新 child 仍默认锁定自动合并、由直接父 Agent 检查确认；只有用户显式为某个 child 选择高级别，才授权它自动验收／归档。
- 开发中可预设；请求已冻结或自动动作正在执行时不可改当前链。已合并待验收、已验收未归档时，允许显式提高级别补办后续步骤。
- 自动成功环节不生成普通完成告知；仅提醒下一个人工环节。失败、受阻和待决仍可见；审计 Event、执行结果与原始历史保留。

## 串行与安全

1. `worker.delivery_ready`：请求合并，沿用现有安全点、父自有队列、分歧修复、Git gate 和交付事实。
2. `delivery.integrated`：自动级别至少为 accept 时再尝试验收，沿用 `acceptTask` 的运行退出、后代终态、消息、待决、同步、分支和未交付改动检查。授权来自用户保存的级别，不伪装为父 Agent 评审。审计仍保留 accepted_by 的 user/parent 边界，可额外写 `via:'completion_hook'`。
3. `worker.accepted`：级别 archive 时再尝试归档。沿用 `archiveBranch` 的子树范围，删除 worktree/ref、保留 Worker、会话和 Git 历史；不启用 discard_worktree，不绕过清洁度、当前检出、活动后代或冻结限制。

三个内置 Hook 展示明确的先后条件，不能用一轮 agent.returned 提前验收或归档。无代码改动时可通过既有交付校验明确记为“无需合并”后进入下一步，不创建空 Squash；这不是将任意 integration:none 当作已交付。

后续级别不得重新合并已落地成果或重复验收。每个阶段持久化领取和收据；安全准入改变时停止并说明，不覆盖用户新输入，不并发删除仍在使用的工作区。自动动作不能借 actor:null 获得额外用户权限，执行时仍须验证当前保存的用户授权和对应轮次。

级别跨轮保存，与本轮执行状态分开；重开/追加开发时不能复用旧轮成功或失败收据推进新成果。父 child 的最低级别仍为 merge，不能用新入口关闭锁定合并。旧 `worker.auto_merge` 开关继续原权限和门禁；on 不降级已有高级别，off（允许时）关闭整条未来自动链，不撤回已发请求。历史 version 1 交付不改造成新自动链，旧配置不回填。

明确失败与未知结果不自动重试。归档有部分副作用或重启途中断时保留逐分支事实与 unknown/failed 诊断，不能因重启再次发射删除；需要用户检查现场并显式恢复。只有精确成功凭据可收口，不能仅凭目录不存在推断成功。

## 持久化与安全读面

不新增核心实体或 Host 调度。复用 `tasks.auto_merge` 的附属 JSON：保留 `{version:1,enabled,locked}`，可增 `level` 与内置自动链的私有执行/提醒收据。旧 enabled:true 的有效新式配置读为 merge，false/缺失读为 off；未设置高级别不自动升级。新 child 不从父复制 level。

RPC 出口递归去除普通 Worker 结果的字符串 `auto_merge`，防止 raw mutation 泄漏内置执行／提醒收据；保留对象形式的安全投影和授权配置/env 字典中的合法同名键。

`autoMergeView` 保留 `{enabled,locked,editable,reason}`，其门禁仍只描述旧开关。新增 `autoCompletionView(task)`，公开 `completion`：

```js
{
  level: 'accept',
  min_level: 'off', // child 为 merge；不是整组选项不可编辑
  locked: false, // 表示最低合并级别锁定，不禁止用户显式选择更高档
  editable: true, reason: null,
  phase: 'merge', // merge | accept | archive | null
  state: 'waiting', // idle | waiting | running | succeeded | failed | unknown
  last_execution: null // 或安全 id/phase/status/created_at/finished_at/error 摘要
}
```

`worker.inspect`、`worker.graph` 和 `worker.hooks` 返回同源 `completion`；不适用的历史 Worker/main/owner 为 null。Hook revision 必须覆盖真实级别与执行授权变化，不只哈希旧 enabled 布尔值。

内置挂载保持 `auto-merge`，新增不可移除 `auto-accept`、`auto-archive`，分别是 delivery_ready、delivery.integrated、worker.accepted 节点。统一用最高级别配置，不提供三份独立且可矛盾的开关。最近执行与阻塞原因走同源安全投影。

动作目录可用 `accept_worker`、`archive_worker` 描述两个内置动作，必须标 `builtin_only:true`；首期仅最高级别授权，不开放任意自定义组合安装这两个动作。前端表单排除 builtin_only，后端也必须拒绝直接安装，不能只藏 UI。原四个自定义动作不变。

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

`test/web/completion-runtime-integration.test.js` 使用真实临时 HTTP/RPC/SQLite/Git 验证四档串行链、成功静默／下一人工环节、补办、去重、child 最低级别和私有收据出口。Runtime 另由 `completion*.test.js` 验证安全准入、部分归档及 unknown 恢复；真实浏览器、桌面与实际模型仍另行验收。

至少实际验证四档级别、顺序与去重、无代码成果、已合并／已验收补办、设置不继承、child 最低级别锁定、旧开关一致性、权限与 stale revision、后代/未读/待决/脏现场/冻结阻塞、并发追加输入、部分归档与重启 unknown 不重放、成功静默及下一人工提醒、失败诊断保留、迟到响应与 Agent 代价标识。测试使用临时项目和可控 provider，不重启用户服务、不调用真实模型。
