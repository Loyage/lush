# 工程质量与开发流程改进建议

本文供维护者选择测试、开发环境与契约维护投入；只记录审查建议，不实施功能，也不将测试缺口描述成业务故障。范围为 `test/`、`scripts/`、`package.json`、CI、文档地图、接口契约与性能测量。

## 基线、方法与结果

- HEAD：`99fcbc993640c057488532a19ca08814ab60b73e`，与指定基线一致；审查开始时工作区干净。
- 环境：Darwin 25.6.0 arm64、Bun 1.4.2、Git 2.55.0；没有安装依赖。执行前阅读 [文档约定](../contributing/documentation.md)、[模块地图](../engineering/modules.md)及其三篇分章、[设计入口](../design/README.md)与[执行过程理念](../design/agent-process.md)，并检查 `AGENTS.md`。
- 隔离：全量测试、性能脚本、探针通过 `env -i` 保留 PATH，使用临时 HOME / XDG_CONFIG_HOME / TMPDIR；设置 `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null`。仅使用 fixture、mock 与测试自己的 daemon；未连接、启停或读取真实项目 `/Users/loyage/Documents/lush/.lush`，未读取密钥。
- 已执行：`git rev-parse HEAD`、`git status --short`、版本检查及源码静态检索；`bun run test` **588 pass / 0 fail / 4771 assertions / 120 files，128.19s**；基线 `bun run docs:check` **52 篇通过**，加入本文后 **53 篇通过**；`git diff --check` 无报错。
- 已执行：`bun run measure:read-performance` **ok=true**；万任务 overview 21.537ms / 36,071 bytes，large log cold 18.308ms / warm 0.116ms，读取恰为 8 MiB。均为一次本机采样，不代表所有机器、真实浏览器或线上 RPC 延迟。
- 已执行：`bun run specs`、`bun run propose` 均退出 1，报 `Script not found`，未进入业务命令；`bun run /tmp/…/probe.js` 运行文档反例；独立进程 `bun run /tmp/…/git-probe.js` 验证合成 Git 配置污染及无配置对照，细节见 E-01 / E-05。探针在临时目录，结束检查未发现本轮遗留进程，随后清理本轮临时目录。
- 唯一仓库交付为本文；无 commit / merge / push。P1 为正确性、安全或数据安全高影响项，P2 为常见效率、体验与维护项，P3 为增强项；本范围未确认值得定为 P1 的缺陷。

## E-01 · 隔离测试继承的宿主 Git 配置

**P2｜已复现｜预估 M**

- **依据**：`test/helpers.js` 的 `env()`（8 行）仅清除 `LUSH_*` 并启用 mock；`git()`（21–25 行）启动 Git 未显式指定隔离环境，`repo()`（26–30 行）只设置仓库用户名、邮箱。`test/integration/harness.js` 的 `cli()`（6–11 行）继续继承这份环境。
- **触发与影响**：在新进程通过 `GIT_CONFIG_GLOBAL` 指向临时配置，其 `core.hooksPath` 指向仅打印标记并退出 42 的自建 hook，调用 `repo(temp())` 失败并打印 `AUDIT_FAKE_GLOBAL_HOOK`；改为 `/dev/null` 的同代码对照成功。日常测试会受开发者签名、hooks 等设置影响，初始化测试仓库也可能执行非测试控制的 hook；这不是项目 Git 业务行为的缺陷。
- **现有保护 / 反例**：项目目录本来就是临时目录，mock 与 LUSH 环境清理有效；本次隔离全量测试全部通过。问题是宿主配置未被测试入口统一封住，而不是测试没有隔离项目。
- **建议与取舍**：增加仅作用于测试子进程的统一环境入口，隔离 HOME / XDG 与 Git 全局、系统配置；确需用户配置语义的用例显式注入合成配置。不要改生产 Git 配置，也不要在不同测试文件中竞争修改进程级环境；兼容现有 helper 公共签名。
- **验收**：带合成失败 hook、开启签名、不同全局 Git 设置的宿主运行同一测试命令仍通过；专测配置继承的用例仍能显式开启；失败和超时路径不留下临时 daemon、工作区或配置。

