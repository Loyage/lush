# 安全与边界改进建议

本文供维护者评估 RPC、Web Host、报告／问卷预览、Electron IPC 与 Agent 子进程边界；区分现行复核、已修复问题与待决建议，不把可信本机工具改造成多用户沙箱。

## 当前复核（2026-10-02）

复核基线为 `81257d12e3001214e7f03bc4ee2398f834e35ee3`。以下旧行号、入口名和临时探针记录保留为历史，不代表当前 HEAD。

| 条目 | 当前结论 | 处理 |
|---|---|---|
| S-01 | 已修复，仍需维持项目路由回归 | 无需重复多项目改造；Host 公开入口现为 `/api/host/*` |
| S-02 | 用户确认后已修复显式 Origin 校验 | 完整同源/配置白名单，保留 null/缺失来源兼容与跨站拒绝 |
| S-03 | 当前 Electron runtime 已修复缺 sender 校验 | 补目录 IPC 专项回归；真实 Electron 验收未运行 |
| S-04 | 仍成立 | 可信代理或代理侧限流的部署选择待决 |
| S-05 | 已按 Notice #81 实现 | RPC 每连接预算、回压与超限关闭，区分未执行和结果未知 |
| S-06 | 仍成立，本轮已修复 | 规范化站内 next，拒绝反斜杠、控制字符及规范化后的 `//` |

- 本轮只使用临时项目、随机端口、可控 socket/Electron mock；没有启停用户 daemon/Host、访问真实凭据或外部网站。`bun run doctor` 报告 worktree 与 daemon 代码目录不同（fingerprint 相同），未据此重启。
- 现行回归：`bun run test test/web/security.test.js test/web/multi-project.test.js test/web/project-route.test.js test/web/launcher.test.js test/web/questionnaire.test.js test/web/worker-api.test.js test/web/service-restart.test.js test/desktop`：**61 pass / 0 fail，806 断言**；日志 `/tmp/lush-review-105/regression.log`。
- 修复前新增 S-06 回归实际失败：Location 解析 origin 为 `http://audit.invalid`；完整失败日志 `/tmp/lush-review-105/security-before.log`。修复后覆盖普通项目深链接、query/hash、dot segment、反斜杠与控制字符、规范化后双斜杠；仅验证 HTTP 与 WHATWG URL，不冒充浏览器跳转验收。
- 临时 S-02/S-04/S-05 characterization 探针：**3 pass / 0 fail，11 断言**；日志 `/tmp/lush-review-105/pending-probes.log`。同站不匹配 Origin 的 logout=303 且旧会话=401；同 socket 五次失败后换 XFF 正确口令=429；write=0 的 mock 接收 200 请求后保留 200 回包、连接未关闭。未做内存耗尽或真实浏览器利用实验。
- 完整 `bun run test` 已跑完：**1091 pass / 1 fail / 1 error**，1092 tests / 184 files；唯一错误为打包测试无法导入 `@electron/asar` 开发依赖，无失败业务断言。完整日志 `/tmp/lush-review-105/full-test.log`；未跳过或安装依赖来掩盖失败，不能宣称全量套件通过。
- `bun run docs:check`：**68 篇 Markdown 通过**；`git diff --check` 无输出。本轮未运行真实浏览器／Electron，仍需在具备环境时验收相关场景。
- 多项目剩余资源预算与验收见[规划索引](multi_proj/README.md)：身份隔离和已确认产品边界已实现，不再作为待选架构；资源总预算与跨项目待办仍非既有交付。

## 首次审查的范围、基线与验证（历史）

