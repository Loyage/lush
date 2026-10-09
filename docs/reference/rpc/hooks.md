# Hooks 与预约接口

用户流程见 [Worker Hooks 与预约发射](../../hooks.md)，完整定义与安全约束见 [Hooks 工程契约](../../engineering/hooks.md)。下列配置、挂载与预约写入口均为**用户专属**；Agent token 不得调用。

## RPC、HTTP 与 CLI

| RPC | 参数 | CLI（加 `bun run lush` 前缀） |
|---|---|---|
| `hooks.list` | `{}` | `hooks list` / `hooks command list` |
| `hooks.command_save` | `{command,expected_revision}` | `hooks command save --file PATH --revision REV` |
| `hooks.command_authorize` | `{id,version,authorized,expected_revision}` | `hooks command authorize\|revoke ID --version N --revision REV` |
| `hooks.command_remove` | `{id,expected_revision}` | `hooks command remove ID --revision REV` |
| `hooks.command_run` | `{id,version,worker_id,expected_revision}` | `hooks command run ID --version N --worker ID --revision REV` |
| `hooks.command_import` | `{source,expected_revision}` | `hooks command import --file PATH --revision REV` |
| `hooks.auto_select` | `{enabled,expected_revision}` | `hooks auto-select on\|off --revision REV` |
| `hooks.completion_defaults` | `{enabled,level,expected_revision}` | 在自动化页面保存 |
| `hooks.save` | `{template,expected_revision}` | `hooks save --file PATH --revision REV` |
| `hooks.remove` | `{id,expected_revision}` | `hooks remove TEMPLATE_ID --revision REV` |
| `hooks.signal_save` | `{signal,expected_revision}` | `hooks signal save --file PATH --revision REV` |
| `hooks.signal_remove` | `{id,expected_revision}` | `hooks signal remove SIGNAL_ID --revision REV` |
| `management.create` | `{name,instruction,signal_id,mode?,profile?,client_request_id?}` | `hooks management create --file PATH` |
| `management.binding_update` | `{id,enabled,expected_revision}` | `hooks management enable\|disable ID --revision REV` |
| `worker.hooks` | `{id}` | `worker hooks ID` |
| `worker.completion` | `{id,level,expected_revision}` | `worker completion ID off\|merge\|accept\|archive --revision REV` |
| `worker.hook_attach` | `{id,hook,expected_revision}` | `worker hook attach ID --file PATH --revision REV` |
| `worker.hook_update` | `{id,hook_id,enabled?,hook?,expected_revision}`（enabled/hook 二选一） | `worker hook enable\|disable ID HOOK_ID --revision REV`；完整编辑由 Web/RPC 提供 |
| `worker.hook_remove` | `{id,hook_id,expected_revision}` | `worker hook remove ID HOOK_ID --revision REV` |

读取 HTTP：`GET /api/hooks`、`GET /api/worker/ID/hooks`，不接受查询参数。写入通过已登录、同源的 `POST /api/action {method,params}`，不是通用 RPC 代理。

目录返回 `{version:1,revision,triggers,actions,templates,commands,daemon_hooks,completion_defaults,signals,management_workers,command_example}`；`daemon_hooks` 是项目内置自动选择的独立挂载读面，含自己的 `version/revision/mounts`。`hooks.auto_select` 必须使用 **daemon_hooks.revision**，布尔开关保存后返回完整目录；启用同时自动答复已有待答问题，详见[daemon 自动选择](../../engineering/daemon-auto-select.md)。Worker 返回 `{version:1,worker_id,revision,completion,can_attach,mounts}`。CLI 的 Worker 参数接受内部整数或 `Wn(-n)*`，先经 `worker.lookup` 解析；RPC/HTTP 的 `id` 与动作 `target_id` 仍是内部整数，不将 W 编号作为外键。消息动作的安全 `target_worker_number` 与创建收据的 `worker_number` 只是读标签，不回传到定义。

