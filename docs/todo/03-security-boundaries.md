# 安全与边界改进建议

本文供维护者评估 RPC、Web 启动器、报告／问卷预览、Electron IPC 与 Agent 子进程边界；仅记录审查建议，不实施功能，不把可信本机工具改造成多用户沙箱。

## 范围、基线与验证

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
- **触发／影响（历史）**：同一启动器的两个标签页／设备分别操作项目 A、B；B 切换后，A 已打开的任务详情仍可能提交 A 的任务 ID，实际命中 B 同 ID 的取消、删除或合并入口。这不是白名单外越权，而是白名单内跨项目误操作，单用户多标签页即可发生。
- **复现／反例（历史）**：临时 opener 记录目标；依次 select A、select B，再模拟 A 旧页面发 `task.cancel {id:1}`，HTTP 200，记录目标为 B。未执行真实取消。现有 canonical 白名单和 select 串行队列有效，但均不绑定发起页面；显式单项目 host 不受此切换问题影响。
- **修复**：全局工作台改为每项目一条稳定身份路由 `/p/<project-id>/`（ID 由 canonical 路径派生，服务端只在已登记集合里反查，不把 URL 片段当路径）；`createProjectHost` 用按 canonical 路径索引的连接集合 + single-flight 取代单一可变 `binding`，每个请求的项目身份在一次请求内冻结。`src/ui/web/assets/route.js` 从 `location.pathname` 取当前项目，`api.js` 据此给所有项目 API 加前缀；页面地址成为当前项目的唯一来源，标签页之间不再共享可变的「当前项目」。全局模式下无前缀的项目读写、未知／已移除身份都被拒绝，绝不回退到别的项目；`/api/launcher/select` 只登记并返回路由 ID，不再设置全局当前项目。
- **验收（现行测试）**：`test/web/multi-project.test.js` 用临时 A／B 项目与记录目标的 mock 客户端锁住：A 的 `task.cancel` / `task.approve_merge` 只落到 A；无前缀写请求被拒且不触达任何项目；`/p/<id>/api/snapshot` 分别读到自己项目；伪造／已移除身份被拒；并发打开只连接一次；公网模式不把登记列表当白名单。`test/web/project-route.test.js` 锁住前端前缀与按项目隔离的筛选／折叠／排序。单项目 Web、CLI 与人工合并约束保持原样（`test/web/security.test.js` 等原有用例不删不改）。

## S-02 · same-site 被等同于 same-origin，退出入口可跨源触发

**P2 · 已复现（HTTP 校验层）· 预估 M**

- **依据**：`src/ui/web/server.js`，`originAllowed`，123–137 行，只要 Sec-Fetch-Site 非 cross-site 就直接通过；`startWeb.fetch` 的 logout，260–264 行，无额外来源校验。旧浏览器分支还只比较 host，不比较完整 origin。
- **触发／影响**：同站不同端口或兄弟子域并不一定同受信任；来源带 `same-site` 时，明确不匹配的 Origin 被忽略。至少会开放表单 POST logout 这类无需 JSON 的会话干扰面，与 HTTP 文档“拒绝跨 Origin”不一致。
- **复现／反例**：fixture 中不匹配 Origin + same-site 的 draft POST 返回 200，cross-site 返回 403；同样来源的 logout 返回 303，原 cookie 随后读 API 为 401。**不能据此宣称浏览器可任意修改任务**：JSON POST 的 OPTIONS 预检仍为 404，SameSite=Strict 也阻挡真正跨站 cookie；浏览器级退出场景仍需补测。
- **建议／取舍**：把 Fetch Metadata 当额外拒绝信号，而非替代 Origin；有 Origin 时对照完整同源值或显式可信 origins。保留反向代理配置能力；`Origin:null`／旧 webview 的兼容策略需明确选择，不能无说明地删除现有支持。
- **验收**：用真实浏览器覆盖同源、兄弟子域、同站异端口、cross-site 与 opaque origin；非可信来源的 login／logout／写 API 不产生状态变化，显式配置的代理 Origin 继续可用。

## S-03 · 原生目录选择 IPC 缺少与通知 IPC 一致的来源校验

**P2 · 代码确认；外部页面到 IPC 的完整链待验证 · 预估 M**

- **依据**：`src/ui/desktop/main.js`，`trustedNoticeSender`，19–22 行；`createWindow`，67–88 行；`app.whenReady` 内 `lush:choose-project` handler，135–138 行。通知校验 webContents／主 frame／origin，目录 handler 却不接收 event；`src/ui/desktop/preload.cjs`，3–8 行，无条件暴露桥。
- **触发／影响**：若非工作台页面获得这份 preload 桥，目录选择没有拒绝条件，可反复弹原生对话框，用户选中后将绝对路径返回调用页面。当前只限制新窗口 URL，没有 `will-navigate` 拦截；报告新窗口的 preload 继承及后续导航需要 Electron 实测。
- **反例／边界**：contextIsolation 已开启、nodeIntegration 已关闭，通知 IPC 有检查，报告有独立 sandbox CSP；因此不能把缺 sender 检查或 `sandbox:false` 单独描述成任意文件读取／RCE。目录选择也仍需要用户交互。
- **建议／取舍**：统一窄 IPC 的主窗口、主 frame、受信来源验证，并明确主窗口及报告窗口导航策略；报告窗口是否完全不带 preload，作为需确认的宿主策略。不要为修复而扩大 Web API 或给渲染层 Node 权限。
- **验收**：主工作台可选目录；子 frame、报告窗口和非可信导航后的页面调用均被拒且不弹框；取消返回 null。增加真实 Electron 集成测试，而不只用通知模块的 DOM mock。