- 基线与本 worktree HEAD 均为 `99fcbc993640c057488532a19ca08814ab60b73e`，无差异；开始时工作区干净。唯一交付为本文，未 commit／merge／push。
- 已读 [开发约定](../../AGENTS.md)、[文档约定](../contributing/documentation.md)、[模块地图](../engineering/modules.md)及 Runtime／Web／接口分章、[执行过程理念](../design/agent-process.md)、[HTTP 边界](../reference/http.md)、[Agent 权限](../reference/agent-environment.md)。
- 方法：静态追踪入口到副作用，运行既有 fixture 测试，另写临时 mock／HTTP 回归探针。仅使用临时项目、假口令、随机端口及可控子进程；未访问真实项目 `.lush`、真实凭据或外部服务。测试服务均关闭，临时探针清理后不作为交付。
- 已执行 `git rev-parse HEAD`、`git status --short` 及只读源码检索；`bun run doctor --project <临时目录>` 确认当前代码身份，临时项目无 daemon／Web，未启动真实 daemon。
- 已执行 `bun run test test/web/security.test.js test/web/launcher.test.js test/web/questionnaire.test.js test/explainer-provider.test.js test/preview.test.js test/project/agents.test.js test/agent-settings.test.js`：**33 pass / 0 fail**，253 个断言。先前分批运行亦通过；模块地图所列 `test/project/permissions.test.js` 实际不存在，权限覆盖以 `agents.test.js` 为准。
- 已执行 `bun run test /tmp/lush-security-audit.kx5rbN/security-audit.test.js`：**5 pass / 0 fail**，18 个断言；分别覆盖跨项目误路由、Origin 矩阵、退出／重定向、代理共享限流及 RPC 写队列。下文保留复现步骤与输出，不依赖临时文件存续。
- Worker 已执行 `bun run docs:check`：53 篇 Markdown 检查通过；`git diff --check` 无输出。该 worktree 只新增本文件，临时探针目录已删除；汇总后的复核记录见[审查索引](README.md)。
- 未运行真实浏览器／Electron，因此浏览器 cookie／导航及 preload 完整利用链不冒充已复现；HTTP 响应、URL 解析和 mock 队列结论与端到端浏览器结论分开。

## S-01 · 全局项目切换会把旧页面操作送到另一个项目

**P1 · 已修复（多项目工作台改造，2026-09-26）· 历史条目与修复证据并存**

- **状态**：已按[多项目工作台改造规划](multi_proj/README.md)实施，用户确认「标签页各自独立保持当前项目、打开项目按需启动、移除只隐藏入口、初版只做有界摘要、路径边界保持现状」。下面「依据／触发／复现」保留审查时的原始记录，仅作历史，不代表当前实现。
- **依据（历史）**：`src/ui/web/server.js`，`createProjectHost/select/require`，139–193 行，所有客户端共用可变 `binding`；`startWeb.fetch`，268–277、361–366 行，动作只取当前 binding，无请求所属项目校验。`src/ui/web/assets/api.js`，`action`，11–14 行，仅发送 method／params。
- **触发／影响（历史）**：同一启动器的两个标签页／设备分别操作项目 A、B；B 切换后，A 已打开的Worker详情仍可能提交 A 的Worker ID，实际命中 B 同 ID 的取消、删除或合并入口。这不是白名单外越权，而是白名单内跨项目误操作，单用户多标签页即可发生。
- **复现／反例（历史）**：临时 opener 记录目标；依次 select A、select B，再模拟 A 旧页面发 `worker.cancel {id:1}`，HTTP 200，记录目标为 B。未执行真实取消。现有 canonical 白名单和 select 串行队列有效，但均不绑定发起页面；显式单项目 host 不受此切换问题影响。
- **修复**：全局工作台改为每项目一条稳定身份路由 `/p/<project-id>/`（ID 由 canonical 路径派生，服务端只在已登记集合里反查，不把 URL 片段当路径）；`createProjectHost` 用按 canonical 路径索引的连接集合 + single-flight 取代单一可变 `binding`，每个请求的项目身份在一次请求内冻结。`src/ui/web/assets/route.js` 从 `location.pathname` 取当前项目，`api.js` 据此给所有项目 API 加前缀；页面地址成为当前项目的唯一来源，标签页之间不再共享可变的「当前项目」。全局模式下无前缀的项目读写、未知／已移除身份都被拒绝，绝不回退到别的项目；原 `/api/launcher/select` 只登记并返回路由 ID，不再设置全局当前项目（该旧入口现已移除，当前为 `/api/host/select`）。
- **验收（现行测试）**：`test/web/multi-project.test.js` 用临时 A／B 项目与记录目标的 mock 客户端锁住：A 的 `worker.cancel` / `worker.approve_merge` 只落到 A；无前缀写请求被拒且不触达任何项目；`/p/<id>/api/snapshot` 分别读到自己项目；伪造／已移除身份被拒；并发打开只连接一次；公网模式不把登记列表当白名单。`test/web/project-route.test.js` 锁住前端前缀与按项目隔离的筛选／折叠／排序。单项目 Web、CLI 与人工合并约束保持原样（`test/web/security.test.js` 等原有用例不删不改）。