## E-02 · 把文档命令与真实入口做契约检查

**P2｜已复现｜预估 S**

- **依据**：根 `README.md` 的“常用开发命令”（253–256 行）列出 `bun run propose/approve/reject/specs`；`scripts/ops.js` 的顶层 `aliases`（4–12 行）确有这些映射，但 `package.json` 的 `scripts`（10–53 行）均未登记。实测代表命令 `specs`、`propose` 在 Bun 层直接失败。
- **触发与影响**：维护者照文档操作无法到达现有 CLI；全量测试和 docs:check 仍绿，说明公开命令入口与文档之间缺少一层一致性校验，非 plan/spec 业务本身不可用。
- **现有保护 / 反例**：底层命令与 ops 别名仍在，没必要重写 CLI；RPC 装配已有 `src/rpc/dispatcher.js` 的 `mergeHandlers()`（12–20 行）查重与查漏，不能说项目完全没有契约保护。
- **建议与取舍**：由维护者确认是补齐便捷 scripts，还是把示例统一为已存在的 `bun run lush plan …` / `bun run lush spec list`；随后增加静态命令入口测试。只检查示例脚本名和分派关系，不在检查文档时执行审批、删除、合并命令。
- **验收**：所有标为可执行的 `bun run NAME` 示例可解析至 package script；故意删掉一个被引用入口时检查失败且定位文档行；既有 `src/index.js` 导出和 RPC 权限集合不被顺便改动。

## E-03 · CI 覆盖支持的平台和最低运行版本

**P2｜代码确认｜预估 M**

- **依据**：`.github/workflows/quality.yml` 的 `jobs.test`（18–29 行）只有 ubuntu-latest / Bun 1.4.2；`package.json` 的 `engines`（57 行）和根 `README.md`（10 行）承诺 Bun 1.2+、macOS / Linux。`src/ui/web/control.js` 的 `webListenerPids()`（65–71 行）依赖 lsof/ss，明确存在平台差异面。
- **触发与影响**：修改 Bun/SQLite/socket 行为或进程识别后，单 Linux 新版本门禁无法证明最低版本与 macOS 仍受支持。**未复现 Bun 1.2 不兼容**；本机 macOS 1.4.2 全量通过，只证明当前组合。
- **现有保护 / 反例**：CI 已固定 Bun 版本、使用 frozen lockfile 并执行测试与文档检查；无需另建一套工具链，也不应把 Windows 未进矩阵定为缺陷，README 当前只承诺两个平台。
- **建议与取舍**：先确认维持 Bun 1.2 下限还是收紧声明；保留 Linux 主门禁，为 macOS 和确认后的最低 Bun 增加精简兼容作业或定期全量作业。记录 Git/Bun/OS 信息，使用 fixture，不连真实 daemon；代价是 runner 时间和平台工具维护。
- **验收**：每个声明支持的 OS 至少有自动回归，最低版本有明确通过记录；进程树退出、Unix socket、文件权限和后台 Web 生命周期在对应平台测试；不支持的组合明确说明而非假绿。

## E-04 · 为真实浏览器和桌面壳补最小冒烟层

**P2｜代码确认（测试能力缺口，不是 UI 故障）｜预估 M**

- **依据**：`test/dom-stub.js` 的 `installDom()`（129–188 行）自建元素、history、计时器，`getElementById` 自动造节点，不加载实际 HTML/CSS；`test/web/assets.test.js` 的样式用例（29–97 行）主要断言源码字符串。`test/mermaid-docs.test.js`（4–68 行）注入假的 Mermaid / Blob；`test/web/notice-notifications.test.js`（58–70 行）模拟桌面 bridge，而非启动 Electron。
- **触发与影响**：真实模块加载、CSP 对 SVG/blob 的执行效果、弹窗焦点、布局遮挡或 preload/IPC 接线出错时，现有 stub 与 HTTP 测试可能仍绿；本轮没有据此声称页面已坏。
- **现有保护 / 反例**：已有真 HTTP/RPC 认证与资源测试，DOM stub 还主动禁止原生弹窗，价值明确；不建议替换数百条快速测试或给生产 runtime 引入浏览器测试依赖。
- **建议与取舍**：确认维护者是否接受开发侧浏览器自动化及 CI 浏览器成本；可选少量 Chromium 冒烟，桌面发布前再跑 Electron 冒烟，或先采用可重复的手动清单。沿用临时项目、mock 与随机回环端口。
- **验收**：实际加载发货 HTML，完成页面导航、应用弹窗、一次 mock 待决答复与本地 Mermaid 图渲染；检查控制台/CSP 错误、窄屏可点击性；桌面检查目录选择 bridge 和关闭只回收自己的 Web host，失败保留截图与日志。

