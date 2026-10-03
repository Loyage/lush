# 工程质量与开发流程改进建议

本文供维护者选择测试、开发环境与契约维护投入；保留原审查证据，逐项记录当前复核、已实施的低风险工程改进及待决方向，不将测试缺口描述成业务故障。范围为 `test/`、`scripts/`、`package.json`、CI、文档地图、接口契约与性能测量。

## 最新核实（2026-10-03，基线 `47239f4`）

本节保留实施前基线核实，并更新 Notice #103 后的收口状态；下文 `81257d12` 的测试数量、失败日志和“当前复核”属于历史证据。

- **E-01 已完成本轮批准范围**：上述基线仍有三个自建继承环境的 Git / 配置测试入口；现已复用 `helpers.env()` 并保留合成配置注入能力，不修改生产环境、不一刀切改所有 spawn，也不新增重复大规模测试。实现与污染回归见 E-01。
- **E-02 / E-03 不按原故障排期**：退休命令不恢复，支持矩阵仍需另行决定。`47239f4` 已将通用测试与需开发依赖的 packaging 分离，质量 CI 亦分 job；历史缺少 `@electron/asar` 的失败不再意味着当前默认 `bun run test` 必然失败。专项未运行仍不能称全套通过。
- **E-04 收窄为复用与补缺**：已有 `scripts/check-{input-history-ui,task-graph-layout,transcript-layout,code-reader-layout,versions-layout}.js` 和 `test/web/check-notice-*.js`，使用真实 Firefox / geckodriver、发货资源、临时服务和 API fixture。不能再称“只有 DOM stub”，也不建议先引入 Chromium 或另建一套浏览器工具链。真实 Electron、中文 IME、完整鉴权 / CSP / 多项目客户端验收仍未被这些脚本替代。
- **E-05 仍需解析方向裁决**：`docs-check.js` 仍仅检查行内路径、不校验标题锚点或引用式链接；现有围栏修复保留，不暗中扩张完整 Markdown 契约。
- **E-06 本地报告已完成**：上述基线仅单次采样与 Bun / platform 身份；现已默认 5 次采样，提供中位数 / p95、提交 / Git / OS 身份与显式 JSON 输出。无新增 CI 或耗时阻断策略，现有阈值逐样本保留。真实 socket / 浏览器和 CI 归档仍属后续，现行契约见[本地读取性能报告](../contributing/read-performance.md)。

本次实际验证：helper / 文档 / desktop / Web 安全与多项目 **57 pass / 0 fail（9 文件，617 断言）**，性能脚本 **ok=true**；真实 Firefox 的 `check-input-history-ui.js` 全部通过，覆盖发货页面加载、布局、原生键盘、编辑 / 发射和 Worker 追加路由。请求 390px 窗宽时实际 viewport 为 **500px**，不能宣称 390px 验收或中文 IME 验收。完整日志与截图在 `/tmp/lush-129-audit.Fc8gnl/`；未运行全部通用 / packaging 套件或真实 Electron，未启停用户服务。

三项子 Worker 的改动合入后，在 `5b52327` 实际完整运行默认通用测试：**1240 pass / 0 fail，195 文件，12852 断言**；文档 **76 篇通过**。干净代码检出的默认 5 次完整测量 **ok=true / dirty=false**，报告显式保存，全部既有预算逐样本通过；日志与报告 `/tmp/lush-129-final.Tg1Ksv/`。未运行 packaging、真实 Electron 跨启动、最低 Bun 或其他平台专项，不称全套 / 全平台验收完成。

交付 `4950` / 尝试 `4953` 的源侧修复：仅在本 Worker 工作区合入 runtime 指定的父提交 `3e4fbcafeee8b57e84280a0ccc657ba9f84d68ed`，合并提交 `cfedd4e` 保留原交付 `eed44b9`，无文本冲突；父侧 Worker 树默认极简及显式详情选择与本地偏好存储均保留。合入后默认通用测试完整运行 **1245 pass / 0 fail，196 文件，13199 断言**，文档 **75 篇通过**，干净检出的默认 5 次性能采样 **ok=true**；日志 `/tmp/lush-129-repair.inWAc4/`。未修改父分支，未新增 packaging / 真实 Electron / 跨平台验收证据。