## S-02 · same-site 被等同于 same-origin，退出入口可跨源触发

**P2 · 用户确认策略后已修复（2026-10-02，Notice #77）· 预估 M**

- **修复前当前证据**：`originAllowed` 优先接受非 cross-site 的 Fetch Metadata；无 Fetch Metadata 时只比较 host，不比较 scheme。探针确认不匹配 Origin + same-site 能退出会话。
- **已确认并实施**：显式非 null Origin 必须为完整同源或现有可信 Origin 白名单；非规范 Origin、不同 scheme/port/hostname 都拒绝，Fetch Metadata 不再覆盖。保留 null／缺失兼容、cross-site 子请求拒绝及 GET 顶层导航；不新增代理信任配置或拒绝旧客户端。
- **回归**：`security.test.js` 覆盖 same-site/same-origin/none + 不匹配来源的 login/logout/修改 API，拒绝后会话和数据不变；可信代理、同源、null/缺失继续可用。与 U-03 定向共 **20 pass / 0 fail**（`/tmp/lush-103-decisions.LmS9JG.log`）。完整 HTTP 约束见[HTTP 参考](../reference/http.md)，真实浏览器利用链仍未测试。
- 以下依据／复现为首次审查历史；浏览器级利用链仍未验证。

- **依据**：`src/ui/web/server.js`，`originAllowed`，123–137 行，只要 Sec-Fetch-Site 非 cross-site 就直接通过；`startWeb.fetch` 的 logout，260–264 行，无额外来源校验。旧浏览器分支还只比较 host，不比较完整 origin。
- **触发／影响**：同站不同端口或兄弟子域并不一定同受信任；来源带 `same-site` 时，明确不匹配的 Origin 被忽略。至少会开放表单 POST logout 这类无需 JSON 的会话干扰面，与 HTTP 文档“拒绝跨 Origin”不一致。
- **复现／反例**：fixture 中不匹配 Origin + same-site 的 draft POST 返回 200，cross-site 返回 403；同样来源的 logout 返回 303，原 cookie 随后读 API 为 401。**不能据此宣称浏览器可任意修改Worker**：JSON POST 的 OPTIONS 预检仍为 404，SameSite=Strict 也阻挡真正跨站 cookie；浏览器级退出场景仍需补测。
- **建议／取舍**：把 Fetch Metadata 当额外拒绝信号，而非替代 Origin；有 Origin 时对照完整同源值或显式可信 origins。保留反向代理配置能力；`Origin:null`／旧 webview 的兼容策略需明确选择，不能无说明地删除现有支持。
- **验收**：用真实浏览器覆盖同源、兄弟子域、同站异端口、cross-site 与 opaque origin；非可信来源的 login／logout／写 API 不产生状态变化，显式配置的代理 Origin 继续可用。

## S-03 · 原生目录选择 IPC 缺少与通知 IPC 一致的来源校验

**P2 · 已修复（当前桌面 runtime）；专项回归已补（2026-10-02）**

- **当前实现**：入口已移到 `src/ui/desktop/runtime.js`；`lush:choose-project` 与通知都走 `trusted(event)`，校验登记窗口、workspace 类型、主 frame、Host origin 与项目页面；远程窗口另行拒绝本机目录选择。窗口导航／重定向限制在所选 Host，预览窗口没有 preload；所有窗口 sandbox=true、contextIsolation=true、nodeIntegration=false。无需重复旧修复或新增公共 API。
- **当前回归**：`test/desktop/runtime.test.js` 新增目录选择专测：未知窗口、子 frame、连接页、不同源／端口、报告路径、独立预览在弹框前拒绝（picks=0）；本地项目页正常选择，取消返回 null。原导航、预览与远程拒绝用例亦通过。该证据是注入 Electron 的单元测试，真实 Electron 导航／preload 集成未运行。
- 以下依据、缺失校验和 sandbox:false 仅为首次审查历史，不再描述当前实现。