`revision` 是不透明字符串，必须先读并随写请求携带；过期返回错误，不覆盖并发修改。模板 `id` 与挂载 `hook_id` 是不同身份。

`hook` 可为新规则定义，或仅 `{template_id:'UUID'}`；后者让后台复制模板的完整私有覆盖。不得用脱敏列表重建原模板挂载。创建动作读取只有安全 `model_selection` 摘要；模板同位置创建动作省略 `profile` 表示编辑时保留原私有覆盖。

挂载含 `trigger`、`mode`、`enabled`、`conditions`、安全动作摘要、`state`、`last_execution`、`editable` 与 `removable`。`removable` 与可启用状态不同：结束的 Worker 可移除未来授权，不能重新启用。`auto-merge`、`auto-accept`、`auto-archive` 是不可移除的内置挂载，通过一份最高级别授权配置；旧 `worker.auto_merge` 开关保留原准入。

## 快捷指令授权

`commands:{version:1,revision,items}` 为当前项目 Shell 指令目录，每项含 `{id,name,command,version,authorized,last_execution}`。保存 `command:{id?,name,command}`，不得附带 authorized、version、运行目录或参数；新增未授权，修改名称或内容递增版本并撤权。指令 id 是 UUID，version 必须是正整数 JSON 数字；授权/撤权必须显式给布尔 authorized 和当前版本。保存、授权、删除和执行使用 **commands.revision**，前者返回完整 Hooks 目录。

手动 `hooks.command_run` 使用 Worker 内部整数 worker_id，CLI `--worker` 可解析 W 编号。执行仅允许当前已授权版本，复用真实工作目录、Git 串行和生命周期门禁，受阻拒绝、不隐式排队重试；返回 `{execution_id,command_result,commands}`，不公开命令原始输出。不是沙箱、不调用 Agent，Shell 具有 daemon 系统用户权限。

Hook 只引用 `{type:'command',command_id:'UUID',command_version:1}`，启用、触发和执行前复核授权版本。旧内联 Shell 不再执行；显式 `hooks.command_import` 的 source 只能是 `{worker_id,hook_id}` 或 `{template_id}`，使用源 Worker Hooks / 模板目录 revision。导入新建未授权指令、替换源引用并停用规则，保留历史、不重放旧触发；返回完整目录及 imported_command_ids、可选 worker_hooks。CLI import 文件的 worker_id 可用 W 编号，其余 Hook/模板身份不改写。

修改、撤权和删除均不会默默将所有 Hook 改绑新版本，不承诺撤回已经开始的副作用；未知结果禁止重放。完整安全契约见[快捷指令与 Hook](../../engineering/shortcut-commands.md)。

## 通用命令与 main 示例

`command_example` 为 `{template_id,worker_id,hook_id,hooks}`，无 main 为 null。示例首次初始化为默认关闭的持续模板与 main 挂载；读取不安装，被用户删除不重装。项目页面启停示例时使用 **command_example.hooks.revision**，不是模板 revision。

定义使用 `trigger:'worker.merge_received'`（父 Worker 收到成功合并）和 `actions:[{type:'command',command_id:'UUID',command_version:1}]`；动作支持节点以目录为准。新项目默认注册并授权内置 `git push` 快捷指令，再由停用示例引用；旧项目未修改的默认示例在启动时一次性导入／授权，不恢复用户撤权、修改或删除，不重放旧触发。其他内联命令仍须显式导入并授权。Hook 不配置 remote/upstream/认证，命令业务语义由用户自己决定。Shell 在挂载目录以 daemon 系统用户权限执行，不是沙箱，不调用 Agent；启用前需明确授权，不自动重放失败或未知副作用。

