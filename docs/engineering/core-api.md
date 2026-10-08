# 核心 API 收敛

本页给维护者列出当前对外可调用的 Worker 中心接口；权威白名单在 `src/rpc/registry.js`，HTTP 写入口另受 `src/ui/web/server.js` 限制。

## Worker 更名与兼容边界

Worker 是原 Task 的整体更名，含义仍是持久的 Agent + Process；父Worker、子Worker、状态、权限与交付生命周期不变。实体名称不再与历史 `role='worker'` 混为一谈：新 指令/child 的角色仍为 `agent`，历史角色值不改写。

这是**破坏性的公开接口命名变更**，旧入口不保留别名：

- CLI 使用 `lush worker …`；Notice 参数使用 `lush notice post … --worker ID`；运行设置命令使用 `lush config set worker-call-limit N` / `lush config reset worker-call-limit`。旧 `lush task`、`--task`、`task-call-limit` 不再可用。
- RPC 使用 `worker.*`，旧公开 `task.*` 方法一律拒绝；`notice.post` 的参数仍叫 `task`，`system.configure` 的设置键仍为 `task_call_limit`。
- HTTP 使用 `/api/worker/<id>` 及其读取后缀、`/api/workers`、`/api/worker-graph`；旧 `/api/task/<id>`、`/api/tasks`、`/api/task-graph` 返回 404。Web 写动作同样使用 `worker.*`。
- 浏览器使用 `#worker-ID`、`#workers`、`#worker-graph`；执行详情仍在 Worker 详情中显式点击打开，没有独立 hash；旧 Task hash 不作为兼容入口。全局模式的项目路由前缀 `/p/<project-id>/` 不变。

此次更名**不迁移既有数据、不改已有分支/worktree/会话目录**。以下是有意保留的内部与数据契约，不是旧公开入口的别名：

- SQLite 表 `tasks`、`task_deps`、`task_specs` 等，以及 `task_id` / `task_kind` 等列、`tasks.reservation`、`tasks.auto_merge` 与相关 `meta` / 聚合键。
- 返回对象中的 `task` / `tasks`、`task_id` 等字段；`notice.post {task,…}`、引用 `target.kind='task'`、代码读面 `scope='task'` 与固定输入规则的 `task` JSON 字段。
- 环境变量 `LUSH_TASK_ID` / `LUSH_TASK_CALLS`、设置文件与 RPC 中的 `task_call_limit`。
- 内部函数/变量/导出名与源码、测试、文档文件路径；`.lush-task/input.mjs`、`.lush/task-rules/`、`task-<id>` 命名与现有 session/input 文件路径。
- Event / signal 的 `task.*` 名称（如 `task.accepted`、`task.merge_integrated`、`task.signal`、`task.idle`）与全部历史记录，不能机械改为 `worker.*`。

其它文档中保留的上述 `task` 拼写均按此边界理解；当前可调用的方法以公开白名单为准。

## 指令更名与历史读取边界

用户提交入口统一为 **order（指令）**：CLI 使用 `lush order`，源码快捷命令使用 `bun run order`，RPC 与 Web 写动作使用 `order.submit`。旧 `say`、`say.submit` 与 `bun run say` 全部移除，不保留公开别名；旧客户端必须更新。

新记录使用 `task_kind='order'`。历史数据库中的 `task_kind='say'` 仅在读取、类型判定及生命周期准入边界兼容为指令 Worker，展示统一为「指令」；这不是新增旧入口，也不是迁移。既有行、分支名、工作区、会话、Event 与引用快照保持原样，不批量回写。源码中的相关函数、变量、类名和测试 fixture 改用 order / Order / ORDER；模块路径为 `src/core/project/order.js`，职责见[Runtime 地图](modules-runtime.md)。

