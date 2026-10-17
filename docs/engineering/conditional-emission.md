# 条件发射与管理输入

本文记录发射的持久授权、条件信号与安全准入边界（W240 / D565）。用户操作见[历史输入与暂存](../input-history.md)，管理权限见[管理型 Worker](hook-signals-management.md)。历史记录、旧已挂载 Hook 和内部 `sendOrder` 创建原语不迁移。

## 已确认的行为

- 发射是可靠挂载输入意图；父 runtime 在真实空闲、安全可写时才创建并开始开发 Worker。main/owner 不因此调用模型。明确选定的其它父身份不改投 main，实际创建时才固定代码基线。
- 条件发射保存一次性授权；多个条件全部满足。提供指定 Worker 工作安全收尾、指定 Worker 本轮成果已合入 main、目标树彻底静息三种条件；不以 invocation 返回或旧轮合并满足新轮需求。条件对应信号使用 Worker 附属 Hook，条件满足只通知输入意图，实际创建另受父准入约束。已经满足的条件须可核验，不等待永远不会再次出现的边缘。
- 彻底静息覆盖目标树及在途交付：暂停、失败、待开始、尚未合并开发工作阻塞。已明确取消或验收的工作、已安全交付的无代码成果不要求虚构合并；取消但有未处理脏现场仍阻塞。已合并且静息待验收不阻塞，新一轮追加与未处理消息再次阻塞。
- 另提供独占开发选项，先静息，再从创建到本轮安全交付与合并收口暂缓其它开发创建及调用；允许独占 Worker 自己的后代、管理、查询及交付。不自动提高合并授权。失败、待决及暂停应公开占用与阻塞原因，用户可显式撤销独占意愿而不丢弃工作。
- 新建与追加输入都支持暂存、编辑及条件发射；暂存不启动 Agent。追加在合法目标上复用消息持久入箱和冻结等待门禁，不伪造 O 编号，不复活终态目标，不静默改投。保留引用及原文，未支持的引用必须明确拒绝且不消费输入。
- 管理输入创建隔离的管理 Agent，不创建开发 Worker、Git 分支或开发 Input；复用现有 manager/management 持久身份、独立提示词、可信受限工具和无 Git 工作目录，不能提供 bash/read/edit/write 或加载项目开发上下文。

## 输入接口

新增用户专属 `input.emit`，Project `emitBufferedInput(options)`：

- 直接路径 `{content,references?,branch?,mode?:'order'|'append',target_id?,conditions?,exclusive?,profile?,client_request_id?}`。
- 版本草稿路径 `{draft_id,expected_revision,profile?,client_request_id?}`；正文、模式、条件和目标从草稿取，不允许覆盖。
- 返回 `{emitted:true,draft_id,mode,parent_id?,target_id?,dispatch}`，不保证有 `task`。`dispatch` 安全读面至少 `{state,reason?,input_id?,worker_id?,worker_number?,message_id?}`；state 为 `waiting_conditions|queued|dispatching|succeeded|failed|unknown|cancelled`。发射确认只表示挂载成功，不能显示“已创建/已开始”。
- 新提交即使可立即创建也先给持久挂载收据，由 runtime 异步推进；重复请求、断连重试必须按 `client_request_id` 和版本去重。
- `draft.add/update` 扩展 `{mode?,target_id?,conditions?,exclusive?}`，旧调用省略保持 order；旧方法可增加末位 options，不破坏现有内部调用。读取 `input.get/history` 的 draft 项提供 `mode,target_id,target_worker_number,conditions,exclusive,dispatch` 安全字段。挂载中不能编辑/删除；增加 `input.emission_cancel {draft_id,expected_revision}` -> `cancelInputEmission(draftId,revision)`，仅撤销尚未执行的意图/条件 Hook。已开始未知不能盲目解除或重放。
- 条件 JSON：`[{kind:'worker_settled',worker_id:整数},{kind:'worker_merged',worker_id:整数},{kind:'parent_quiet'}]`，最多 16 项，无脚本。worker_merged 明确是本轮成果到 main，不把 child 到直接父的合并等同 main。exclusive 为 boolean，仅 order，隐含 parent_quiet；append 不提供独占。
- 条件等待、发射已挂载、实际创建/追加分别投影；queued/条件等待的草稿不能消失。实际新建关联真实 Input 后，原稿页仍能追踪其原始 Input；追加成果只关联真实 Message/追加编号，不造 O。
- 旧内部 `order/sendOrder` 继续是创建原语，Hook legacy create_worker 行为不变。公开 `order.submit` 缺省及 start:true 改走 emit；显式 start:false 保留兼容“仅创建”入口但不是发射，Web 新入口不再宣传两种发射。`worker.message` 保留现有 API，新统一 UI 经 input.emit 发送追加。
- `input.exclusive_release {draft_id,expected_revision}` 只释放独占意愿，不取消开发、不重放未知发射。安全投影 `dispatch.exclusive_active`、`dispatch.can_release_exclusive` 为明确布尔值；只有持有独占且状态为 `succeeded|unknown` 才可释放，不允许解除 `dispatching` 中的占用。

