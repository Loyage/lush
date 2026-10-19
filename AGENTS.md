# LushCode 开发约定

LushCode 是项目名，软件简称 Lush；管理入口 `lush`、Worker 协作入口 `lushw`、后台 `lushd`，`.lush` 与 `LUSH_*` 保持不变。

Lush 是项目级多 agent 开发应用，Bun / JavaScript / SQLite；daemon 与 CLI 零第三方运行时依赖。Web 文档图表使用固定本地 Mermaid，按需加载。

## 作用域

- 浏览器 UI ↔ Lush Host ↔ 每 canonical 项目一个 lushd。Host 只负责登记、鉴权、设备配置、路由与来源派生读面，不持有 Worker 权威事实、不跨项目调度。项目状态固定在 `<project>/.lush/`。
- `lushw self/parent/children` 是有效 Worker invocation 的自身与直接父子事务入口，自动定位身份、不依赖 cwd 或自身编号；`lush` 是用户／Valet 的项目管理入口，旧项目式 `lushw` 调用不保留别名。Agent 使用 daemon 固定的 `lushw`，不能借管理入口绕过身份与亲缘限制。Valet 的跨树代理与危险确认见[管理契约](docs/engineering/hook-signals-management.md)。
- CLI 向上发现 `.lush/project.json` 或 `.git`；其他项目必须显式 `--project PATH`。Agent worktree 通过固定 `LUSH_PROJECT` 连接原项目；不得更改 `LUSH_PROJECT`／`LUSH_HOME`／`LUSH_TASK_ID`／`LUSH_AGENT_TOKEN`，非空 `LUSH_HOME` 必须等于项目 `.lush`，不是设备全局目录。
- 核心实体只有 Input / Worker / Agent / Message / Notice / Event，不引入整机调度。公开提交为 order，操作为 worker，不恢复 Task／say 别名；保留内部字段、事件、历史类型和路径，完整兼容边界见[核心 API](docs/engineering/core-api.md)。

## 命令一律走 bun run

```bash
bun run lush doctor                  # 先核对项目 / home / daemon 的代码身份
bun run test 路径...             # 专项；无路径为完整套件
bun run docs:check               # 文档改动
bun run lush daemon start                   # 只启动所选项目，已有 daemon 不换版本
bun run lush daemon restart          # 用户确认安全空闲后更新 daemon
bun run lush order '输入'
bun run lush worker tree
bun run lush worker show 3
bun run lushw children message W5-1 '补充要求'  # invocation 内，只能直接 child
bun run lushw parent message '需要父 Worker 决定' # main/owner 不接收普通消息
bun run lushw self show       # 自动定位自身，无需 ID
bun run lushw help              # 开发协作；bun run lush help 为管理帮助（无业务快捷脚本）
bun run lush host start [--project PATH]
bun run lush host status
bun run lush host restart
bun run lush host stop
bun run lush daemon stop
```

无 `--project`／`LUSH_PROJECT` 的 Host 进入全局工作台，显式打开项目才启动／连接 daemon；单项目 Host 不替用户启动 daemon。**Host 与 lushd 是独立进程，改两端须分别更新，不能只刷新页面。** `host start` 幂等、不替换旧进程；`doctor` 与 `host status` 分别核对对应进程身份，指纹覆盖 src、bin、package.json。重启须在用户确认的安全点进行，不能默认操纵开发中的项目；Host 重启会清空登录会话。部署／认证／远程网络见[部署索引](docs/deployment/README.md)，Lush 不部署服务器或管理 SSH／隧道。

## 安全与持久化

