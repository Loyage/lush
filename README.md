# Lush

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

Lush 是项目级的多 agent 开发应用。一个 daemon 绑定一个项目目录；输入、任务、agent 会话、工作区与待决问题都属于这个项目。

你随时描述想法，并可指定任一本地父分支。Lush 立即创建 `input-<id>` 分支与 worktree，planner 在这份不可漂移的代码上解析；多项任务再从输入分支创建子分支并行工作。任务结果会在**私有 Intent 分支内自动集成**，但用户选择的目标分支始终不自动变化；用户可为满足稳定性与代码去重条件的已登记分支进行[效果展示](docs/showcase.md)，再明确批准分支合并；底层 Review Candidate 检验与接受接口兼容保留。

Bun 1.2+ / JavaScript / SQLite / Unix socket；daemon 与 CLI 零第三方运行时依赖。Web 文档视图随包内置固定版本的 Mermaid 浏览器资源，用于离线绘制流程图。支持 macOS 和 Linux。

第一次接触任务状态、`code` / `order` 依赖、交付队列或 resolver 时，先从[行动任务流程总览](docs/task-flow.md)开始，再按页尾链接连续阅读“提交与规划 → 私有集成与候选 → 验收与回收”。这条短章路线是交付语义的权威说明；根 README 只保留快速入口与关键边界。

最重要的状态不要混在一起：

```text
Task completed（任务交付提交）
  → 私有 Intent 分支自动集成
  → 可选：为合格的稳定分支启动效果展示
  → 展示页 / 本机预览（不等于检验通过，仍未落地）
  → 审阅代码与检验结果 → 用户明确批准合并
```

详见[私有集成与 Review Candidate](docs/task-flow-2-integration.md)和[验收、诊断与安全回收](docs/task-flow-3-delivery.md)。

## 开始使用

在 Lush 源码仓库内操作统一使用 `bun run`。Web 与桌面应用都可以先启动、再在界面里选择项目：

```bash
bun run web                 # 全局启动器；首次选择项目，以后自动恢复上次项目
bun run desktop             # Electron 桌面版；与 Web UI 可同时打开
```

选中项目后，界面会自动启动或连接该项目 daemon。全局启动器的最后项目记录在用户配置目录（macOS 为 `~/Library/Application Support/Lush/launcher.json`，Linux 为 `${XDG_CONFIG_HOME:-~/.config}/lush/launcher.json`，Windows 为 `%APPDATA%\\Lush\\launcher.json`）；它不是 `LUSH_HOME`，项目事实仍只写入 `<project>/.lush/`。左栏的「切换项目」可以随时改选。桌面版复用完全相同的 Web UI 与 API，只额外提供原生目录选择器；它使用随机本机端口，因此可以和后台 Web 同时运行。桌面版仍要求 Bun 在 PATH 中可用，首次使用先执行 `bun install` 安装 Electron。

CLI 的项目命令仍默认使用当前仓库；操作其他项目时显式指定路径：

```bash
bun run doctor --project /absolute/path/to/my-project
bun run start --project /absolute/path/to/my-project
bun run say '实现登录页面，先研究现有认证流程，再拆分实现和测试' --project /absolute/path/to/my-project
bun run tree --project /absolute/path/to/my-project
bun run web 4318 --project /absolute/path/to/my-project  # 可选：启动绑定单项目的 Web
```

`start` 只启动项目 daemon；`say` **立即返回输入和 task ID，不等待模型或开发完成**（提交时从 `--branch` 指定的本地分支、或当前分支创建 `input-<id>` 分支与检出，所以它短暂排在 Git 串行队列里）。无 `--project` 的 `bun run web` 是全局项目启动器；带 `--project` 时保留原来的单项目模式，日志在该项目 `.lush/web.log`，且不隐式启停 daemon。命令都在后台起进程后立即返回，Web 离线后会自动重连。两种模式默认只监听 `127.0.0.1`；单项目模式如需从公网访问，在项目的 `.lush/web.json` 写入登录凭证：

```json
{
  "version": 1,
  "username": "your-name",
  "password": "a-strong-password-at-least-12-characters"
}
```

全局启动器的公网配置写在用户配置目录的 `web.json`（macOS：`~/Library/Application Support/Lush/web.json`；Linux：`${XDG_CONFIG_HOME:-~/.config}/lush/web.json`；Windows：`%APPDATA%\\Lush\\web.json`），并且必须用 `projects` 列出允许远程打开的项目：

```json
{
  "version": 1,
  "username": "your-name",
  "password": "a-strong-password-at-least-12-characters",
  "projects": ["/absolute/path/to/project"]
}
```

本地、无认证的全局启动器仍可输入任意现存绝对目录；配置公网认证后，路径规范化后必须命中白名单，最后使用的项目不在白名单时也不会自动恢复。Electron 桌面版始终只监听回环地址，不读取这份公网配置。

两类 `web.json` 的文件权限都必须是 `600`。对应 Web 会监听 `0.0.0.0`，首次启动时自动把明文 `password` 原地替换为 scrypt `password_hash`；之后浏览器通过登录页取得 12 小时的 HttpOnly / SameSite 会话 Cookie。密码首尾的空白一律忽略（从终端复制常会带上换行），但大小写与中间字符仍须完全一致：建议选一个**好辨认**的密码，避开 `0/O`、`1/I/l` 这类易混字符；连续输错 5 次会锁 60 秒。登录被拒与被挡的跨站请求都会写进后台 Web 自己的日志：项目模式为 `.lush/web.log`，全局模式为同一用户配置目录下的 `web.log`；`bun run web-status` 会告诉你日志位置以及运行的是否是当前代码。

