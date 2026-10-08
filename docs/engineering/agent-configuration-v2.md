# 项目 Agent 配置与双模式运行

用户决定 #157：账号/API、扩展与 Skills 在当前项目统一管理；用户创建 Worker 时可选编辑运行设置，未修改用项目默认，Agent 派生 Worker 自动继承；直接分阶段实施。此章在涉及 Pi 配置模式的范围内优先于 #154 的“所有调用只能使用托管来源”，其余凭证隔离规则不变。

W116 / #261 增加[设备共享设置](device-settings.md)：Worker 显式覆盖 → 项目文档覆盖 → 设备默认。下文原项目安装边界扩展为显式 device/project 存储根，旧本地库保留，不物理搬迁；外部 Pi 认证仍不复制，历史/消费者仍项目隔离。Web 默认 device，既有 CLI/RPC 省略 scope 仍 project。

## 三层配置

1. 模型来源：一个账号/Key 一个稳定 connection ID；同服务商多个账号独立凭证、模型可见范围和额度。沿用连接文件及额度历史，不迁移外部 Pi 凭证。
2. 项目工作配置：Agent 默认 profile、扩展/Skills 安装库和显式启用路径。安装不等于启用，更新显式执行，第三方代码不是沙箱。
3. Worker：完整 profile 覆盖优先于项目默认，创建时可编辑；子 Worker 在 spawn 时继承父有效 profile（无明确覆盖时），之后独立保存。保存不启动调用，不改变当前 invocation。新式 order/child（含历史 say 读取兼容）的运行覆盖跨失败、无参数重试、结算、合并与验收保留；仅用户显式 `worker.clear_override {id}`（Web「清除运行覆盖」/CLI `worker clear-override ID`）或重新保存完整覆盖才改变，不能因交付自动切回另一个模式。旧 Task 协议的 attempt-scoped retry 行为不变。

## Profile 模式

新增 `config_mode: 'lush' | 'pi'`，缺省 `lush`，只允许 Pi 使用 `pi` 模式。旧配置按 lush 读取，无磁盘迁移。`pi` 模式有效 profile 仅保留后端与模式，不允许托管来源/模型/思考深度/用户 Prompt/资源/预算/env 覆盖混入；表单切换时清空这些选项。保留 Lush 必需的任务指令、Worker 会话、消息、内置 runtime/preemption 协议和项目网络策略；不注入 Lush 自定义 Prompt 文件或 Agent env 文件。使用执行环境的 Pi 默认目录（通常 ~/.pi/agent，显式进程 PI_CODING_AGENT_DIR 则遵循它），不复制该目录；Pi 自己管理认证、资源、模型及项目信任。不得默默自动 approve 未受信项目。

Lush 模式必须选择托管来源，继续使用私有调用快照，只有本次凭证，OAuth refresh 由连接管理器协调。Pi 模式不读连接、不参与托管来源策略/被动观测。隔离的 explainer/butler 仍要求 Lush 模式，不能绕过无工具边界。模式切换必须避免从既有 session/fork 恢复另一模式旧模型，启动参数/会话恢复应实际测试。Pi 默认模式会话使用 `_lush-task-ID-pi.jsonl`；执行记录、项目/Worker 用量统计及明确确认删除的资源归属均识别此后缀和原 `_lush-task-ID.jsonl`，两种会话仍属于同一 Worker，不因运行隔离而遗漏历史/消耗。

`order.submit` 增加可选 `profile`；CLI `order --profile-file PATH` 传完整覆盖，Worker configure/retry/resume 保持既有准入。Agent CLI `agent set ... --config-mode lush|pi`。安全 next-call 摘要添加 config_mode，不泄漏完整 profile。

## 模型目录

现有 connection.models 保持用户限制范围，不将自动目录写入它。新增独立有界缓存；连接模型读面：

```js
{version:1,id,checked_at,status,source,models:[{id,name,thinking_levels,...}],warning}
```

模型 ID 使用 qualified provider/model。缓存必须按连接端点及账号身份隔离，换凭证/端点/限制不展示旧目录为当前结果；OAuth access 刷新不应导致同账号目录反复失效。允许 service 端从连接私有身份生成匿名 fingerprint，不公开凭证/密钥摘要。目录状态区分 fresh/cached/unknown/error/unsupported，失败保留明确旧值但不冒充本次成功。

