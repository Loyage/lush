# Worker Hooks 工程接缝

本文记录用户决定 #197 对应的首期实现接口与模块边界；设计目标见[Worker Hooks](../design/hooks.md)，使用流程见[Hooks 与预约发射](../hooks.md)。用户决定 #202 的追加实现以[合并—验收—归档自动链](completion-hooks.md)为准，覆盖最高级别、串行门禁与成功静默告知。触发目录不是测试证明，验证入口和实际验收限制见末节。

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

分区：runtime 子 Worker 负责 `src/core/hooks.js`、新增纯时间计算模块及 project Hooks/调度恢复接缝、`test/project/*scheduled*` 和纯计算测试；前端子 Worker 负责 `src/ui/web/assets/` Hooks 表单/渲染/状态与 DOM 测试；父 Worker 负责文档、接口白名单相关必要适配和跨区联调。现有 RPC/CLI 复用定义文件与挂载接口，无新增 RPC。

项目 daemon 的内置自动选择不挂在 Worker 上、不属于模板动作目录；W118 / 决定 #267 的开关、来源与接口见[daemon 自动选择契约](daemon-auto-select.md)。

## 时间信号与管理型 Worker 增补

用户追加需求与决定 #270 引入项目内具名时间信号及独立管理 Worker；并非放开开发 Agent 的用户专属权限。产品授权、数据字段、专用受限工具、RPC 和分区见[时间信号与管理契约](hook-signals-management.md)。此前定时 Worker 规则继续原行为；管理 Worker 首版仅查询、开始／继续及重试失败，不负责开发／Git 交付。

## 触发目录

目录由后端统一提供，前端不得自行制造触发名称。每个节点返回 `{id,label,description}`。

| ID | 节点语义 |
|---|---|
| `agent.started` | invocation 正式开始 |
| `agent.returned` | 正常返回且实际退出；不等于工作完成 |
| `agent.failed` | 异常、超时或重启观测到孤儿调用；未知副作用不重放 |
| `agent.paused` | 用户安全暂停实际生效 |
| `agent.preempted` | 新输入安全抢占实际生效，不冒充失败 |
| `worker.delivery_ready` | Agent 完成工作且后代、消息、待决已收口；合并动作仍复核 Git |
| `worker.frozen` | 整体分支写冻结从无到有 |
| `worker.unfrozen` | 最后一项分支写冻结释放 |
| `worker.parent_ready` | 当前父 Worker 已通过创建准入，预约发射使用此节点 |
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
- `request_merge`：只在 `worker.delivery_ready`，通过现有请求及父自有队列。
- `create_worker`：只在 `worker.parent_ready`，只允许 `once`；所挂载的 Worker 就是父，不允许动作改投任意分支。保存完整有效 profile，不保存凭证快照。
- `notify`：`{type,title,body}`，纯 `info` 告知，不创建待决、不唤醒 Agent。
- `message`：`{type,target_id,body}`，首期仅允许 `mode:'once'`，防止返回→消息→调用的无限付费循环；目标仅当前或直接父子；发信通过既有消息准入，触发链有硬边界，不能自动重试调用。会安排 Agent 调用，UI 必须提示代价。

模板定义同形，但未填 profile 的 create_worker 在实际挂载时冻结默认。`worker.hook_attach` 的 `hook` 也可为 `{template_id:UUID}`，由服务器复制完整私有定义，不能把裁去 profile 的安全读面当作完整参数回传。挂载时复制模板；以后编辑模板不修改实例。同一位置的 `create_worker` 编辑时省略 `profile` 会保留模板已有私有覆盖，显式提供则替换；前端新增或移动创建动作要求显式设置参数，避免从安全读面重建秘密。普通读面必须剔除完整 profile/Prompt/env，仅给 `model_selection` 的无秘密摘要；事件不得包含秘密或任意运行错误输出。

持久化采用附属 versioned JSON（如 `tasks.hooks`、项目模板 `meta`），不新增核心业务实体。现有 `tasks.auto_merge` / `tasks.reservation` 保持兼容，自动合并投影为内置挂载 `id:'auto-merge'`，触发为 `worker.delivery_ready`，持续、启用、锁定/可编辑原因复用 `autoMergeView`。此阶段不批量迁移历史行。

## Project / RPC / HTTP

以下新增 RPC 全部用户专属，包括读面；Agent 不能借 Hook 安装获得用户权限。输入参数严格白名单。