## 较早复核（基线 `81257d12`）

2026-10-02 在独立 Worker worktree 复核，环境 Linux x64 / Bun 1.4.2 / Git 2.55.0。已读设计入口、执行过程理念、文档约定、模块总地图及 CLI/RPC/测试分章；只使用临时项目和 mock，不操作用户 daemon、Host 或生产 Git 配置。以下“历史”记录仍指原基线，不作为当前 HEAD 的通过证据。

| 条目 | 当前结论 | 本轮动作 / 剩余方向 |
|---|---|---|
| E-01 | 仍合理，已修共享 helper 路径 | 子进程 HOME/XDG/Git 配置隔离；合成 hooks/签名/环境注入回归；非 helper 入口未统一改造 |
| E-02 | 原 README 命令故障已过时 | 不恢复已退休 plan/spec 入口；是否加新静态契约检查待决 |
| E-03 | 部分已覆盖，原判断须收窄 | 已有 Linux/macOS × Bun 1.2.0/1.4.2 的代码阅读器矩阵；扩大覆盖/收紧最低版本待决 |
| E-04 | 仍是合理测试能力缺口 | 保留快速 stub；真实浏览器/桌面冒烟及依赖成本待决 |
| E-05 | 仍合理，部分已修 | 围栏长度/嵌套示例与长章 warning；引用/标题锚点解析方向待决 |
| E-06 | 仍合理，先修陈旧脚本 | 当前 Worker fixture/分页窗口恢复；报告标明投影、stub 与事件循环测量边界；归档/分位数/CI门禁待决 |

验证结果与限制见本文末尾；完成项只覆盖上述明确范围，不代表所有原验收条件已满足。

## 历史基线、方法与结果

- HEAD：`99fcbc993640c057488532a19ca08814ab60b73e`，与指定基线一致；审查开始时工作区干净。
- 环境：Darwin 25.6.0 arm64、Bun 1.4.2、Git 2.55.0；没有安装依赖。执行前阅读 [文档约定](../contributing/documentation.md)、[模块地图](../engineering/modules.md)及其三篇分章、[设计入口](../design/README.md)与[执行过程理念](../design/agent-process.md)，并检查 `AGENTS.md`。
- 隔离：全量测试、性能脚本、探针通过 `env -i` 保留 PATH，使用临时 HOME / XDG_CONFIG_HOME / TMPDIR；设置 `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null`。仅使用 fixture、mock 与测试自己的 daemon；未连接、启停或读取真实项目 `/Users/loyage/Documents/lush/.lush`，未读取密钥。
- 已执行：`git rev-parse HEAD`、`git status --short`、版本检查及源码静态检索；`bun run test` **588 pass / 0 fail / 4771 assertions / 120 files，128.19s**；基线 `bun run docs:check` **52 篇通过**，加入本文后 **53 篇通过**；`git diff --check` 无报错。
- 已执行：`bun run measure:read-performance` **ok=true**；万Worker overview 21.537ms / 36,071 bytes，large log cold 18.308ms / warm 0.116ms，读取恰为 8 MiB。均为一次本机采样，不代表所有机器、真实浏览器或线上 RPC 延迟。
- 已执行：`bun run specs`、`bun run propose` 均退出 1，报 `Script not found`，未进入业务命令；`bun run /tmp/…/probe.js` 运行文档反例；独立进程 `bun run /tmp/…/git-probe.js` 验证合成 Git 配置污染及无配置对照，细节见 E-01 / E-05。探针在临时目录，结束检查未发现本轮遗留进程，随后清理本轮临时目录。
- 唯一仓库交付为本文；无 commit / merge / push。P1 为正确性、安全或数据安全高影响项，P2 为常见效率、体验与维护项，P3 为增强项；本范围未确认值得定为 P1 的缺陷。

