# CLI 与 RPC

管理 CLI 帮助：`bun run help` / `bun run lush help`；开发协作帮助：`bun run lushc help`。全局参数 `--project PATH`、`--json` 可放在命令前后。

## 开发与管理双入口

`lushc` 面向开发 Worker 的协作与查询，`lush` 面向用户／Valet 的项目管理。两者共用命令目录与处理器；共享查询可由任一入口调用，开发专属命令从旧 `lush` 直接迁出、不保留别名，旧调用在派发前给出迁移提示。用户也可使用 `lushc`，但 Agent-only 方法仍须有效 invocation。

入口不授予权限：开发 Agent 的工作区、直接父子协作与后端安全门保持不变，带 Agent token 的 `lush` 管理写入口不能绕过这些限制。Valet 默认获得全部 `lushc` RPC 能力，通过可信管理工具在当前项目内跨树代理；不获得 Shell 或 Git 分支，危险动作仍须精确确认，既有私有授权快照不回写，详见[Valet 契约](../engineering/hook-signals-management.md)。

CLI 学习页面不再固定搜索前缀；目录、格式、示例与搜索使用实际 `lush`／`lushc`。具体命令、读／写分类与关联 RPC 由 `src/cli/catalog.js` 派生，不在这里维护另一份权限名单。读入口不接受写选项，准备阶段包含读取的变更命令仍归写；分类不等于执行授权，现有逐 RPC 权限与确认门不变。

`daemon start/restart` 是客户端工作流，不是 RPC。`doctor` 默认提供简短身份摘要，`--verbose` 才附带完整 daemon 状态（含 Agent 配置）。它检查本地项目配置，并把当前磁盘代码、该项目 daemon、以及该项目状态目录记录的后台 Web 三份身份分别列在 `identities.current/daemon/host`；保留旧的顶层 `fingerprint` / `code_match` 字段供脚本兼容。发现代码不一致时只返回 `update_hints` 并在 stderr 给出带正确 `--project` 的命令，绝不自动重启。项目 `doctor` 不猜测无项目启动器的 Web；诊断全局启动器请运行 `bun run lush host status`。

`bun run lush host start [PORT]` 后台启动 Host：无 `--project` 时进入全局项目工作台；带 `--project` / `LUSH_PROJECT` 时保持单项目绑定模式（日志 `.lush/host.log`，不替用户启动 daemon）。首次全局启动可要求绝对目录，之后使用已登记项目；命令等 Web 真的占住端口就返回，同端口已运行时幂等报告，不换进程。两种模式本机也必须登录；单项目读取 `.lush/web.json`，全局模式读取用户配置目录的 `web.json`，缺少所选作用域配置时拒绝启动并提示手工创建，无默认密码或首次设置页。新 `version:2` 默认只监听本机，显式 `listen:"public"` 才全接口监听；旧 `version:1` 保留历史公网并警告。全局公网必须提供 `projects` 非空绝对路径白名单，回环可选。`bun run lush host restart [PORT]` 先停旧 Host 再按当前代码启动；改完 `src/ui/web/` 后使用。`bun run lush host stop [PORT]` 停止后台 Host，`bun run lush host status [PORT]` 通过 `current_code` / `host_code`（以及同义的 `identities.current/host`）分别报告磁盘与进程的目录、版本和指纹；不一致时 `update_hint.command` 精确包含端口及项目作用域。停止操作只会停止确认属于 Lush 的 Web 进程；端口由其他程序占用时会报告命令行，不会触碰它。调试前台运行使用 `bun run lush host start --foreground`。

本页是索引：CLI 与 RPC 表格、返回值和错误信息都在下面各章里。若要先理解从输入到交付的实际操作顺序，请读[当前指令流程](../task-flow.md)。