| RPC | 参数 | Project 方法 | HTTP 读面 |
|---|---|---|---|
| `hooks.list` | 无 | `hooksList()` | `GET /api/hooks` |
| `hooks.save` | `template`（可带 id）, `expected_revision` | `saveHookTemplate(template,expectedRevision)` | POST action |
| `hooks.remove` | `id`, `expected_revision` | `removeHookTemplate(id,expectedRevision)` | POST action |
| `worker.hooks` | `id` | `taskHooks(id)` | `GET /api/worker/ID/hooks` |
| `worker.hook_attach` | `id`, `hook`, `expected_revision` | `attachTaskHook(id,hook,expectedRevision)` | POST action |
| `worker.hook_update` | `id`, `hook_id`, `enabled`, `expected_revision` | `updateTaskHook(id,hookId,enabled,expectedRevision)` | POST action |
| `worker.hook_remove` | `id`, `hook_id`, `expected_revision` | `removeTaskHook(id,hookId,expectedRevision)` | POST action |

`hooks.list` 返回 `{version:1,revision,triggers,actions,templates}`；actions 目录包含 `{type,label,description,triggers,modes,agent_call}`，`modes` 是支持的 `once|persistent` 数组，组合规则只能使用全部动作都支持的模式；templates 为 `{id,...安全定义}`。

`worker.hooks` 和所有挂载修改返回 `{version:1,worker_id,revision,mounts}`。每项为 `{id,name,trigger,mode,enabled,builtin,locked,editable,removable,reason,conditions,actions,state,last_execution,model_selection?}`；state 为 `idle|waiting|running|succeeded|failed|unknown`；last_execution 可空，否则为 `{id,trigger,status,created_at,finished_at,error?,worker_id?,worker_number?,input_id?}`，其中 error 仅为安全诊断。revision 为不透明字符串；所有修改要求读面给定的 expected_revision，过期拒绝并保留客户端编辑。

`worker.inspect` 的 `hooks` 是同一读面（不得把私有 JSON 原样展开）；`input.parents` 每项新增 `freeze`（可空）供输入按钮解释预约，不删除有效但冻结的父候选。

`order.submit` 新增 `defer?:boolean`。未指定保持原创建语义；显式 true 允许冻结父保存一次性创建 Hook；父当前可写时仍直接创建并应用运行覆盖。末位 Project `order/sendOrder` 增加 `defer=false`，`submitBufferedDraft(draftId,revision,start=true,defer=false,profile=null)` 同样透传。仅当 `defer:true` 才允许 `draft_id+profile`，正文/引用/父仍只能取版本草稿；非 defer 草稿保持旧拒绝。挂载返回 `{deferred:true,parent_id,hook_id,hooks}`，不返回虚构 task；直接创建仍返回真实 task。`input.get(draft)` 增加 `hook_mount:{parent_id,hook_id,state}|null`；占用的 draft 拒绝编辑、删除和重复发射。创建成功才回写真实 input_id；等待／明确失败挂载停用或移除可释放版本占用，unknown 仅停用不释放，须检查现场后移除。占用关联保存在 Hook 附属 draft 身份，不引入第二套 Input 状态机。

`editable` 与 `removable` 分开：启用/停用沿用活动 Worker 准入；父已取消、验收或归档时，未运行的自定义挂载仍可移除，释放 Draft 授权，不写分支、不复活 Worker。运行中的挂载及内置自动合并不可移除。

## CLI

用户专属 CLI：`hooks list`、`hooks save --file PATH --revision REV`、`hooks remove TEMPLATE_ID --revision REV`；`worker hooks ID`、`worker hook attach ID --file PATH --revision REV`、`worker hook enable|disable|remove ID HOOK_ID --revision REV`；`order --defer` 显式允许冻结期间预约。定义文件必须是有界、owner-only、非链接 JSON，revision 从对应读面取得，不提供跳过乐观锁的快捷入口。

CLI 的挂载 Worker 身份遵循父侧编号接缝：允许整数或 `Wn(-n)*`，经 `worker.lookup` 转成真实整数后调用原 RPC；Hook UUID、模板 UUID、`message.target_id` 仍保持原身份。Web Hook 标签用持久编号，创建收据补安全 `worker_number`、消息动作读面补 `target_worker_number`；仅做投影，不回写定义、收据或历史行，不从整数猜编号。消息目标表单明确要求内部整数 ID；读面附属标签不能当作定义字段回传。

## 执行与恢复