## E-01 · 隔离测试继承的宿主 Git 配置

**P2｜当前：已完成批准范围内的共享 helper 与自建 Git / 配置测试环境收敛｜历史：已复现｜预估 M**

- **2026-10-03 追加实施（Notice #103，基线 `d7d5cb3`）**：`agent-settings.test.js` 删除自建继承环境，`workspaces/safety.test.js` 的 Config 和 `agent/fork.test.js` 的 Git 提交适配器子进程改用现有 `helpers.env(extra)`；受控配置和 fork 所需的项目 / Worker / Run 身份仍显式传入。未改 helper 签名、生产环境、默认测试入口或其他 spawn，也未新增重复大规模用例。范围是已核实的 Git / 配置入口，不承诺所有子进程、所有环境变量均已全局隔离。
- **本次验证**：隔离子进程注入失败 hook、签名、config-count/parameters 与 Git 路径污染，修复前四文件 **11 pass / 6 fail**（safety 初始化提交失败、fork 提交适配器退出 1）；修复后同一命令 **17 pass / 0 fail，156 断言**，清掉首次反例产生的合成 marker / index 后再次完整重跑仍通过，且二者未再生成。沿用现有 helper 回归验证显式合成配置可用与调用者环境不变。正常 `bun run test` **1229 pass / 0 fail，193 文件，12706 断言**；不包含 packaging、真实浏览器 / Electron、最低 Bun 或其他平台。完整日志 `/tmp/lush-131-env.FGlxZ0/{before,after,after-clean,full}.log`；测试仅使用自建临时项目和 mock，未启停用户服务。

- **较早复核与实施**：原问题仍可由继承全局配置触发。`test/helpers.js` 的 `env(extra)` 现为子进程提供临时 HOME/XDG，清除继承的 `GIT_*`，禁用全局/系统配置；`git(root,...args)` 也使用该环境，`fixture` 与 integration `cli` 自动受益，签名不变。临时 home 在测试进程退出时删除，不修改 `process.env`；`extra` 可显式注入合成配置。`test/helpers.test.js` 在独立子进程注入失败 hook、签名、config-count/parameters 与 Git 路径污染，验证 repo 和 fixture Git 均成功、hook 未执行、home 已回收。独立拼装环境/直接 spawn 的历史测试不在本次 helper 保护范围；若要让所有测试命令统一隔离，还需另行收敛入口。

- **依据**：`test/helpers.js` 的 `env()`（8 行）仅清除 `LUSH_*` 并启用 mock；`git()`（21–25 行）启动 Git 未显式指定隔离环境，`repo()`（26–30 行）只设置仓库用户名、邮箱。`test/integration/harness.js` 的 `cli()`（6–11 行）继续继承这份环境。
- **触发与影响**：在新进程通过 `GIT_CONFIG_GLOBAL` 指向临时配置，其 `core.hooksPath` 指向仅打印标记并退出 42 的自建 hook，调用 `repo(temp())` 失败并打印 `AUDIT_FAKE_GLOBAL_HOOK`；改为 `/dev/null` 的同代码对照成功。日常测试会受开发者签名、hooks 等设置影响，初始化测试仓库也可能执行非测试控制的 hook；这不是项目 Git 业务行为的缺陷。
- **现有保护 / 反例**：项目目录本来就是临时目录，mock 与 LUSH 环境清理有效；本次隔离全量测试全部通过。问题是宿主配置未被测试入口统一封住，而不是测试没有隔离项目。
- **建议与取舍**：增加仅作用于测试子进程的统一环境入口，隔离 HOME / XDG 与 Git 全局、系统配置；确需用户配置语义的用例显式注入合成配置。不要改生产 Git 配置，也不要在不同测试文件中竞争修改进程级环境；兼容现有 helper 公共签名。
- **验收**：带合成失败 hook、开启签名、不同全局 Git 设置的宿主运行同一测试命令仍通过；专测配置继承的用例仍能显式开启；失败和超时路径不留下临时 daemon、工作区或配置。

