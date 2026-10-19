# CLI 设计：按对象组织，按动作表达

本文保存 W356 的最终实施依据，以通过固定 `lush_cli` 使用管理命令的 Valet 和通过 `lushw` 协作的 Worker Agent 为主要消费者，同时服务用户终端与实现者。D727 已确认：一次性切换、不保留可执行旧别名；删除重复与失效入口但保留有效能力；对象分组为主，保留少量高频短入口。命令核心及调用契约已进入实施，业务模块的接线与真实链路验证须由最终集成树证明，本页不是“已验证”的证据；可执行契约以固定 CLI 的 `src/cli/catalog.js`、同源 CommandSpec 和[现行 CLI 契约](../reference/api.md)为准，已运行的旧进程不会热更新。

## 1. 结论与问题定位

建议保留 `lush`（用户／受控 Valet 管理）和 `lushw`（开发 Worker 协作），**重建命令层级与交互契约，不重建 Worker、权限或交付系统**。不是把所有 RPC 改成命令，也不是仅给帮助加分类。Agent 应能从用户意图发现能力、取得正确参数、遵守执行前提并理解真实结果；信息披露与命令重组必须一起设计，详见[Agent 能力发现](cli-agent-discovery.md)。

核对基线 `f0df8e6793904d363d73648c9ca452ddd6098d37`：`lush` 有 167 个叶命令，`lushw` 有 23 个，help 两边共享。主要问题如下：

| 问题 | 实际例子 | 设计处理 |
| --- | --- | --- |
| 一个入口承担不同业务 | `order` 同时新建、追加、暂存、创建管家 | 新建仍用 order；即时追加用 worker message；草稿与条件追加归 input draft；管家归 valet submit |
| 一个对象按开发时期散落 | 管家分布于 order、valet、hooks management | 专属动作集中到 valet；通用运行记录仍复用 worker，不复制同义命令 |
| 把内部读面命名暴露给用户 | page、completion-page、delivery-graph | 用户按列表、自动化、合并查询；分页变成参数，不再当业务动作 |
| 配置缺少边界 | agent set/configure、config patch、hooks auto-select | 设备策略归 config；资源目录归 agent；单 Worker 覆盖归 worker config |
| 名字相似但行为不相同 | agent resources 与 agent usage resources | 前者是模型来源缓存，后者实际是扩展／Skills 资源，必须分名而非误删 |
| 失效接口占据正式目录 | hooks install、convergence on/off 等 | 从可执行命令目录删除；旧输入仅得到本地迁移提示 |
| 语义没有从名字中体现 | notice read 是标已读；interrupt 是安全点暂停 | 改为 mark-read、pause；请求已接收与真正生效分开显示 |

现有单一目录、实际 CLI bridge、逐 RPC 权限校验是基础资产，应继续利用。精简以“同一意图只有一个正式入口”为准，**不以叶命令数量下降作为验收指标**；把含多种动作的 login 拆开可能增加叶数，却减少记忆和误用。

## 2. 总体结构

以下保留已确认的信息架构，不是第二份运行时注册表。全部旧叶命令的去向见[迁移清单](cli-migration.md)。

