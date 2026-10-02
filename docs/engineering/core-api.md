# 核心 API 收敛

本页给维护者列出当前对外可调用的 Worker 中心接口；权威白名单在 `src/rpc/registry.js`，HTTP 写入口另受 `src/ui/web/server.js` 限制。

## Worker 更名与兼容边界

Worker 是原 Task 的整体更名，含义仍是持久的 Agent + Process；父Worker、子Worker、状态、权限与交付生命周期不变。实体名称不再与历史 `role='worker'` 混为一谈：新 say/child 的角色仍为 `agent`，历史角色值不改写。

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

## 核心工作流

- `say.submit`：一条用户输入创建一个有独立分支/worktree 的 say Worker。`start:false`（Web 主发送默认）只创建为 `paused`（Web 显示「待开始」）且不调用 Agent；`start:true`（缺省）立即排队运行。main 自动确立静息 owner；其它现有本地分支须先 `branch.bind` 固定 HEAD。
- `input.history` / `input.get` / `input.parents` 与 `draft.add` / `draft.update` / `draft.remove`：用户专属历史输入与持久缓冲区；草稿通过 `say.submit {draft_id,expected_revision,start?}` 发射，不恢复旧 planner 或批量提交。字段、版本检查与分页见[历史输入接口](input-history.md)。
- `worker.spawn`：只可在活动 say/child 下派 agent 子 Worker；不再接受 role、deps 或 spec。
- `worker.message` / `notice.post` / `notice.answer` / `notice.dismiss`：继续沟通和决策。
- `branch.history {cursor?,limit?}`：用户专属只读 main 第一父链历史与精确交付 Worker / 原始 say 追溯；Web `GET /api/versions`，不新增 CLI 写入口，见 [版本迭代](version-history.md)。
- `worker.inspect` / `worker.page` / `worker.graph` / `worker.diff` / `worker.history*` / `worker.transcript*`：按需只读审阅；支持 CLI 与 Web。
- `worker.integrate`：运行中的直接父 Agent 核对固定子提交并快进；`worker.resolve_child_divergence` 为父侧分歧派隔离Worker。
- `worker.auto_merge {id,enabled}`：用户专属的持久自动合并开关；新 say 默认关闭，新 child 默认开启且不可关闭，开发就绪后不能调整。与单次请求分离，语义见 [Worker RPC](../reference/rpc/tasks.md#自动合并开关与本轮合并)。
- `worker.reserve {kind:'merge'}` / `worker.reserve_all {branch}` / `worker.unreserve` / `worker.resolve_divergence` / `worker.approve_merge`：冻结、复查、解分歧和由用户批准固定 commit + baseline；`reserve_all` 把一条分支下所有已静息待合并的 Worker 逐条按同一套准入放入 v2 merge 队列，当前 version 2 请求由父 Worker 自有队列的 runtime 串行 Squash（含 main），不创建 merge Worker、不改父子关系、不额外调用父 Agent；旧 version 1 仍需固定提交批准，旧 version 2 merge 身份／在途重挂只作历史兼容。
- `worker.accept` / `worker.reopen` / `worker.sync_parent` / `worker.resolve_sync`：[多轮交付](task-iteration.md)。`accept` 支持用户验收 say、运行中的直接父 Agent 确认已交付 child；其余入口仍用户专属。合并后待验收，可追加输入继续；验收/归档分开，父同步无冲突程序完成、冲突另点 Agent；历史Worker不批量迁移，归档不重建。
- `worker.resolve` / `worker.cancel` / `worker.retry` / `worker.cleanup`：显式结算与安全维护。`worker.interrupt` / `worker.resume` / `worker.configure` 是可恢复的暂停流程：中断进入非终态 paused，暂停中可追加消息或固定本轮运行设置（profile 可含只在本Worker生效的 `env` 覆盖，Pi 按 common → 角色 → 本Worker三层合并），继续才重新排队；`say.submit {start:false}` 直接建出的「待开始」Worker 就走这套 resume。`worker.cancel` 仍是不可恢复的终态放弃，且只在 paused 下作为次级入口。`branch.tree/show/bind/archive` 管理分支。Agent 和 runtime 配置、进度、daemon 状态是运行必需的辅助接口。

- `worker.delete_preview {id}` / `worker.delete {id,revision,confirm:true}`：用户专属的整棵 Worker 子树彻底删除；只读预检资源、外部依赖与共享使用者，最终确认授权丢弃专属代码现场与历史，无剩余使用者的原始 Input 一并清除。活动任务先取消，main/owner 保护，陈旧 revision 拒绝，不恢复旧 `task.delete` 别名；见[磁盘回收与删除](../reference/rpc/maintenance.md#彻底删除-worker)。

服务维护另有用户专属的 `system.stop_if_idle {}`：daemon 同步拒绝有活动调用或 Git/合并工作的重启请求，准入后封闭新调度并正常停止。Host 的项目重启入口负责等待退出、启动新进程；Host 自身重启独立进行，不停止项目。完整 HTTP 与返回字段见[服务重启](../reference/web-routes.md#服务重启)。

## 移除与磁盘边界

Intent / Plan / Candidate、旧批量草稿提交、快速路由、展示、解释、托管、旧合并编排与旧Worker创建不再有公开 RPC、CLI 或 Web 操作入口。旧行、会话与工作区不迁移、不自动删除；仅用户明确确认 `worker.delete` 才按资源归属清除所选范围。旧排队Worker和预约不会自动启动或重放。已有历史记录可能不能由新版本继续收尾。内部旧实现及旧测试尚未全部移除，不能把公开白名单当作已完成的物理删码证明。

Web 保留原 Studio 的项目选择、侧栏、Worker 图、Worker详情、执行过程、设置与文档布局；概览改按 Worker 展示。旧 Intent/Plan、批量草稿、展示、解释与托管入口不再显示；新的「历史输入」与缓冲区只接当前 say 路径。`/api/overview` 与 `/api/snapshot` 返回同一份有界的 Worker 核心读模型；`/api/docs` 仍只读随代码发布的文档。

变更 API 时必须同步 RPC 参数与权限表、Web 写白名单和只读路由、CLI 帮助、Agent 提示词及新的 Worker 中心测试；不能仅隐藏 UI 按钮。