## E-02 · 把文档命令与真实入口做契约检查

**P2｜当前：原故障已过时，新增检查待决｜历史：已复现｜预估 S**

- **当前复核**：根 `README.md` 已不含下面记录的 propose/approve/reject/specs 开发命令示例；模块地图与当前 CLI 明确退休 plan/spec 公开入口，不能为消除历史反例恢复它们。`test/help-guard.test.js`、`test/worker-cli.test.js`、RPC 白名单等已有公开入口回归；未发现现有“文档脚本名检查”承诺。是否增加静态契约测试仍有价值，但会形成新增门禁，并需区分当前操作说明、源码路径示例及本 todo 的历史失败命令，留给维护者选择。

- **依据**：根 `README.md` 的“常用开发命令”（253–256 行）列出 `bun run propose/approve/reject/specs`；`scripts/ops.js` 的顶层 `aliases`（4–12 行）确有这些映射，但 `package.json` 的 `scripts`（10–53 行）均未登记。实测代表命令 `specs`、`propose` 在 Bun 层直接失败。
- **触发与影响**：维护者照文档操作无法到达现有 CLI；全量测试和 docs:check 仍绿，说明公开命令入口与文档之间缺少一层一致性校验，非 plan/spec 业务本身不可用。
- **现有保护 / 反例**：底层命令与 ops 别名仍在，没必要重写 CLI；RPC 装配已有 `src/rpc/dispatcher.js` 的 `mergeHandlers()`（12–20 行）查重与查漏，不能说项目完全没有契约保护。
- **建议与取舍**：由维护者确认是补齐便捷 scripts，还是把示例统一为已存在的 `bun run lush plan …` / `bun run lush spec list`；随后增加静态命令入口测试。只检查示例脚本名和分派关系，不在检查文档时执行审批、删除、合并命令。
- **验收**：所有标为可执行的 `bun run NAME` 示例可解析至 package script；故意删掉一个被引用入口时检查失败且定位文档行；既有 `src/index.js` 导出和 RPC 权限集合不被顺便改动。

## E-03 · CI 覆盖支持的平台和最低运行版本

**P2｜当前：部分已覆盖，扩大范围待决｜历史：代码确认｜预估 M**

- **当前复核**：`quality.yml` 仍仅 Linux / Bun 1.4.2 全量，但 `code-reader-posix.yml` 已为代码阅读器及对应 HTTP 安全建立 ubuntu/macOS × Bun 1.2.0/1.4.2 聚焦矩阵，相关路径变更和手动触发；`windows-desktop.yml` 另做 Windows 构建/安装器校验。故“没有 macOS/最低 Bun 自动覆盖”已不成立；生命周期/socket/权限/后台 Host 的跨平台覆盖仍有限。`package.json` 仍声明 Bun >=1.2.0；本轮未运行远端 CI 或 Bun 1.2，不能宣称矩阵实际通过。扩展兼容作业或收紧最低版本属于支持政策与 runner 成本决策。

