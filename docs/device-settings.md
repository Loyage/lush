# 设备共享设置

系统运行参数、Agent 默认、模型来源、网络、Agent 环境变量、安装库和快捷解释配置可供**运行 Lush 的同一机器、同一系统用户**的项目复用。远端项目使用服务器的设置，不是浏览器所在电脑的设置；不自动跨机器同步凭证。

## 编辑范围

设置默认显示「设备共享」，也可切到「本项目覆盖」。未打开项目时仍可管理设备配置，但不能查看项目历史、实际消费者或发起快捷解释调用。

- 运行参数逐键继承；项目清除一个键后回到设备默认。
- Agent、网络和快捷解释按完整文档覆盖；清除项目覆盖后继承设备文档。
- 环境变量按设备通用 → 设备角色 → 项目通用 → 项目角色 → Worker 显式变量叠加。项目环境编辑显示有效值，**整表保存会把未改动的继承值也保存为项目变量**；删除本地变量后同名设备值仍可继承。
- Worker 已有的完整运行覆盖优先，保存共享设置不改写它，也不打断在途调用。
- 模型来源的项目视图包含共享与旧本地连接，同 ID 旧本地优先；设备视图只管理共享连接。不会按账号名字合并。
- 安装与启用分开。共享资源使用明确路径；无项目时不能保存依赖某项目 cwd 的相对启用路径。Pi 默认模式仍遵循执行机器 Pi 自己的配置，不导入外部认证。

共享采样默认由各项目独立执行，继承项目在后续读取来源或准备调用时刷新调度；旧项目来源文件的采样/保留策略可继续覆盖。设备管理不会以较短共享期限清理仍受项目策略保护的历史，无项目 Host 不运行采样。

修改共享值影响继承它的项目的后续调用；已有项目覆盖仍有效。切到项目视图查看实际继承和覆盖来源。旧来源尚未迁移时，删除共享连接不会删除其他项目自己的私有连接。

## 迁移已有项目

打开作为起点的项目，在「设置 → 系统」预检「迁移当前项目设置到设备共享」。先结束该项目在途 Agent、解释、登录、网络查询、资源安装和 Git/合并操作，再确认预检范围。

迁移仅导入当前项目：运行参数、Agent、网络、快捷解释、环境变量和托管模型来源。保留 connection ID 和项目历史；不迁移数据库、Worker、会话、Git、AGENTS.md、其他项目或外部 Pi/Codex 凭证。安装库不物理搬迁，已配置资源路径归一为原项目绝对路径，原库保留。

存在不同的共享文档、同 ID 不同凭证、已知重复 OAuth 凭证或不安全文件时会阻止迁移，不静默覆盖。成功后源项目的活跃配置退役并改为继承；其他旧项目继续保留覆盖。

CLI 默认仍选 project，以兼容旧命令；显式管理共享值：

```bash
bun run lush config show --scope device
bun run lush config set concurrency 4 --scope device
bun run lush agent show --scope device
bun run lush agent sources list --scope device
bun run lush agent packages list --scope device
bun run lush config migrate --json
# 查看预检后，将其 revision 原样填入：
bun run lush config migrate --confirm --revision REV --json
```

预检 revision 过期或 daemon 重启后需重新预检。不要在命令行输入密钥；沿用来源录入文件/登录流程。

## 备份与中断

迁移备份在项目 `.lush/device-migration/<uuid>/files/`，步骤记录在同级 `journal.json`，`current.json` 指向当前记录。它们含私有配置，勿提交或分享。

迁移先备份，再发布共享配置，最后退役源覆盖。中断不自动重放；重新预检并确认才能按已核验的备份和磁盘事实恢复。凭证交接未完成时源端认证读取/刷新会被阻止，防止 OAuth 双活。未知残留锁不会自动抢占，需用户核查对应进程与迁移记录；不要直接删除锁或复制 refresh token。

## 存储与生效

设备配置在 `launcherStateDir(env)/shared`（通常 `~/.config/lush/shared`，显式 `LUSH_GLOBAL_CONFIG` 时在该根下）；项目 `.lush/` 和 `LUSH_HOME` 不变。目录 0700、秘密文件 0600，不是加密保险箱或 Agent 沙箱。主题等浏览器偏好不因此成为后台设备配置。

合入并部署后，用户在安全空闲时更新项目 daemon 和 Host；两端都要更新，不能只刷新旧 Host 页面。用 `bun run doctor` 与 `bun run lush host status` 分别检查身份。工程边界与测试见[设备设置契约](engineering/device-settings.md)。
