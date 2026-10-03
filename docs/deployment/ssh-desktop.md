# 桌面通过 SSH 部署与打开服务器

适用于只有 SSH 入口、没有 GUI 的 Linux 服务器。Electron 在本地运行；项目、Git、Agent、Host、daemon 和 `.lush/` 都在服务器。本功能只管理连接与部署，不是远程编辑器、终端或文件同步。

## 首次连接

1. 本机准备系统 OpenSSH，配置 `~/.ssh/config` 的 Host 别名（Windows 通常为 `%USERPROFILE%\.ssh\config`）。先在终端执行 `ssh my-server true`，核对服务器指纹并准备密钥 / ssh-agent。桌面只支持已就绪的公钥认证，不输入或保存密码、私钥、解锁口令。
2. 打开 Lush 桌面连接页，在「通过 SSH 打开服务器」填写 `my-server`，点击「预检服务器」。首期需 Linux x64 / ARM64；远端需 shell、GNU tar/gzip、sha256sum 和基础 Unix 工具。私有 Bun 还需对应 CPU 与 Linux/glibc 运行条件，不保证任意发行版都兼容。
3. 核对目标、安装目录、Lush / Bun 版本、本地入口和执行步骤，点击「确认安装并连接」。可信客户端上传随发行提供的运行包，验证后原子安装到 SSH 用户目录；不从服务器下载脚本、不 sudo、不修改 PATH、防火墙或自启服务。
4. 工作窗口加载远端 Host。填写**远端项目目录**，Host 按需启动或连接该项目 daemon。项目需 Git 初始提交；Agent 和模型认证仍需在远端准备，连接成功不等于 Agent 已认证。

预检不安装远端文件、不启动服务或模型。连接记录只保存本地入口元数据；首次预检会为别名保留独立端口和身份。兼容的远端已有 Bun 可用于运行，随包私有 Bun 仍保留为备用。不安装 Electron 或 node_modules 到服务器。

已有手工部署的 Lush 不会被覆盖或强制接管；自动部署复用自己管理的匹配版本。只连接已有 HTTPS Host 或手工隧道时，仍可使用原来的「远程 Host」入口，见[远程桌面](remote-desktop.md)。

## 重连、取消与断开

- 从 SSH 连接记录重新预检并确认；匹配安装和 Host 会被复用，不重复安装。多个服务器使用不同端口与持久会话，SSH 窗口还按连接 ID / 别名隔离 Cookie。
- 改别名、取消、关闭连接页会作废本次安装授权并取消尚在进行的操作。安装已落地的版本可能保留，不能把取消当作回滚或停止远端服务。
- 「断开隧道」和退出桌面只回收本机自有 SSH 进程，不停止远端 Host / daemon / Worker。关闭一个工作窗口不会断开其它窗口使用的隧道。
- 运行中断线不会自动重发输入或其它写操作。重新连接后先读状态；目前没有自动重连隧道或后台推送。
- SSH 别名改指另一台机器 / 用户时，拒绝复用原身份和登录入口。应使用新别名重新连接，不通过删除记录、复用端口或跳过主机校验修复。

远端进程按需后台运行，不等于已安装开机自启。机器重启、会话管理策略或故障仍可能停止它；不能承诺持续在线。

## 状态与版本边界

```text
~/.local/share/lush/remote/
├── versions/<fingerprint>-linux-x64或linux-arm64/  Lush 源码与私有 Bun
├── profiles/<连接ID>/                            Host 配置缓存、绑定、状态和 host.log
└── uploads/                                     安装暂存
```

这些目录不是项目数据库；项目状态仍在各项目 `.lush/`。失败上传可能保留暂存文件，已存在但身份不符的版本目录不会被覆盖。profile 与版本 / origin 绑定，现有 Host 版本不兼容时拒绝自动重启；首期不提供一键升级或卸载。清理和停服务应先确认范围与活动工作，交给[Agent 指导](ssh-desktop-agent.md)。

## 常见问题

| 现象 | 处理 |
|---|---|
| 公钥或主机校验失败 | 先在终端核对指纹、登录 / 解锁密钥；不禁用安全检查 |
| 别名已有端口转发 | 给 Lush 使用不预设 LocalForward / RemoteForward / DynamicForward 的 SSH 别名 |
| 缺少目标架构运行包 | 使用含该架构产物的可信客户端，或按 Agent 指导构建；没有任意下载兜底 |
| 本地固定端口占用 | 释放该端口；不静默换端口或复用另一个服务器的身份 |
| 远端安装 / 版本拒绝 | 查看安装目录及 profile 的 `host.log`；不删 `.lush/`、强杀或覆盖版本 |
| SSH 记录损坏 | SSH 入口报错，但本地 / URL 连接仍可用；记录不会被静默重置 |

## 验证边界

自动测试覆盖模拟桌面、受控子进程、真实隔离 shell 安装及打包校验。可选真实回环 SSH 测试将生产桌面 IPC / 安装授权与 SSH manager 串联，用临时 sshd / 密钥 / HOME / Git 项目验证上传、私有 Bun、Host、项目 daemon 与重连，只有 Electron 窗口仍模拟；它不等于你的服务器、ARM64、实际 Electron 或 Windows 安装验收，也不调用模型。

[返回部署索引](README.md) · [交给 Agent 配置](ssh-desktop-agent.md) · [设计边界](../design/remote-ssh.md)
