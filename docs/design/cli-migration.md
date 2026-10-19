# CLI 重设计迁移清单（提案，未实施）

本清单是[整体提案](cli.md)的有限迁移附录，面向后续实施者，冻结核对基线 `f0df8e6793904d363d73648c9ca452ddd6098d37` 的实际 catalog。不是当前命令参考，不授予执行或接口退役权限；实施时必须复核后续新增命令。完成切换后，把有效契约收回代码目录及现行参考，不长期维护两套命令表。

表中省略可执行文件与未改参数；每个旧叶仅登记一次。箭头目标是建议的唯一正式入口，括号说明必须保留的模式／语义；涉及多个目标时按明确动作分流，不建立别名。所有未明确修改的选项、私有文件限制、revision、目标类型及 RPC 权限保持。命令目录层不是叶命令，源码快捷包装另见主方案。

## lush：入口与服务

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `help` | `help [PATH]`，新增可信视图、search、workflow 主题、有界 all、显式 json 与目录版本；详见[Agent 能力发现](cli-agent-discovery.md) |
| `status` | `status --detail` 保留 system.status 全量安全读面；不带 detail 默认 system.summary |
| `system summary` | `status`，保留 development 筛选；不与 detail 混用 |
| `system diagnostics` | `project diagnostics`，当前项目速率／估算费用，不冒充全设备统计 |
| `system interrupt-all` | `project pause`，保留 notify-completion 和持久维护门 |
| `system resume-all` | `project resume`，只恢复本次维护影响范围 |
| `system stop` | `daemon request-stop`，仅受控 RPC，不执行本地进程工作流 |
| `daemon start` | 不变，本地用户专属 |
| `daemon stop` | 不变，本地等待停止工作流；不与 request-stop 合并 |
| `daemon restart` | 不变，不自动重启忙碌项目 |
| `daemon status` | 合并到 `status --detail`；当前两者实际同调 system.status |
| `host start` | 不变，PORT／foreground 与全局、显式项目模式保留 |
| `host stop` | 不变，只停止 Host |
| `host restart` | 不变，明确登录会话失效 |
| `host status` | 不变，真实 Host 进程身份，不能用 status 替代 |
| `doctor` | 不变，磁盘／daemon／Host 身份核对及 verbose 模式 |
| `log` | `daemon log`，本地用户日志读取，Valet 不开放 |
| `order` | 仅新建开发指令；management → valet submit；buffer → input draft create；append → draft create/submit 保留发射协议，直接追加另用 worker message；quiet → when-idle；删除 defer |

## lush：输入与通知

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `input history` | `input list`；view=drafts 分离为 input draft list；保留全库搜索、模式、过滤与分页 |
| `input get` | `input show KIND ID`；kind=draft 改 input draft show ID；input/message/management 仍明确来源 |
| `input parents` | `input targets`，显示合法新建目标，不泛化成项目枚举 |
| `input emit` | `input draft submit ID --revision REV`，授权已保存版本；新建可显式传 profile-file 至既有 input.emit，追加禁止覆盖；不是立即运行保证 |
| `input cancel-emission` | `input draft cancel ID --revision REV`，不撤回既有副作用 |
| `input release-exclusive` | `input draft release ID --revision REV`，只释放独占，不取消挂载 |
| `input buffer update` | `input draft update`；target 统一为 append-to，保留 mode、branch、conditions、exclusive、references |
| `input buffer remove` | `input draft remove ID --revision REV`，不可删已提交原话 |
| `notice list` | `notice list --view current`（默认），原 notice.list 读面 |
| `notice page` | `notice list --view history`，原 notice.page 筛选与分页，不用 current 结果冒充历史 |
| `notice sync` | `notice events`，保留增量 cursor 与事件语义 |
| `notice post` | `notice ask` 或 `notice notify`；目标仍显式 worker，禁止 notify 携带问卷 |
| `notice answer` | 不变，文本与 answers-file 互斥，可能恢复 Agent |
| `notice dismiss` | 不变，不表示接受推荐项 |
| `notice read` | `notice mark-read ID`，标已知，不读取正文或执行动作 |