```text
lush
  order '目标'                       新建开发指令，一步提交
  status / doctor / help             项目概况、代码身份、离线帮助
  worker                            工作记录与生命周期
    list / show / tree / graph       列表、详情、委派树、完整图
    message / create / spawn         追加、空容器或复制、即时委派
    transcript / watch / events      执行正文、终端观看、事件
    progress / relations / wait      里程碑、直接关系、用户终端等待
    pause / resume / retry / cancel  暂停、继续、重试、终止
    merge request/show/cancel/graph  本轮合并请求与诊断
    accept-preview / accept         验收及回收
    delete-preview / delete         彻底删除的预检与执行
    sync / config / automation      父同步、运行覆盖、实际挂载
    rename / reopen / cleanup       展示标题及低频维护
  input                             人类输入与尚未发送的草稿
    list / show / targets
    draft list/show/create/update/remove/submit/cancel/release
  notice                            决策与告知
    list / events / ask / notify / answer / dismiss / mark-read
  branch                            分支与代码关系
    show / tree / graph / history / versions / bind / archive
    merge-all                       普通串行批量请求，不调用整合 Agent
    integrate preview/start/show/cancel/retry
    legacy-convergence              旧记录读取和旧在途重试
  automation                        项目功能注册目录
    list / register / save / remove / upgrade
    completion-defaults             只影响未来新指令
    command / signal                被引用的动作定义与时间信号
  valet                             管家专属管理事务
    submit / schedule / receipt / emergency
    context / self                  仅真实管家 invocation 可用
  agent                             执行软件、模型来源与安装资源
    status / model / source / resource / package / usage / prompt / env
  config                            设备配置与显式迁移
    runtime / agent / network / auto-answer / valet-permission / migration
  project pause/resume/diagnostics   当前项目维护与用量诊断，不跨项目
  daemon                            项目后台本地生命周期、日志、停止请求
  host                              Web 工作台本地生命周期

lushw
  self / parent / children          invocation 绑定；不接受任意项目目标
  question / skills / help          本地辅助；不需要项目或 invocation
```

### 对象的边界

- **order 是动作，不再是混合输入路由器。** 它保留新建所需的分支、运行覆盖、条件与独占参数；删除 `--management`、`--buffer`、`--append`，删除已无独立意义的 `--defer`。不另加 `worker run` 或 `input submit` 作为同义新建入口。
- **worker 是持久运行记录，不等于调用进程。** 支持现有 W／V 目标的通用读取、追加、暂停、取消及删除继续共用 worker；Git、合并、验收、开发设置仍按真实类型拒绝 V。不再另造 `valet show/watch/message` 这一套同义入口。管家专属的创建、信号绑定、受控收据与急救才放 valet。
- **input 管原话与未发送意图，worker message 管直接追加。** draft 是 input 下的子资源，不恢复已退役的顶层草稿／planner 流程。草稿保存不创建 Worker、不授权调用；submit 授权可靠挂载，不承诺立即执行。
- **automation 管定义，worker automation 管挂载。** 注册、固定版本挂载、实际执行仍是三件事；不恢复“一步注册并安装”或手动执行快捷指令。
- **config 管策略，agent 管资源。** Agent 默认／角色配置迁到 config agent；模型来源、安装包、模型候选及统计读取留在 agent。Prompt/env 的本地检查与约定文件初始化留在 agent，不伪装成设备配置 RPC。
- **project、daemon、host 不是同一控制面。** project pause 是安全维护门；daemon stop 是本地停止工作流；daemon request-stop 仅提交受控 RPC；host stop 不停止项目。目录归类不能抹掉执行身份差异。

## 3. 命名与参数规则

1. 实体名默认单数：`source`、`package`；`children` 保留自然的亲缘复数，`skills` 保留现有指南入口。不为形式统一强行重命名一切。
2. `list` 查集合，`show` 查一个对象或配置，`events` 查事件，`transcript` 查执行正文，`history` 查领域历史（输入、版本、使用量）。不再使用 get/inspect/show 混指同一种 CLI 意图。
3. `create` 创建，`set` 修改指定字段，`replace` 提交完整配置，`reset` 恢复继承；`save` 仅用于现有“含身份则存新版本、无身份则创建”的定义协议。不把 replace 偷换成 patch。
4. `remove` 移除配置／草稿／挂载，`delete` 彻底删除工作历史与专属资源，`cancel` 撤销未来意图或终止工作，`pause` 可继续，`accept` 验收并安全回收。帮助必须说明各自不能撤回什么。
5. 简单高频动作保持短：`worker message W5 '说明'`、`worker accept W5`。多动作资源才设子目录：`worker merge request W5`、`agent source models refresh ID`。不提供可执行缩写、隐式动词、模糊前缀或同义别名。
6. 独立预检仍为只读叶命令：保留短的 `accept-preview`、`delete-preview`；操作组内使用 `preview`，例如 `branch integrate preview`。不引入在同一叶命令下切换读写权限的通用 `--dry-run`。
7. `--project` 仍只选择当前操作项目，绝不隐式启动；设备策略不因为当前目录改变。`--scope device` 沿用既有授权规则，Valet 仍需用户本轮明确授权；不把设备域名当成授权。
8. 参数使用 kebab-case；普通布尔旗标用有／无，显式配置值统一 `on/off`，查询布尔沿现有契约转义。重复单值参数、未知参数、冲突模式、非法整数在副作用前拒绝；条件旗标允许重复，仍为 AND。
9. Worker 参数继续接受真实 W／V 编号或整数；O/D/N 仍只展示，Input、Notice、游标参数用原整数。不得由内部 ID 猜编号，不改写历史引用。
10. `--file PATH` 与 `--data JSON` 只对支持的结构化输入提供互斥路径；不成为任意 RPC 入口。秘密只能经受保护文件输入，不经 argv；Valet 不获得文件读取。`--` 后的正文按文本处理，正文中的 `--help` 不应误触发帮助。