**通过反向代理或域名访问时**，代理默认会把 `Host` 改写成 `127.0.0.1:4318`，而浏览器发出的 `Origin` 是对外地址；两者不一致的提交会被当作跨站拒绝（登录时报 `Cross-site access denied`）。二选一：

- 让代理保留原始 Host（推荐，nginx 写 `proxy_set_header Host $host;`）；
- 或在当前模式的 `web.json` 里登记对外地址：`"origin": "https://lush.example.com"`（多个用 `"origins": [...]`）。

公网部署仍应在前面配置 HTTPS 反向代理，否则登录密码会在网络中明文传输。跨站请求判定以浏览器自己填的 `Sec-Fetch-Site` 为准（网页无法伪造它），`Origin` 只在旧浏览器没有这个头时作为回退；内嵌 webview、沙箱页面与部分隐私扩展会报 `Origin: null` 却依然是同源，这类客户端能正常登录。删除对应模式的 `web.json` 即恢复仅本机、无需登录的模式。

Web UI（默认 `http://127.0.0.1:4318`）是 **Intent 优先**的项目工作台：左栏是导航，首屏是 **Intent 工作台**（目标、Plan 状态、交付与历史检验结果、真正需要你决定的事）；分支图、待你决定、行动任务、Intent 记录、结构化 Plan 与文档分别在右侧独立成页。右侧顶部始终保留返回上一页的入口，页面地址使用 `#graph`、`#settings`、`#notices`、`#tasks`、`#intents`、`#specs`、`#task-ID`、`#docs` / `#doc-<id>`，浏览器前进 / 后退可以在各视图与任务详情之间往返。首页顶部指标按 Intent 计（Intent / 并行执行 / 需要你决定），并用同一份 `graph.get` 读模型把 Git 交付诊断折叠在成果主线之后；「效果展示」仅在合格分支详情提供次要启动入口，已有展示的任务详情内嵌展示页并提供可操作预览入口；历史候选的报告与 `candidate.accept` / `candidate.changes` 仍保留。任务详情以目标为标题，结果与执行过程优先。执行过程支持内容摘要、工具输入输出配对、完整记录检索和 JSON 结构视图；选中文字右键“介绍”可启动专用无工具解释 Agent，在旁侧阅读结果并保留历史（当前需 Pi，详见[执行记录阅读器](docs/engineering/transcript-reader.md)）。输入框常驻内容区底部（默认折叠，只留一行输入与一行操作，点「更多」展开父分支与快捷键）。窄屏用「导航菜单」展开页面入口。左栏顶部可切换**深色 / 浅色主题**，并集中显示项目名、并发槽、连接状态与退出登录——应用没有整条顶栏，内容区从最上面开始。左栏的**设置**页（`#settings`）分为三个页签：**Agent** 管项目默认与 planner / coordinator / worker / research / verifier / merger / showcase / explainer 八类行为的独立覆盖，可分别选择 Pi / Codex、模型、思考深度并追加项目 Prompt；配置原子写入 `.lush/agent.json`，正在运行的调用不打断，排队任务与后续唤醒立即读取新配置。**界面**管理 Markdown、主题、减少动效、信息列表排序、轮询与消息停留时长，这些偏好只存在当前浏览器；**系统**展示 daemon 参数与路径，其中**并发额度**（执行通道 / 控制通道）可直接编辑、保存即对排队任务生效，「恢复环境默认」清除覆盖，其余参数只读。移动端会压缩导航、工具栏和分支卡片，并让左栏（含品牌 / 项目名 / 连接 / 退出）排在内容与输入区之前；分支诊断 / 设置 / 文档页隐藏底部输入器，把视口优先留给内容。过渡动画尊重系统「减少动态效果」。文档读的是随这份代码发布的 `docs/` 与 `README.md`（不随被开发的项目变），Markdown 相对链接可以直接点开，Mermaid 流程图从同一份 Markdown 源码按需渲染；刷新不丢已输入的答复。

页面内容可以直接“引用到输入”：右键任务可引用单个任务或整棵任务子树，右键交付项可引用 Git / 目标分支，选中任意文字后右键可引用所选内容。引用以卡片显示在输入框上方，加入待提交意图后随草稿持久化；planner 同时收到引用时快照和 invocation 开始时解析的当前状态，目标已被清空时仍保留快照。引用只帮助聚焦，后续仍走同一条 `develop` / `explain` intent 通道。

若 `bin/` 已在 PATH，在目标项目内可以直接使用：