## S-04 · HTTPS 反向代理后的登录限流会连带锁住所有访问者

**P2 · 已复现（本地代理等价请求）· 预估 M**

- **依据**：`src/ui/web/server.js`，`startWeb.fetch` 登录分支，230–251 行；限流键只用 `server.requestIP(request).address`，同一键累计五次错误后先于密码校验返回 429。
- **触发／影响**：文档推荐 HTTPS 反向代理；多个浏览器经同一代理连接到 Bun 时，通常共享代理地址。一个来源五次错误就能让正确口令也一分钟无法登录；连续重复可持续影响新登录，但不撤销已建立会话。
- **复现／反例**：fixture 从同一 socket 地址发送五次错误，随后换 X-Forwarded-For 并提交正确口令，仍为 429。忽略任意 X-Forwarded-For 本身是正确保护，不能直接信任客户端自报地址作为“修复”。
- **建议／取舍**：选项 A：显式配置可信代理并只从可信跳点解析客户端地址；选项 B：代理侧负责细粒度限流，应用保留有界总量保护与提示。需用户确认部署方式；按 username 分桶也不能独自解决单账号被锁问题。
- **验收**：受信代理后的来源 A 失败不阻断来源 B 正确登录；直连伪造转发头不能绕过限制；清理过期限流项不应一次清空全部保护；提供可检查的部署说明。

## S-05 · RPC 帧有上限，但在途请求与回包队列没有总量上限

**P2 · 已复现（可控慢 socket mock）· 预估 M**

- **依据**：`src/rpc/server.js`，`RPCServer._data`，63–85 行，为每个合法帧追加 Promise；`src/socket_io.js`，`createWriter/flush/write`，6–54 行，write 返回 0 时保留队列，后续回包继续 push，无 pending-byte 预算。
- **触发／影响**：本机客户端流水发送许多小请求却不读回复，或 agent／CLI 出现故障重试，可让 daemon 排队内存持续增长、挤占正常任务。它是可信本机边界内的稳健性问题，不是公网 RPC 或跨用户越权。
- **复现／反例**：fake socket 的 write 固定返回 0，送入 200 个有效小帧，等待请求链后 `writer.pending === 200`，连接未受限；没有做耗尽内存实验。现有单帧 1 MiB 限制、逐连接串行和 drain 重试均有效，但不限制累计保留量。
- **建议／取舍**：加入每连接在途帧数、输入／输出字节预算，超过高水位暂停读取或关闭故障连接；预算按真实吞吐确定并提供明确错误。不得自动重放已经执行但未送达回复的修改请求。
- **验收**：用不读响应、持续流水及恢复 drain 三种可控 socket 验证内存／排队量有界；正常大响应仍完整交付；单个慢连接不能拖垮其他连接，关闭语义明确区分未执行与结果未知。

## S-06 · 登录 next 的反斜杠可绕过站内跳转检查

**P3 · 已复现（HTTP 响应与 WHATWG URL 解析）· 预估 S**

- **依据**：`src/ui/web/server.js`，`safeNext`，111–113 行，只拒绝 `//`；`loginPage`，118–121 行，保留 next；`startWeb.fetch` 登录成功路径，250–257 行，直接写 Location。
- **触发／影响**：登录表单 next 为 `/\audit.invalid/` 时通过检查，Location 原样返回；对 HTTP URL，反斜杠按斜杠解释，会转到外站。可用于登录后诱导跳站；未发现把口令或 HttpOnly cookie 自动转交该外站的证据，不是认证绕过。
- **复现／反例**：用假口令登录返回 303；`new URL(location, fixtureUrl).hostname` 为 `audit.invalid`，未实际访问该域。现有 escapeHtml 防 HTML 注入，`//host` 与直接 `https://host` 也已被拒。
- **建议／取舍**：拒绝反斜杠与控制字符，再基于可信基准解析并验证 origin；只返回规范化的 pathname／search／hash。无需增加外部跳转功能。
- **验收**：普通站内路径与查询仍可回跳；`//host`、反斜杠变体及控制字符变体均回退 `/`；补浏览器跳转测试且不实际出网。

## 已确认有效的边界与后续验证

- 全局认证要求非空 canonical 项目白名单；未登录 API、未知方法／参数、伪造本地 Host 与跨项目 token 有拒绝测试。S-01 不否认这些保护。
- `src/ui/web/notice-preview.js` 的 HTMLRewriter 白名单会去除脚本、事件、导航、表单和嵌套 frame，并设置独立无脚本 sandbox CSP；报告路由另有角色、真实路径、非 symlink、8 MiB 校验及无同源权限 CSP。未确认这些路径存在任意文件读取或脚本越权，仍建议真实浏览器测导航／网络限制。
- invocation token 每轮轮换、结束清空、取消失效；USER_ONLY、父子消息约束及 explainer 无工具／无 token 测试通过。普通 Agent 继承 daemon 环境是明确设计；预览环境采用白名单且有父进程死亡清理。无 token 的本机用户 RPC、人工批准与重启不重放均不列为漏洞。
- 下一步优先确认 S-01 的多窗口产品语义，再按条目选择修复与真实浏览器／Electron 验证；本文不授予任何实施或真实数据操作授权。