优先支持经过审核的服务商列表接口（HTTPS、目的地授权、拒重定向、限时/限响应，绝不付费模型探测），没有接口使用 Pi auth-free 本地模型元数据或手动限制，标明未验证。目录不保证账号有额度或请求成功。添加/成功登录后自动同步，后台低频过期更新；Worker 表单只读缓存。禁止每次打开表单联网。停止必须取消请求/定时器，配置变更的迟到结果不能覆盖新账号目录。模型能力只能按有证据元数据展示；未知能力不伪造支持所有思考等级。

新增 USER_ONLY `agent.connections.models {id}` / `agent.connections.models.refresh {id?}`；GET `/api/agent/connections/models?id=...` 只读；联网刷新走 action。`agent.selection.resources` 加入每连接安全 model_catalog 缓存；不实现新策略。

## CLI

新增 `agent sources list|show ID|save --file PATH|remove ID|refresh [ID]|models ID [--refresh]|login ID`，登录可提供设备 start/poll/cancel 和回调备用，凭证通过私有输入文件（不放命令行明文），所有输出安全且支持全局 --json。`agent resources` 返回共享模型选择的连接/额度/模型读面（不是已安装资源列表），只读本地。

新增 `agent packages list|install SOURCE|remove ID|update ID` 与 USER_ONLY `agent.packages.list/install/remove/update`。安装位置为所选作用域的私有 Lush Pi 目录，不改用户默认 Pi；显式 --scope device 安装共享库。资源读面列出安装来源、固定版本、扩展与 Skills 的稳定绝对路径，Worker/profile 沿用现有 extensions/skills 显式路径。安装与更新不得自动启用或启动模型，受控子进程有界、可取消，测试注入假安装器，不访问真实 npm/账号。初版允许固定版本 npm、固定 commit/tag git、显式本地路径；未固定远端来源拒绝并指导，不能隐式升级。安装失败保留可恢复事实，不将部分成功冒充成功；秘密和任意 subprocess stderr 不进入 RPC。

## Web

Agent 配置、Worker 完整 profile 编辑以及用户 order 发射设置最先展示配置模式。Pi 默认模式隐藏托管选项并解释由执行机器 Pi 决定；Lush 模式展示来源、匹配模型、受支持思考深度、已安装扩展/Skills启用、Prompt/预算高级设置。来源使用缓存目录，无目录则明确未知/手动补充。安装资源管理放 Agent 配置，不建顶级实体。保存不调用 Agent；发射/重试/继续仍带 agent-call 与 agentHelp。子 Worker 不弹用户确认。

## 验证

自动测试用临时项目/私有目录、mock 网络/CLI；不触碰真实凭证，不重启用户 daemon/Host。覆盖双模式 argv/env/session 隔离、子 Worker 继承、创建覆盖、缓存及迟到结果、同服务商多账号、CLI/RPC 权限、资源安装隔离与失败、Web 未保存输入和模式切换。真实跨账号模型请求、OAuth 和第三方包发布环境另行验收。

## 项目扩展与 Skills 安装管理（实现契约）

后端位于 `src/agent/packages.js` 与 `src/core/project/agent-packages.js`。所有读写只针对明确所选根的 `<home>/pi/`（device 为 deviceHome，project 为原 home；`PI_CODING_AGENT_DIR`），从不改用户默认 Pi 的声明或凭证。

### 来源

- 初版接受三种来源：固定精确版本的 npm（`npm:@scope/name@1.2.3`）、带显式 ref 的 git（`git:owner/repo@ref`、`https://host/owner/repo@ref`）、显式本地目录（`/abs`、`./rel`、`~/rel`、`file://`）。
- 未写精确版本的 npm、未写 ref 的 git、裸名字、`github:` 前缀在联网之前就被拒绝并给出可照抄的示例。git 的 ref 可为 tag、branch 或 commit，但它只是声明目标：tag/commit 通常不可变，**branch 会移动**，Lush 不声称 branch ref 不可变；`update` 会把 checkout 对到 ref 当前指向，因此它是可能改变代码的显式联网动作，不是无风险的“重新读取”。
- 本地路径在服务端解析为绝对真实路径后再交给 `pi`，不受 daemon cwd 影响；必须在磁盘上存在且是目录。
- 安装与启用分离：这里只写声明、拉取 checkout；某个 Worker 是否加载它仍由 profile 的 `extensions` / `skills` 显式路径决定。
- 扩展目录按入口识别：优先目录的 `pi.extensions` 声明，其次 `index.ts` / `index.js`；有入口时不把同目录的 helper、CLI 或 MCP 服务脚本列为候选。没有入口的普通扩展集合仍枚举直接文件与有入口的子目录，声明为空或全部被排除时不回退发现其它扩展。枚举不执行第三方代码，循环声明有界终止。
- 插件管理展示各包的可启用资源与完整入口路径；项目/Worker 选择框也显示路径，并说明独立 MCP 服务不作为 Pi 扩展勾选。历史显式路径不自动删除或迁移；当前目录未发现的已选路径保留警告，用户可以明确取消。入口识别不等于安全审计，包作者显式声明的扩展仍须受信。