```bash
lush daemon start
lush draft add '给搜索增加键盘导航'
lush draft add '顺便把筛选器抽成组件'
lush draft edit 2 '把筛选器抽成独立组件'   # 改一条缓存输入
lush draft commit 1 2   # 只提交选中的几条（无参即全部）交给一个 planner：拆解、建依赖，然后才创建任务 worktree
lush task tree
lush task inspect 3
lush task message 3 '还要考虑中文输入法'
lush showcase start feature/ui --baseline main  # 分析分支并实际展示效果
lush showcase stop 12   # 停止任务 #12 的托管预览，静态展示页保留
lush task verify 3      # 兼容的底层只读检验入口
lush notice list
lush notice answer 1 '采用方案 A'
lush task merge 3       # 审阅代码与验证报告后，明确批准这个分支
lush task merge 3       # 如果冲突：主树回到合并前，并开一个解冲突任务 + 一条待决问题等你决定
lush task cleanup 3     # 合并后安全回收 worktree 与任务分支（--keep-branch 留分支作恢复点）
lush task delete 3      # 只删这一条已结束任务与它的已结束后代的行（消息、事件一并清）；会丢掉这部分任务历史
lush branch tree        # 分支谱系：谁从谁创建出来（不是 commit graph，也不是任务树）
lush branch show lush/…/7-auth-ui   # 一条分支的 parent / fork commit / task / worktree 与祖先链
lush branch archive lush/…/7-auth-ui  # 不要这条分支了：删 worktree 与本地 ref，任务、事件与会话留在库里
lush daemon stop
```

单条输入也可以用 `lush say '原话'` 立即提交，不等缓存。目标已经足够明确时，用 `bun run say '明确的小任务' --direct` 或 Web「直接执行」跳过规划模型，交给单个 worker；仍保留输入分支、零调用的 planner 占位与人工合并批准，已有草稿不受影响。上下文裁剪、用量归因和默认关闭的 Pi 软预算见 [Token 效率](docs/engineering/token-efficiency.md)。

### 需要你拍板时：选择题与效果预览

Agent 遇到架构、产品行为、UX、接口或需求歧义等关键取舍，会把相关决定合成结构化问卷，放入项目统一的「待定事项」，所有任务分支共用一个入口。发布后 runtime 主动停止该轮 agent，task 标为等待输入，不占执行槽；普通消息和子任务结果不能绕过这份未决问卷。用户提交答案后，通过收件箱唤醒原 task 的下一轮 agent。

Web / Electron 中：**单选点一下即进入下一题 → 多选点选后继续 → 汇总全部选择 → 一次确认并继续任务**。每题支持自定义答案，提交前可返回修改；提交成功自动打开下一个待决问题，结果留在任务「决策记录」。可先查看 Markdown / 静态 HTML 方案预览；HTML 经白名单清洗，在无脚本、无网络、无宿主权限的 iframe 中显示。选择草稿在当前标签页保存，刷新再打开仍在；忽略不等于同意推荐项。

调用方式、JSON 示例及安全边界见[待决问题](docs/reference/rpc/notices.md)。无需安装 pi ask 插件，不迁移已有数据库，旧文字 notice 与计划审批保持兼容。

### 两类输入：develop 与 explain

每条输入有一个流程判定（`inputs.flow`），由处理它的根 planner 用 `lush input flow develop|explain` 记录：

- `develop`：需要新增功能或改代码。照常拆解，派 coordinator/worker，可派 research。
- `explain`：只是了解、询问、解释相关内容。planner 直接把答案写进 result，必要时派 research；runtime 会拒绝 worker/coordinator，因此不会产生任务分支（提交时创建的输入分支仍提供稳定读取上下文）。

未判定（`flow` 为空）的输入按 `develop` 处理。用户随时可以改判：`lush input flow [TASK_ID] develop|explain`（agent 省略 TASK_ID 时判定自己的输入，Web 任务详情里也有「标记为开发/了解」），`lush input list` 会显示当前判定。改判只影响之后的派工，不会追溯取消已经建立的 worker/coordinator 子任务。

### 效果展示与底层检验

Web 的手动验收入口已由效果展示替代：从概览、分支图或任务详情选择分支，专用 agent 在冻结提交的隔离 worktree 中分析变化、设计并执行展示，交付图文页面和适合的本机预览。展示不代表检验通过，不自动合并。预览成功后保留到用户停止或 daemon 退出，重启不自动重放。基线选择、权限与使用方法见[分支效果展示](docs/showcase.md)。

以下 Candidate 流程作为底层兼容接口保留。私有集成完成后，`candidate prepare` 只冻结 integration commit 与 target baseline commit，创建 `pending` Candidate；它**不会**生成报告或自动派 verifier。用户执行 `candidate verify`（CLI / RPC 兼容入口）后才开始对照验收；查看结果后再由用户选择接受、要求修改或放弃。

```bash
lush candidate list --input 1
lush candidate prepare 1 --summary '一句话说明这版做了什么'  # 只创建待验收候选
lush candidate verify 2                    # 用户显式启动验收并生成报告
lush candidate inspect 2
lush candidate accept 2                    # 最终人工接受后才落地目标分支
lush candidate changes 2 '按钮再明显一点'   # 同一 Intent 下启动增量规划，产出 v2
lush candidate reject 2 --reason '方向不对'
```

单 worker 的兼容入口 `lush task verify ID` 也会派只读 verifier，但不等同于 Candidate 已被接受。完整状态机、固定 commit 校验、报告与回收规则见[私有集成与 Review Candidate](docs/task-flow-2-integration.md)、[验收与回收](docs/task-flow-3-delivery.md)和[Candidate API](docs/reference/rpc/candidates.md)。

### Intent 分支：稳定上下文与聚合点