公开实体入口为 `lush worker`／`lushc worker` / RPC `worker.*`，旧 Task 命令与方法不保留别名；`notice --worker` / `config worker-call-limit` 与保留的内部字段之间的映射见[更名边界](../engineering/core-api.md#worker-更名与兼容边界)。

## CLI 精简迁移（D647）

旧 CLI 拼写不保留别名，脚本须更新：

| 旧调用 | 当前调用 |
|---|---|
| `worker reserve ID merge` | `worker merge ID` |
| `worker reserve-all BRANCH` | `worker merge-all BRANCH` |
| `worker unreserve ID` | `worker merge-cancel ID` |
| `worker resolve ID` | `lushc worker accept ID` |
| `worker delete ID`（预检） | `worker delete-preview ID` |
| `config migrate`（预检） | `config migrate-preview` |
| `agent sources models ID --refresh` | `agent sources models-refresh ID` |
| `worker completion ID archive --revision REV` | `worker completion ID accept --revision REV` |
| `agent set TARGET --prompt TEXT` | `agent set TARGET --append-prompt TEXT` |

`worker delete` 与 `config migrate` 必须提供 `--confirm --revision REV`；强制删除的预检和执行都须 `--force`。旧 `worker integrate/resolve-child-divergence/resolve-divergence/approve-merge` CLI 已删除，历史在途所需后端 RPC 保留，不删除记录或改写交付协议。`branch convergence on` 不再接受旧 `--command/--version` 参数；归并使用当前目标策略。快捷指令、具名信号与 Valet 信号绑定仍可通过 `hooks command/signal/management` 管理。

## 用户编号与 CLI 身份

新原始输入沿用项目次序显示为 `O5`，其直接指令 Worker 为 `W5`；Agent 派生的后代按父级次序显示为 `W5-1`、`W5-1-1`。新指令即使提交到已有 Worker 分支，仍用自身输入编号。失败或删除可能留下空号，编号不复用。历史 Worker 不改编号；未编号的历史父 Worker 新派生后代继续使用旧整数编号。

新 Valet 使用项目独立序列 `V1`、`V2`……，保存于共有 `tasks.worker_number` 字段；不依赖 Input 或内部 ID。创建时在事务内更新 `meta.valet_number_high`，删除、purge、重启后不复用；同一 Valet 的多次信号执行保持原编号。历史管理记录不补号，仍按原身份查看。V 编号没有开发子层级。

CLI 的工作身份参数支持原整数或严格的 W／V 编号；身份解析不授予对应类型未具备的操作权限：

```bash
bun run lush worker inspect W5-1
bun run lush worker inspect V1  # Valet 通用只读详情；不是开发 Worker
bun run lushc worker message W5-1 '补充说明'
bun run lush worker rename W5 '登录修复'  # 仅用户，只改展示标题；空串恢复自动标题
bun run lushc worker spawn '目标' --parent W5 --name child
bun run lushc notice post '问题' --worker W5-1 --body '背景'
```

CLI 通过只读 `worker.lookup {number}` 找到真实整数 ID 后，再调用原接口；`W5` 或 `V5` 均不意味着内部 `id=5`。解析严格接受 `Wn(-n)*` 或 `Vn`，正安全整数、无前导零；`V1-1`、小写、溢出和超长值拒绝。RPC/HTTP 的既有 `id`、引用目标、链接、环境变量和磁盘路径仍使用整数。`--json` 保留整数 `id` 和可空 `worker_number`；分页游标与 Notice ID 仍为整数，不接受 W／V 编号。

### 持久身份边界

`tasks.worker_number` 可空、创建后不可改写，部分唯一索引兜底；同父 child 次序在 `meta.worker_child_high:<parent_id>` 持久递增，不按存活子数重算，不随删除／purge 清除。读面携带明确编号，缺关联时为 null；用户报告回退 `#内部ID`，不得用整数或当前树推算 W／V 编号。机器身份、排序、权限、合并顺序和引用快照不改。

## 追加输入与 Notice 编号

同一 Input 下明确用户 `worker.message`（sender_id 为 NULL）的追加使用 `A<Input ID>-<seq>`，跨 Worker 共享次序，不占 O 或 child 序号。`Store.appendMessage` 在写锁事务内更新 `meta.input_append_high:<input_id>` 并保存 nullable `messages.append_number`；唯一索引兜底，高水位删除／重启／purge 后不复用，回滚不泄漏编号。内部 `Store.message`、Notice 答复、自动选择、Hook／系统信号及 Agent 通信不分配追加号；无 Input 时为 null。收件箱／inspect／历史与新 Event 携带已有值，冻结释放不重新编号，旧行／事件不回填。

Notice 按明确 kind 展示：question／questionnaire／历史 plan 为 `D<Notice ID>`，info 或未知 kind 为 `N<Notice ID>`。不按标题或状态猜测。D/N/O/A 只用于展示，API、CLI Notice 参数、分页与引用仍用原整数；Draft 不改成 O，历史正文与快照不重写。

## 速查表

| 命令 | 章节 |
|---|---|
| `lush order`（指令；旧 say 无别名） | [一条指令输入如何交付](../task-flow.md) |
| `lushc worker list/tree/inspect/spawn/message/accept`；`lush worker cancel/retry/merge/cleanup` 等管理操作 | [Worker、Run 与 Artifact](rpc/tasks.md) |
| `lush worker inspect` / `history` / `transcript` / `watch`（[终端内观看](../native-viewer.md)） / `wait`（`worker.diff` / `worker.usage` 仅 RPC） | [审阅与过程读模型](rpc/inspect.md) |
| `lush worker cleanup [--keep-branch]` / `worker delete-preview ID` / `worker delete ID --confirm --revision REV` | [磁盘回收与彻底删除](rpc/maintenance.md) |
| `lush branch tree` / `show` / `bind` / `archive` | [分支谱系](rpc/branches.md) |
| `lush branch integrate plan/start/show/cancel/retry` | [一次性整合](rpc/convergence.md#一次性整合)（仅用户，非空操作调用 Agent） |
| `lush branch convergence list/show/runs/retry` | [历史归并兼容](rpc/convergence.md#单分支策略)（策略／默认写入口退休） |
| `lushc notice list/post/example/check`；`lush notice answer/dismiss` | [待决问题](rpc/notices.md) |
| `lush status` / `lush config show` / `lush config set|reset` / `lush agent show|prompt|env|init|set|reset` / `lush daemon stop` | [Agent 环境与权限](agent-environment.md) |
| `lush agent network show` / `set --file PATH` / `reset` | [项目出站网络代理](../engineering/outbound-network.md) |
| Web 读取路由与 `POST /api/action` | [Web 路由](web-routes.md) |
| HTTP 监听与安全约束 | [HTTP](http.md) |

已下线的方法与命令不再有公开入口：Intent / Plan / Candidate、草稿、快速路由、效果展示、介绍、托管模式、`task.analyze`、`task.verify`、`task.delete` / `task.clear`、`task.merge` / `task.merge_many` / `task.ladder`、`branch.import` / `branch.merge` / `branch.sync` / `branch.catchup` / `branch.summary` 与合并编排。旧记录、会话与工作区不迁移、不自动删除；仅用户明确确认 `worker.delete` 时清除所选子树的专属资源与历史。完整边界见[核心 API 收敛](../engineering/core-api.md)。