## 管理入口

新增用户专属 `management.submit {instruction,profile?,client_request_id?}`，Project `submitManagementInstruction(options)` 返回 `{management:true,task:安全管理记录}`；独立入口可立即安排管理 Agent，不要求时间信号。已有信号管理 Worker 原契约继续可用。管理结果入口复用现有管理详情/执行记录，不展示开发合并控件。

可信管理工具新增能力目录、历史查询与受控调用：`manager.catalog`、`manager.history`、`manager.call {method,params,request_id?}`，专用 RPC 后端同时核验 invocation 身份/当前授权；具体安全目录由 `src/rpc/management-policy.js` 提供。不能让普通开发 Agent 获得这些方法，不能将 manager token 当作用户 token。

作用域为当前项目，设备共享设置必须在管理指令及工具参数中显式指定；不跨项目，不读取原始凭证。全部当前 Lush 功能可发现；不适用或需交互的能力明确说明原因，不能宣称一切已实现。

查询、诊断、有界执行历史、草稿编辑、条件设置、发射和合法追加可自动执行。取消、验收回收、删除、快捷指令保存／删除等管理操作、敏感配置和服务操作必须先持久预检、展示精确请求，用户确认后经原引擎执行；快捷指令管理的确认范围见[管理契约](hook-signals-management.md#产品和授权)，不是恢复指令预授权。管理模型不能确认自己的请求。保留旧 token、冻结、脏现场、生命周期及未知副作用门禁，操作有审计和去重。账号/设置安全读面不得泄漏秘密；设备操作不可通过泛化 method/params 绕过授权。Web 用现有 Notice 待决入口承载精确请求与预检；确认回执由 runtime 执行，不再次唤醒模型重发。自动选择必须跳过管理授权问卷，管理模型不能答复自己或其它管理调用的授权。

## 持久化与恢复

`drafts.input_options` 保存模式、目标和条件；旧节点选择原文保留但不再生效，见[执行节点退役](execution-model.md#单机执行与执行节点退役)。`drafts.emission` 保存授权快照、请求指纹、条件信号与发射收据。附属 JSON 列为 nullable，不回填历史。条件对应受保护的内置 `input_signal` Hook，不能经自定义 Hook 安装、改写或解除发射占用；撤销入口负责一致地清除信号。多个条件必须全部满足，满足证明含当前轮次与精确向 main 的交付链，不以标题或旧合并状态猜测。

先提交挂载收据，再异步准入；跨 Git 等待后重新核验父空闲、冻结、基线、草稿占用和独占门。挂载中拒绝编辑与删除。取消未开始的意图可恢复可编辑草稿；已经开始却无确定结果的发射标记 `unknown`，重启不重放。只释放未知独占仍保留未知收据。已挂载追加阻止目标验收、归档或删除吞掉需求，实际投递仍沿用消息收件箱门禁。

实现入口为 `src/core/project/input-emissions.js`、`input-emission-safety.js` 与 `input-emission-data.js`；公共适配为 RPC 输入 handler、Web action 与 CLI `order`。`test/project/input-emissions.test.js` 保留代表性条件发射主流程；管理授权及完整 HTTP／main 交付组合不再独立回归，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。受控 Provider 不代表真实模型或物理浏览器验证。