提交输入时可用 `--branch NAME` 选择父分支（省略时用当前分支）。runtime 创建 `lush/<项目哈希>/input-<id>` 与 `.lush/worktrees/input-<id>`；planner 就在这里解析。Plan 编译出的普通 worker 以它为直接父分支，完成后由 Integration Service 自动逐层聚合；全部收拢后才是 Review Candidate 可以出现的时刻。字段名为兼容旧库仍叫 `anchor_*`，但分支已经是可推进的聚合分支。

### 输入缓存与任务依赖

输入可以先攒着：`lush draft add`（Web 输入框里回车）只写缓存、不规划；`lush draft edit ID '内容'`（Web 里点草稿正文就地编辑）改动某一条；`lush draft commit [ID...]`（Web 的「提交并规划」）把选中的草稿交给一个 planner——省略 ID 即提交整个缓存，给了 ID 就只提交这几条、其余继续留在缓存，由 planner 拆成多个任务、给互有先后的任务建依赖边，然后才创建任务 worktree 开工。缓存存库（`drafts` 表），换浏览器或重启 daemon 都不丢；提交后每条草稿留着 `input_id` 作为审计链（已提交的草稿不可改也不可再提交）。

依赖边在 Plan 编译时由 runtime 从 planner 的 spec 依赖建立（`task spawn --depends-on ID[:code|order]` 仍是兼容入口），daemon 只做结构校验：

- `code`（默认）：子任务从上游任务分支拉出，并只合回这个直接父分支；从最深下游开始逐层向输入分支收敛。
- `order`：只等上游结束，代码仍从这条输入的锚点（提交那一刻冻结的 commit）开始。适合等一个调研结论。
- 一个任务最多一条 `code` 依赖；依赖不能指向自己的祖先任务——祖先在等子孙结算，双方会互等而死。
- 依赖未满足的任务保持 `queued`，界面显示「等 #ID」；上游结算时由调度器唤醒，不占 agent 槽。
- 一批 Plan 内没有依赖边的 spec 会同时开工；不同 Intent 的 Plan 也互不等待。
- 语义冲突（重复劳动、改同一个文件）不做自动检测：那是 planner 读任务树自己判断的事，拿不准就问用户。

默认从 cwd 向上找到 `.lush/project.json` 或 `.git`，以那个目录为项目根。`--project PATH` / `LUSH_PROJECT` 可以显式绑定。目录会 canonicalize，符号链接不会创建第二个 daemon。不同 Git worktree 可作为不同项目独立运行；agent 在任务 worktree 内通过注入的 `LUSH_PROJECT` 始终连接所属项目。每次 invocation 还注入 `LUSH_TASK_ID`（与当前 agent 直接绑定的 task）与一次性 `LUSH_AGENT_TOKEN`；`lush progress …` 不接收 task ID，而是由 token 安全绑定同一个 task。

### 运行前提

- 默认 Agent 是 `pi`，也支持 `codex`；对应 CLI 需要在 PATH 中可用且已完成认证。推荐用 `lush agent set ...` 或 Web 设置页写项目级 `.lush/agent.json`；环境变量 `LUSH_PI_COMMAND` / `LUSH_CODEX_COMMAND` 仍可指定可执行文件。
- 提交输入需要项目是 **Git worktree 根目录且父分支有初始提交**。可用 `--branch NAME` 指定任一本地分支；未指定时 detached HEAD 会被拒绝。未提交改动不进入输入分支，并记录在 `input.anchor.dirty_source`；Lush 不替你提交、暂存或 stash。分支落地时，涉及的 child / parent worktree 都必须干净。
- 非 Git 项目不能提交输入（也建不了实现 worktree）：提交前先 `git init` 并至少提交一次。
- `LUSH_PROVIDER=mock bun run start --project ...` 可离线演示调度。Mock 只派调研任务，不调用模型、不修改代码。
- 改 daemon 自身环境变量或运行代码后用 `bun run daemon-restart`，不是再次 `start`。`.lush/agent/*.env` 与 Prompt 文件补充在每次 invocation 前热加载，不需要重启。Web 是另一个进程：改完 `src/ui/web/` 用 `bun run web-restart`（它先停掉端口上那个后台 Web，再按当前代码起一个新的）；`daemon-restart` 不会动它，而再跑一次 `bun run web` 只会如实报告「已在运行」。先用 `bun run doctor --project PATH` 区分磁盘 / daemon / 项目绑定 Web，或用 `bun run web-status` 检查全局启动器；诊断只给出精确更新命令，不会自动重启。

### Agent Prompt：按角色组合并保留项目覆盖

内置 Prompt 是有名字的公共/角色片段，每个角色只组合自己的职责、相关 CLI、协作知识和安全边界。planner 只收到选择 worker / coordinator / research 所需的短目录，不再携带其它角色的完整操作细节。

```bash
lush agent prompt planner          # 显示最终 Prompt、组成顺序与来源
lush --json agent prompt worker    # 机器可读 parts / source / content / text
lush agent init planner            # 创建可提交的 .lush-agent/common.md、planner.md
lush agent init worker --local     # 创建本机私有的 .lush/agent/common.md、worker.md
```

