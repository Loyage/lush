# Worker Hooks 工程接缝

本文记录用户决定 #197 对应的首期实现接口与模块边界；设计目标见[Worker Hooks](../design/hooks.md)，使用流程见[Hooks 与预约发射](../hooks.md)。用户决定 #202 的追加实现以[合并—验收—归档自动链](completion-hooks.md)为准，覆盖最高级别、串行门禁与成功静默告知。触发目录不是测试证明，验证入口和实际验收限制见末节。

## 快捷指令引用

D676：所有项目自动化先进入统一注册目录，复用 hook_templates 附属配置，不新增实体。新挂载只接受 `{template_id,template_version,enabled?}`，完整更新同样拒绝内联动作；注册定义和命令正文均有不可变版本，挂载复制明确授权版本及 `{type:'command',command_id,command_version}`。定义修改不改变旧挂载，显式选择新版才升级。固定历史版的真实执行、删除／类型失配门禁及旧内联显式导入见[快捷指令契约](shortcut-commands.md)。旧内联只保留展示和历史，不能执行或启用。项目自动化按功能列表进入设置页，具体授权与记录从对应 Worker 查看，通用指令与模板的 Web 编辑入口已退休，定义管理仍经既有 CLI／API，页面入口见[使用指南](../hooks.md#页面入口)。

## 通用命令与 main 推送示例（W133 / 用户决定 #319）

用户选择通用命令而非专用推送动作。新增 `worker.merge_received` 父侧节点，区别于源 Worker 的 `delivery.integrated`；命令动作引用已注册的快捷指令身份，支持一次性/持续，不调用 Agent。允许的生命周期触发点以动作目录为准，本期不开放 `time.scheduled` 命令。remote、跟踪分支与认证只由用户自己的命令和 Git 配置决定。

初始化一次性保存默认关闭的持续示例模板及 main 挂载，读取不安装，用户删除后不重装。`hooks.list` 新增 `command_example:{template_id,worker_id,hook_id,hooks}`；无 main 返回 null。hooks 为 main 同源安全读面，项目页面与 main 管理区修改同一挂载、使用它的 revision。模板和实例编辑继续分离。

`worker.hook_update` 的完整 hook 只接受登记 ID、明确版本及可选 enabled，与顶层 enabled 互斥；Project 签名不变。选择版本保留挂载身份，不把安全摘要当私有定义回传。修改定义先 hooks.save，再明确更新挂载；复制为新的停用挂载，不复制执行记录。

通用命令以系统用户权限执行，不是沙箱。以所挂载 Worker 的真实目录运行，经过项目写门、Workspaces 串行区及冻结/同步/归档/实际 invocation 的执行前核验；输入非交互，运行时间与输出有界，去除 Agent invocation 凭证。命令执行使用[按 ref 的精确收据](target-branch-guard.md)，仅成功命令记录挂载分支的 before → after；失败或未开始不提供成功归因，无关 ref 不豁免。执行器使用 POSIX `/bin/sh -c`，最长 60 秒，累计输出最多 64 KiB，超时/超限回收进程组；不支持交互认证。公开读面仅返回退出码、超时/超限等安全状态和诊断，不公开命令原始输出或秘密。成功合并使用持久事件身份去重，连续触发在开始前持久等待；失败和 unknown 停止挂载未来执行，显式重新启用只恢复未来触发，不自动重放旧动作。失败不会撤销成功合并。

## 定时 Hook 增补（用户决定 #266）

定时仍是 Worker 附属 Hook，不新增 Host 调度、业务实体或 Agent 权限。用户确认：一次性与每日固定时间；停机错过跳过；到点持久提交非阻塞待执行动作，临时受阻时在首个安全点执行；允许重试失败与继续暂停，不恢复取消／验收／归档。

定义新增 `trigger:'time.scheduled'` 与 `schedule`：
- 一次性：`{kind:'once',at:'2026-10-08T00:05:00+08:00',timezone:'Asia/Shanghai'}`，at 必须带明确偏移／Z，归一为 UTC ISO；timezone 必须有效 IANA。挂载一次性须是未来时间，模板保存可保留原时间，但挂载过期模板明确拒绝。
- 每日：`{kind:'daily',time:'00:05',timezone:'Asia/Shanghai'}`，HH:mm、IANA 时区；对应 `mode:'persistent'`；一次性对应 `mode:'once'`。每日按本地日期最多一次；夏令时重叠取首次，缺失时间跳过当天。非定时规则不得带 schedule。

`create_worker`、`message` 和 `notify` 可用于 time.scheduled；新增 `retry_worker` / `resume_worker`，只允许定时，参数 `{type,target_id,profile?}`，目标限当前或直接父子、非 main/owner。retry 只处理 failed，resume 只处理 paused（不撤销尚未生效的主动暂停请求）；其他状态记录 skipped，不等待未来失败。普通消息继续已有生命周期准入，不自动复活失败 Worker。显式 profile 是完整运行覆盖、不含凭证；未指定沿用目标 Worker 已有设置，不隐式换账号。create_worker 仍挂在所选父身份，不改投分支。模板编辑同位置、同类型动作未提供 profile 保留已有私有覆盖；读面只给 model_selection 摘要，不回读 profile。message 使用目标既有运行设置，界面明确提示。

动作目录保留 `modes` 的旧生命周期限制；新增可选 `modes_by_trigger:{'time.scheduled':['once','persistent']}` 覆盖定时模式。所有表单以目录交集为准，不解除生命周期消息的一次性防递归限制。

挂载读面新增 `schedule?`、`next_run_at:string|null`、`pending_due_at:string|null`；state 增加 `skipped`（已错过／不适用），last_execution 保留 skipped 诊断与原 due_at。Worker Hooks 读面新增 `can_attach:boolean`，失败的 order/child 仅可挂载定时自重试（可组合纯告知），不放开其他终态挂载、创建或合并能力。paused 沿用活动挂载准入。failed 上允许停用／移除定时授权，不复活 Worker。

到点先持久记 occurrence 和 pending_due_at，再异步经原安全门执行；冻结、同步、实际收尾或清理中保留等待并公开固定安全原因，绝不绕过门禁。一次最多保留一项待执行，每日受阻跨天不累计排队。安全门已通过但执行开始后副作用未知，停止该挂载、禁止重放。目标取消、验收、归档、祖先关闭等永久不可用停止并留诊断。同规则多动作逐项收据，不重放已成功部分。

项目 daemon 用有界可取消定时器，关闭页面不影响执行，停机不自动启动项目或唤醒设备。恢复仅跳过停机期间未提交的过期 occurrence：一次性标 skipped 并停用，每日推进到启动时刻之后；停机前已持久提交、尚未开始动作的 pending 项仍继续等待安全点。已 started 的沿用 unknown/精确收据恢复，不盲目重试。运行期间定时器迟到不冒充停机错过。停用后重新启用不补跑停用期间 occurrence，保留已提交且未执行项；移除仅撤销未来授权，执行中不可移除。API 读取无副作用，shutdown 清计时器并等 Hook 写入收口。

定时定义复用既有 RPC／CLI 的文件与挂载接口，不新增 RPC；纯时间计算与 runtime 执行分离。

项目 daemon 的内置自动选择不挂在 Worker 上、不属于模板动作目录；W118 / 决定 #267 的开关、来源与接口见[daemon 自动选择契约](daemon-auto-select.md)。

## 时间信号与管理型 Worker 增补

用户追加需求与决定 #270 引入项目内具名时间信号及独立管理 Worker；并非放开开发 Agent 的用户专属权限。产品授权、数据字段、专用受限工具和 RPC 见[时间信号与管理契约](hook-signals-management.md)。此前定时 Worker 规则继续原行为；管理输入还可即时安排，按最新设备接口权限执行，权限修改本身始终须用户确认，仍不负责开发／Git 交付。

## 中断完成信号（W216／D508）

`worker.interrupted` 与 main／owner 上的 `project.interrupted` 分别表示本次调用安全中断真正生效、当前项目维护批次全部安全收尾。两个新节点首版仅允许纯 `notify`，在维护期间可立即执行；普通 Hook 仍等维护解除。批次／调用绑定、自动一次性挂载、容量原子拒绝、未知副作用及全局汇总契约见[中断完成信号](interrupt-completion.md)。不能把 Worker 完成或旧成功通知冒充当前可重启。

## 触发目录

目录由后端统一提供，前端不得自行制造触发名称。每个节点返回 `{id,label,description}`。

| ID | 节点语义 |
|---|---|
| `agent.started` | invocation 正式开始 |
| `agent.returned` | 正常返回且实际退出；不等于工作完成 |
| `agent.failed` | 异常、超时或重启观测到孤儿调用；未知副作用不重放 |
| `agent.paused` | 用户安全暂停实际生效 |
| `agent.preempted` | 新输入安全抢占实际生效，不冒充失败 |
| `worker.interrupted` | 用户中断已生效且当前 invocation 真正退出；仅纯告知 |
| `project.interrupted` | 项目维护批次已确认安全收尾及真实空闲；挂在 main／owner，仅纯告知 |
| `worker.delivery_ready` | Agent 完成工作且后代、消息、待决已收口；合并动作仍复核 Git |
| `worker.frozen` | 整体分支写冻结从无到有 |
| `worker.unfrozen` | 最后一项分支写冻结释放 |
| `worker.parent_ready` | 当前父 Worker 已通过创建准入，预约发射使用此节点 |
| `delivery.requested` | 目标接收已授权且已固定的交付；处理策略已在固定事务选定，仅系统处理器使用，不允许自定义挂载 |
| `worker.merge_received` | 子 Worker 的交付成功合入当前父 Worker，在父侧触发 |
| `worker.awaiting` / `worker.resumed` | 待决出现／解除 |
| `delivery.integrated` / `delivery.suspended` / `delivery.blocked` | 交付落地／挂起释放执行位／未知现场保留执行位 |
| `worker.accepted` / `worker.cancelled` | 明确验收／取消 |

每次触发使用持久 Event ID（或可重建的来源身份）去重。冻结和就绪是状态边缘，不靠 UI 轮询触发；挂载新的 parent_ready 一次性规则时也检查已经可用的父。读 API 不执行动作。

## 定义与安全投影

```js
// 用户创建的模板/挂载定义；最多 4 个有序动作。
{
  name: '解冻后发射', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
  conditions: { statuses: ['waiting'], integrations: ['none'] }, // 条件可省略，空数组表示不限
  actions: [
    { type: 'create_worker', content: '目标', references: [], start: true, profile: {/*完整运行覆盖*/} }
  ]
}
```

`mode` 是 `once|persistent`；条件只允许现有 Worker 状态和 integration 枚举，无脚本。动作：
- `command`：注册定义为 `{type,command_id,command_version?}`，省略版本时注册固定当前版；挂载复制明确版本，不允许内联 Shell。旧未升级挂载兼容与真实历史版执行见[快捷指令契约](shortcut-commands.md)。一次性/持续，真实目录和安全边界见上节；不调用 Agent。
- `request_merge`：只在 `worker.delivery_ready`，通过现有请求及父自有队列。
- `create_worker`：只在 `worker.parent_ready`，只允许 `once`；所挂载的 Worker 就是父，不允许动作改投任意分支。保存完整有效 profile，不保存凭证快照。
- `notify`：`{type,title,body}`，纯 `info` 告知，不创建待决、不唤醒 Agent。
- `message`：`{type,target_id,body}`，首期仅允许 `mode:'once'`，防止返回→消息→调用的无限付费循环；目标仅当前或直接父子；发信通过既有消息准入，触发链有硬边界，不能自动重试调用。会安排 Agent 调用，UI 必须提示代价。

模板定义同形，但未填 profile 的 create_worker 在实际挂载时冻结默认。`worker.hook_attach` 的 hook 只能为 `{template_id:UUID,template_version:N,enabled?}`，服务器复制该版本完整私有定义，不能把裁去 profile 的安全读面当作完整参数回传；以后编辑注册定义不修改实例。同一位置的 `create_worker` 编辑时省略 `profile` 会保留模板已有私有覆盖，显式提供则替换；前端新增或移动创建动作要求显式设置参数，避免从安全读面重建秘密。普通读面必须剔除完整 profile/Prompt/env，仅给 `model_selection` 的无秘密摘要；事件不得包含秘密或任意运行错误输出。

持久化采用附属 versioned JSON（如 `tasks.hooks`、项目模板 `meta`），不新增核心业务实体。现有 `tasks.auto_merge` / `tasks.reservation` 保持兼容，自动合并投影为内置挂载 `id:'auto-merge'`，触发为 `worker.delivery_ready`，持续、启用、锁定/可编辑原因复用 `autoMergeView`。派生 child 的合并—验收—归档流程 Hook 整体对用户只读，旧开关及挂载入口也不能修改；其他受控自定义规则保留原权限。此阶段不批量迁移历史行。

Worker 详情展示为「自动化」。来源结束规则与目标内部处理器复用工具目录和安全操作读面；worker.hooks.convergence 只兼容历史配置，不另保存授权。持续归并的挂载／启停／未来默认已退休，新 main／order／child 不安装策略；普通单项与自动合并保持 serial，child 结束流程锁定不变。一次性整合是显式用户操作，不是新 Hook 或持续默认，见[实施接缝](merge-convergence-implementation.md)。

## 系统工具与持久操作

`request_merge`、`accept_worker`、`integrate_deliveries` 在动作目录中标记 `execution:'operation'`，由同一内部工具分发接入现有交付与验收引擎。通用 Hook 与内置来源规则请求交付使用同一工具。该内部入口不是公共 RPC，不增加 Agent、管理 Worker 或 Shell 的权限。

- `request_merge`：来源本轮交付就绪时提交合并意图；Hook 动作成功只证明请求提交，不证明交付完成。无代码成果仍可合法交付，不制造空 Squash。
- `accept_worker`：受既有最高级别或显式验收授权约束，仍 `builtin_only:true`；复用统一安全验收，不允许自定义安装、丢弃脏现场或连带验收独立指令。
- integrate_deliveries：builtin_only、scope=target，目录保留 serial／converge 以解释旧记录；新普通请求固定为 serial，不按历史 enabled 分流，不提高来源自动级别。原固定旧请求继续原路由，不转换或重放未知操作。

适用目标 mounts 仍含不可普通编辑／复制／移除的 delivery-handler，当前动作投影为 serial；operation 可保留原固定 converge 尝试的真实状态。处理器内部兼容不恢复持续归并 UI 或 setter。worker.completion 的来源授权入口不变，模板不能安装受保护工具；新一次性操作使用[整合接口](../reference/rpc/convergence.md)，也不改变来源验收授权。

系统工具挂载的 `operation` 为 null 或以下安全摘要：

```js
{
  version: 1, id: '固定操作身份', tool: 'request_merge',
  status: 'submitted', // submitted | waiting | running | succeeded | failed | unknown
  worker_id: 7,
  delivery_id: 123, // 以下关联字段按真实证据可选
  run_id: 4, generation: 2, round: 0, strategy: 'converge',
  created_at: 'ISO 时间', finished_at: 'ISO 时间', error: '安全诊断'
}
```

操作关联本轮、授权及精确持久收据，不能用当前可变分支、目录配置或旧轮成功推断完成。`succeeded` 表示对应真实交付处理／验收已收口；不证明测试或业务质量。读取不得推进队列、发射事件、安装配置或恢复副作用；原 v1/v2 与旧 v3 command 在途继续原协议，未知结果不得自动重放。

## Project / RPC / HTTP

以下新增 RPC 全部用户专属，包括读面；Agent 不能借 Hook 安装获得用户权限。输入参数严格白名单。

| RPC | 参数 | Project 方法 | HTTP 读面 |
|---|---|---|---|
| `hooks.list` | 无 | `hooksList()` | `GET /api/hooks` |
| `hooks.save` | `template`（可带 id）, `expected_revision` | `saveHookTemplate(template,expectedRevision)` | POST action |
| `hooks.remove` | `id`, `expected_revision` | `removeHookTemplate(id,expectedRevision)` | POST action |
| `worker.hooks` | `id` | `taskHooks(id)` | `GET /api/worker/ID/hooks` |
| `worker.hook_attach` | `id`, `hook`, `expected_revision` | `attachTaskHook(id,hook,expectedRevision)` | POST action |
| `worker.hook_update` | `id`, `hook_id`, `enabled` 或完整 `hook`（互斥）, `expected_revision` | `updateTaskHook(id,hookId,enabled,expectedRevision,hook=null)` | POST action |
| `worker.hook_remove` | `id`, `hook_id`, `expected_revision` | `removeTaskHook(id,hookId,expectedRevision)` | POST action |

`hooks.list` 返回 `{version:1,revision,registry,triggers,actions,templates,...}`；registry 的完整目录、真实计数、有界目标和显式升级协议见[注册目录接口](../reference/rpc/hooks.md#rpchttp-与-cli)。内置完工／告知及受保护交付、输入信号、维护告知和预约发射在可信 bootstrap 注册；系统挂载关联登记 ID/版本，仅专用入口可配置，不开放通用 raw Project attach。读取不登记、不迁移旧行；actions 目录包含 `{type,label,description,triggers,modes,agent_call,builtin_only?,execution?,scope?,strategies?}`，`modes` 是支持的 `once|persistent` 数组，组合规则只能使用全部动作都支持的模式；templates 为 `{id,...安全定义}`。

`worker.hooks` 和所有挂载修改返回包含 `{version:1,worker_id,revision,mounted_features,mounts}` 的同源安全读面；实际挂载与未来 scope 的精确字段见[项目自动化接口](../reference/rpc/hooks.md#新指令默认流程)。每项为 `{id,name,trigger,mode,enabled,builtin,locked,editable,removable,reason,conditions,actions,state,last_execution,model_selection?}`；state 为 `idle|waiting|running|succeeded|failed|unknown`；last_execution 可空，否则为 `{id,trigger,status,created_at,finished_at,error?,worker_id?,worker_number?,input_id?}`，其中 error 仅为安全诊断。revision 为不透明字符串；所有修改要求读面给定的 expected_revision，过期拒绝并保留客户端编辑。

`worker.inspect` 的 `hooks` 是同一读面（不得把私有 JSON 原样展开）；`input.parents` 每项新增 `freeze`（可空）供输入按钮解释预约，不删除有效但冻结的父候选。

公开 `order.submit` 缺省/start:true 现统一可靠挂载输入，收据、条件、准入与恢复见[条件发射](conditional-emission.md)，不再要求显式 defer。显式 start:false 仍走仅创建原语；内部 Project order/sendOrder、submitBufferedDraft 及历史 create_worker Hook 保留原 defer 行为，不迁移旧挂载。旧 hook_mount 占用仍保护版本与正文，成功才关联 input_id；等待／明确失败时可释放，unknown 不因重启重放。新的条件信号使用受保护 input_signal 挂载，不能借普通启停／删除绕过草稿占用，须经 input.emission_cancel 或 input.exclusive_release。

`editable` 与 `removable` 分开：启用/停用沿用活动 Worker 准入；父已取消、验收或归档时，未运行的自定义挂载仍可移除，释放 Draft 授权，不写分支、不复活 Worker。运行中的挂载及内置自动合并不可移除。

## CLI

用户专属 CLI：`hooks list`、`hooks save --file PATH --revision REV`、`hooks register --file PATH`（只注册 Shell 指令和功能）、`hooks upgrade --revision REV`（显式补登记旧规则）、`hooks remove TEMPLATE_ID --revision REV`；`worker hooks ID`、`worker hook attach ID --file PATH --revision REV`、`worker hook enable|disable|remove ID HOOK_ID --revision REV`；`order --defer` 保留旧参数兼容，新发射缺省即可靠挂载，条件用 --after-settled/--after-merged/--quiet，独占用 --exclusive。定义文件必须是有界、owner-only、非链接 JSON，revision 从对应读面取得，不提供跳过乐观锁的快捷入口。

CLI 的挂载 Worker 身份遵循父侧编号接缝：允许整数或 `Wn(-n)*`，经 `worker.lookup` 转成真实整数后调用原 RPC；Hook UUID、模板 UUID、`message.target_id` 仍保持原身份。Web Hook 标签用持久编号，创建收据补安全 `worker_number`、消息动作读面补 `target_worker_number`；仅做投影，不回写定义、收据或历史行，不从整数猜编号。消息目标表单明确要求内部整数 ID；读面附属标签不能当作定义字段回传。

## 执行与恢复

- 配置持久化、动作领取和执行结果分离；动作逐个去重，部分失败如实记载，不能重复前面已成功动作。
- 一次性 Worker 挂载仅在 `succeeded` 后自动移除（预约发射、生命周期、命令和定时共用此边界）；结算、成功审计与自动 `hook.removed` 同事务保存，移除事件带 `automatic:true` 与 execution_id。动作收据、Worker/Input、草稿已发射关联、模板和持续挂载保留；最后一项移除将 `tasks.hooks` 清为 NULL，释放挂载容量。失败、unknown、skipped 与待执行挂载保留。启动恢复会清理旧版本保留的成功一次性挂载，并对精确收据确认成功的中断动作同样清理；读 API 不执行清理，不重放动作。
- create_worker 的触发领取先持久化；调用现有 order 路径受写 gate 和串行 Git 保护，最后再次检查分支冻结及身份。`Workspaces.anchor(inputId,requestedBranch,guard?)` 增补可选同步 guard，在串行 Git 区内创建前复核，不改变现有调用；sendOrder 在落库前再次核验，失败只回收本次自建 anchor。创建事务保存关联 Hook 执行身份，成功关联真实 Worker/Input。
- 父队列每项释放执行位后，先给已挂载创建 Hook 一次有界准入机会，再推进下一项。仍有冻结或同步时等待；不能跨源侧修复释放父执行位。
- 不持有 Git 锁跨 Agent 调用，不新增永久 token、父 Agent 调用或调度进程。shutdown 等待本项目在途 Hook 写入并禁止新动作。
- 重启只恢复明确尚未执行的等待项；running 动作有精确成功关联可收口，否则标 unknown 留诊断，不自动重放。历史 hook 开关、合并请求和旧人工确认保持原义。
- 规则数量、定义字节、执行记录和每轮处理数有硬上限；动作触发链有硬边界，禁止递归无限调度。读取不泄漏 env、Prompt、凭证或原始异常。

公开 RPC 出口通过 `src/rpc/public-result.js` 递归去除 `retry_profile` 与字符串私有 `hooks` / `auto_merge`（后者可含自动链收据），保留对象形式安全 Hooks、自动合并和 completion 投影；仅在授权 Agent 配置/环境路径保留合法同名字符串键，普通 Worker mutation 不例外。

## 模块职责

纯目录／时间定义、Project 领取／执行／恢复、Git 写边界及用户界面各守自己的职责，精确定位见[模块地图](modules.md)。接口转发不能绕过 runtime，前端只消费安全投影，不复制调度或权限规则。

## 验证与交付限制

`test/project/automation-registry.test.js`、`automation-registry-bridge.test.js` 覆盖注册硬边界、明确版本、显式升级、只读、并发 revision 及可控 Provider → 真实 bridge 的默认自动注册／独立挂载、权限收紧后分别确认或禁用，以及真实 Shell 收据。`hooks.test.js`、`hooks-command.test.js` 和 `hooks-scheduled.test.js` 保留定义、真实命令和定时提交主流程。独立 RPC／HTTP 权限、私有字段出口、时区／DST、冻结、失败重试及重启组合不再逐项回归；精确保留范围以测试断言为准，不将少量冒烟当作旧矩阵的等价替代。

测试使用临时项目、可控 provider 与 DOM，不重启用户 daemon/Host、不调用真实模型。当前保留主要执行与界面路径，不再保证每种异常、暂停、冻结及重启 unknown 组合都有独立回归；覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。真实浏览器和实际模型端点另行验收。