### 准入、串行与停止

- mixin 的 `installAgentPackage` / `removeAgentPackage` / `updateAgentPackage` 都经过 `Project.write` 的 clear/delete 准入，清理期间被拒绝；只读 `agentPackages()` 不走该 gate，也不触发安装。
- `AgentPackages` 用有界串行队列执行安装/移除/更新，同一时刻最多一个变更，排队超过上限直接拒绝；`stop()` 后封闭新调用（读也一样），中止在途子进程并取消已排队任务，迟到任务不会再启动。
- 子进程不经过 shell；stdout 有界，stderr 不采集也不返回，任何 npm/git 诊断、代理认证或 provider 凭证都不会进入 RPC 结果或事件。
- 超时、取消、输出超限、进程不可用映射为固定安全错误码（`timeout` / `cancelled` / `output_too_large` / `unavailable` / `failed`），失败不写声明，不冒充成功。
- 环境是项目私有 `PI_CODING_AGENT_DIR`、`PI_OFFLINE` 关闭（安装/更新需要网络）、`PI_PACKAGE_DIR` 等所有 `PI_*` 被清掉以防重定向安装根，provider 凭证变量被剔除，网络走所选作用域出站策略（device 不读项目覆盖）；子进程为独立进程组，超时/取消时整组结束。
- 项目 shutdown 时中止所有在途安装；不启动 Agent、不探测模型。

### 读模型

`agentPackages()` / `installAgentPackage(source)` / `removeAgentPackage(id)` / `updateAgentPackage(id)` 返回同一份读面，写操作额外带 `action`：

```js
{
  version: 1,
  packages: [{
    id,                // 'pkg-<16 hex>，来源稳定标识；remove/update 用它寻址
    source,            // 规范来源；本地包是绝对路径
    configured,        // 私有 settings.json 里的原始声明
    kind,              // 'npm' | 'git' | 'local' | 'unknown'
    installed, root,    // 安装位置（本地包与非本地包都以绝对路径给出，未知为 null）
    filtered, autoload, // 对象形式声明 / autoload:false
    requested,          // 固定版本或 ref；本地为 null
    version,            // 已安装 package.json 的 version（可读时）
    resource_counts: { extensions, skills }
  }],
  resources: {
    extensions: [{ name, path, kind, source, package_id?, description? }],
    skills:     [{ name, path, kind, source, package_id?, description? }]
  },
  truncated,            // 资源数超过上限
  warning?,             // 例如无法读取安装位置，仅显示声明
  action?               // 'install' | 'remove' | 'update'
}
```

`id` 由来源身份派生（npm/git 用声明，本地用绝对路径），同一包跨调用稳定；读面只读本地文件与一次有界的 `pi list`，绝不联网、不加载扩展代码。

### RPC / HTTP / CLI

USER_ONLY：`agent.packages.list {scope?}` / `agent.packages.install {source,scope?}` / `agent.packages.remove {id,scope?}` / `agent.packages.update {id,scope?}`；HTTP `GET /api/agent/packages` 只读，其余走 `/api/action`。

CLI：`lush agent packages list|install SOURCE|remove ID|update ID`，全局 `--json` 输出上述读模型。`update` 只对带显式 ref/精确版本的来源生效；固定的 npm 精确版本不会移动，git 的 tag/commit 通常不移动，但 **branch ref 可能跟随远端移动**。未写 ref 的远端来源直接拒绝，避免隐式升级。CLI 处理器为 `src/cli/commands/agent-packages.js` 的 `runPackages(args, client)`，由 `agent` 命令父模块接入，本文件不修改父接入。