- 配置持久化、动作领取和执行结果分离；动作逐个去重，部分失败如实记载，不能重复前面已成功动作。
- create_worker 的触发领取先持久化；调用现有 order 路径受写 gate 和串行 Git 保护，最后再次检查分支冻结及身份。`Workspaces.anchor(inputId,requestedBranch,guard?)` 增补可选同步 guard，在串行 Git 区内创建前复核，不改变现有调用；sendOrder 在落库前再次核验，失败只回收本次自建 anchor。创建事务保存关联 Hook 执行身份，成功关联真实 Worker/Input。
- 父队列每项释放执行位后，先给已挂载创建 Hook 一次有界准入机会，再推进下一项。仍有冻结或同步时等待；不能跨源侧修复释放父执行位。
- 不持有 Git 锁跨 Agent 调用，不新增永久 token、父 Agent 调用或调度进程。shutdown 等待本项目在途 Hook 写入并禁止新动作。
- 重启只恢复明确尚未执行的等待项；running 动作有精确成功关联可收口，否则标 unknown 留诊断，不自动重放。历史 hook 开关、合并请求和旧人工确认保持原义。
- 规则数量、定义字节、执行记录和每轮处理数有硬上限；动作触发链有硬边界，禁止递归无限调度。读取不泄漏 env、Prompt、凭证或原始异常。

公开 RPC 出口通过 `src/rpc/public-result.js` 递归去除 `retry_profile` 与字符串私有 `hooks` / `auto_merge`（后者可含自动链收据），保留对象形式安全 Hooks、自动合并和 completion 投影；仅在授权 Agent 配置/环境路径保留合法同名字符串键，普通 Worker mutation 不例外。

## 模块职责

- Runtime：`src/core/hooks.js`、`src/core/project/hooks.js`、Project 装配、base、scheduling/lifecycle/messages/iteration/merge-queue/order/input-history/tasks 及 Store/schema 附属列、`workspaces/worktree.js` 的 anchor guard 小接缝，`test/project/*hooks*` 与受影响 runtime 回归。
- 接口：RPC registry/handlers、CLI 命令/帮助、Web server 路由，`test/hooks-api.test.js` / `test/web/hooks-api.test.js` 与接口回归；不修改 assets 或 runtime。
- 前端：新 `render-hooks.js`（`openHooks`、`workerHooks`）、`hook-form.js`（表单）、`styles-hooks.css`，详情/交付/Worker 图、composer/历史暂存、导航/app/index；DOM 测试。前端挂载按钮和模板按钮只用上述契约；自动合并仍走 `worker.auto_merge`。
- 父 Worker：设计/工程/使用文档、AGENTS 阅读索引、集成验证与跨区必要适配。接口或投影变动先告知父与关联分区，不互改文件。

## 验证与交付限制

`test/project/hooks*.test.js` 覆盖 runtime、生命周期、模板和恢复；`test/hooks-api.test.js`、`test/web/hooks-api.test.js` 覆盖 RPC/HTTP/CLI、权限、修订和文件入口；`test/rpc-public-result.test.js` / `test/web/rpc-public-result.test.js` 覆盖私有字段出口隔离；`test/web/dom-hooks*.test.js` 与输入 DOM 测试覆盖界面状态。`test/web/hooks-runtime-integration.test.js` 使用真实临时 HTTP、RPC、SQLite 与 Git 联调，验证冻结预约、模板私有覆盖保留及终态父上的草稿释放。

定时补充验证入口：`test/hook-schedule.test.js`（定义、时区与 DST）、`test/project/hooks-scheduled.test.js`（真实／可控定时器、停机跳过、pending 恢复、门禁与去重）、`test/web/dom-hooks-scheduled.test.js`（时间表单、模式目录、运行覆盖与安全提示），以及 `test/web/hooks-scheduled-integration.test.js`（真实 HTTP/RPC/SQLite/Git：自动到点创建、失败重试／暂停继续、私有覆盖保留、冻结待执行与当前 tip、错过一次性禁止回拨重启）。提交、错过、skipped 的中文事件标签由 `test/web/event-labels.test.js` 覆盖。

测试使用临时项目、可控 provider 与 DOM，不重启用户 daemon/Host、不调用真实模型。覆盖：正常返回与交付就绪区别、异常/暂停/冻结边缘、自动合并锁定、冻结期间参数与默认快照、首次安全点、公平与创建恰好一次、重复提交/草稿版本、权限/白名单、禁用/取消、去重及重启 unknown、秘密投影、模板实例隔离、迟到响应与按钮调用标识。真实浏览器和实际模型端点另行验收。