## E-05 · 文档检查补上当前会漏过的 Markdown 边界

**P2｜已复现｜预估 M**

- **依据**：`scripts/docs-check.js` 的 `markdownLinks()`（52–58 行）只匹配行内链接，`checkDocs()`（82–95 行）跳过/剥去锚点；`withoutFencedCode()`（22–36 行）与 `mermaidFenceErrors()`（38–50 行）只记围栏字符，不记长度；长度告警（7、79 行）仅按 50 KiB。
- **触发与影响**：临时文档中的引用式失效链接、指向现存文件不存在标题的链接、四反引号开启却仅三反引号结束的 Mermaid，均返回 `errors=[]`；201 行小文档亦无 warning。前两项是文档导航保护缺口，第三项直接弱于“正确闭合”的既有检查承诺；行数是约定与实现的提示口径差异，不应直接升级为硬错误。
- **现有保护 / 反例**：现有检查能抓 HTML 文档、多个 H1、普通失效行内路径及普通未闭合 Mermaid，`test/docs-check.test.js`（19–38 行）已有正反例；不能由反例推断当前 52 篇文档全部有错。
- **建议与取舍**：补引用定义、围栏长度/嵌套示例状态；对明确的内部标题锚点做校验，并按约定给长章、缺目录入口提供告警。完整 Markdown 解析器与小型受限实现二选一需确认，避免正则不断扩张或把告警全变硬门禁；新 todo 目录索引由协调者统一维护。
- **验收**：上述三个错误样例被拒绝，四反引号中展示三反引号示例不会误报；中文/重复标题锚点有测试；普通代码块里的伪链接不检查，长参考表可解释豁免；仓库文档检查保持通过。

## E-06 · 将现有性能脚本变为可比较、分层的回归证据

**P2｜代码确认｜预估 M**

- **依据**：`scripts/measure-read-performance.js` 的 `fixture()`（26–35 行）将 client.request 直接接到 Dispatcher；`taskDataset()`（38–59 行）和 `logDataset()`（69–83 行）各单次采样，渲染使用 DOM stub；顶层阈值/报告（85–113 行）有固定预算、无分位数和历史归档。CI 的 `jobs.test`（18–29 行）没有执行此脚本。
- **触发与影响**：本次性能预算全部通过，但 `other_rpc_timer_delay` 实际是同进程定时器延迟，不是真实竞争 RPC 延迟；同一脚本也没有测浏览器布局。没有自动留存时，难区分增长趋势、机器噪声与单次回退，且脚本自身长期可能不被运行。
- **现有保护 / 反例**：已有 20 / 1000 / 10000 任务、三档日志、字节预算和分页控件断言，是可直接复用的基础；没有依据要求立即优化已经通过预算的代码。
- **建议与取舍**：先加定期/手动作业归档 JSON，标注“投影 / stub 渲染 / 事件循环阻塞”；重复样本记录中位数/高分位及环境身份，再为真实 socket 并发读增加独立测量。是否将时间预算设为阻断门禁由维护者确认；结构/字节上限可先硬校验，耗时先观察，避免共享 runner 抖动。
- **验收**：同一数据规模可比较至少两次提交的结果，记录 OS/Bun/Git 和样本数；结构预算超限稳定失败，时间告警可解释；真实 RPC 延迟与投影耗时分列，报告不混入用户任务内容或凭证。