## lush：Worker 读取、输入与运行

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `worker list` | `worker list --view all`，保留按内部 ID 升序完整分页及 brief；新默认不是此 view |
| `worker activity` | `worker list --view recent`（新默认），活动项＋有界历史尾部；不命名为 active-only |
| `worker page` | `worker list --view history`，终态历史页，保留 work/all scope |
| `worker graph` | 不变，高级读面；details、归档、隐藏状态与完整图分页不能被 tree 代替 |
| `worker tree` | 不变，委派树；保留目标与人类输出状态说明 |
| `worker inspect` | `worker show ID`，保留按真实用户／Valet身份的不同 coverage |
| `worker progress-history` | `worker progress ID`，里程碑规划历史，不混入执行正文 |
| `worker relations` | 不变，直接父子局部关系与真实分页 |
| `worker transcript` | 不变，单次执行正文／受限元数据读面，按真实身份脱敏 |
| `worker watch` | 不变，仅用户终端 TUI；不增加开发 Agent 轮询能力 |
| `worker history` | `worker events ID`，事件元数据与各身份有界读面 |
| `worker wait` | 保留为高级用户终端命令；帮助明确等终态而非 Agent 本轮返回，失败／取消非成功；与 watch 不混为一谈 |
| `worker create` | `worker create` 创建暂停空容器，`--from ID` 表达原 fork 来源；原 parent/title/profile-file 保留；不授权执行 |
| `worker spawn` | 不变，活动父下即时委派；不能与 create 合并，否则会改变首次输入及自动合并授权 |
| `worker rename` | 不变，只改展示标题；空值恢复自动标题 |
| `worker message` | 不变，直接追加；合法冻结输入可靠暂存，成功不证明 Agent 已处理；Valet 追加仍限真实用户 |
| `worker configure` | `worker config set`；窄 connection/model 与完整 data 互斥；profile-json 改 data，不新增私有读取前置依赖 |
| `worker clear-override` | `worker config reset ID`，清 Worker 显式覆盖，恢复继承，不改设备默认 |
| `worker interrupt` | `worker pause ID`，安全点暂停请求，不伪装进程已退出 |
| `worker resume` | 不变，继续或开始合法暂停 Worker，可能调用 Agent |
| `worker retry` | 不变，只重试合法失败，不用 resume 覆盖失败语义 |
| `worker cancel` | 不变，终止／撤销未开始授权，不保证未知副作用已撤销 |
| `worker reopen` | 不变，用户专属恢复历史已合并工作待验收，不自动调用 Agent或重建归档资源 |
| `worker sync-parent` | `worker sync start ID`，程序同步；冲突只返回诊断 |
| `worker resolve-sync` | `worker sync resolve ID`，显式调用 Agent 修复已记录同步冲突 |
| `worker cleanup` | 不变，高级资源维护，keep-branch 保留，不等于验收或删除历史 |
| `worker accept-preview` | 不变，独立只读叶命令 |
| `worker accept` | 不变；普通安全验收与 force/confirm/revision 模式保留，force 不绕过其它安全门 |
| `worker delete-preview` | 不变，保留 force 范围预检 |
| `worker delete` | 不变，精确 confirm/revision；force 必须与预检对应，不变成通用强删 |

## lush：交付与实际挂载

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `worker merge` | `worker merge request ID`，一次请求，仍调 worker.reserve |
| `worker merge-after` | `worker merge request ID --after-settled/--after-merged ... --revision REV`，条件分支仍调 worker.merge_after |
| `worker merge-conditions` | `worker merge show ID`，保留条件 revision 与本轮状态；不得只用 inspect 摘要替代 |
| `worker merge-cancel` | `worker merge cancel ID`，只撤销合法未发出的单次请求 |
| `worker merge-all` | `branch merge-all BRANCH`，原 worker.reserve_all，逐项普通串行队列，不是 integrate |
| `worker delivery-graph` | `worker merge graph`，高级真实交付关系／历史诊断，不改 parent_id |
| `worker completion-page` | `worker automation list`，分页读取实际授权；不是执行历史或模板目录 |
| `worker hooks` | `worker automation show ID`，含完整合法挂载视图及 revision |
| `worker completion` | `worker automation completion ID off/merge/accept --revision REV`，最高自动级别，不继承给 child |
| `worker auto-merge` | 合并到 worker automation enable/disable ID auto-merge --revision REV；保留开关逻辑而非硬改最高级别，新增 revision 前置读取；旧 auto_merge 与 hook_update 权限不静默互授 |
| `worker hook attach` | `worker automation attach`，引用已登记固定版本，保留 file/data 互斥与 revision |
| `worker hook enable` | `worker automation enable`，不重放失败／未知的一次性挂载 |
| `worker hook disable` | `worker automation disable`，只阻止未来动作 |
| `worker hook remove` | `worker automation detach`，解除实际挂载，不删除注册定义；保护系统／child流程 |