- **依据**：`.github/workflows/quality.yml` 的 `jobs.test`（18–29 行）只有 ubuntu-latest / Bun 1.4.2；`package.json` 的 `engines`（57 行）和根 `README.md`（10 行）承诺 Bun 1.2+、macOS / Linux。`src/ui/web/control.js` 的 `webListenerPids()`（65–71 行）依赖 lsof/ss，明确存在平台差异面。
- **触发与影响**：修改 Bun/SQLite/socket 行为或进程识别后，单 Linux 新版本门禁无法证明最低版本与 macOS 仍受支持。**未复现 Bun 1.2 不兼容**；本机 macOS 1.4.2 全量通过，只证明当前组合。
- **现有保护 / 反例**：CI 已固定 Bun 版本、使用 frozen lockfile 并执行测试与文档检查；无需另建一套工具链，也不应把 Windows 未进矩阵定为缺陷，README 当前只承诺两个平台。
- **建议与取舍**：先确认维持 Bun 1.2 下限还是收紧声明；保留 Linux 主门禁，为 macOS 和确认后的最低 Bun 增加精简兼容作业或定期全量作业。记录 Git/Bun/OS 信息，使用 fixture，不连真实 daemon；代价是 runner 时间和平台工具维护。
- **验收**：每个声明支持的 OS 至少有自动回归，最低版本有明确通过记录；进程树退出、Unix socket、文件权限和后台 Web 生命周期在对应平台测试；不支持的组合明确说明而非假绿。

## E-04 · 为真实浏览器和桌面壳补最小冒烟层

**P2｜最新：已有真实 Firefox 专项，剩余为复用与未覆盖场景｜历史：代码确认（测试能力缺口，不是 UI 故障）｜预估 M**

Web / 桌面功能建议已完成，对应待办专题删除；未完成的真实客户端验收集中保留在本条：

- 真实 Electron 启动两次且 Host 端口不同，确认共享外观 / 行为与项目视图偏好保留、恢复默认不清其它项目、通知沿用既有语义；现行存储与安全范围见[桌面偏好契约](../engineering/desktop-preferences.md)。
- 真实中文 IME 的组词、候选确认及最终 Enter 提交，在浏览器与 Electron 各验证一次；合成 composition 事件和 WebDriver 普通键盘通过不能替代输入法验收。
- 本轮 Firefox 输入专项最窄实测 viewport 为 500px，不冒称 390px、真实 Electron、读屏器或帧率验收；后续复用现有专项补足目标环境证据，不从零新建浏览器工具链。

- **当前复核**：现在还有 `test/desktop/runtime.test.js` 的模拟 BrowserWindow/preload/IPC 回归、`test/desktop/local-host.test.js` 的真实临时 Host 生命周期，以及 Windows 包产物校验；这比原审查更强，但仍不等于真实 Chromium 加载发货 HTML/CSS 或 Electron 端到端。未增加浏览器依赖、CI runner 或发布门禁。可选开发侧 Chromium 自动冒烟、桌面发布前 Electron 冒烟，或先维护可重复手工清单；均须维护者确认成本。

- **依据**：`test/dom-stub.js` 的 `installDom()`（129–188 行）自建元素、history、计时器，`getElementById` 自动造节点，不加载实际 HTML/CSS；`test/web/assets.test.js` 的样式用例（29–97 行）主要断言源码字符串。`test/mermaid-docs.test.js`（4–68 行）注入假的 Mermaid / Blob；`test/web/notice-notifications.test.js`（58–70 行）模拟桌面 bridge，而非启动 Electron。
- **触发与影响**：真实模块加载、CSP 对 SVG/blob 的执行效果、弹窗焦点、布局遮挡或 preload/IPC 接线出错时，现有 stub 与 HTTP 测试可能仍绿；本轮没有据此声称页面已坏。
- **现有保护 / 反例**：已有真 HTTP/RPC 认证与资源测试，DOM stub 还主动禁止原生弹窗，价值明确；不建议替换数百条快速测试或给生产 runtime 引入浏览器测试依赖。
- **建议与取舍**：确认维护者是否接受开发侧浏览器自动化及 CI 浏览器成本；可选少量 Chromium 冒烟，桌面发布前再跑 Electron 冒烟，或先采用可重复的手动清单。沿用临时项目、mock 与随机回环端口。
- **验收**：实际加载发货 HTML，完成页面导航、应用弹窗、一次 mock 待决答复与本地 Mermaid 图渲染；检查控制台/CSP 错误、窄屏可点击性；桌面检查目录选择 bridge 和关闭只回收自己的 Web host，失败保留截图与日志。