- **依据**：`src/ui/desktop/main.js`，`trustedNoticeSender`，19–22 行；`createWindow`，67–88 行；`app.whenReady` 内 `lush:choose-project` handler，135–138 行。通知校验 webContents／主 frame／origin，目录 handler 却不接收 event；`src/ui/desktop/preload.cjs`，3–8 行，无条件暴露桥。
- **触发／影响**：若非工作台页面获得这份 preload 桥，目录选择没有拒绝条件，可反复弹原生对话框，用户选中后将绝对路径返回调用页面。当前只限制新窗口 URL，没有 `will-navigate` 拦截；报告新窗口的 preload 继承及后续导航需要 Electron 实测。
- **反例／边界**：contextIsolation 已开启、nodeIntegration 已关闭，通知 IPC 有检查，报告有独立 sandbox CSP；因此不能把缺 sender 检查或 `sandbox:false` 单独描述成任意文件读取／RCE。目录选择也仍需要用户交互。
- **建议／取舍**：统一窄 IPC 的主窗口、主 frame、受信来源验证，并明确主窗口及报告窗口导航策略；报告窗口是否完全不带 preload，作为需确认的宿主策略。不要为修复而扩大 Web API 或给渲染层 Node 权限。
- **验收**：主工作台可选目录；子 frame、报告窗口和非可信导航后的页面调用均被拒且不弹框；取消返回 null。增加真实 Electron 集成测试，而不只用通知模块的 DOM mock。

## S-04 · HTTPS 反向代理后的登录限流会连带锁住所有访问者

**P2 · 当前仍成立，代理信任／部署方案待决（2026-10-02）· 预估 M**

- **当前证据**：登录仍按 `server.requestIP` 分桶，不信任 XFF；本轮临时探针再次得到「五次错误后，另一个 XFF 的正确口令=429」。此前复现仍合理，不应直接信任转发头修复。
- **待决方案**：显式可信代理与受检转发链，或由代理负责客户端级限流、应用保留有界总量保护；二者均改变部署契约，留给统一问卷。限流表超过 1024 项时 `failures.clear()` 仍存在，预算／清理语义也不能冒充已完成。
- 以下为首次审查的依据与复现。

- **依据**：`src/ui/web/server.js`，`startWeb.fetch` 登录分支，230–251 行；限流键只用 `server.requestIP(request).address`，同一键累计五次错误后先于密码校验返回 429。
- **触发／影响**：文档推荐 HTTPS 反向代理；多个浏览器经同一代理连接到 Bun 时，通常共享代理地址。一个来源五次错误就能让正确口令也一分钟无法登录；连续重复可持续影响新登录，但不撤销已建立会话。
- **复现／反例**：fixture 从同一 socket 地址发送五次错误，随后换 X-Forwarded-For 并提交正确口令，仍为 429。忽略任意 X-Forwarded-For 本身是正确保护，不能直接信任客户端自报地址作为“修复”。
- **建议／取舍**：选项 A：显式配置可信代理并只从可信跳点解析客户端地址；选项 B：代理侧负责细粒度限流，应用保留有界总量保护与提示。需用户确认部署方式；按 username 分桶也不能独自解决单账号被锁问题。
- **验收**：受信代理后的来源 A 失败不阻断来源 B 正确登录；直连伪造转发头不能绕过限制；清理过期限流项不应一次清空全部保护；提供可检查的部署说明。

## S-05 · RPC 帧有上限，但在途请求与回包队列没有总量上限

**P2 · 已按用户确认方案实现（2026-10-02，Notice #81）· 预估 M**

- **当前实现（2026-10-03 核对 `8dbde1b`）**：每连接在途上限 32 帧、低水位 8 帧；待写超过 8 MiB 时暂停读取，持续 30 秒则断开。未执行请求用 `-32022` 标记可安全重试；已执行但回包丢失只标结果未知，修改请求不得自动重放。数字为内部默认，不新增公共配置。
- **现行契约与回归**：[HTTP 与传输边界](../reference/http.md)、`test/rpc-budget.test.js`；覆盖暂停 / 恢复、未执行无副作用、正常大回复和慢连接不影响其它连接。以下无限排队探针是修复前历史，不代表当前行为。
- 以下为首次审查的依据与复现。