## lush：项目自动化与管家

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `hooks list` | `automation list`，保留目录、聚合配置与真实 revision；子资源读取使用同源投影 |
| `hooks register` | `automation register`，只注册动作及功能，不挂载或执行 |
| `hooks save` | `automation save`，保存定义新版本，不等于 register 的组合事务，不静默升级挂载 |
| `hooks remove` | `automation remove`，仍有挂载时拒绝 |
| `hooks upgrade` | `automation upgrade`，显式升级旧定义／挂载，不能藏在 list 中 |
| `hooks install` | 删除：已经退役；本地提示先 register 再 attach，不保留执行别名 |
| `hooks completion-defaults` | `automation completion-defaults set on/off merge/accept --revision REV`；项目未来指令默认，不归设备 config |
| `hooks auto-select` | `config auto-answer set on/off --revision REV`，设备策略，可能答复已有问题并恢复调用；不是模型选择 |
| `hooks command list` | `automation command list`，快捷指令定义，不提供 run |
| `hooks command save` | `automation command save`，固定版本保存 |
| `hooks command export` | `automation command export`，版本化 Skill 风格文本，只读不安装 |
| `hooks command remove` | `automation command remove`，阻止未来执行，保留原安全门 |
| `hooks command history` | `automation command history`，before/limit/execution 及互斥语义保留 |
| `hooks command history-remove` | `automation command history-remove`，危险清理 EXECUTION_ID 或 all，不归普通 remove |
| `hooks command import` | `automation command import`，显式旧内联源导入并停用源 Hook，不能做自动迁移 |
| `hooks signal save` | `automation signal save`，具名时间信号，不证明额度恢复 |
| `hooks signal remove` | `automation signal remove`，保留绑定引用门禁 |
| `hooks management create` | `valet schedule create`，创建未来信号绑定，不立即调用 Agent；与 submit 区分 |
| `hooks management enable` | `valet schedule enable`，保留 revision 与可启用状态核验 |
| `hooks management disable` | `valet schedule disable`，撤销未开始授权，不强杀已开始副作用 |
| `hooks management receipt` | `valet receipt show EVENT_ID`，安全收据及有界时间线，保留 after/limit |
| `hooks management emergency-preview` | `valet emergency preview`，当前项目全管家范围、只读、真实用户专属 |
| `hooks management emergency-stop` | `valet emergency stop --confirm --revision REV`，永久撤权与停止；stopping 不等于 isolated |
| `hooks management permission-get` | `config valet-permission show METHOD --scope device`，原 management.permission_get |
| `hooks management permission-set` | `config valet-permission set METHOD ACCESS --revision REV --scope device`，权限修改仍须真实用户精确批准 |
| `valet query` | `valet context show [ID]`，仅管家 invocation 的安全跨树摘要，不是用户通用 show |
| `valet history` | `valet context history`，仅管理身份安全调用历史，不能冒充原始会话 |
| `valet auto-title` | `valet self title '标题'`，自身一次性自动标题 |
| `valet progress plan` | `valet self progress plan`，真实自身里程碑，不指向任意目标 |
| `valet progress complete` | `valet self progress complete`，只标实际完成 |
| `valet notice post` | `valet self notice ask/notify`，问卷只用内联 data；不得打开本地文件或复制开发 context 权限 |

## lush：分支与历史归并

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `branch history` | 不变，版本历史与交付追溯 |
| `branch version-graph` | `branch versions`，main 可达／固定成功交付来源图；delivery 仍为 Event ID |
| `branch graph` | 不变，与 Worker 图不是同一对象 |
| `branch tree` | 不变，分支谱系与 verbose |
| `branch show` | 不变，单分支详情 |
| `branch bind` | 不变，显式绑定已有本地分支；不暴露裸 Git 写入口 |
| `branch archive` | 不变，高级特殊／失败分支资源操作；discard/continue 风险及归属检查保留，不等于 Worker accept |
| `branch integrate plan` | `branch integrate preview`，只读固定来源集合预检 |
| `branch integrate start` | 不变，带 revision；实际调用整合 Agent |
| `branch integrate show` | 不变，操作 ID 而非 Worker／分支 ID |
| `branch integrate cancel` | 不变，安全停止并保留来源和私有代码 |
| `branch integrate retry` | 不变，显式重试固定操作，重新验证最终树 |
| `branch convergence list` | `branch legacy-convergence list`，历史只读，不作为当前功能推广 |
| `branch convergence show` | `branch legacy-convergence show`，历史单分支策略／revision |
| `branch convergence runs` | `branch legacy-convergence history`，历史运行有界分页 |
| `branch convergence retry` | `branch legacy-convergence retry`，仅原可恢复旧在途，不转成新整合 |
| `branch convergence defaults show` | `branch legacy-convergence defaults`，只读旧默认，不与当前设置混用 |
| `branch convergence on` | 删除：已退休写入口，不恢复持续归并 |
| `branch convergence off` | 删除：已退休写入口，不修改历史启停 |
| `branch convergence mount` | 删除：已退休写入口，不挂载持续归并 |
| `branch convergence remove` | 删除：已退休写入口，不删除历史挂载 |
| `branch convergence defaults set` | 删除：已退休写入口，不修改历史默认 |