## 4. 几个必须设计清楚的工作流

### 提交、追加与草稿

```text
lush order '实现登录' --branch main
lush worker message W5 '补充测试'
lush input draft create '等前项合并后继续' --append-to W5 --after-merged W6
lush input draft show 17
lush input draft submit 17 --revision 3
```

直接 message 保留现有入箱／冻结暂存语义；**旧 `order --append` 走 input.emit，不应直接改写成 worker.message 后声称完全等价**。需要保留可靠条件发射、原收据或延迟准入的旧脚本，迁到 draft create → submit；接受多一步显式授权，不偷偷丢条件。只保存草稿的原 `order --buffer` 改为 draft create。`--quiet` 明确改为 `--when-idle`，它是调度条件，不是静默输出。

输入结果分别报告 saved、scheduled、delivered、unknown；只有真实获得 Input／Message 才报告已投递，实际 Worker 身份可以暂时没有。cancel 与 release（仅释放独占）保持独立，后者不取消提交。新建草稿的私有运行覆盖只在 submit 时通过 `--profile-file` 传给现有 input.emit，不保存进 draft；追加不能覆盖目标配置。草稿路径失败不得自动另建或重发。

### 合并、自动化与验收

```text
lush worker merge show W5
lush worker merge request W5
lush worker merge request W5 --after-merged W6 --revision REV
lush worker automation show W5
lush worker automation completion W5 accept --revision REV
lush worker accept W5
```

- merge request 是本轮一次请求；带条件时走既有 merge_after，使用该条件配置 revision；不带条件走 reserve，不改变持久自动开关。merge cancel 只撤销合法的未发出请求。
- automation completion 是最高自动级别，不是“立即完成”。旧 auto-merge 开关归并到实际挂载的 enable/disable，目标挂载 ID 为现有 `auto-merge`；**不能把 on 一律翻译成 completion merge**，否则可能降低既有 accept 授权。采用现有 Hook 更新路径的 revision 和全部准入，权限差异须在切换清单中显式核对。
- `branch merge-all main` 仍是逐项普通请求；`branch integrate start main --revision REV` 仍调用整合 Agent。不把二者合成一个含义模糊的 merge 命令。
- accept 保留子树安全核验、交付证明与资源回收；失败不假装验收成功。cleanup 仍是低频资源维护，不当作 accept/delete 的别名。开发 Agent 不新增任何管理权限。

### Notice 的读写分离

`notice ask` 发布决策，`notice notify` 发布非阻塞信息；删除同时靠默认 kind 和选项改变阻塞语义的 post。用户入口、Valet 自身入口及 `lushw self notice` 都用相同动作词，但授权、输入格式和目标范围仍各自固定。开发问卷保持 question create/check 的本地准备，然后 self notice ask 发布并结束本轮；dismiss 不是同意，mark-read 不是执行。

### 设备配置与模型来源

`config agent set default ...` 只作字段更新；`config agent replace --data JSON --scope device` 提交完整显式配置，不先读取 Valet 无权读取的私有配置。`worker config set` 保留“来源＋模型窄更新”与“完整显式覆盖”两种互斥模式，前者必须原子保留其它字段；保存不自动继续、重试或热换当前调用。

