# daemon 自动选择 Hook

本文记录 W118 / 用户决定 #267 的项目级自动答复契约。使用入口见 [Hooks](../hooks.md)，问卷格式与暂停机制见 [Notice](../reference/rpc/notices.md)。它是当前项目 lushd 的内置 Hook，不是 Worker 挂载、模板或 Host 全局策略。

## 授权与行为

默认关闭；用户在项目 Hooks 页面显式启用，开关按项目持久保存，不共享到设备或其他项目。开启时同时处理本项目已有待答问题，之后在后台接收到问题时触发 `notice.received`。

| Notice 类型 | 自动答复 |
|---|---|
| `questionnaire` 单选题 | 选择零基序号 `0`，即第一项 |
| `questionnaire` 多选题 | 自定义答案「请由 Agent 自行判断并继续。」 |
| `question` 文字问答 | 答案「请由 Agent 自行判断并继续。」 |
| `plan` / `info` | 不处理 |

第一项不要求含推荐标记；这是用户明确选择的规则，不是后台猜测。多题问卷逐题应用对应规则，一次规范化提交。多选/问答的自动回复是将判断交给 Agent，并不表示用户批准某个方案。

停用只撤销未来自动答复与尚未处理的积压项，不撤回已写入的答案、消息或已开始的调用。开启可能让多个旧 Worker 恢复并产生调用费用；前端必须明确说明并确认授权，开启按钮使用 `agent-call` 与 `agentHelp()`。

## 数据与来源

- 配置保存到项目 SQLite `meta`，不新增业务实体。
- Notice 增加可空 `answer_source`，有效读值为 `user|lush|null`。
- 自动答复将 `answer_source='lush'` 与答案、收件箱消息、`notice.answered` Event 在同一事务保存。
- 消息携带来源与自动答复说明，不冒充用户决断；用户公共答复入口不能传入或伪造来源。
- 历史已回答／已忽略记录没有持久来源时，读面兼容投影为 `user`，未答记录为 `null`，不回填历史行。
- Web 记录与详情显示「Lush 自动选择」或「用户答复」，不依据答案内容猜来源。

## 接口与修订

`hooks.list` 在既有模板目录外增加：

```js
daemon_hooks: {
  version: 1, revision: 'opaque',
  mounts: [{ id: 'auto-select', name: '自动选择', trigger: 'notice.received',
    mode: 'persistent', enabled: false, builtin: true /* 状态、说明与最近执行 */ }]
}
```

daemon 的 revision 独立于模板 revision，执行收据不改变配置 revision；旧客户端省略字段时仍能读取原模板目录。读取不得执行 Hook。

用户专属 RPC `hooks.auto_select {enabled:boolean,expected_revision:string}` 调用 `Project.setDaemonAutoSelect(enabled,expectedRevision)`，返回更新后的完整 `hooks.list`。过期 revision 拒绝，不覆盖其他标签的设置。Agent token 不可读写 Hook 配置。

Web 使用当前项目已登录、同源的 `POST /api/action`，不接受项目路径或 `_token`。CLI 为 `bun run lush hooks auto-select on|off --revision REV`，REV 来自 `hooks.list.daemon_hooks.revision`。

## 调度与恢复边界

自动答复复用问卷规范化、事务和消息唤醒路径。结构化问卷仍先持久暂停当前 invocation，令 token 失效，并等待进程真实退出后再启动下一轮；自动答案不允许重叠 Agent 调用，running 收尾必须保住唤醒。

积压处理有界，关闭或项目 shutdown 后停止新动作；只有仍 open 的问题才能结算一次。终态 Worker 不复活。重启保留开关与来源，不重放已答问题或副作用未知的 invocation，也不把暂停前的半成品当完成成果。

## 模块与验证

Runtime 入口为 `src/core/project/auto-select.js`，装配见 `project.js`；Notice 答复在 `project/messages.js`，共享投影在 `persistence/notice-projection.js`。RPC/CLI、Web server 与 assets 只调用该窄契约，分区见[模块地图](modules.md#daemon-自动选择-hook-接缝w118--决定-267)。

测试应覆盖默认关闭、项目隔离、热更新和持久化、旧问题批次、新问题、混合问卷与文字问答、来源不可伪造、去重、过期 revision、权限、shutdown、真实退出后的恢复，以及页面授权和历史来源展示。不调用真实模型，不重启用户正在工作的 daemon/Host；真实浏览器与实际模型另行验收。