## lush：设备配置、Agent 与模型资源

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `config show` | `config runtime show`，统一从 system.settings 获取设备策略，保留原限额与只读历史字段；不以 system.status 旁路读取 |
| `config set` | `config runtime set KEY VALUE`，现有三种命名限额与范围检查保留 |
| `config patch` | `config runtime set --data JSON`，与 KEY VALUE 互斥，仍是 patch，不先读取私有设置 |
| `config reset` | `config runtime reset [KEY/all]`，all 仍只恢复原三个限额，不扩大成设备所有配置清空 |
| `config migrate-preview` | `config migration preview`，当前项目旧根 → 设备根，保留只读预检 |
| `config migrate` | `config migration apply --confirm --revision REV`，保留备份与安全续办，不自动覆盖／重放 |
| `agent show` | `config agent show`，私有配置读面仍不可供 Valet 绕权 |
| `agent set` | `config agent set TARGET ...`，现有字段更新；依赖读取的权限必须明示 |
| `agent configure` | `config agent replace --data JSON --scope device`，完整显式配置，不强制读取 agent.config |
| `agent reset` | `config agent reset ROLE`，只清角色覆盖，不增加 default reset 含义 |
| `agent network show` | `config network show`，设备代理安全读面，凭证不回显 |
| `agent network set` | `config network set --file PATH`，仍用户本地安全文件；不因移出 agent 目录就向 Valet开放 |
| `agent network reset` | `config network reset`，恢复继承后台启动环境，不热改旧调用 |
| `agent prompt` | `agent prompt show ROLE`，本地最终 Prompt，仅用户 |
| `agent init` | `agent prompt init [ROLE] [--local]`，创建补充约定文件，不覆盖已有文件；项目／设备根语义保留 |
| `agent env` | `agent env show ROLE`，只显示键与来源，值脱敏 |
| `agent status` | 不变，实际是执行软件安装与版本诊断，修正旧帮助的“调用状态”描述 |
| `agent models` | `agent model list --backend pi/codex`，沿原后端发现逻辑，不冒充来源缓存 |
| `agent resources` | `agent model choices`，agent.selection.resources 的托管来源／模型／额度缓存 |
| `agent usage resources` | `agent resource list`，agent.resources 的扩展／Skills／安装资源，不与模型缓存合并 |
| `agent sources list` | `agent source list`，安全连接列表与最新观测缓存 |
| `agent sources show` | `agent source show ID`，单来源安全详情 |
| `agent sources save` | `agent source save --file PATH`，用户专属私有文件，凭证不经 argv／输出 |
| `agent sources remove` | `agent source remove ID`，不改历史调用／外部客户端凭证 |
| `agent sources refresh` | `agent source refresh [ID]`，显式额度联网查询，默认全部范围保留并在帮助注明 |
| `agent sources models` | `agent source models list ID`，只读缓存 |
| `agent sources models-refresh` | `agent source models refresh ID`，显式联网写缓存；失败不冒充旧缓存成功 |
| `agent sources login` | `agent source login start/poll/cancel/finish`；start 的 method=device/callback，poll/cancel 仍仅原设备流；poll 可能写入认证，不能标成只读 status；finish 只接原回调文件 |
| `agent sources history` | `agent source history ID`，项目归因历史与 days，不能冒充全设备完整历史 |
| `agent sources sampling` | `agent source sampling set --data JSON --scope device`，设备采样配置，不隐式开启 |
| `agent packages list` | `agent package list`，设备安装库 |
| `agent packages install` | `agent package install SOURCE`，沿现有固定来源安全校验，不自动启用 |
| `agent packages remove` | `agent package remove ID`，仍按最新授权与设备 scope |
| `agent packages update` | `agent package update ID`，包可执行代码风险不变 |
| `agent usage show` | `agent usage config show`，统计配置，不误认为统计数据 |
| `agent usage set` | `agent usage config set --data JSON`，保存统计配置，不更改统计历史 |
| `agent usage history` | 不变，provider/account-key/days 原安全筛选 |