`agent model choices` 是模型来源及额度缓存，`agent resource list` 是本机扩展／Skills 资源，`agent status` 是执行软件状态，不是额度或调用状态。`source refresh` 显式联网查额度，`source models refresh` 显式联网刷新模型目录；list/show 不隐式刷新。设备配置、项目历史、实际消费者分别标 scope，不能从命令根名推定所有字段都全局。

## 5. 输出、分页与帮助

- 默认人类输出给结论、真实编号、关键状态和下一步；详情不再默认把整个对象作为 JSON 倾倒。`--json` 的 stdout 严格只有一个版本化 JSON 值，进度和非结构化诊断去 stderr。
- 建议 JSON 外壳为 `{version:1,data,page?,outcome?,warnings?}`。data 保留已有安全读模型及真实身份；page 统一 `next_cursor/has_more/limit`，不得丢掉 coverage、截断原因和原总数。outcome 明确请求已接收、等待、结果未知，不把 CLI 正常返回包装成业务成功。
- `worker list --view recent/all/history` 分别承接 activity/list/page，默认 recent（活动项加有界历史尾部），**不是三个等价查询**。all 保留完整枚举能力，history 保留终态历史；原 scope 和 brief 仍按各 view 的有效范围校验。不跨页客户端过滤冒充完整筛选。
- 输入 list 只查已发送历史；draft list 只查未发送／挂载中的意图。Notice list 的 current/history 视图分别承接 list/page；增量事件单独用 notice events，不能用列表游标冒充事件游标。
- 游标包装必须带版本、view、scope／筛选与底层续读来源，拒绝混用；保留后台签名游标原值。recent 的续读只接历史尾部，不重新插入活动列表。一次 CLI 调用默认只取有界一页，不默默扫全项目；包装游标不是鉴权证据。
- 退出码建议：0＝收到正常结果／受理收据（可能仍排队或待确认）；1＝确定失败；2＝参数错误；3＝身份／授权拒绝；4＝版本冲突或准入阻塞；5＝副作用结果未知；130＝本地中断。只有可信执行前／完成边界才能区分未开始、已生效、未知；不靠异常字符串推断，不自动重试写入。
- 信息披露采用“少量固定提示 → 分层 help → 按需工作流 → 可信执行反馈”。帮助按可信入口生成用户、Valet、Worker／用户上下文视图；根与组只给短索引，叶命令提供 CLI 参数、值的来源、前置条件、效果及恢复说明，不让 Agent 自行翻译底层 RPC。
- `help --search` 按名称／用途／场景搜索固定文档；`help workflow [TOPIC]` 解释跨命令步骤及停止点；`help --all` 是当前视图的分页短目录，显式 `--json` 输出同源机器描述。启动注入目录版本，允许复用已读静态用法，不要求每次调用前重复读帮助。
- 帮助离线、不读私有材料；静态适用性不是实时授权，不能缓存权限或假定目标可执行。完整语法、叶帮助契约、视图边界、缓存和真实链路验收只在[能力发现方案](cli-agent-discovery.md)维护。

## 6. 权限和实施架构