读取实现由 `src/core/order-kind.js` 的 `normalizeOrderRecord(row)` 与 Store `get` / `all` 行投影负责，SQL 类型筛选兼容两种值；新默认名称为 `order-ID`，旧名称不回写。新建 指令/child 另带不可变、可空的 `worker_number`：指令为 `W<Input id>`，已编号父下的 child 为父编号加持久同父序号，历史 Worker 与其新派生后代保持 NULL；数字内部 ID 仍是唯一的存储、鉴权、引用 target、路径与合并身份。当前子指令数读面使用 `subtree_order`，历史 `say.integrated` Event 仅兼容读取，原始审计不改写。具体职责见[Runtime 地图](modules-runtime.md#指令类型的只读兼容接缝)。

Input（原始输入）、历史输入、Draft（暂存）仍是各自的实体与界面名称；「指令」只替代原 say 概念，不把它们一并更名。上述兼容的历史指令 Worker 继续按原交付协议受检；下文关于退休 Intent / Plan 等记录的限制不表示历史指令被退休。

## 设备共享设置与兼容

W116 / 待决 #261 批准设备同系统用户共享技术配置，项目/Worker 可覆盖；项目事实/历史/Git/调度及 `LUSH_HOME` 绑定不变。新增用户专属 `system.settings {scope?}`、`settings.clear_override {kind,target?}`、`settings.migration.preview {}`、`settings.migration.apply {revision,confirm:true}`。既有设置/来源/安装管理 RPC 增可选 `scope=device|project`，省略仍选 project，Agent token 不能访问 device scope；Worker 与历史接口不因此全局化。

无项目 Host 提供窄 `/api/host/settings/**` 用户管理入口，不是通用 RPC 代理。CLI `config ...` / 配置类 `agent ...` 可显式 --scope；`config migrate` 预检、带 confirm/revision 执行。字段、优先级、迁移与限制以[设备共享设置](device-settings.md)为权威；组合交付的实际验证另记录，不把接口登记当作功能已验收。

## 核心工作流

- `order.submit`：一条用户输入创建一个有独立分支/worktree 的指令 Worker；显式 `defer:true` 且父冻结时则先保存父可创建安全点的一次性 Hook，返回预约而非 task，真正创建时才固定基线；父可写时仍直接创建。`start:false`（Web 主发送默认）只创建为 `paused`（Web 显示「待开始」）且不调用 Agent；`start:true`（缺省）立即排队运行。main 自动确立静息 owner；其它现有本地分支须先 `branch.bind` 固定 HEAD。
- `input.history` / `input.get` / `input.parents` 与 `draft.add` / `draft.update` / `draft.remove`：用户专属历史输入与持久缓冲区；草稿通过 `order.submit {draft_id,expected_revision,start?}` 发射，不恢复旧 planner 或批量提交。字段、版本检查与分页见[历史输入接口](input-history.md)。
- `hooks.list/save/remove`、`worker.hooks/hook_attach/hook_update/hook_remove`：用户专属受控模板与挂载；自动合并是内置 Hook，执行收据与私有定义持久化，未知副作用不自动重放。见 [Hooks 工程契约](hooks.md)及 [接口参考](../reference/rpc/hooks.md)。
- `worker.completion {id,level,expected_revision}`：用户专属的最高自动级别 off/merge/accept/archive，按合并 → 安全验收 → 子树归档串行推进；高级别不继承，child 至少合并，交付后可显式提高补办。成功自动环节不告知，只提示下一人工环节；失败/unknown 不重放。见[自动链接缝](completion-hooks.md)。
- `worker.spawn`：只可在活动 指令/child 下派 agent 子 Worker；不再接受 role、deps 或 spec。
- `worker.message` / `notice.post` / `notice.answer` / `notice.dismiss`：继续沟通和决策。普通消息仍受目标生命周期、直接父子权限与合并冻结限制，main/owner 不是普通收件箱；发送失败不自动重投，见[消息准入与失败处理](../reference/rpc/tasks.md#追加消息的准入与失败处理)。
- 选择快照与重选已按 W138 停用；`notice.snapshot` / `notice.rechoose` 不在公开白名单中。历史资源兼容边界见[停用说明](choice-snapshots.md)。
- `branch.history {cursor?,limit?}`：用户专属只读 main 第一父链历史与精确交付 Worker / 原始指令追溯；Web `GET /api/versions`，不新增 CLI 写入口，见 [版本迭代](version-history.md)。
- `worker.inspect` / `worker.page` / `worker.graph` / `worker.diff` / `worker.history*` / `worker.transcript*` / `worker.runs_page` / `worker.artifacts_page` / `worker.artifact`：按需只读审阅；支持 CLI 与 Web。另有只读 `worker.lookup {number}`：把用户编号（`W5` / `W5-1`）严格解析成 `{id,worker_number}`，供 CLI/Web 转调原整数身份接口；它不改写任何状态，也不让原 RPC/HTTP 的 `id`（含 Artifact 产物 ID）接受编号。
- `worker.integrate`：运行中的直接父 Agent 核对固定子提交并快进；`worker.resolve_child_divergence` 为父侧分歧派隔离Worker。
- `worker.auto_merge {id,enabled}`：用户专属的持久自动合并开关，Web 位于 Worker 详情的「本轮交付就绪」Hooks 节点；新指令默认关闭，新 child 默认开启且不可关闭，开发就绪后不能调整。与单次请求分离，语义见 [Worker RPC](../reference/rpc/tasks.md#自动合并开关与本轮合并)。
- `worker.reserve {kind:'merge'}` / `worker.reserve_all {branch}` / `worker.unreserve` / `worker.resolve_divergence` / `worker.approve_merge`：冻结、复查、解分歧和由用户批准固定 commit + baseline；`reserve_all` 把一条分支下所有已静息待合并的 Worker 逐条按同一套准入放入 v2 merge 队列，当前 version 2 请求由父 Worker 自有队列的 runtime 串行 Squash（含 main），不创建 merge Worker、不改父子关系、不额外调用父 Agent；旧 version 1 仍需固定提交批准，旧 version 2 merge 身份／在途重挂只作历史兼容。
- `worker.accept` / `worker.reopen` / `worker.sync_parent` / `worker.resolve_sync`：[多轮交付](task-iteration.md)。`accept` 支持用户验收指令成果（含静息无改动回答，无需先合并）、运行中的直接父 Agent 确认已交付 child；其余入口仍用户专属。合并后待验收，可追加输入继续；验收/归档分开，父同步无冲突程序完成、冲突另点 Agent；历史Worker不批量迁移，归档不重建。
- `worker.configure` 的 `model_selection:{connection_id,model}` 与旧 `profile` 输入互斥，仅用户可用，沿用暂停/请求中断准入。仅更新 Pi 的托管来源与模型，后台原子保留其余完整覆盖，不切换后端、不联网刷新、不启动 Agent；返回安全下次选择摘要。`worker.inspect.model_selection` 白名单 `{agent,connection_id,model,thinking,explicit}` 不暴露完整 `retry_profile`、Prompt、env 或资源路径，也不冒充当前调用绑定。用户决定 #154 同时要求所有 Pi 调用使用 Lush 独立配置、未绑定来源不回退外部 Pi；历史配置/会话/观测不迁移删除。
- `worker.resolve` / `worker.cancel` / `worker.retry` / `worker.cleanup`：显式结算与安全维护；`resolve` 仅为用户验收指令的兼容入口，委托 `acceptTask`，不再有独立的「已解决」结算协议。`worker.interrupt` / `worker.resume` / `worker.configure` 是可恢复的暂停流程：中断发送可撤销的暂停意愿，`interrupt_state=requested` 期间仍可执行当前工具与 RPC，到安全点才进入非终态 paused；继续立即接受，未认领则撤销，已认领则内部等待旧调用退出后排队（`interrupt_state=resuming`），不重叠调用、不因中断等待超时强杀。暂停或请求期间可追加消息或保存下一次调用的运行设置（profile 可含只在本Worker生效的 `env` 覆盖，Pi 按 common → 角色 → 本Worker三层合并），不会热改旧调用；`order.submit {start:false}` 直接建出的「待开始」Worker 就走这套 resume。`worker.cancel` 仍是不可恢复的终态放弃，在暂停或中断/恢复请求期间作为次级危险确认入口。`branch.tree/show/bind/archive` 管理分支。Agent 和 runtime 配置、进度、daemon 状态是运行必需的辅助接口。

- `worker.delete_preview {id}` / `worker.delete {id,revision,confirm:true}`：用户专属的整棵 Worker 子树彻底删除；只读预检资源、外部依赖与共享使用者，最终确认授权丢弃专属代码现场与历史，无剩余使用者的原始 Input 一并清除。活动任务先取消，main/owner 保护，陈旧 revision 拒绝，不恢复旧 `task.delete` 别名；见[磁盘回收与删除](../reference/rpc/maintenance.md#彻底删除-worker)。

项目网络另有用户专属 `agent.network {}` / `agent.network.configure {config}`，CLI `agent network show|set --file PATH|reset`；后台账号请求与后续 Agent 调用共享默认网络，代理认证只写、安全读模型不含秘密，不增加整机调度。字段与协议边界见[项目出站网络代理](outbound-network.md)。

服务维护另有用户专属的 `system.stop_if_idle {}`：daemon 同步拒绝有活动调用或 Git/合并工作的重启请求，准入后封闭新调度并正常停止。Host 的项目重启入口负责等待退出、启动新进程；Host 自身重启独立进行，不停止项目。完整 HTTP 与返回字段见[服务重启](../reference/web-routes.md#服务重启)。

## 快捷解释

新增用户专属 `quick_explain.config/configure/start/followup/get/list/delete`，仅用于项目内所选文字的直连模型阅读辅助，不创建 Worker、Input、分支或 Agent invocation；`followup` 在同一条解释上追加多轮追问，沿用原来源/Prompt 快照。来源复用现有受支持 Chat Completions API Key 连接；独立设置与全历史页为 `#quick-explain`。旧 `intro.*` / `explanation.*` 仍无公开入口，不恢复旧解释 Agent。配置、历史与安全边界见[快捷解释契约](quick-explanation.md)。

## 移除与磁盘边界

Intent / Plan / Candidate、旧批量草稿提交、快速路由、展示、旧解释 Agent、托管、旧合并编排与旧Worker创建不再有公开 RPC、CLI 或 Web 操作入口。旧行、会话与工作区不迁移、不自动删除；仅用户明确确认 `worker.delete` 才按资源归属清除所选范围。旧排队Worker和预约不会自动启动或重放。已有历史记录可能不能由新版本继续收尾。内部旧实现及旧测试尚未全部移除，不能把公开白名单当作已完成的物理删码证明。

Web 保留原 Studio 的项目选择、侧栏、Worker 图、Worker详情、执行过程、设置与文档布局；概览改按 Worker 展示。旧 Intent/Plan、批量草稿、展示、旧解释 Agent 与托管入口不再显示；新的「历史输入」与缓冲区只接当前指令路径。`/api/overview` 与 `/api/snapshot` 返回同一份有界的 Worker 核心读模型；`/api/docs` 仍只读随代码发布的文档。

变更 API 时必须同步 RPC 参数与权限表、Web 写白名单和只读路由、CLI 帮助、Agent 提示词及新的 Worker 中心测试；不能仅隐藏 UI 按钮。