组合顺序为：角色内置片段（或 `.lush/agent.json` 的 `default_prompt` 替代内容）→ `.lush-agent/common.md` → `.lush-agent/<role>.md` → `.lush/agent/common.md` → `.lush/agent/<role>.md` → `agent.json` 的 `append_prompt`。`.lush-agent/` 可提交给团队，`.lush/agent/` 适合个人偏好。项目 `AGENTS.md` 继续负责代码库约定；角色行为放在 `.lush-agent/`，不要把所有角色的完整协议重新塞回公共上下文。

### Agent 专用环境变量

启动 daemon 的环境仍由所有 agent 继承。额外变量每轮从本机状态目录读取：

```dotenv
# .lush/agent/agent.env：所有角色
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
ALL_PROXY=socks5://127.0.0.1:7897

# .lush/agent/research.env：只覆盖 research
SEARCH_ENDPOINT=https://example.invalid
```

角色文件覆盖 `agent.env`，两者覆盖 daemon 继承环境；若设置 `PATH`，Lush 自己的 `bin/` 仍前置。所有 `LUSH_*` 保留给 runtime，配置时会拒绝。env 使用字面量 `NAME=value`，支持单/双引号与 `export` 前缀，不做 shell 展开。用 `lush agent env research` 查看加载文件和变量名，值始终隐藏；也可在 Web「设置 → Agent → 环境变量」按公共/角色文件编辑，读取后值默认遮罩，下一次调用立即生效。

## 新模型：Intent-first + Candidate-first，Branch-backed

产品主线是 **Intent → Plan → Work DAG → Run → Artifact → Review Candidate**。用户围绕目标和可验收结果行动；Branch / worktree 继续承担代码隔离、集成与恢复，但退回 Git 基础设施层。从[核心架构](docs/core-architecture.md)开始，可连续阅读执行模型与验收闭环。

```text
Intent（逐字保存用户目标）
  └─ planner Run → 结构化 Plan/spec
       └─ deterministic Plan Compiler（代码，不调用模型）
            ├─ WorkItem / worker Run → commit artifact
            ├─ WorkItem / research Run → finding artifact
            └─ WorkItem / verifier Run → evidence artifact
                 └─ Intent integration branch
                      └─ Review Candidate @ exact commit
                           └─ 用户接受 / 要求修改 / 放弃
```

planner 一轮写完 spec 后，runtime 在事务中直接编译根 WorkItem 与依赖边：不再创建 scheduler agent，没有全项目串行 batch，也不为机械 ID 翻译消耗模型调用。高风险计划仍可用 `plan propose` 建审批闸门；批准后由 runtime 编译，驳回则让 planner 带反馈重拆。

每次 provider invocation 都落成独立 `agent_runs` 行；结果同时形成结构化 Artifact。Task 暂时作为兼容的 WorkItem 投影，重试与唤醒不会覆盖 Run 历史。

- control lane：planner 等控制面调用，容量默认取 `LUSH_CONTROL_CONCURRENCY`（2）；长 worker 不会饿死新输入规划。
- execution lane：worker / research / verifier 等执行面调用，容量默认取 `LUSH_CONCURRENCY`（4）。
- 两条车道的容量是**可运行时改写的项目级设置**：环境变量只是默认值，被 `<home>/settings.json` 里显式覆盖的键取代。用 Web「设置 → 系统 → 并发额度」或 `lush config set` 写入，下一次调度立即按新生效值准入，不需要重启 daemon；调低并发不取消已经在跑的任务。
- 等依赖、等子任务、等用户时不占槽。

开发工作完成后，Integration Service 自动把 Plan 编译出的 worker 分支从叶子向 Intent 私有集成分支聚合；父子分歧时自动创建子侧 merger。目标分支不会自动变化。聚合完成后系统只冻结 integration commit 与 baseline commit 并创建 `pending` Review Candidate；用户显式开始验收后才生成前后对照 HTML 报告，最终人工接受这个精确 commit 后才落地。若 branch 已移动，旧 Candidate 不能复用。

## Worktree 与合并