- 只在 runtime 给定的自身 worktree／分支改代码和提交；不切换或直接推进 main／父分支，不 reset／clean 或提交用户已有改动。提交前核对当前分支。
- Lush Git 写入只经 `src/core/workspaces.js`，无 shell 插值且串行；固定 refs、清洁度、祖先与落地凭据校验不能绕过。授权分歧修复在源侧合入固定父提交，先审查双方含改名增量和语义迁移，保留原源提交，测试后提交；普通 Worker 不自行同步父分支。详见[Git 边界](docs/engineering/git-boundary.md)与[合并](docs/engineering/merge.md)。
- 新式指令默认不自动合并，child 默认开启且锁定；父 runtime 队列安全点固定成果、串行交付，不改委派关系。预约是持久事实，通知不等于落地；Worker 状态与 integration 独立，`completed` 不等于 merged。旧 v1 审批与 v2 在途兼容保留，v3 只按授权目标策略执行。
- 父 Agent 必须检查 child 成果与测试，默认保留待验收现场供追加需求，不因合并成功就提前回收。验收即归档，安全回收 worktree／ref、保留历史；脏现场、未读／暂存输入、待决、活动调用／后代及未交付改动阻止验收。部分失败保留诊断、显式续办，不猜成功；Agent 不修改自动级别。权威约束见[统一验收](docs/engineering/worker-acceptance.md)。
- 不迁移或覆盖已有数据，重启不重放未知副作用。已提交 Input／Draft 默认不可改写／删除；用户明确预检确认的[彻底删除](docs/reference/rpc/maintenance.md)是专属子树例外，共享资源／外部依赖／main-owner 仍保护，ID 不复用。
- 终态不允许活动后代。历史依赖只在 spawn 写入、之后不可变；结构校验不证明语义正确，code 基线必须上游先交付。历史 explain 输入不得派生开发 Worker；当前接口不恢复旧 role／deps／spec 派工参数。
- Worker 与 Agent 终身一对一，token 仅本次 invocation 有效：库只存 SHA-256，actor 必须仍 running 且未 abort。不得把旧 token 变为终身凭证，私有权限不是 OS 沙箱，不公开凭证或原始认证响应。
- 消息只在 invocation 之间送达；冻结追加先持久暂存，不抢占固定修复。等待用户／子 Worker 时结束本轮，不轮询或后台等待；收尾、恢复须防止 lost-wakeup。详见[invocation](docs/engineering/invocation.md)与[消息准入](docs/reference/rpc/tasks.md#追加消息的准入与失败处理)。

## 文档维护与阅读

默认先实现与验证，不为普通修复、内部搬家或临时派工新增文档。必要设计、安全／兼容边界、公共接口与用户操作变化随对应改动交付，一个事实只维护一处；分级规则以[文档写作约定](docs/contributing/documentation.md#维护分级与时机)为准。

先定位文件／符号，再按改动范围读对应理念及工程章节；不沿索引或交叉链接递归通读。涉及权限、持久化、Git、生命周期或公共 API，必须读清相应约束；冲突或信息不足再扩大调查。理念指导取舍，不当作已实现功能清单；源码可表达的内部清单不重复维护。长期职责从[模块地图](docs/engineering/modules.md)定位。

## 模块

修改模块前必须从[设计索引](docs/design/README.md)读对应主题；按以下范围补关键边界：

| 改动范围 | 理念／契约 |
|---|---|
| 执行记录、工具渲染、检索 | [执行过程](docs/design/agent-process.md)、[阅读器](docs/engineering/transcript-reader.md) |
| 引用、选区、快照／现状取舍 | [引用](docs/design/references.md) |
| Web 文案、图标、样式与 Agent 按钮 | [UI 指引](docs/design/ui-guidance.md)：Agent 动作必须紫色 agent-call＋agentHelp；非直观按钮 data-help，禁用用 help-host |
| 输入、暂存、历史与状态投影 | [输入理念](docs/design/input-history.md)、[接口](docs/engineering/input-history.md) |
| Notice、分类、已读／滑动消除 | [通知理念](docs/design/notices.md)、[Notice 契约](docs/reference/rpc/notices.md) |
| Hook、预约、生命周期与自动级别 | [Hook 理念](docs/design/hooks.md)、[契约](docs/engineering/hooks.md)、[自动链](docs/engineering/completion-hooks.md)、[验收](docs/engineering/worker-acceptance.md) |
| 归并合并 | [归并设计](docs/design/merge-convergence.md)、[当前范围](docs/engineering/merge-convergence-implementation.md)；按需读算法／异常，旧在途不转换，普通 Agent 不创建 integration 或操作其他分支 |
| 内置能力、Skills／启停 | [能力理念](docs/design/agent-capabilities.md)、[契约](docs/engineering/agent-capabilities.md)；开关不关闭核心安全、权限、调度或已有 child 交付 |
| 账号、凭证、观测与绑定 | [账号理念](docs/design/account-resources.md)、[连接](docs/engineering/agent-connections.md)、[旧历史](docs/engineering/agent-usage.md) |
| 全局页面、设备设置／自动化与聚合 | [工作台理念](docs/design/user-workspace.md)、[契约](docs/engineering/user-workspace.md)；旧根显式迁移另读[设备迁移](docs/engineering/device-settings.md) |
| 启动、项目入口与环境管理 | [工作台理念](docs/design/workbench.md)、[接入契约](docs/engineering/workbench.md)；附着 API 只读，旧页轮询不得启动停止的后台 |

快速对话、Prompt 库、右键模型动作和专用模型配置已删除，不恢复；专用数据清理与正常历史保护见[退役契约](docs/engineering/project-quick-chat.md)。

## 验证与交付

测试只保留各模块少量关键主流程，默认不新增测试文件／用例：先复用或修改已有测试，不为每次修复、异常分支、参数组合、历史兼容或 UI 细节扩建矩阵。仅在关键主流程缺失时补最小代表用例，说明现有覆盖为何不足，并优先替换重复测试、避免净增长；临时专项可用隔离脚本／命令留证，不必全部长期入库。少加测试不等于免验证或放宽生产安全边界；完整取舍见[覆盖取舍](docs/contributing/README.md#覆盖取舍)。

实施前简要明确改动行为、受影响调用点、专项／集成范围及最终全量负责人；小改动一句说明即可，按风险选最小充分回归，扩测说明原因。必须验证新增／修改行为，所选范围实际完整跑完，再提交预期改动并保持工作区干净。子 Worker 默认专项／受影响回归，中间汇总补集成；顶层开发指令在最终代码树交付 main/owner 前负责集成与全量，影响广泛或范围不明须扩大。实际命令、结果、被测代码树标识、日志、未覆盖风险及全量负责人写交付；中断／仍失败不报通过，代码变化不沿用旧树证据，CI／自动合并不代替验证。证据复用和失败处理以[分层测试与交付](docs/contributing/README.md#分层测试与交付)为准。

使用项目测试入口的 20 秒单项默认预算，不改产品／性能预算、不自动重试；独立测试尽量并行，资源冲突才串行诊断。临时项目与 mock／可控进程隔离，退出清理自己的服务／文件，不操作用户项目。详见[测试预算](docs/contributing/README.md#测试超时预算)。