完整编辑使用 `worker.hook_update {id,hook_id,hook:{name,trigger,mode,enabled,conditions?,actions,schedule?},expected_revision}`；不得同时提供 enabled。保留挂载 id，同位置省略 profile 保留已存私有覆盖。创建副本用新模板/挂载定义且 enabled=false，不携带原挂载状态或执行记录。示例用户流程见[自动化示例](../../hooks.md#示例main-合并后自动推送)。

## 时间信号与管理指令

`signals:{version:1,revision,items}` 是项目时间信号配置读面；保存／删除使用 **signals.revision**，不使用模板或 daemon 自动选择版本。定义 `{id?,name,enabled?,schedule}` 复用定时 schedule；发出历史、next_run_at、last_due_at 和 last_execution 可读，不把时间到点当作额度恢复。

`management.create` 返回 `{task}`；创建新 role='manager'/task_kind='management' 的无 Git 管理 Worker，保存后等待 signal_id，不立即启动 Agent。默认 mode='once'，可显式 persistent。Web 表单固定 client_request_id 去重；同 key 同定义重试返回原 Worker，同 key 改定义拒绝。key 非空、最多 128 字符、无首尾空白／控制字符；CLI 文件可显式提供，未提供时响应丢失应先检查历史，不盲目重做创建。management_workers 是有界列表，附安全 management 对象和 model_selection；完整 profile 仅写，不回读。启停使用 **management.revision**。已消费一次性／失败／未知不可重新启用重放，需要另建指令。普通 mutation/inspect 出口剔除字符串 management 私有 JSON。

专用受限工具使用 Agent-only `manager.query {id?}` / `manager.start {id}` / `manager.retry {id}`，不在 Web POST action 或用户 CLI 管理执行入口开放。后端另强制核验当前 invocation 的管理角色、绑定和 occurrence，普通开发 Agent 不能调用。目标是内部整数 ID，工具通过 worker.lookup 解析 W 编号。开始仅处理 paused，重试仅 failed；无 profile 参数、不切账号。受阻返回已持久 waiting，安全点执行，不让模型循环重发。

产品授权、动作收据和恢复规则见[时间信号与管理契约](../../engineering/hook-signals-management.md)。

## 新指令默认流程

`completion_defaults:{version:1,enabled,level,revision}` 是当前项目新指令默认配置，初始 disabled、level=merge。`hooks.completion_defaults` 严格接受布尔 enabled 和 `merge|accept|archive`，使用 **completion_defaults.revision**，返回完整目录；关闭仍保留 level。该版本独立于模板、daemon 自动选择及 Worker Hooks 的版本。

仅实际创建的新指令（含预约／定时，已停用的重选路线不恢复）复制授权，不改已有 Worker、不推进已有成果。child 和管理 Worker 不应用此默认，不提供设备作用域。此用户专属接口不启动 Agent；保存归档默认授权未来新指令及后代安全清理 worktree/ref，历史保留、脏现场不丢弃。单 Worker 设置仍用以下接口。

## 最高自动级别

`worker.completion` 严格接受 `off|merge|accept|archive`，高档包含之前的步骤，返回更新后的 Worker Hooks。读取当前 revision 后显式保存，不隐式继承给后代。派生 child 的 min_level 为 merge，整组流程 Hook 对用户只读；所有级别设置（含同值）与旧自动合并开关写入均拒绝。用户直接创建的指令仍可配置，即使其父不是 main。

`completion` 为 `{level,min_level,locked,editable,reason,phase,state,last_execution}`；child 的 locked:true、editable:false 表示整组流程 Hook 锁定，reason 解释用户不可修改；三个内置挂载同样锁定且不可移除。phase 是 merge/accept/archive 或 null，state 沿用 idle/waiting/running/succeeded/failed/unknown。inspect、graph、Hooks 为同源安全投影，不含私有执行／提醒收据。普通 Worker 出口去除字符串 hooks、auto_merge 和完整 retry_profile，保留安全对象和授权配置/env 字典。

已冻结请求、挂起、执行中、同步或 unknown 不能改级别；用户指令已合并／验收时只允许显式提高，补办仍复用原安全门。验收不做模型质量评审；归档不授权丢弃脏工作区。归档高级别失败不会重放或反向撤销验收。历史 completed 没有 task.accepted 事实时不能冒充验收。

动作目录中的 `accept_worker` / `archive_worker` 标 `builtin_only:true`，用于说明内置步骤，不能安装为自定义规则。配置和恢复细节见[自动链接缝](../../engineering/completion-hooks.md)。

## JSON 规则示例

保存为当前用户独占的普通文件（例如 `chmod 600 hook.json`）；CLI 拒绝符号链接、其他所有者或宽权限文件，并限制 JSON 大小。

```json
{
  "name": "失败时通知",
  "trigger": "agent.failed",
  "mode": "persistent",
  "enabled": true,
  "actions": [{ "type": "notify", "title": "Worker 失败", "body": "请查看执行记录。" }]
}
```

模板编辑在定义中带 `id`，新建不带。可用节点、动作支持的触发器和模式以 `hooks.list` 为准；生命周期创建与消息动作只接受 `mode:'once'`；定时支持持续每日，目录可用 `modes_by_trigger[trigger]` 覆盖动作 `modes`。

### 定时规则示例

定时仍使用上表的模板／挂载入口，不增加任意 RPC 调度接口。以下规则挂在 main，按上海时区每天提交一次创建请求；把 profile 换成已配置的真实来源可显式固定 Codex 账号，不保存凭证。

```json
{
  "name": "每日额度更新后创建",
  "trigger": "time.scheduled",
  "mode": "persistent",
  "enabled": true,
  "schedule": { "kind": "daily", "time": "00:05", "timezone": "Asia/Shanghai" },
  "actions": [{ "type": "create_worker", "content": "执行已安排的开发目标", "start": true }]
}
```

一次性用 `mode:'once'`、`schedule:{kind:'once',at:'2027-01-01T00:05:00+08:00',timezone:'Asia/Shanghai'}`，at 必须含明确偏移或 Z，挂载时必须是未来时间。每日 HH:mm，IANA 时区必须有效。

定时另支持 `{type:'retry_worker',target_id:7,profile?}` 和 `{type:'resume_worker',target_id:7,profile?}`，目标只当前或直接父子且非 main/owner。分别只处理 failed/paused，其他状态记 skipped。未提供 profile 沿用目标原运行设置；显式覆盖须是完整合法 profile，同位置同类型模板编辑省略 profile 保留私有覆盖，安全读面仅投影 model_selection。message 不带 profile、使用目标已有设置。

定时挂载新增 schedule、next_run_at、pending_due_at；last_execution 可带 due_at、status:'skipped' 和诊断。`can_attach` 给实际挂载能力，失败 order/child 仅允许定时自重试（可组合 notify），不是开放终态 Worker 的所有动作。到点持久提交，不保证 Agent 准点开始；临时门禁保留等待。停机未提交过期时间跳过、不补跑，已提交未执行项恢复继续，未知副作用不重放。详见[使用流程](../../hooks.md#定时-hook到点提交尽早开始)。

## 预约指令与草稿

- `order.submit {content,branch?,references?,start?,profile?,defer:true}` 或 CLI `bun run lush order '指令' --defer [--branch BRANCH]`。
- 草稿：`order.submit {draft_id,expected_revision,start?,defer:true,profile?}`。只有显式预约才允许草稿附加运行覆盖；不得混入 content、references 或 branch。
- 父冻结时返回 `{deferred:true,parent_id,hook_id,hooks}`，**没有 `task`**，由父可创建安全点执行；父当前可写时仍直接创建，返回真实 `task`，显式覆盖同样生效。仅创建模式用 RPC `start:false` 或 Web 显式按钮。
- `input.parents.items` 包含有效的冻结父 Worker 和 `freeze`；只读候选不是最终创建许可。
- 草稿 `input.get` 返回 `hook_mount:{parent_id,hook_id,state}|null`；占用中的草稿拒绝编辑、删除和重复发射。

正常直接提交及草稿发射没有 `defer:true` 时行为不变；最终创建仍核验当前父身份、冻结、Git 与草稿版本。执行未知或明确失败不会因重启自动重试。