- 每个 worker 的 worktree 位于 `.lush/worktrees/<id>-<name>/`，分支名为 `lush/<项目路径哈希>/<id>-<name>`（`<name>` 是派工时 planner 给的英文短名，如 `fix-login-composer`）。id 保证唯一，短名说清任务做什么；共享 Git 仓库的不同项目不会争用同名 task 分支。省略 `--name` 时 runtime 从 goal 首行的英文词回退，提不出可用名字（例如纯中文 goal）才回到 `task-<id>`；名字只在 spawn 时定一次，之后不变。
- 普通 worker 从输入提交时冻结的 commit 创建，直接父分支是输入分支；`code` 下游从上游任务分支创建，并只合回这个直接父分支。兄弟任务互不偷看。
- **分支谱系**在 `git worktree add -b` 时显式记录。输入分支 parent 是用户指定分支，普通任务 parent 是输入分支，`code` 下游 parent 是上游任务分支，sync merger parent 是待同步 child。merge 永不改写谱系；已有但未登记的分支只显示 `[?]`，不能据此执行合并。
- agent 最终输出作为 result。worker 必须提交改动、保持工作区干净；未提交就结束会失败，文件原样保留供检查和重试。
- 完成与合并是两个状态：`completed + pending` 表示已产出提交，**尚未进入主工作树**。
- **Intent 工作台与 Review Candidate 是主要交付界面**；分支图保留为 Git 诊断界面。每条 fork 连线仍显示 ahead/behind、分歧、缺失与恢复动作。
- `branch merge CHILD`（图上的「合入父分支」）只把 child fast-forward 到 recorded direct parent；父分支未检出时用 compare-and-swap 更新 ref，已检出时要求 worktree 干净并同步 index/工作目录。
- 父子已分歧时用 `branch sync CHILD`。runtime 从 child tip 创建 merger 子分支，让 agent 合入冻结的 parent commit、在子侧解决冲突并测试；之后先 FF 回 child，再 FF 到 parent。父分支上永不直接 `--no-ff`，最终落地树就是测试过的树。
- 不再要某条分支的代码时用 `branch archive BRANCH [--discard]`（图上的「归档」）。它删掉该分支的 worktree、本地 ref，以及关联终态效果展示的展示／基线 detached worktree（仍在运行的托管预览会先停止），但保留分支记录（`branches.status` 标 `archived`）、任务行、展示报告、消息、事件，以及不随 worktree 消失的 pi 会话文件（`.lush/sessions/`）。归档明知可能未合并也允许删，因此是用户专属的显式动作；默认要求 worktree 干净，只有 `--discard` 才会连着未提交改动一起丢。与「证明已进入目标分支才删」的 `task cleanup` 不是一回事。
- `task merge` / 批量交付保留为兼容入口，最终遵循同一条 direct-parent / ff-only 规则；批量在首个分歧处停止。
- `task cleanup ID [--keep-branch]` 不使用 `--force`：branch tip 必须仍包含任务审阅提交，并且整个 tip 已进入直接父分支，才用 compare-and-delete 回收。聚合过子分支的任务分支也能安全清理，不会把额外提交当成漂移丢掉。
- `task delete ID`（图末兜底分组「未归属分支的任务」里的「删除」）只删**一条**已结束任务及其全部已结束后代的行，连同它们的消息、事件、notice、spec 与两端依赖边；这是除 `task clear` 之外唯一会丢任务历史的路径，所以子树里有活动任务、planner 还有未处理 spec、有 verifier / 候选指着它，或磁盘状态收不回来时**拒绝**，一行都不删（不会像 clear 那样把收不回的成果留在磁盘上）。分支谱系行与输入行故意保留（id 不复用），删时留一条 `task.deleted` 审计事件。
- `task clear`（`bun run clear`，Web 项目概览里的「清空任务看板」）一键删掉**全部已结束任务**及其消息、通知、事件与 `inputs` / `drafts` 审计，并先按与 `task cleanup` 相同的安全门回收磁盘状态：能回收的连 `.lush/worktrees/<id>-<name>/`、检验对照检出、任务分支与每条输入的 `input-<id>` 一起删，返回值 `reclaimed` 给出 `{worktrees, branches, anchors}`。有 `queued`/`running`/`waiting`/`awaiting` 任务、或还有 invocation 在收尾时**拒绝执行**，不会隐式取消。回收不掉的任务（未合并成果、审阅后被改过的分支、脏工作区）连同目录与分支一起保留在磁盘上，`retained.tasks` 列出 `{id, branch, workspace, baseline_workspace, reason}`，被动过的锚点在 `retained.anchors` 里说明原因；`.lush/sessions/` 与检验报告不受影响。因为目录与分支名里带着 task id / input id，清空后 **id 不从 1 重新开始**，新任务与新输入不会撞上保留的旧目录。

## 常用开发命令

```bash
bun run help
bun run doctor
bun run start
bun run say '你的原话' --branch main  # 从指定父分支创建输入分支；省略 --branch 使用当前分支
bun run intents             # Intent、Plan 编译与候选验收进度
bun run propose '标题' --body '我打算这样拆'   # planner 专用：这轮拆解请你先拍板
bun run approve 40          # 批准（ID 可以是 planner task id 或那条 notice id）
bun run reject 40 '别动架构'  # 驳回：本轮 spec 作废，理由送回 planner 重拆
bun run specs               # 结构化 Plan：待编译 / 已编译 / 已丢弃
bun run tasks               # 默认前 200 条，只含开发任务（意图层见 intents）
bun run tree
bun run inspect 3
bun run transcript 3        # 只看不写：agent 的思考、工具调用与输出
bun run usage 3             # 同一个 agent 的模型、上下文占用与累计花费
lush progress plan inspect:确认现状 implement:实现 test:测试 git_commit:提交改动  # agent 汇报当前 task 的计划
lush progress complete inspect  # agent 完成一步；同 key 的完成态在计划更新后保留
bun run lush candidate list # 查看固定 commit 的验收候选
bun run lush candidate prepare 1   # 为 Intent #1 冻结待验收候选；不自动生成报告
bun run lush candidate accept 2    # 接受 Candidate #2 并合入目标分支
bun run lush candidate changes 2 '按钮再明显一点'  # 反馈进入同一 Intent 的增量规划
bun run message 3 '补充要求'
bun run notices
bun run answer 1 '我的选择'
bun run cancel 3            # 取消这个任务及其活动后代，保留工作区
bun run retry 3             # 检查失败现场之后明确重试
bun run merge 3
bun run cleanup 3           # 回收 worktree 与分支（--keep-branch 只回收 worktree）
bun run clear               # 一键清空已结束任务并回收可安全回收的 worktree/分支
bun run lush config         # 看并发额度：生效值、环境默认值、来源与设置文件（--json 输出结构化读模型）
bun run lush config set concurrency 8           # 执行通道并发上限（1..64），写回项目设置并立即生效
bun run lush config set control-concurrency 4   # 控制通道并发上限（1..16）
bun run lush config reset all                   # 清除覆盖，回到环境默认
bun run branch tree         # 分支谱系（--verbose 带 task / worktree / fork / parent；见 docs/engineering/branch-genealogy.md）
bun run branch show 3       # 按 branch 名或 task id 查一条分支的 parent 与祖先链
bun run branch import       # 把旧项目已有本地分支登记成记录（不推断 parent）
bun run branch merge lush/…/7-auth-ui  # ff-only 合回直接父分支
bun run branch sync lush/…/7-auth-ui   # 分歧时在子侧创建 merger
bun run branch archive lush/…/7-auth-ui  # 归档：删 worktree 与 ref，保留任务、事件与会话（--discard 才丢未提交改动）
bun run wait 3              # 只有当前客户端等待，不影响调度
bun run web                 # 全局项目启动器（默认 4318），自动恢复上次项目并启动 daemon
bun run desktop             # Electron 桌面版；独立随机端口，可与 Web 同时运行
bun run web --project .     # 兼容的单项目 Web；使用项目内 web.json / web.log
bun run web-status          # 在不在跑、跑的是不是这份代码、日志在哪
bun run web-restart         # 改完 src/ui/web/ 换掉那个后台 Web 进程（它不会跟着代码换版本）
bun run web-stop            # 停掉后台 Web；只停命令行确实是 Lush Web 的进程，别人的只报告
bun run daemon-restart
bun run stop
```

