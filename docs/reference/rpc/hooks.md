# Hooks 与预约接口

用户流程见 [Worker Hooks 与预约发射](../../hooks.md)，完整定义与安全约束见 [Hooks 工程契约](../../engineering/hooks.md)。下列配置、挂载与预约写入口均为**用户专属**；Agent token 不得调用。

## RPC、HTTP 与 CLI

| RPC | 参数 | CLI（加 `bun run lush` 前缀） |
|---|---|---|
| `hooks.list` | `{}` | `hooks list` / `hooks command list` |
| `hooks.install` | `{id,command,hook,expected_revisions,client_request_id}` | `hooks install ID --file PATH` |
| `hooks.command_save` | `{command,expected_revision}` | `hooks command save --file PATH --revision REV` |
| `hooks.command_export` | `{id,version}` | `hooks command export ID --version N` |
| `hooks.command_remove` | `{id,expected_revision}` | `hooks command remove ID --revision REV` |
| `hooks.command_history` | `{before?,limit?,execution_id?}` | `hooks command history [--before CURSOR] [--limit N] [--execution UUID]` |
| `hooks.command_history_remove` | `{execution_id}` 或 `{clear:true}` | 既有 API 删除／清空已结束记录；独立 Web 入口已退休 |
| `hooks.command_import` | `{source,expected_revision}` | `hooks command import --file PATH --revision REV` |
| `hooks.auto_select` | `{enabled,expected_revision}` | `hooks auto-select on\|off --revision REV` |
| `hooks.completion_defaults` | `{enabled,level,expected_revision}` | 项目默认流程兼容入口 |
| `hooks.automation_settings` | `{patch,expected_revision}` | 项目自动化设置页保存 |
| `worker.acceptance_notice` | `{id,enabled,expected_revision}` | Worker 自动化内开启／关闭待验收告知 |
| `hooks.save` | `{template,expected_revision}` | `hooks save --file PATH --revision REV` |
| `hooks.remove` | `{id,expected_revision}` | `hooks remove TEMPLATE_ID --revision REV` |
| `hooks.signal_save` | `{signal,expected_revision}` | `hooks signal save --file PATH --revision REV` |
| `hooks.signal_remove` | `{id,expected_revision}` | `hooks signal remove SIGNAL_ID --revision REV` |
| `management.permissions` | `{}` | —（兼容读取有效权限；新页面走 Host 全局接口） |
| `management.permissions_update` | 旧 `{permissions,expected_revision}` 写入已退役并拒绝；改用 Host 根接口 | — |
| `management.permission_get` | `{method,scope:'device'}` | `hooks management permission-get METHOD --scope device` |
| `management.permission_set` | `{method,access,expected_revision,scope:'device'}` | `hooks management permission-set METHOD ACCESS --revision REV --scope device` |
| `management.create` | `{name,instruction,signal_id,mode?,profile?,client_request_id?}` | `hooks management create --file PATH` |
| `management.submit` | `{instruction,profile?,client_request_id?}` | `order '管理需求' --management`（即时管理，无需时间信号） |
| `management.binding_update` | `{id,enabled,expected_revision}` | `hooks management enable\|disable ID --revision REV` |
| `worker.hooks` | `{id}` | `worker hooks ID` |
| `worker.completion` | `{id,level,expected_revision}` | `worker completion ID off\|merge\|accept --revision REV` |
| `worker.hook_attach` | `{id,hook,expected_revision}` | `worker hook attach ID --file PATH --revision REV` |
| `worker.hook_update` | `{id,hook_id,enabled?,hook?,expected_revision}`（enabled/hook 二选一） | `worker hook enable\|disable ID HOOK_ID --revision REV`；完整编辑由 Web/RPC 提供 |
| `worker.hook_remove` | `{id,hook_id,expected_revision}` | `worker hook remove ID HOOK_ID --revision REV` |