## E-05 · 文档检查补上当前会漏过的 Markdown 边界

**P2｜当前：围栏与长章提示已修，链接解析待决｜历史：已复现｜预估 M**

- **当前复核与实施**：原四反引号/三反引号反例仍有效，已用共享 fence 状态修复：结束必须同字符、长度不短于开启且无 info string；普通围栏内的 Mermaid 示例不被误作图，代码里的标题/伪链接仍忽略。新增测试覆盖反引号/波浪线、过短/异字符/带 info 的错误结束、较长合法结束、嵌套示例与围栏后的真实链接。超 150 行仅给可解释 warning，参考表仍可更长，不增加硬错误。引用式链接、内部标题锚点和缺目录入口尚未实现；完整解析器依赖 vs 明确受限的零依赖实现需先决策，不能将本次围栏扫描当成完整 Markdown 支持。

- **依据**：`scripts/docs-check.js` 的 `markdownLinks()`（52–58 行）只匹配行内链接，`checkDocs()`（82–95 行）跳过/剥去锚点；`withoutFencedCode()`（22–36 行）与 `mermaidFenceErrors()`（38–50 行）只记围栏字符，不记长度；长度告警（7、79 行）仅按 50 KiB。
- **触发与影响**：临时文档中的引用式失效链接、指向现存文件不存在标题的链接、四反引号开启却仅三反引号结束的 Mermaid，均返回 `errors=[]`；201 行小文档亦无 warning。前两项是文档导航保护缺口，第三项直接弱于“正确闭合”的既有检查承诺；行数是约定与实现的提示口径差异，不应直接升级为硬错误。
- **现有保护 / 反例**：现有检查能抓 HTML 文档、多个 H1、普通失效行内路径及普通未闭合 Mermaid，`test/docs-check.test.js`（19–38 行）已有正反例；不能由反例推断当前 52 篇文档全部有错。
- **建议与取舍**：补引用定义、围栏长度/嵌套示例状态；对明确的内部标题锚点做校验，并按约定给长章、缺目录入口提供告警。完整 Markdown 解析器与小型受限实现二选一需确认，避免正则不断扩张或把告警全变硬门禁；新 todo 目录索引由协调者统一维护。
- **验收**：上述三个错误样例被拒绝，四反引号中展示三反引号示例不会误报；中文/重复标题锚点有测试；普通代码块里的伪链接不检查，长参考表可解释豁免；仓库文档检查保持通过。

## E-06 · 将现有性能脚本变为可比较、分层的回归证据

**P2｜当前：本地重复采样、身份与显式报告已完成；CI / 真实 RPC 仍待决｜历史：代码确认｜预估 M**