任一命令都可以加 `--project PATH`。`--json` 输出机器可读结果。底层完整命令见 `bun run help`；真实 Agent 后端支持 Pi 与 Codex，另有只用于离线验证的 mock。

## 状态、恢复与边界

状态目录固定为 `<project>/.lush/`：

```text
project.json       不可跨目录复用的项目绑定
settings.json      运行设置（并发额度）的覆盖；不存在表示全部使用环境默认
project.db         SQLite：inputs / drafts / tasks / task_specs / task_deps / agent_runs / artifacts / review_candidates / messages / notices / events / branches（task.clear 会清空任务相关的表，并把 task id / input id 高水位记在 meta；branches 是历史事实，不被清空）
sessions/          每个 task 的独立 pi session 与当前输入文件（thinking / 工具调用的原文）
worktrees/         worker 工作区、每条输入的聚合分支检出（input-<id>），以及检验期间临时对照检出
verify/            每个 verifier 的自包含 HTML 检验报告
daemon.lock        项目 daemon 单实例锁
daemon.log         daemon 日志
```

socket 放在用户私有临时目录，名字由 canonical 项目路径决定，以避免长项目路径超过 Unix socket 限制。它只是通信端点；持久状态仍在项目内。`LUSH_HOME` 不是独立作用域：若保留该变量，必须恰好等于所选项目的 `.lush`，否则拒绝运行。

任务状态：`queued → running → waiting / awaiting / completed / failed / cancelled`。等待收到新消息后重新排队（开放的结构化问卷优先挡住唤醒，必须先回答或忽略）。终态任务不会保留活动子任务。取消或停止会终止 agent 进程组；重启对未知副作用的运行中任务标记失败，不自动重放；未开始的排队任务、待用户答复和记录保留。重试失败子任务要求父任务仍活动，否则重试父任务或提交新输入。

角色有 planner / coordinator / worker / research / verifier / merger。planner 属于 control lane，只写结构化 Plan；没有 scheduler 角色（旧数据里的 `scheduler` 行仍可读）。verifier 有两条来源：用户点「检验」时的单 worker 对照（用 `tasks.verifies_task_id` 指向被检验的 worker），以及用户显式启动 Candidate 验收后创建的对照（用 `tasks.review_candidate_id`）。两者都是独立根任务，不是被检验任务的子任务（终态任务不能再挂活动子任务），父子不变的不变量不被破坏，界面上依旧挂在被检验对象下面。

**Task 与 agent 是终身一对一的身份。** 任务一创建就拥有一个 agent（`<role>#<task-id>`，例如 `worker#7`），跨唤醒不换身份：pi session、累计唤醒次数和上次动手时间都记在这个 agent 上，`task inspect` 与 Web 详情直接展示。但它的 RPC 凭证是每次唤醒重新签发的：daemon 只存 SHA-256，且只在该次 invocation 运行期间可解析，invocation 结束即作废，重启后一律清空。因此 1:1 指的是身份，不是进程或凭证——等待子任务或用户时 agent 依然存在，但不占执行槽、也没有活着的调用。

**这是可信用户工具，不是沙箱。** 目录绑定隔离的是 Lush 的数据库、RPC、调度和工作区管理，不是 OS 文件权限。pi 的 bash 仍拥有当前用户权限，角色约束主要依赖 agent 指令；应审阅改动，不向不可信用户暴露 socket，也不要让其他程序同时修改正在合并的工作树。公网 Web 必须启用对应作用域的 `web.json` 登录认证并使用 HTTPS，但这仍不把 agent 或宿主机变成面向恶意用户的安全沙箱。Agent RPC 用属于活动 invocation 的 token 限制所属任务，不能通过正常 agent 命令批准合并；这不是针对恶意本机进程的安全边界。