读取 HTTP：`GET /api/hooks`、`GET /api/worker/ID/hooks`，不接受查询参数。一般写入通过已登录、同源的 `POST /api/action {method,params}`，不是通用 RPC 代理；单项权限接口仅 RPC／CLI，页面的完整映射读取／保存走 Host 根权限接口。

目录返回 `{version:1,revision,triggers,actions,templates,commands,daemon_hooks,completion_defaults,automation_settings,signals,management_workers,command_example}`；`daemon_hooks` 是项目内置自动选择的独立挂载读面，含自己的 `version/revision/mounts`。`hooks.auto_select` 必须使用 **daemon_hooks.revision**，布尔开关保存后返回完整目录；启用同时自动答复已有待答问题，详见[daemon 自动选择](../../engineering/daemon-auto-select.md)。Worker 返回 `{version:1,worker_id,revision,mounted_features,completion,convergence,push,acceptance_notice,automation_settings,can_attach,mounts}`；`mounted_features:{completion,push,convergence,acceptance_notice}` 四个布尔值是实际挂载的权威投影，不由显示原则推算。Worker 的 automation_settings 仅提供 version 与兼容 display_principles，不泄漏项目默认授权身份。CLI 的工作身份参数接受内部整数或 `Wn(-n)*`／`Vn`，先经 `worker.lookup` 解析，目标操作仍按原类型准入；RPC/HTTP 的 `id` 与动作 `target_id` 仍是内部整数，不将 W 编号作为外键。消息动作的安全 `target_worker_number` 与创建收据的 `worker_number` 只是读标签，不回传到定义。

`revision` 是不透明字符串，必须先读并随写请求携带；过期返回错误，不覆盖并发修改。模板 `id` 与挂载 `hook_id` 是不同身份。

`hook` 可为新规则定义，或仅 `{template_id:'UUID'}`；后者让后台复制模板的完整私有覆盖。不得用脱敏列表重建原模板挂载。创建动作读取只有安全 `model_selection` 摘要；模板同位置创建动作省略 `profile` 表示编辑时保留原私有覆盖。

挂载含 `trigger`、`mode`、`enabled`、`conditions`、安全动作摘要、`state`、`last_execution`、`editable` 与 `removable`。`removable` 与可启用状态不同：结束的 Worker 可移除未来授权，不能重新启用。实际挂载完工流程时，`auto-merge`、`auto-accept` 是不可移除的内置挂载（验收包含归档回收，旧 auto-archive 仅历史兼容），通过一份最高级别授权配置；旧 `worker.auto_merge` 开关保留原准入。

## 系统工具操作读面

`actions` 目录中的 `request_merge`、`accept_worker`、`integrate_deliveries` 标 `execution:'operation'`。后两者仅系统挂载；`integrate_deliveries` 另提供 `scope:'target', strategies:['serial','converge']`。这不是任意工具调用 RPC，也不开放 Agent 安装规则或提高自动级别。

适用目标的 `mounts` 包含受保护 `id:'delivery-handler', kind:'delivery_handler'`，节点 `delivery.requested` 表示接收已授权交付，不创建新授权。新普通请求始终 serial，历史固定操作可保留 converge 证据；branch.convergence* 仅保留旧读面／在途重试，两个 setter 明确退休。来源授权仍使用 worker.completion，一次性整合不作为 Hook 安装，见[整合接口](convergence.md)。

