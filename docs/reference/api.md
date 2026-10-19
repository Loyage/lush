# CLI 与 RPC

管理 CLI 帮助：`bun run help` / `bun run lush help`；开发协作帮助：`bun run lushw help`。全局参数 `--project PATH`、`--json` 可放在命令前后。

## 开发与管理双入口

W332／D695：`lush` 面向用户／Valet 的项目管理，`lushw`（Lush Worker）只处理当前 Worker 自身与直接父子事务。两者由同源目录派生，但业务叶命令只有一个入口，只有本地 help 双入口。项目级 Worker／branch 查询及管理操作归 `lush`；Worker 无需知道自身编号、树中层级或当前目录，服务端从有效 invocation token 绑定 `lushw self/parent/children`。无身份、过期身份或越权关系的数据调用拒绝；不能通过伪造 `LUSH_TASK_ID` 选择自身。

这是破坏性迁移：旧 `lushw worker/branch/status/progress` 及 `lushw notice post/list` 不保留。自身查询改用 `self inspect/history/transcript`；父查询／消息用 `parent inspect/message`；直接 child 的分页、查询、派工、消息和安全验收用 `children …`；标题、Notice 与进度归 `self`。精确参数、完整命令与示例以 `bun run lushw help` 及 `src/cli/catalog.js` 为准，不在文档维护第二份命令清单。`skills list/get` 和本地 `notice example/check` 不需项目或 invocation。源码快捷 `bun run progress` 映射到 `lushw self progress`；`bun run message ID '说明'` 是用户管理的 `lush worker message`，不是开发消息入口。

`context.*` 的参数、注册和校验同源于 `src/core/worker-context.js`，普通调用全部要求有效 invocation，拒绝未知参数；self 是默认关系，parent 自动解析，child 关系仅接受自己的直接 child（整数或真实 W 编号）。`context.children {after?,limit?}` 按 ID 升序返回 `items,total,cursor,has_more,limit`，默认50、最多200；`context.notices {before?,limit?}` 只查自身 Notice，倒序分页默认30、最多100。分页使用实际返回的 cursor；详情 `coverage=worker_context`，省略嵌套关系、收件箱、原始运行记录等，`omitted` 标明范围；历史 `coverage=event_metadata_only` 只含事件身份／类型／时间，使用 next/has_more 续读，不含事件正文。执行证据须按需读取相关 transcript，不把精简详情或历史元数据冒充全量。