pi 默认禁用个人 extensions / skills / prompt templates / themes，保留上下文文件加载以遵循项目开发约定。daemon 意外被 SIGKILL 时可能留下外部进程；恢复不会重放任务，但仍应检查进程和工作区后再重试。

### 配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `LUSH_PROJECT` | 从 cwd 发现 | 显式项目目录；设置后 Web 也进入单项目绑定模式 |
| `LUSH_PROVIDER` | `pi` | 首次未写项目配置时的 Agent：`pi` / `codex`；`mock` 为离线测试模式 |
| `LUSH_CONCURRENCY` | `4` | worker / research / verifier 执行槽的环境默认值，可被 `.lush/settings.json` 覆盖 |
| `LUSH_CONTROL_CONCURRENCY` | `2` | planner 等控制面槽（不被执行面占用）的环境默认值，可被 `.lush/settings.json` 覆盖 |
| `LUSH_CALL_TIMEOUT` | `900` | 单次模型调用超时秒数 |
| `LUSH_TASK_CALLS` | `24` | 单 task invocation 总上限 |
| `LUSH_MAX_DEPTH` | `8` | 任务树最大层数 |
| `LUSH_PI_COMMAND` | `pi` | pi 可执行文件 |
| `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL` / `LUSH_PI_THINKING` | pi 默认 | `.lush/agent.json` 不存在时的 Pi 初始选择；之后由项目配置覆盖 |
| `LUSH_CODEX_MODEL` / `LUSH_CODEX_THINKING` | codex 默认 | `.lush/agent.json` 不存在时的 Codex 初始选择；之后由项目配置覆盖 |
| `LUSH_PI_COMMAND` / `LUSH_CODEX_COMMAND` | `pi` / `codex` | Agent CLI 可执行文件 |

角色 Prompt 文件位于 `.lush-agent/*.md`（可提交）与 `.lush/agent/*.md`（本机）；Agent 子进程环境补充位于 `.lush/agent/agent.env` 和 `.lush/agent/<role>.env`。它们按 invocation 热加载。Web Agent 设置页提供键值编辑器：公共/角色文件分开读取，值默认遮罩、逐项可显示；保存会规范化文件并使用 `600` 权限，原注释与排序不会保留。

两条并发上限是唯一可在运行时改写的软件设置，存储在 `.lush/settings.json`（version 1，权限 `600`）：环境变量仍是默认值，文件里显式覆盖的键优先，`null` / 删键即回到环境默认。`lush config`（等价 `lush config show`）打印生效值、环境默认值、是否被覆盖与设置文件路径；`lush config set concurrency N`（1..64）与 `lush config set control-concurrency N`（1..16）写回并立即生效，`lush config reset [concurrency|control-concurrency|all]` 清除覆盖。Web 的「设置 → 系统 → 并发额度」提供同一读模型与保存 / 恢复动作（走 `system.configure`）。读取是 `system.status.settings`；读写两端都是用户专属，agent 调用会被拒绝。

项目 Agent 配置保存在 `.lush/agent.json`，可在 Web「设置 → Agent」或 `lush agent set` 中按六类任务行为覆盖。每份配置分别提供“默认 Prompt”和“追加 Prompt”：项目默认留空时，各角色使用自己的内置组合；角色覆盖页会显示该角色内置 Prompt，并可恢复默认。非空默认 Prompt 会完整替换内置协议，可能造成任务 API、权限边界和交付流程失效；追加 Prompt 用于在文件补充之后追加项目要求。`lush agent prompt ROLE` 是查看最终生效组成的权威入口。Web 可以按需读取 Pi / Codex CLI 当前可用模型，CLI 对应 `lush agent models pi|codex`，读取失败时仍可使用预设或手工模型 ID。Pi profile 还可从当前用户与项目已安装的扩展和 Skills 中多选，只把勾选项显式加载进后续 invocation；这些资源拥有当前用户权限，Codex profile 会保留选择但不加载。

`tasks.result` 只保存 invocation 的最后一次输出；完整的执行过程（思考、工具调用、工具输出）留在 `.lush/sessions/*.jsonl`，用 `lush task transcript ID`（Web 详情里的「执行过程」）只读查看，agent 的模型、上下文占用与累计花费用 `lush task usage ID` 从同一批文件里读出（Web 详情里的「Agent」块）。截图、过程与结论分开：审阅合并时看 result 与 `task diff`，需要追究 agent 怎么做的时候看 transcript，需要直接看结果跑起来时点「检验」。

## 验证与文档

```bash
bun run test
```

测试覆盖纯任务树、并发额度、独立规划槽、消息与 notice 唤醒、取消、恢复、任务权限、真实 Git worktree/merge/冲突、检验的对照基线生命周期与报告路由、真实 daemon 的项目隔离、pi 子进程协议与本地 Web 边界。pi 协议测试使用可控的假 pi 可执行文件，不调用付费模型。

[核心架构阅读线](docs/core-architecture.md) · [工程架构](docs/engineering/architecture.md) · [命令与 RPC](docs/reference/api.md) · [文档](docs/README.md)
