# 核心 API 收敛

本页给维护者列出当前对外可调用的 AP 中心接口；权威白名单在 `src/rpc/registry.js`，HTTP 写入口另受 `src/ui/web/server.js` 限制。

## 核心工作流

- `say.submit`：一条用户输入创建一个有独立分支/worktree 的 say AP。main 自动确立静息 owner；其它现有本地分支须先 `branch.bind` 固定 HEAD。
- `ap.spawn`：只可在活动 say/child 下派 agent 子 AP；不再接受 role、deps 或 spec。
- `ap.message` / `notice.post` / `notice.answer` / `notice.dismiss`：继续沟通和决策。
- `ap.inspect` / `ap.page` / `ap.graph` / `ap.diff` / `ap.history*` / `ap.transcript*`：按需只读审阅；支持 CLI 与 Web。
- `ap.integrate`：运行中的直接父 Agent 核对固定子提交并快进；`ap.resolve_child_divergence` 为父侧分歧派隔离 AP。
- `ap.reserve {kind:'merge'}` / `ap.unreserve` / `ap.resolve_divergence` / `ap.approve_merge`：冻结、复查、解分歧和由用户批准固定 commit + baseline；不会自动批准进 main。
- `ap.resolve` / `ap.cancel` / `ap.retry` / `ap.cleanup`：显式结算与安全维护。`branch.tree/show/bind/archive` 管理分支。Agent 和 runtime 配置、进度、daemon 状态是运行必需的辅助接口。

## 移除与磁盘边界

Intent / Plan / Candidate、草稿、快速路由、展示、解释、托管、旧合并编排与旧 AP 创建不再有公开 RPC、CLI 或 Web 操作入口。旧行、会话与工作区不迁移、不删；旧排队 AP 和预约不会自动启动或重放。已有历史记录可能不能由新版本继续收尾。内部旧实现及旧测试尚未全部移除，不能把公开白名单当作已完成的物理删码证明。

Web 保留原 Studio 的项目选择、侧栏、AP 图、分支图、AP 详情、执行过程、设置与文档布局；概览改按 AP 展示。旧 Intent/Plan、草稿、展示、解释、托管和自动合并的操作入口不再显示。`/api/overview` 与 `/api/snapshot` 返回同一份有界的 AP 核心读模型；`/api/docs` 仍只读随代码发布的文档。

变更 API 时必须同步 RPC 参数与权限表、Web 写白名单和只读路由、CLI 帮助、Agent 提示词及新的 AP 中心测试；不能仅隐藏 UI 按钮。
