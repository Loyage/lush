# 核心 API 收敛

本页给维护者列出当前对外可调用的 Task 中心接口；权威白名单在 `src/rpc/registry.js`，HTTP 写入口另受 `src/ui/web/server.js` 限制。

## 核心工作流

- `say.submit`：一条用户输入创建一个有独立分支/worktree 的 say Task。`start:false`（Web 主发送默认）只创建为 `paused`（Web 显示「待开始」）且不调用 Agent；`start:true`（缺省）立即排队运行。main 自动确立静息 owner；其它现有本地分支须先 `branch.bind` 固定 HEAD。
- `task.spawn`：只可在活动 say/child 下派 agent 子 Task；不再接受 role、deps 或 spec。
- `task.message` / `notice.post` / `notice.answer` / `notice.dismiss`：继续沟通和决策。
- `task.inspect` / `task.page` / `task.graph` / `task.diff` / `task.history*` / `task.transcript*`：按需只读审阅；支持 CLI 与 Web。
- `task.integrate`：运行中的直接父 Agent 核对固定子提交并快进；`task.resolve_child_divergence` 为父侧分歧派隔离任务。
- `task.reserve {kind:'merge'}` / `task.reserve_all {branch}` / `task.unreserve` / `task.resolve_divergence` / `task.approve_merge`：冻结、复查、解分歧和由用户批准固定 commit + baseline；`reserve_all` 把一条分支下所有已静息待合并的 Task 逐条按同一套准入放入 v2 merge 队列，不会自动批准进 main。
- `task.resolve` / `task.cancel` / `task.retry` / `task.cleanup`：显式结算与安全维护。`task.interrupt` / `task.resume` / `task.configure` 是可恢复的暂停流程：中断进入非终态 paused，暂停中可追加消息或固定本轮运行设置（profile 可含只在本任务生效的 `env` 覆盖，Pi 按 common → 角色 → 本任务三层合并），继续才重新排队；`say.submit {start:false}` 直接建出的「待开始」Task 就走这套 resume。`task.cancel` 仍是不可恢复的终态放弃，且只在 paused 下作为次级入口。`branch.tree/show/bind/archive` 管理分支。Agent 和 runtime 配置、进度、daemon 状态是运行必需的辅助接口。

## 移除与磁盘边界

Intent / Plan / Candidate、草稿、快速路由、展示、解释、托管、旧合并编排与旧任务创建不再有公开 RPC、CLI 或 Web 操作入口。旧行、会话与工作区不迁移、不删；旧排队任务和预约不会自动启动或重放。已有历史记录可能不能由新版本继续收尾。内部旧实现及旧测试尚未全部移除，不能把公开白名单当作已完成的物理删码证明。

Web 保留原 Studio 的项目选择、侧栏、Task 图、分支图、任务详情、执行过程、设置与文档布局；概览改按 Task 展示。旧 Intent/Plan、草稿、展示、解释、托管和自动合并的操作入口不再显示。`/api/overview` 与 `/api/snapshot` 返回同一份有界的 Task 核心读模型；`/api/docs` 仍只读随代码发布的文档。

变更 API 时必须同步 RPC 参数与权限表、Web 写白名单和只读路由、CLI 帮助、Agent 提示词及新的 Task 中心测试；不能仅隐藏 UI 按钮。