- **依据**：`src/rpc/server.js`，`RPCServer._data`，63–85 行，为每个合法帧追加 Promise；`src/socket_io.js`，`createWriter/flush/write`，6–54 行，write 返回 0 时保留队列，后续回包继续 push，无 pending-byte 预算。
- **触发／影响**：本机客户端流水发送许多小请求却不读回复，或 agent／CLI 出现故障重试，可让 daemon 排队内存持续增长、挤占正常Worker。它是可信本机边界内的稳健性问题，不是公网 RPC 或跨用户越权。
- **复现／反例**：fake socket 的 write 固定返回 0，送入 200 个有效小帧，等待请求链后 `writer.pending === 200`，连接未受限；没有做耗尽内存实验。现有单帧 1 MiB 限制、逐连接串行和 drain 重试均有效，但不限制累计保留量。
- **建议／取舍**：加入每连接在途帧数、输入／输出字节预算，超过高水位暂停读取或关闭故障连接；预算按真实吞吐确定并提供明确错误。不得自动重放已经执行但未送达回复的修改请求。
- **验收**：用不读响应、持续流水及恢复 drain 三种可控 socket 验证内存／排队量有界；正常大响应仍完整交付；单个慢连接不能拖垮其他连接，关闭语义明确区分未执行与结果未知。

## S-06 · 登录 next 的反斜杠可绕过站内跳转检查

**P3 · 本轮已修复（2026-10-02）· 历史证据保留**

- **修复**：`safeNext` 拒绝非站内路径、原始反斜杠与 ASCII 控制字符；基于固定 HTTP origin 解析，校验 origin 并只返回规范化 pathname/search/hash。规范化后以 `//` 开头也回退 `/`，堵住 `/a/..//host` 和编码 dot segment 的二次解析跳站。登录 GET 隐藏字段与成功 POST Location 复用同一规则，认证、代理 Origin/null Origin 兼容不变。
- **验证**：`test/web/security.test.js` 新增 14 组 HTTP 回归，修复前实际失败、修复后通过；不跟随重定向、不出网。普通项目路径、查询及 fragment 保留。
- 以下为首次审查的缺陷依据与复现，不代表修复后行为。

- **依据**：`src/ui/web/server.js`，`safeNext`，111–113 行，只拒绝 `//`；`loginPage`，118–121 行，保留 next；`startWeb.fetch` 登录成功路径，250–257 行，直接写 Location。
- **触发／影响**：登录表单 next 为 `/\audit.invalid/` 时通过检查，Location 原样返回；对 HTTP URL，反斜杠按斜杠解释，会转到外站。可用于登录后诱导跳站；未发现把口令或 HttpOnly cookie 自动转交该外站的证据，不是认证绕过。
- **复现／反例**：用假口令登录返回 303；`new URL(location, fixtureUrl).hostname` 为 `audit.invalid`，未实际访问该域。现有 escapeHtml 防 HTML 注入，`//host` 与直接 `https://host` 也已被拒。
- **建议／取舍**：拒绝反斜杠与控制字符，再基于可信基准解析并验证 origin；只返回规范化的 pathname／search／hash。无需增加外部跳转功能。
- **验收**：普通站内路径与查询仍可回跳；`//host`、反斜杠变体及控制字符变体均回退 `/`；补浏览器跳转测试且不实际出网。

## 已确认有效的边界与后续验证

- 全局认证要求非空 canonical 项目白名单；未登录 API、未知方法／参数、伪造本地 Host 与跨项目 token 有拒绝测试。S-01 不否认这些保护。
- `src/ui/web/notice-preview.js` 的 HTMLRewriter 白名单会去除脚本、事件、导航、表单和嵌套 frame，并设置独立无脚本 sandbox CSP；报告路由另有角色、真实路径、非 symlink、8 MiB 校验及无同源权限 CSP。未确认这些路径存在任意文件读取或脚本越权，仍建议真实浏览器测导航／网络限制。
- invocation token 每轮轮换、结束清空、取消失效；USER_ONLY、父子消息约束及 explainer 无工具／无 token 测试通过。普通 Agent 继承 daemon 环境是明确设计；预览环境采用白名单且有父进程死亡清理。无 token 的本机用户 RPC、人工批准与重启不重放均不列为漏洞。
- S-02 已按用户确认策略修复；S-05 已按用户确认方案实施，S-04 未选入下一批、继续留待评审；S-01 已确认且实现，不重复询问。真实浏览器／Electron 的 Origin、导航与 IPC 验收仍未完成；本文不授予真实数据操作授权。