- **最新实施（2026-10-03，Notice #103 批准范围）**：默认 5 次完整采样，每个数据集 / 样本重建临时 fixture；`--samples N` 支持 1～50，增加中位数及 nearest-rank p95 / min / max、全部原样本、UTC 时间与代码提交 / dirty / OS / Bun / Git 身份。`--output PATH` 可保存与 stdout 完全相同的 JSON，独占新建、不覆盖旧报告。现行参数 / 报告 / 退出语义见[本地读取性能报告](../contributing/read-performance.md)，小规模契约回归为 `test/read-performance.test.js`。不新增依赖、CI 作业或耗时门禁，不改生产代码。
- **预算与测量边界**：全部原有字节、结构和时间阈值仍逐样本检查，任何样本超限即 `ok:false` / 退出 1，不用摘要中位数掩盖。旧耗时标量现在表示中位数，原样本保留；dispatcher / DOM stub / 事件循环不冒充真实 socket / 浏览器。日志 cold 只指 fixture 首次读取，不清 OS 缓存；5 个样本的 p95 是最大值，不承诺稳定尾延迟。
- **实际验证**：性能契约 **5 pass / 0 fail，54 断言**，连同文档最终聚焦 **9 pass / 0 fail，73 断言**；`docs:check` **75 篇通过**（长章仅 warning），`git diff --check` 通过；默认 5 次全规模测量 **ok=true**，万 Worker overview median / p95 为 **4.631 / 4.841ms**，stub render 为 **4.552 / 6.829ms**，大日志 cold 为 **14.094 / 14.214ms**，读取 **8 MiB**。stdout 与显式报告逐字节一致；该开发时报告的代码身份正确标为 `dirty:true`。完整日志与报告在 `/tmp/lush-132-performance.Xw700O/`。首轮新增代码存在合成日志对象括号遗漏，测试加载与测量均失败；修复后完整重跑通过，首次错误日志保留在 `/tmp/lush-132-performance.jUfgsM/`，不把首次失败当成测试通过。未运行真实 socket / 浏览器、远端 CI 或跨平台矩阵。
- **固定父基线源侧修复（交付 4743 / 尝试 4746）**：按 runtime 指定在本源工作区合入父提交 `903deb808d293ef5b1c52fae6215daf4d7b1ab96`，保留原源提交 `4351de0fafe8bd60d7607bd0c17894696cf4680a`，无文本冲突。合入后性能 / 文档 / helper 及父侧 E-01 相关六文件 **26 pass / 0 fail，229 断言**，文档 **75 篇通过**，完整日志 `/tmp/lush-132-repair.1SSTTK/`。未修改父分支，测量范围和既有预算不变。
- **较早修复（历史）**：原脚本 1000/10000 Worker 的 `shown=0` 来自缺 `task_kind` 的 research fixture，现已用 agent/order 修复；分页按公开 limit 而非退休窗口检查。R-07 最新窗口 / 分页功能已完成，10 万行历史、分配量与生产延迟仍未量测；自动 CI 归档及新门禁仍须另行裁决。

- **依据**：`scripts/measure-read-performance.js` 的 `fixture()`（26–35 行）将 client.request 直接接到 Dispatcher；`taskDataset()`（38–59 行）和 `logDataset()`（69–83 行）各单次采样，渲染使用 DOM stub；顶层阈值/报告（85–113 行）有固定预算、无分位数和历史归档。CI 的 `jobs.test`（18–29 行）没有执行此脚本。
- **触发与影响**：本次性能预算全部通过，但 `other_rpc_timer_delay` 实际是同进程定时器延迟，不是真实竞争 RPC 延迟；同一脚本也没有测浏览器布局。没有自动留存时，难区分增长趋势、机器噪声与单次回退，且脚本自身长期可能不被运行。
- **现有保护 / 反例**：已有 20 / 1000 / 10000 Worker、三档日志、字节预算和分页控件断言，是可直接复用的基础；没有依据要求立即优化已经通过预算的代码。
- **建议与取舍**：先加定期/手动作业归档 JSON，标注“投影 / stub 渲染 / 事件循环阻塞”；重复样本记录中位数/高分位及环境身份，再为真实 socket 并发读增加独立测量。是否将时间预算设为阻断门禁由维护者确认；结构/字节上限可先硬校验，耗时先观察，避免共享 runner 抖动。
- **验收**：同一数据规模可比较至少两次提交的结果，记录 OS/Bun/Git 和样本数；结构预算超限稳定失败，时间告警可解释；真实 RPC 延迟与投影耗时分列，报告不混入用户Worker内容或凭证。

## 本轮验证与限制