不改变[开发／管理身份契约](../reference/api.md#开发与管理双入口)、[Valet 受控 bridge](../engineering/hook-signals-management.md)、[交付安全门](../engineering/merge.md)和[验收契约](../engineering/worker-acceptance.md)。不机械重命名 RPC、数据库字段、Event、环境变量、分支／工作区或历史正文。

在现有 catalog 上形成 **CommandSpec 单一声明源**：稳定 command ID、唯一可执行入口、path、参数 schema、read/write 分类、身份／scope、分支实际调用的 RPC、脱敏输出适配及示例；按[能力发现方案](cli-agent-discovery.md)补充用途／关键词、参数来源、前置读取、效果和恢复说明，workflow 只引用稳定命令身份。parser、help、Web 学习页、Worker CLI 预检、Valet 静态准入共用；运行时 dispatcher 仍是授权权威。不要再依赖 `daemon` 等根名前缀一刀切权限：request-stop 与本地 stop 同组但权限不同。

旧路径只进入独立、不可执行的迁移提示表，不进入命令注册／能力发现，不读取文件或转调新命令。RPC 权限键和历史审计保留；已保存的旧命令历史仅用于展示，不在重放时静默转换。多路径合并后仍按实际选项检查全部前置读取和写入权限，不能因为一条命令可见就放行其所有分支。旧入口的权限收紧不得因重命名失效；底层方法确实变化时列明差异，不自动转移自定义授权。

旧叶路径与新目录同名时按完整参数语法区分：例如旧 `worker merge W5` 必须拒绝并提示 `worker merge request W5`，而 `worker merge` 只显示子组帮助。旧 `worker list` 路径保留但默认视图变化，必须在升级说明突出；脚本若要旧枚举范围须写 `--view all`。不能用“不保留别名”掩盖这些仍能解析但语义改变的调用。

### 改动类型与顺序

| 阶段 | 内容 | 完成条件 |
| --- | --- | --- |
| 1. 冻结契约 | 复核迁移表与参数、身份、scope、revision、返回值；保留后端协议 | 每个旧叶及重要模式有明确去向；不能仅查 RPC 在目录出现 |
| 2. 命令核心 | 新目录、严格 parser、读写分类、输出／分页、分层 help／搜索／工作流、不可执行迁移提示 | 帮助文本／机器描述与真实分发同源，目录版本可识别；秘密和未知副作用不泄漏／重放 |
| 3. 完整调用方迁移 | bins、源码快捷脚本、Skills／Prompt 的短启动契约、Valet bridge、CLI 学习页、Worker CLI 试运行、文档 | 三种真实身份从发现到执行的调用链分别通过；区分 bridge JSON 外壳与 help 正文，旧拼写不得继续执行 |
| 4. 原子发布 | 同一发布包切换所有入口；在用户确认的安全点分别更新 Host 与 daemon | 不混用目录／schema 版本；在途会话、权限配置和旧收据可核对 |

大部分为 CLI 重组。新增薄适配限于：draft create/list/show 与 signal list 的现有读写协议投影；worker config show 接现有用户专属 run_settings；多读面统一分页外壳；局部参数与诊断规范化。信息披露另增加离线分层 help、固定文档搜索／工作流主题、机器描述和目录版本，不增加模型工具或执行权限。其中分页和错误证据必须核对现有 RPC 是否足够，**不足时只补窄读面／类型化诊断，不靠假数据完成统一，也不引入泛型 RPC 命令**。

源码 `bun run tree/inspect/message/...` 快捷包装在正式切换时删除，统一为 `bun run lush ...`／`bun run lushw ...`，避免仓库再养一套口头命令；构建、测试、docs:check 等工程脚本不在此删除范围。旧外部脚本和自定义 Prompt 提供迁移表，不自动改写。

## 7. 验证与验收

静态目录覆盖核对与文档检查不能证明新接口已经可执行。实施必须先在最终集成树验证真实链路：用户 bin → parser → RPC → 结果；可控 Provider → 固定 Valet bridge → CLI → 权限／执行／收据；开发 invocation → lushw → 亲缘核验 → 返回；再补 Web Worker CLI 的预检、租约和历史。各 Agent 链路必须包含从帮助发现命令、获得真实前置值到解释结果的过程；具体披露断言见[能力发现验收](cli-agent-discovery.md#8-实施接线与验证标准)。

复用现有 `test/cli-catalog.test.js`、`test/cli-entrypoints.test.js`、`test/worker-context.test.js`、`test/worker-cli-trial.test.js`、`test/project/management-cli.test.js` 及已有问卷／结果告知主流程，不为每个重命名新建用例。迁移清单作为数据驱动断言覆盖已移除的旧拼写拒绝、保留路径的默认语义迁移，以及新入口注册／帮助／实际权限一致；权限、副作用及异步收据不能只用 mock 目录断言代替。

实施后的顶层指令 Worker 负责先跑 `bun run test:integration cli rpc page`，再对最终代码树跑 `bun run test` 和 `bun run docs:check`；分工 child 只做专项与受影响回归。最终验收重点：常见动作能从对象帮助直接找到；没有可执行旧别名；现有有效能力均有去向；无权限扩大；不误报提交、合并、验收或未知结果；没有历史迁移／自动重放。