系统工具挂载可含 `operation:null|{version,id,tool,status,worker_id,delivery_id?,run_id?,generation?,round?,strategy?,created_at?,finished_at?,error?}`。status 为 `submitted|waiting|running|succeeded|failed|unknown`，id 为固定字符串身份，所有关联来自真实收据。Hook 的 request_merge 成功只证明请求提交；对应 operation 成功才证明本轮交付收口，可能是无代码结果交付，不能推断产生了合并提交或测试通过。公开摘要不含授权秘密、完整 profile 或原始错误；读取无副作用，未知结果不自动重放。完整语义见[工具与持久操作](../../engineering/hooks.md#系统工具与持久操作)。

## 中断完成节点

目录新增 `worker.interrupted` 与 main／owner 的 `project.interrupted`，分别为本次用户安全中断真实退出、项目维护批次全部安全收尾；首版仅允许一次性／持续 `notify`，维护期间可执行纯告知，其它动作不可安装。`system.interrupt_all` 的 `notify_completion=false` 仅抑制内置项目完成 Notice，不停用这些节点、Worker 中断告知或用户自装纯告知 Hook。节点不是 RPC，未新增任意事件发射权限；自动挂载及精确来源去重见[中断完成契约](../../engineering/interrupt-completion.md)。

## 快捷指令目录

`commands:{version:1,revision,items}` 为当前项目 Shell／提示词目录。每项含 `{id,name,kind,default_worker_id,version,last_execution}`，以及 description、when_to_use、tags、examples、warnings；正文按 kind 仅返回 command 或 prompt。保存 `command:{id?,name,kind?,command?|prompt?,default_worker_id?,description?,when_to_use?,tags?,examples?,warnings?}`，旧缺省 kind=shell。元数据为可空字符串，tags 为字符串数组；编辑省略元数据保留原值。default_worker_id 仅兼容已有配置，为真实 Worker 内部整数或 null，编辑省略保留、null 清空；不参与 Hook 路由，页面不再管理手动默认目标。commands.items 不公开 authorized；旧授权字段不参与执行准入。所有编辑递增版本但不撤权或停用挂载，已有自动化未来执行跟随最新定义。不接受路径、authorized、version 或额外参数；两类正文不可混合。保存和删除使用 **commands.revision**，保存返回完整 Hooks 目录。`hooks.command_authorize`、Project `authorizeShortcutCommand` 和 CLI `hooks command authorize/revoke` 已删除，UI 不提供授权／撤权或授权筛选。

W241／D566 删除 `hooks.command_run`、`hooks.command_start` 与 CLI `hooks command run/start`，Web 不再提供手动运行；不保留兼容执行别名。指令只由启用且通过安全门的 Hook 引用执行，原有权限、真实目录、Git 串行与生命周期门禁不变。

用户专属只读 `GET /api/hooks/commands/executions` 保留 Hook 及旧手动运行安全摘要，返回 `{version:1,items,has_more,next_before}`。limit 默认 30、最多 100，before 为正整数事件游标；execution_id 为固定 UUID，不可与 before 同用。编辑或删除不抹去历史；历史不保存 Shell 输出，断线不代表失败，未知结果不重放。完整读模型与恢复边界见[运行历史契约](../../engineering/shortcut-command-runs.md)。

提示词 Hook 以挂载 Worker 为父创建并启动独立指令 Worker，消耗 token，不是追加消息。历史与 last_execution 含 kind、created_worker_id、created_worker_number、input_id；succeeded 仅表示创建并提交，不表示 Agent 工作完成，结果从关联 Worker 查看。受阻不改投 main。

`hooks.command_export {id,version}` 是用户专属只读接口，返回 `{filename,markdown}`；HTTP `GET /api/hooks/commands/export?id=UUID&version=N` 不接受额外／重复参数。导出单条 Skill 风格 Markdown，不安装、不注入，不开放 Agent 调用能力。版本核验用于精确导出，不是预授权。

`hooks.command_history_remove` 是用户专属写入口，经同源 POST action，参数必须二选一：`{execution_id:UUID}` 逐条移除，或 `{clear:true}` 清空全部已确认成功／失败记录，返回 `{removed_count}`。重复移除同 UUID 返回 0；待执行、执行中、unknown 不可移除。删除持久隐藏历史列表、精确查询与快捷指令 last_execution，不删除原审计、不改变挂载启停或副作用，恢复／去重仍使用原事实。

Shell Hook 引用 `{type:'command',command_id:'UUID'}`；提示词用同形 `type:'prompt_command'`，仅 `worker.parent_ready`＋once，以挂载 Worker 为父，标明 Agent 代价；同 Hook 不混合两类指令，最多一个 create_worker／prompt_command。旧可选 command_version 为正安全整数，仅兼容，不固定未来版本；执行前核验指令存在与类型匹配，执行开始固定实际定义，编辑竞态不得混用正文与收据。旧内联 Shell 不再执行；显式 `hooks.command_import` 的 source 只能是 `{worker_id,hook_id}` 或 `{template_id}`，使用源 Worker Hooks / 模板目录 revision。导入新建指令、替换源引用并停用规则，保留历史、不重放旧触发；返回完整目录及 imported_command_ids、可选 worker_hooks。CLI import 文件的 worker_id 可用 W 编号，其余 Hook/模板身份不改写。

旧已停用规则不自动启用，不改写历史或重放；删除／类型不匹配仍阻止执行，不承诺撤回已经开始的副作用。完整安全契约见[快捷指令与 Hook](../../engineering/shortcut-commands.md)。

## 原子安装合并后命令

`hooks.install` 将**一条新 Shell 快捷指令与一个引用挂载**在同一 SQLite 事务内保存，返回 `{installed:true,worker_id,worker_number,command_id,hook_id}`。不创建模板，不改写已有命令，不执行命令，也不调用 Agent。首版仅支持 `worker.merge_received`，模式可为 once／persistent；目标仍须通过原 Worker 生命周期和容量门禁。

用户 CLI 先读 `hooks list` 和 `worker hooks ID`，再运行 `bun run lush hooks install ID --file automation.json`。ID 使用查询到的 main／目标 Worker 身份，可为内部整数或 W 编号，不能假定 main 的 ID。文件须是 owner-only、非链接、有界 JSON，**不含 id**，例如：

```json
{
  "command": { "name": "重启应用", "kind": "shell", "command": "bun run restart" },
  "hook": { "name": "main 合并后重启", "trigger": "worker.merge_received", "mode": "persistent", "enabled": true },
  "expected_revisions": { "commands": "填入 hooks.list.commands.revision", "worker_hooks": "填入 worker.hooks.revision" },
  "client_request_id": "本次安装固定的唯一标识"
}
```

RPC／HTTP 另传正整数 `id`。command 仅接受 name、kind（省略为 shell）、command、可选 description／warnings，不接受现有命令 id、提示词、默认目标、目录或凭证；hook 必填 name／trigger／mode／enabled，可带既有 statuses／integrations 条件，不接受 actions。后台生成 `{type:'command',command_id}` 引用，执行仍在挂载 Worker 的真实目录，并跟随该指令最新定义。

两个 revision 必须来自各自读面。任一过期、目标不适用、容量不足或写入失败，命令、挂载和安装收据一起回滚。client_request_id 必填，最多 128 字符，无首尾空白／控制字符；同 key **同完整参数（含 revision）**返回原安装收据，不新建、不重新启用已删除／停用配置，不证明配置目前仍存在；不同参数拒绝。响应丢失可按原参数查询式重试；新安装须新 key 和最新 revision。去重和精确收据持久保留，重启不重放副作用。

Valet 通过 `manager.catalog` 取得同源 schema／示例，使用 `manager.call {method:'hooks.install',params:完整请求}`，不能直接运行用户 CLI。按最新设备权限执行，默认 automatic，可收紧为 confirmation／unavailable；若需确认，用户一次确认完整命令、目标、触发条件和版本后，由 runtime 完成两个写入，不恢复模型继续下一步。结果的 command_id／hook_id／worker_id 为安全安装收据，不返回 Shell 正文。纯事务配置中断后由同事务的安装收据证明成功；没有收据且事务已回滚则明确失败，不借重启自动补装。

只订阅安装之后的新合并事件，旧事件不补跑。此节点只覆盖 Lush 落地的合并，不监控外部 Git 操作。实际执行仍须等待冻结／同步等安全门，Shell 的 60 秒／64 KiB、非交互和非沙箱限制不变；失败／unknown 停止未来执行，不撤销已成功合并。

## 通用命令与 main 示例

`command_example` 为 `{template_id,worker_id,hook_id,hooks}`，无 main 为 null。`worker.hooks.push` 是同源安全身份 `{worker_id,hook_id}`（无 main 为 null），只从真实 main 和匹配的安装 metadata 提取，不按标题或猜整数 ID。缺失／不匹配 metadata 的 hook_id 为 null；删除后保留 tombstone 身份，实际 mount 是否存在决定可用性，不读取时重装。两种读面共用不递归的 identity helper，不公开额外私有 metadata。示例首次初始化为默认关闭的持续模板与 main 挂载；读取不安装，被用户删除不重装。项目页面启停示例时使用 **command_example.hooks.revision**，不是模板 revision。

定义使用 `trigger:'worker.merge_received'`（父 Worker 收到成功合并）和 `actions:[{type:'command',command_id:'UUID'}]`；动作支持节点以目录为准。新项目默认注册内置 `git push` 快捷指令，再由停用示例引用；旧项目导入与停用保留见[兼容契约](../../engineering/shortcut-commands.md#旧配置与-git-push)。Hook 不配置 remote/upstream/认证，命令业务语义由用户自己决定。Shell 在挂载目录以 daemon 系统用户权限执行，不是沙箱，不调用 Agent；启停与原执行安全门不变，不自动重放失败或未知副作用。

完整编辑使用 `worker.hook_update {id,hook_id,hook:{name,trigger,mode,enabled,conditions?,actions,schedule?},expected_revision}`；不得同时提供 enabled。保留挂载 id，同位置省略 profile 保留已存私有覆盖。创建副本用新模板/挂载定义且 enabled=false，不携带原挂载状态或执行记录。示例用户流程见[自动化示例](../../hooks.md#示例main-合并后自动推送)。

## 时间信号与管理指令

`signals:{version:1,revision,items}` 是项目时间信号配置读面；保存／删除使用 **signals.revision**，不使用模板或 daemon 自动选择版本。定义 `{id?,name,enabled?,schedule}` 复用定时 schedule；发出历史、next_run_at、last_due_at 和 last_execution 可读，不把时间到点当作额度恢复。

`management.create` 返回 `{task}`；创建新 role='manager'/task_kind='management' 的无 Git Valet（`worker_number` 保存独立 V 编号，见[编号规则](../api.md#用户编号与-cli-身份)），保存后等待 signal_id，不立即启动 Agent。默认 mode='once'，可显式 persistent。Web 表单固定 client_request_id 去重；同 key 同定义重试返回原 Worker，同 key 改定义拒绝。key 非空、最多 128 字符、无首尾空白／控制字符；CLI 文件可显式提供，未提供时响应丢失应先检查历史，不盲目重做创建。management_workers 是有界列表，附安全 management 对象和 model_selection；完整 profile 仅写，不回读。启停使用 **management.revision**。已消费一次性／失败／未知不可重新启用重放，需要另建指令。普通 mutation/inspect 出口剔除字符串 management 私有 JSON。

`management.permissions` 为用户专属兼容读取：返回当前有效设备权限；旧 `management.permissions_update` 保留注册但拒绝写入。Host 根 `GET/POST /api/host/management/permissions` 仍仅供用户页面读取／保存完整映射；新增 `management.permission_get`／`management.permission_set` 供用户 CLI 及 Valet 的 `manager.call` 逐项查询／审核修改，普通开发 Agent 不可直调。permission_set 始终 confirmation／unavailable，真实用户批准前不写入，revision 变化拒绝旧批准；返回 `{method,access,revision}`。默认开放、旧限制退出授权、文件保留、读模型及跨进程排序统一见[全局管家权限契约](../../engineering/hook-signals-management.md#设备全局管家权限)。历史 permissions_snapshot 不作为新操作授权，client_request_id 去重仍返回原身份。

未开始的排队／waiting／pending_confirmation 操作在执行前按最新权限复核，异步预检及写入准入等待不能使用旧授权。unavailable 阻止执行；automatic→confirmation 的旧 approved／waiting 若无用户精确批准则 failed／skipped，需重新请求确认。未答 pending_confirmation 放宽为 automatic 时关闭 Notice并继续原精确请求，变 unavailable 时 rejected 并关闭 Notice；参数、目标、资源及原安全门保持。已经 running 的操作固定开始授权，不因后续修改权限强制中断，完成操作不撤销；放宽不重放失败、拒绝、取消或 skipped 请求。私有历史快照与开始授权不进入公开 inspect；完整安全及恢复契约见[全局管家权限](../../engineering/hook-signals-management.md#设备全局管家权限)。

专用受限工具使用 Agent-only `manager.query {id?}` / `manager.start {id}` / `manager.retry {id}`，并提供 `manager.catalog {}`、`manager.history {id?,before?,limit?}`、`manager.call {method,params,request_id?}`；均不在 Web POST action 或用户 CLI 管理执行入口开放。能力分级与用户精确确认见[管理契约](../../engineering/hook-signals-management.md)。后端另强制核验当前 invocation 的管理角色、绑定和 occurrence，普通开发 Agent 不能调用。目标是内部整数 ID，工具通过 worker.lookup 解析明确的 W／V 编号；查找不扩大开始／重试等目标准入。开始仅处理 paused，重试仅 failed；无 profile 参数、不切账号。受阻返回已持久 waiting，安全点执行，不让模型循环重发。

产品授权、动作收据和恢复规则见[时间信号与管理契约](../../engineering/hook-signals-management.md)。

## 新指令默认流程

项目 `automation_settings` 为 `{version:1,revision,completion_defaults:{enabled,level},acceptance_notice_defaults:{enabled},mount_scopes:{completion,acceptance_notice},display_principles:{completion,push,convergence,acceptance_notice}}`。`hooks.automation_settings` 接受上述四项的非空严格 partial patch，使用 **automation_settings.revision**，返回完整 hooks.list；未知字段、非法值及过期 revision 拒绝。保存只设置未来默认，不批量修改现有 Worker。

完工默认初始 disabled、level=merge；level 为 `merge|accept`，旧 archive 等价 accept，关闭记住所选环节。只有本项目实际创建的新指令（含预约／定时）复制授权，不应用于 child／管理 Worker。旧 `hooks.completion_defaults` 写同一项目策略，`completion_defaults:{version:1,enabled,level,revision}` 的 revision 与 automation_settings 相同。旧设备配置及旧项目历史 meta 保留，但不自动导入或参与新建默认；Host `/api/host/automation` 的 completion_defaults 写入明确退役。验收回收语义见[自动链契约](../../engineering/completion-hooks.md)。

`mount_scopes` 两项初始均为 `all`，允许 `main|all|user|none`：main 匹配 main/owner，all 匹配全部适用类型，user 匹配 main/owner/order，none 不挂载；未来完工／告知仅适用于 order/child，因此 main 作用域不会给新开发 Worker 挂载这两项。实际创建事务冻结偏好，不从父继承；未挂载实例默认关闭，即使项目记住 enabled:true。child 完工流程例外：始终挂载且锁定自动合并，告知按创建时 scope 冻结但默认关闭。

旧 `display_principles` 保留 version 1 字段和 `main|all|user` 写兼容，不参与实际挂载或新展示判断。UI 只显示 `mounted_features` 已挂载项；异常及处理器诊断不能因此隐藏。convergence 字段只兼容历史读面，未来持续归并 scope 写入已退休，新 Worker 不安装该策略，见[整合接口](convergence.md)；push 仅从真实 main 的 push identity 与存在的 hook 判定，删除后不重装，不扩大执行范围。

告知默认 enabled=true，只复制给新用户指令；child 创建时默认 false。`worker.acceptance_notice` 使用 **worker.hooks.revision**，返回完整 Worker Hooks；只允许 order/child 等合法开发 Worker，冻结、同步、终态及执行中的安全门仍核验。`acceptance_notice:{enabled,editable,reason}` 是安全读面；child 可以独立改告知，不因此解锁合并／验收级别。已有 order/child 缺少挂载元数据按旧内置能力已挂载解释，告知未配置时按 order 开启、child 关闭解释，不改写历史。历史 say 保留原告知语义并投影已挂载，不新增 say 创建入口；现有 say→order 只读规范化及原完工可用性不变，不额外创建授权。显式启用 `worker.acceptance_notice` 或提高 `worker.completion`／启用旧 `worker.auto_merge` 会在原安全门通过后同时保存真实挂载，避免执行却隐藏；关闭保留已有挂载。Worker revision 包含挂载变化，不受未来默认修改影响。关闭不屏蔽异常，告知去重与不补发边界见[告知契约](../../engineering/completion-hooks.md#告知)。

## 最高自动级别

CLI `worker completion` 仅接受 `off|merge|accept`；后端 RPC `worker.completion` 的旧 archive 入参兼容等价 accept，读面规范为 accept；高档包含之前的步骤，验收即归档回收资源，返回更新后的 Worker Hooks。读取当前 revision 后显式保存，不隐式继承给后代。派生 child 的 min_level 为 merge，整组流程 Hook 对用户只读；所有级别设置（含同值）与旧自动合并开关写入均拒绝。用户直接创建的指令仍可配置，即使其父不是 main。

`completion` 为 `{level,min_level,locked,editable,reason,phase,state,last_execution}`；child 的 locked:true、editable:false 表示整组流程 Hook 锁定，reason 解释用户不可修改；两个内置挂载同样锁定且不可移除。phase 规范为 merge/accept 或 null，last_execution.phase 可保留历史 archive，state 沿用 idle/waiting/running/succeeded/failed/unknown。inspect、graph、Hooks 为同源安全投影，不含私有执行／提醒收据。普通 Worker 出口去除字符串 hooks、auto_merge 和完整 retry_profile，保留安全对象和授权配置/env 字典。

已冻结请求、挂起、执行中、同步或 unknown 不能改级别；用户指令已合并／验收时只允许显式提高，补办仍复用原安全门。验收不做模型质量评审，包含安全资源回收，不授权丢弃脏工作区。资源回收成功才完成统一验收；部分失败保存事实、可显式续办，失败/unknown 不自动重放。旧已验收未回收可受检补办，历史 completed 没有 task.accepted 事实不能冒充验收。

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

## 条件发射与兼容创建

`input.emit`、`order.submit` 缺省及 start:true 均先返回持久挂载收据 `{emitted:true,draft_id,dispatch}`，不保证有 task，条件及父安全准入由 runtime 独立推进；`--defer` 保留参数兼容，不要求用户因冻结换发射模式。显式 start:false 仍仅创建，历史 create_worker Hook 不迁移。版本草稿可附运行覆盖，但不能混入正文、引用、条件或去向覆盖。

`input.parents.items` 保留有效冻结父及 freeze，只读候选不是最终创建许可。条件发射对应受保护 input_signal Hook，多个条件全部满足；草稿挂载中不能编辑／删除。撤销或独占释放必须走对应输入 API，不能借普通 Hook 编辑绕过占用。精确参数、读面与恢复见[历史输入接口](../../engineering/input-history.md)和[条件发射](../../engineering/conditional-emission.md)。