- helper/文档聚焦回归：**6 pass / 0 fail / 33 assertions**，合成污染只注入独立子进程，不竞争修改全局测试环境。
- 实际完整运行默认 `bun run test`：**1093 pass / 1 fail / 1 error / 185 files / 10990 assertions**；唯一加载错误为本机未安装既有开发依赖 `@electron/asar`，Windows packaging 文件未能执行。完整日志：`/tmp/lush-107-full.jCl5PP/test.log`，未为本轮安装依赖或修改锁文件。
- 排除上述 packaging 后默认超时运行：**1092 pass / 1 fail / 184 files**，`notice-info.test.js` 的 200 条提醒测试超过 5s；该文件独跑亦 **5 pass / 1 timeout**，不能当成仅并行抖动。日志：`/tmp/lush-107-available.Rwphjj/test.log`、`/tmp/lush-107-notice.HQOEb4/test.log`。未改业务或用例，不能宣称默认命令全绿。
- 相同 184 文件显式使用 `--timeout 30000` 完整重跑：**1093 pass / 0 fail / 10990 assertions / 99.16s**，日志：`/tmp/lush-107-retry.AeWcev/test.log`；这不包含缺依赖的包装测试，也不替代默认 5s 超时下的失败证据。
- `bun run docs:check`：**68 篇 Markdown 通过**，长章 warning 不阻断；`git diff --check` 通过。修复后的 `bun run measure:read-performance`：**ok=true**，万 Worker 展示 100 条，overview 4.733ms / stub render 6.442ms；大日志 cold 23.766ms / warm 0.084ms，8 MiB 读取预算通过。这是单机单样本，不是浏览器/socket/跨平台证据；日志：`/tmp/lush-107-final-quality.kFpyVj/performance.log`。首轮脚本失败记录保留于 `/tmp/lush-107-quality.sBuF24/performance.log`。
- 测试使用临时 HOME/XDG/TMPDIR、Git 全局/系统配置隔离、mock 与临时项目；未连接或启停用户服务。临时进程已退出，保留完整日志便于复查；未验证远端 CI、macOS、Windows 或最低 Bun。

## 固定父基线源侧修复验证

交付 `3834` / 尝试 `3870` 按 runtime 指定在本源工作区合入父提交 `f1f577c3cc3a39c5be1ee15e1c3268f4b38849b4`，原源提交 `54cca87ad528ebddb8f0e14713a519d748674d54` 保留；文件无文本冲突，不修改父分支。合入后再次实际完整运行 `bun run test --timeout 30000`：**1101 pass / 1 fail / 1 error / 11168 assertions / 185 files**；唯一错误仍为缺少既有 `@electron/asar`，不宣称全量通过，完整日志 `/tmp/lush-107-repair-full.bAv1Bm/test.log`。本轮涉及的 helper、文档、安全、桌面与 Web 聚焦 8 文件：**71 pass / 0 fail / 746 assertions**，日志 `/tmp/lush-107-repair-focused.gZ419V/test.log`；文档 68 篇、性能 `ok=true`、Git whitespace 检查通过。未安装依赖或改变原支持/门禁决策。

## 剩余待决选项

- **E-02 文档入口契约**：只维护当前文档与既有公开 API 回归；或为明确标注的当前示例新增静态检查（需排除历史记录/路径示例）。不考虑恢复已退休公开入口。
- **E-03 支持矩阵**：维持现有聚焦矩阵；或继续承诺 Bun 1.2 并扩大生命周期/Host/socket 兼容作业；或经验证后收紧最低版本。后两者影响支持政策或 runner 成本。
- **E-04 冒烟层**：优先复用已有 Firefox 专项，明确覆盖与未覆盖场景；是否整合入口 / CI 或增加真实 Electron 发布前冒烟仍需确认。不是从零新增 Chromium 工具链，不得把开发依赖变成 daemon/CLI 运行依赖。
- **E-05 Markdown 方向**：保持现有受限检查、明确未覆盖导航；或零依赖补受限引用/标题规则；或引入开发侧完整解析器。标题去重/中文锚点与告警豁免必须明确，不能靠扩张正则暗中承诺完整解析。
- **E-06 性能证据**：本地重复采样、环境身份与显式 JSON 输出已完成；手动 / 定期 CI 归档以及经稳定性验证的新耗时门禁仍需裁决。真实 socket 并发读独立于投影 / 事件循环指标；既有本地阈值保留，未新增门禁。