W348／D723：登录用户在 Worker CLI 页面执行 `lushw` 时另走用户上下文模式：self 绑定指定页面 Worker，parent／child 仍由服务端核验直接关系；只支持 catalog 标注 `user_context_rpc` 的用户等价操作，转调原管理 RPC 并重新检查用户权限、冻结及生命周期。未映射的 Agent 专属操作在 preview 拒绝；普通终端无 invocation 仍不能使用数据命令。私有关联仅属于已授权、在途且单次派发的 CLI lease，不能由环境中的 Worker ID 选择身份，不能复制／读取／伪造 Agent token，也不是通用 RPC 代理。用户详情／历史沿用用户读面，不冒充 `worker_context` 精简投影；Agent 与 Valet 的原权限不变。页面执行及加密历史边界见 [Worker CLI](rpc/tasks.md#worker-cli-交互)。

后端同样限制普通 Worker 的 raw RPC 查询为自身、直接父和直接 child；拒绝项目级枚举、兄弟、孙辈和无关目标，不是只隐藏帮助目录。特殊整合 Worker 的额外只读查询须命中持久固定成员集合，不获得派工、消息或验收权限。原写入、冻结、生命周期与安全验收门保持。

旧 `lushc` 可执行文件与源码脚本直接移除，不保留兼容入口，外部脚本须改用 `lushw`。已有进程不会热更新；用户须在安全空闲点更新安装入口，并分别更新 daemon 与 Host，不能只刷新页面。历史会话、用户自定义 Prompt 和外部脚本不批量改写；旧指令引用须由维护者按新入口更新。

帮助可离线读取：`lush help agent resources`、`lush agent sources list --help`、`lushw help self inspect` 只打印指定命令／子目录的用法，不发现项目、不调用 RPC，也不会因存在待执行正文而执行命令。普通 CLI 处理器报错附带对应的只读帮助入口；未知结果不可通过重试来验证。Valet 没有 Shell，唯一模型工具 `lush_cli {argv:string[]}` 通过固定可信 bridge 运行同一个 `lush` parser 与命令处理器；例如 `{"argv":["help","worker","inspect"]}`，再提交 `{"argv":["worker","inspect","W5"]}`。模型不再暴露 `manager_*` 工具，内部管理 RPC 只作受控传输与历史兼容。`valet` 命令处理当前管家的安全查询、调用历史和自身 Notice／进度，不代理开发 `context.*`。help、命令、schema 与 CLI 学习目录同源；结构化输入使用正式命令的 `--data JSON`／`--questions-json JSON`，不读本地文件。真实命令共用但身份不共用：项目、token、可执行文件固定，不开放 `--project`、Shell、交互认证、扩展加载或本地服务工作流；已审核的插件安装库管理仍经原权限及显式设备授权，不代表向管家运行环境加载插件。静态本地边界在帮助与目录的 `management_cli` 中明示，最新接口权限和原安全门仍逐次检查。补齐仍有效能力，不恢复已明确退役的 CLI；完整安全与兼容边界见管家契约。设备接口权限与范围授权的区别见[管家权限契约](../engineering/hook-signals-management.md#设备全局管家权限)。

入口不授予权限：带 Agent token 的 `lush` 管理入口不能绕过开发限制。Valet 的项目能力独立于 `LUSHW_METHODS`，由 `MANAGEMENT_CODE_METHODS` 和管理策略审核；保留已审核的当前项目跨树代理，不代理 invocation 绑定的 `context.*`。Valet 仅使用可信管理工具，不获得 Shell 或 Git 分支；已支持的受控写操作默认自动执行，可逐项收紧，权限修改本身始终须用户审核。既有私有授权快照不回写，详见[Valet 契约](../engineering/hook-signals-management.md)。

CLI 学习页面不再固定搜索前缀；目录、格式、示例与搜索使用实际 `lush`／`lushw`。具体命令、读／写分类与关联 RPC 由 `src/cli/catalog.js` 派生，不在这里维护另一份权限名单。读入口不接受写选项，准备阶段包含读取的变更命令仍归写；分类不等于执行授权，现有逐 RPC 权限与确认门不变。

`daemon start/restart` 是客户端工作流，不是 RPC。`doctor` 默认提供简短身份摘要，`--verbose` 才附带完整 daemon 状态（含 Agent 配置）。它检查本地项目配置，并把当前磁盘代码、该项目 daemon、以及该项目状态目录记录的后台 Web 三份身份分别列在 `identities.current/daemon/host`；保留旧的顶层 `fingerprint` / `code_match` 字段供脚本兼容。发现代码不一致时只返回 `update_hints` 并在 stderr 给出带正确 `--project` 的命令，绝不自动重启。项目 `doctor` 不猜测无项目启动器的 Web；诊断全局启动器请运行 `bun run lush host status`。

`bun run lush host start [PORT]` 后台启动 Host：无 `--project` 时进入全局项目工作台；带 `--project` / `LUSH_PROJECT` 时保持单项目绑定模式（日志 `.lush/host.log`，不替用户启动 daemon）。首次全局启动可要求绝对目录，之后使用已登记项目；命令等 Web 真的占住端口就返回，同端口已运行时幂等报告，不换进程。两种模式本机也必须登录；单项目读取 `.lush/web.json`，全局模式读取用户配置目录的 `web.json`，缺少所选作用域配置时拒绝启动并提示手工创建，无默认密码或首次设置页。新 `version:2` 默认只监听本机，显式 `listen:"public"` 才全接口监听；旧 `version:1` 保留历史公网并警告。全局公网必须提供 `projects` 非空绝对路径白名单，回环可选。`bun run lush host restart [PORT]` 先停旧 Host 再按当前代码启动；改完 `src/ui/web/` 后使用。`bun run lush host stop [PORT]` 停止后台 Host，`bun run lush host status [PORT]` 通过 `current_code` / `host_code`（以及同义的 `identities.current/host`）分别报告磁盘与进程的目录、版本和指纹；不一致时 `update_hint.command` 精确包含端口及项目作用域。停止操作只会停止确认属于 Lush 的 Web 进程；端口由其他程序占用时会报告命令行，不会触碰它。调试前台运行使用 `bun run lush host start --foreground`。

本页是索引：CLI 与 RPC 表格、返回值和错误信息都在下面各章里。若要先理解从输入到交付的实际操作顺序，请读[当前指令流程](../task-flow.md)。

项目管理实体入口为 `lush worker` / RPC `worker.*`；Worker 自身协作入口及 `context.*` 见上文，旧 Task 命令与方法不保留别名；`notice --worker` / `config worker-call-limit` 与保留的内部字段之间的映射见[更名边界](../engineering/core-api.md#worker-更名与兼容边界)。

## CLI 精简迁移（D647）

旧 CLI 拼写不保留别名，脚本须更新：

| 旧调用 | 当前调用 |
|---|---|
| `worker reserve ID merge` | `worker merge ID` |
| `worker reserve-all BRANCH` | `worker merge-all BRANCH` |
| `worker unreserve ID` | `worker merge-cancel ID` |
| `worker resolve ID` | `lush worker accept ID`（用户）；`lushw children accept ID`（直接父 Agent） |
| `worker delete ID`（预检） | `worker delete-preview ID` |
| `config migrate`（预检） | `config migrate-preview` |
| `agent sources models ID --refresh` | `agent sources models-refresh ID` |
| `worker completion ID archive --revision REV` | `worker completion ID accept --revision REV` |
| `agent set TARGET --prompt TEXT` | `agent set TARGET --append-prompt TEXT` |

`worker delete` 与 `config migrate` 必须提供 `--confirm --revision REV`；强制删除的预检和执行都须 `--force`。旧 `worker integrate/resolve-child-divergence/resolve-divergence/approve-merge` CLI 已删除，历史在途所需后端 RPC 保留，不删除记录或改写交付协议。`branch convergence on` 不再接受旧 `--command/--version` 参数；归并使用当前目标策略。快捷指令、具名信号与 Valet 信号绑定仍可通过 `hooks command/signal/management` 管理。

## 用户编号与 CLI 身份

新原始输入沿用项目次序显示为 `O5`；新指令 Worker 不论是否关联 Input，均从项目独立持久单调序列分配 `W1`、`W2`……，与 Input 及内部 ID 解耦。新指令即使提交到已有 Worker 分支，也分配新的顶层 W 编号；Agent 派生的后代仍按父级次序显示为 `W5-1`、`W5-1-1`。分配避让所有现存顶层 W 编号及 child 的顶层 W 前缀，失败或删除可能留下空号，删除／purge／重启后不复用。历史 Worker 不改编号、不补 NULL；未编号的历史父 Worker 新派生后代仍无 W 编号，按原整数身份查看。

新 Valet 使用项目独立序列 `V1`、`V2`……，保存于共有 `tasks.worker_number` 字段；不依赖 Input 或内部 ID。创建时在事务内更新 `meta.valet_number_high`，删除、purge、重启后不复用；同一 Valet 的多次信号执行保持原编号。历史管理记录不补号，仍按原身份查看。V 编号没有开发子层级。

CLI 的工作身份参数支持原整数或严格的 W／V 编号；身份解析不授予对应类型未具备的操作权限：

```bash
bun run lush worker inspect W5-1
bun run lush worker inspect V1  # Valet 通用只读详情；不是开发 Worker
bun run lush worker message W5-1 '用户补充说明'
bun run lush worker rename W5 '登录修复'  # 仅用户，只改展示标题；空串恢复自动标题
bun run lush worker spawn '目标' --parent W5 --name child  # 用户管理派工
# 以下在有效 Worker invocation 内，自动绑定自身：
bun run lushw self inspect
bun run lushw children message W5-1 '补充说明'  # 必须是真实直接 child
bun run lushw children spawn '目标' --name child
bun run lushw self notice post '问题' --body '背景'
```

管理 CLI 通过只读 `worker.lookup {number}` 找到真实整数 ID 后，再调用原接口；上下文 CLI 的 child 参数由服务端解析并复核直接父子关系。`W5` 或 `V5` 均不意味着内部 `id=5`。解析严格接受 `Wn(-n)*` 或 `Vn`，正安全整数、无前导零；`V1-1`、小写、溢出和超长值拒绝。RPC/HTTP 的既有 `id`、引用目标、链接、环境变量和磁盘路径仍使用整数。`--json` 保留整数 `id` 和可空 `worker_number`；分页游标与 Notice ID 仍为整数，不接受 W／V 编号。

### 持久身份边界

`tasks.worker_number` 可空、创建后不可改写，部分唯一索引兜底；顶层 W 高水位在 `meta.worker_number_high` 与创建事务内一同保存，删除前也钉住历史 W 前缀高水位；同父 child 次序在 `meta.worker_child_high:<parent_id>` 持久递增，不按存活子数重算，不随删除／purge 清除。读面携带明确编号，缺关联时为 null；用户报告回退 `#内部ID`，不得用整数或当前树推算 W／V 编号。机器身份、排序、权限、合并顺序和引用快照不改。

## 追加输入与 Notice 编号

同一 Input 下明确用户 `worker.message`（sender_id 为 NULL）的追加使用 `A<Input ID>-<seq>`，跨 Worker 共享次序，不占 O 或 child 序号。`Store.appendMessage` 在写锁事务内更新 `meta.input_append_high:<input_id>` 并保存 nullable `messages.append_number`；唯一索引兜底，高水位删除／重启／purge 后不复用，回滚不泄漏编号。内部 `Store.message`、Notice 答复、自动选择、Hook／系统信号及 Agent 通信不分配追加号；无 Input 时为 null。收件箱／inspect／历史与新 Event 携带已有值，冻结释放不重新编号，旧行／事件不回填。

Notice 按明确 kind 展示：question／questionnaire／历史 plan 为 `D<Notice ID>`，info 或未知 kind 为 `N<Notice ID>`。不按标题或状态猜测。D/N/O/A 只用于展示，API、CLI Notice 参数、分页与引用仍用原整数；Draft 不改成 O，历史正文与快照不重写。

## 速查表

| 命令 | 章节 |
|---|---|
| `lush order`（指令；旧 say 无别名） | [一条指令输入如何交付](../task-flow.md) |
| `lushw self/parent/children …`（自身与直接父子）；`lush worker …`（项目查询与管理） | [Worker、Run 与 Artifact](rpc/tasks.md) |
| `lush worker inspect` / `history` / `transcript` / `watch`（[终端内观看](../native-viewer.md)） / `wait`（`worker.diff` / `worker.usage` 仅 RPC） | [审阅与过程读模型](rpc/inspect.md) |
| `lush worker cleanup [--keep-branch]` / `worker delete-preview ID` / `worker delete ID --confirm --revision REV` | [磁盘回收与彻底删除](rpc/maintenance.md) |
| `lush branch tree` / `show` / `bind` / `archive` | [分支谱系](rpc/branches.md) |
| `lush branch integrate plan/start/show/cancel/retry` | [一次性整合](rpc/convergence.md#一次性整合)（仅用户，非空操作调用 Agent） |
| `lush branch convergence list/show/runs/retry` | [历史归并兼容](rpc/convergence.md#单分支策略)（策略／默认写入口退休） |
| `lushw self notice list/post`、本地 `lushw notice example/check`；`lush notice …` 管理 | [待决问题](rpc/notices.md) |
| `lush status` / `lush config show` / `lush config set|reset` / `lush agent show|prompt|env|init|set|reset` / `lush daemon stop` | [Agent 环境与权限](agent-environment.md) |
| `lush agent network show` / `set --file PATH` / `reset` | [项目出站网络代理](../engineering/outbound-network.md) |
| Web 读取路由与 `POST /api/action` | [Web 路由](web-routes.md) |
| HTTP 监听与安全约束 | [HTTP](http.md) |

已下线的方法与命令不再有公开入口：Intent / Plan / Candidate、草稿、快速路由、效果展示、介绍、托管模式、`task.analyze`、`task.verify`、`task.delete` / `task.clear`、`task.merge` / `task.merge_many` / `task.ladder`、`branch.import` / `branch.merge` / `branch.sync` / `branch.catchup` / `branch.summary` 与合并编排。旧记录、会话与工作区不迁移、不自动删除；仅用户明确确认 `worker.delete` 时清除所选子树的专属资源与历史。完整边界见[核心 API 收敛](../engineering/core-api.md)。
