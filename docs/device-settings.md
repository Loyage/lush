# 设备设置与显式迁移

本文说明同设备配置的归属、生效与旧项目迁移。设备指**运行 Lush 的机器、同一系统用户**，不是浏览器所在电脑；远端项目使用服务器配置，不自动跨设备同步。页面安排与全局能力见[用户工作台设计](design/user-workspace.md)，接口与验收边界见[工程契约](engineering/user-workspace.md)。

## 配置跟人，工作归项目

偏好、系统运行参数、Agent 默认与角色配置、模型来源和凭证、出站网络、Agent 环境变量、安装库、Pi 基础配置和快捷解释配置只有一份设备权威，**不支持项目覆盖**。没有项目在线时仍可管理设备配置；设备设置不伪造跨项目调用历史或实际消费者。

- 修改设备配置影响各项目的后续读取／调用，不热切换在途调用快照。并发参数仍是每项目上限，不是整机总预算。
- 完整 Worker 显式运行参数仍优先，child 继承规则不变；保存设备设置不改写已有 Worker。
- 环境变量按设备通用 → 设备角色 → Worker 显式变量叠加，旧项目 env 不再参与运行。
- 模型来源只取设备库；旧项目连接即使同 ID 也不形成覆盖。缺设备配置时需要配置或显式迁移，不能回退到旧凭证。
- 安装与启用分开。共享资源使用明确路径；无项目时不能保存依赖项目 cwd 的相对启用路径。显式 Pi 默认模式使用执行机器 Pi 自己的配置，不混入 Lush 托管配置。
- 数据库、Worker、输入草稿、Git、会话、调用／解释历史及采样执行仍归项目。采样使用设备技术配置，Host 不代替项目运行采样或调度 Worker。

主题、阅读、排序和提醒等偏好也由设备后端保存；浏览器缓存不能自动覆盖权威值。项目名称、标签标题及辨识配色保留；配色在用户工作台的「项目」页管理，不构成项目主题覆盖，旧项目 theme 留存但不生效。当前选区、滚动、节点折叠和筛选属于工作状态，不跨项目同步。浏览器通知权限是客户端能力：设备提醒开关不替其它浏览器授予权限，权限被拒绝也不撤销设备开关。

## 本机 Prompt 补充与项目约定

设备私有补充为设备根 `agent/common.md` 和受支持角色 `.md`。缺文件不创建目录，也不回退旧项目 `.lush/agent/*.md`。`agent init --local` 由用户执行，使用共享写锁、只创建缺失文件；公开权限、外来所有者、链接和超限文件会被拒绝，不自动修复或覆盖。

```bash
bun run lush agent init --local worker  # 设备私有补充，可能影响所有项目
bun run lush agent init worker          # 项目可提交 .lush-agent/ 约定
```

`AGENTS.md` 与可提交 `.lush-agent/` 仍属代码库上下文，不传播到设备。管理角色与 Pi 默认模式的 Prompt 隔离不变。用户可通过 `agent prompt ROLE`、`agent env ROLE` 检查角色 Prompt 组合／脱敏环境来源，不代表某个 Worker 已冻结的调用快照；这些设备读取不向 Agent token 开放。

## 迁移旧项目

旧技术文件仅作显式迁移来源，不再活跃。未迁移的其它项目也不会继续形成覆盖。升级不会自动导入、删除或扩散旧配置；尤其不能未经确认把仓库专属 Prompt 传播到所有项目。

在设备设置的迁移入口选择已登记来源项目，先预检；来源后台必须在线。确认前结束该项目在途 Agent、解释、登录、网络查询、安装和 Git／合并操作。CLI 固定当前项目为来源，可用 `--project PATH` 显式选择，不接受任意来源文件路径。

迁移涵盖运行参数、Agent、网络、快捷解释、环境变量、托管来源及受支持的私有 Markdown 补充。保留 connection ID 和项目历史；不迁移数据库、Worker、会话、Git、AGENTS.md、`.lush-agent/`、其它项目或外部 Pi/Codex 凭证。安装库不物理搬迁，已配置资源路径归一到原项目绝对路径，原库保留。

不同目标内容、同 ID 不同凭证、已知重复 OAuth 凭证或不安全文件会阻止迁移，不静默覆盖。Markdown 同内容目标可复用，成功导入后旧原件和私有备份保留，但旧原件不再影响新调用；重复迁移不会自动复活已删除的设备补充。JSON、env 和凭证仍按发布后退役协议处理，不能把 Markdown 的保留规则套到 OAuth。

CLI 设置命令省略 scope 也选择设备；可选 `--scope device`，显式 project 已停用：

```bash
bun run lush config show
bun run lush config set concurrency 4
bun run lush agent show
bun run lush agent sources list
bun run lush agent packages list
bun run lush config migrate --json
# 核对项目、条目、所有项目影响、冲突与备份后，原样填入预检 revision：
bun run lush config migrate --confirm --revision REV --json
```

预检不会回显 Markdown 正文或凭证。revision 过期或 daemon 重启后必须重新预检。不要在命令行输入密钥，沿用私有来源文件／显式登录流程。

## 备份与中断

备份在来源项目 `.lush/device-migration/<uuid>/files/`，步骤记录为同级 `journal.json`，`current.json` 指向当前记录。它们含私有配置，勿提交或分享。

迁移先备份，再发布设备配置，最后退役普通源配置或记录 Markdown 原件保留。中断不自动重放；重新预检并确认才能按已核验的备份、内容与磁盘身份恢复。凭证交接未完成时源端认证读取／刷新会被阻止，防止 OAuth 双活。未知残留锁不会自动抢占，需用户核查对应进程与迁移记录；不要直接删除锁或复制 refresh token。

## 存储与部署

设备根为 `launcherStateDir(env)/shared`（通常 `~/.config/lush/shared`，显式 `LUSH_GLOBAL_CONFIG` 时在该根下）；项目 `.lush/` 和 `LUSH_HOME` 不变。私有目录 0700、文件 0600，不是加密保险箱或 Agent 沙箱。

合入并部署后，在安全空闲时更新各项目 daemon 和 Host；两端都要更新，不能只刷新旧 Host 页面。用 `bun run doctor` 与 `bun run lush host status` 分别检查代码身份。跨项目 Notice 的权威记录仍归来源后台，全局自动选择授权由各后台执行；读取设备设置／收件箱不会启动停止的项目。

备份、OAuth 与恢复细节见[设备迁移工程契约](engineering/device-settings.md)；全局自动化、收件箱与前端组合测试要求见[用户工作台契约](engineering/user-workspace.md#验证与交付)。
