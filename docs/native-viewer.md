# 终端内观看

本文面向想在真实终端中观看 Worker 执行过程的用户。入口为 `lush worker watch`；Web「Agent → 执行过程」的「终端内观看」提供复制命令。工程边界见[执行记录阅读器](engineering/transcript-reader.md)。

## 打开观看

在**项目所在机器**的终端运行：

```bash
bun run lush worker watch W195 --project /path/to/project
```

也可以使用已安装的 `lush worker watch W195 --project /path/to/project`。Worker 身份接受真实页面编号或内部整数 ID；编号通过项目只读查询解析，不从编号推算整数。Web 复制命令在已知来源项目时带上 Shell 引用后的 `--project`，避免终端当前目录指向另一项目。

观看器使用本机已安装 Pi 的原生消息、Markdown 和内置工具渲染组件。Pi 包仅在显式观看时加载，不成为 daemon 或普通 CLI 命令的运行时依赖；缺少或不兼容时明确报错，不自动安装。定位遵循本地包解析及 `LUSH_PI_COMMAND`／PATH 中的 `pi` 路径，不执行该命令来探测。需要真实 TTY，不支持重定向和 `--json`。

观看使用 Pi 原生全屏视图与滚动组件，不把历史塞入终端自身回滚区；退出恢复原主屏。固定栏只占两行，其余用于正文，右侧常驻滚动条。

- 鼠标滚轮、上下箭头、j／k、PageUp／PageDown、Home／End：滚动阅读；离开底部时暂停自动跟随位置，End 或 f 回到最新。
- 空格／p：暂停或恢复跟随；?／h：显示帮助。
- Ctrl+O：全部工具展开／折叠。
- q、Esc、Ctrl+C：退出观看，关闭本地正在读取的客户端连接，不取消、不暂停 Worker；daemon 已开始的只读扫描可能继续完成。
- 尚无会话时继续等待；读取失败明确退出，不把失败当成结束或成功。

配色使用 Pi 保留的 `system` 主题，查询终端前景、背景及 ANSI 调色板；启动等待最多 100ms，晚到响应和深浅色切换会刷新。无响应时根据终端提示选择对比配色，未知则使用暗色回退。工具面板和 Markdown 代码块有背景，保留原生语法高亮；不读取用户主题或设置。

全屏滚轮由 Pi 处理；终端或 tmux 拦截鼠标／按键、未报告配色时，体验可能与直连终端不同。实现依赖兼容 Pi 的全屏组件，以及随包发布的 `dist/modes/interactive/theme/theme.js` 颜色接缝（不是包根公开 API）；缺失时明确拒绝，不静默降级成旧观看器。

远程项目请自行在服务器终端或 SSH 登录后运行；Lush 不建立 SSH 连接或隧道。仅在本地复制远端项目路径，不会让本地 CLI 自动连接远端 daemon。

## 只读意味着什么

观看器只调用既有 `worker.inspect`／编号 lookup 与 `worker.transcript_page`，按 `(seq, offset)` 连续分页。不会创建 Agent、调用模型、执行日志中的命令、加载用户扩展、写会话／配置或读取 Worker 代码现场。Agent 凭证不能运行此命令；键盘和鼠标仅控制阅读，选区不自动写剪贴板。

工具调用和结果按 `(会话文件, call_id)` 配对；缺失或重复身份保守展示，不假装成功或仍在运行。日志中的终端控制内容按不可信文字净化，不执行 CSI／OSC 控制序列。内置工具只使用渲染接口，不持有可执行工具入口；edit 不根据当前文件生成历史差异。

这是**已记录步骤的原生渲染**，不是后台 Pi TUI 的接管，也不是逐字直播。后台仍以原有 `--print` 模式运行，消息完成后才写会话；没有记录的中间输出不能重建。投影不含原始图片、工具 details 或扩展特殊界面，不能保证还原全部原生能力；元数据没有可靠 token／时间字段时不编造。

## 大记录与单次查询

读取和渲染有界：默认单条正文最多 128Ki 字符、累计分页 JSON 最多 4MiB、最多 2000 条记录及 50000 渲染行。超过任一上限时明确退出，不默默跳过历史。可以根据显示的步骤编号显式从后续继续：

```bash
bun run lush worker watch W195 --after 1000 --project /path/to/project
```

`--after N` 跳过前 N 步，不自动猜测「最新」。从结果开始时，前序调用未读到就单独显示，不补造调用。单个超大步骤请使用 Web 的分段原文阅读，完整搜索也仍走 Web 阅读器。

纯文本持续跟随已删除，不提供旧循环或兼容别名。单次 `transcript` 查询仍可用于排障或 Agent 读取记录，不需要 Pi 渲染包，也不持续轮询：

```bash
bun run lush worker transcript W195 --project /path/to/project
```

Web 执行详情、搜索、引用与代码阅读器保持独立，不新增 Web 终端或模型入口。

## 开发验证

常规回归覆盖独立的分页、配对、安全净化、安装定位、权限及客户端取消测试，不要求全局 Pi 可用。安装兼容 Pi 且具备 POSIX／python3 的开发环境可显式运行：

```bash
bun run scripts/check-native-viewer.js
LUSH_NATIVE_PI_SMOKE=1 bun run test ./test/native-watch-smoke.test.js
```

PTY 专项使用临时项目、受控 Unix RPC 与真实 CLI／原生组件，检查滚轮／键盘翻页、工具展开、代码和输出背景、晚到浅色配色、窄屏 resize、在途读取 q／Ctrl+C 退出及 raw mode／主屏／鼠标与配色通知恢复；不启动项目 daemon 或模型，输出完整日志路径。它不是远端／macOS 实测，也不替代最终全量。