## lushw：开发协作与离线辅助

这些操作仍由有效 invocation 定位自身及直接亲缘；只改 CLI 词汇，不改 context.* 协议。Web 用户上下文 lease 仍仅开放原本映射过的用户等价操作，不能因新目录继承 Agent-only 能力。

| 现有叶命令 | 建议去向与约束 |
| --- | --- |
| `help` | 同源分层离线帮助及搜索／工作流／机器描述；默认开发协作视图，Web 可信用户上下文只投影已映射操作；仅 help 与 lush 共享 |
| `self inspect` | `self show`，不接受自身 ID |
| `self history` | `self events`，安全事件元数据而非完整收件箱 |
| `self transcript` | 不变，原有分页与正文覆盖限制 |
| `parent inspect` | `parent show`，服务端确定直接父 |
| `parent message` | 不变，main/owner 仍不是普通收件箱 |
| `children inspect` | `children show ID`，真实直接 child |
| `children history` | `children events ID`，不扩大历史范围 |
| `children transcript` | 不变，不开放兄弟／孙辈会话 |
| `children message` | 不变，冻结消息可持久暂存，成功不证明已处理 |
| `children list` | 不变，真实分页，不从 inspect 摘要猜全量 |
| `children spawn` | 不变，派工后结束本轮，不等待子 Worker |
| `children accept` | 不变，只验收合法已交付直接 child，默认保留现场，不提前回收 |
| `self auto-title` | `self title`，自身一次性自动标题，不是用户 rename |
| `self notice list` | 不变，只查自身 Notice |
| `self notice post` | `self notice notify '标题' [--body TEXT]` 或 `self notice ask --question-file FILE`；后者发布后结束本轮 |
| `self progress plan` | 不变，规划本轮自身里程碑 |
| `self progress complete` | 不变，只标实际完成 |
| `question example` | 不变，本地题目 JSON 示例，不连接 daemon |
| `question create` | 不变，本地校验并输出完整问题，stdout 可保存供 ask 发布 |
| `question check` | 不变，本地校验不证明发布准入 |
| `skills list` | 不变，固定随代码指南目录，不读设备开启状态 |
| `skills get` | `skills show ID`，与其它详情动词一致，不扩大文件读取能力 |

## 少量补齐的入口与迁移门槛

- help 的 search、workflow 与 all/json 是同一离线发现入口的读法，不新增业务权限或模型工具。同步迁移 Prompt／Skills 中的命令拼写与启动短索引；Valet bridge 的自动 JSON 输出不得使默认 help 文本变成完整机器 schema。静态目录版本与实时授权严格分开，流程引用真实命令 ID，不保存另一套可执行别名。

- 新 `input draft create` 承接原 order --buffer 的 draft.add；draft list/show 是现有 input.history/get 的明确子资源投影。create 的 --append-to 固定 mode=append 和 target，--branch 固定新建父；二者互斥。原 quiet/条件/独占旗标分别迁为 when-idle、原 after 条件及 exclusive；order 与 draft create 共用规范化，保存不授权。update 若改变 mode／去向仍走原版本检查，不得静默改投。
- 新 `worker config show` 仅将现有 worker.run_settings 用户专属读面接入 CLI；不能用它给 Valet 的 set/replace 增加私有读取依赖。普通 worker show 仍只含安全模型摘要。
- 新 `automation signal list`、`automation completion-defaults show`、`config auto-answer show` 取 hooks.list 相应投影与其真实 revision；不新建存储或调度器，不因为按需分组隐藏未知状态。
- 新 `valet submit` 只承接原 order --management 的 management.submit，仍固定当前项目、独立身份与去重边界；不支持开发 draft/branch/条件参数。
- 旧 worker auto-merge 合并到 Hook enable/disable 后，Valet 所需方法会由 worker.auto_merge 变为 worker.hook_update（及其前置读取）。**不能把用户已有的一个授权自动复制给另一个方法。** 切换前列出该差异及原有自定义权限，按已有权限执行；需要调整由用户明确确认，拒绝时提供可理解的迁移提示。相同原则适用于 config show 的读取方法收敛。
- 列表合并不代表 RPC 权限合并：例如 worker list recent/all/history 仍分别校验实际 activity/list/page。目录必须声明参数分支及其前置 RPC；schema 检查只证明格式，不证明权限、资源或生命周期准入。
- 六个已退休叶命令删除后仍保留相应历史与必要后端兼容；其余旧叶的功能迁到上述入口。新名称并不授权删除旧数据库行、恢复持续归并、重放未知操作或操作其它项目。
