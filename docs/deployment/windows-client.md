# Windows Web UI 与桌面客户端

本文面向 Windows 用户，解释浏览器 / Electron 的选择和安全边界；配置与维护者构建命令交给[Windows 客户端 Agent 指导](windows-client-agent.md)。客户端操作远程 Linux / macOS Lush Host。Windows 原生侧仅运行前端，不提供原生后台；项目目录、Git、Agent、Host 与 lushd 都在 Linux / macOS 后台侧。本文介绍远程机器连接；若要在同一台 Windows 上运行后台，见[WSL2 用户说明](windows-wsl2.md)与[Agent 配置指导](windows-wsl2-agent.md)。桌面入口是 `src/ui/desktop/main.js`。

## 为什么 Windows 客户端不带后台

客户端只负责连接与展示，项目、Git、编码 Agent 和凭证留在 Linux/macOS 后台。这样 Windows 用户不用重复配置开发工具，也不把已有 Unix 后台的权限和进程管理机制强行搬到 Windows。

浏览器是最小使用方式；Electron 主要提供独立窗口与桌面连接 / 通知体验。安装包内置 Electron 的代价是需要可信的构建来源与安装验收，它不增加 Windows 原生执行项目的能力。需要在同机开发时选择 WSL2，原因见对应[用户说明](windows-wsl2.md)。

## 浏览器：无需安装客户端

1. 在远端按[远程 Host 指导](remote-host-agent.md)启动 Host，并配置认证、项目白名单和 HTTPS 反向代理。
2. 在 Windows 的现代 Edge、Chrome 或 Firefox 打开 Host 的 HTTPS 根地址，例如 `https://lush.example.com`。
3. 登录后选择远程项目；新增项目必须填写远程机器上的绝对目录，不是 `C:\...` 本地路径。

Worker输入、执行记录、待决问卷、Worker树和项目设置都使用远端提供的同一份 Web UI。浏览器不启动本机 Bun 或 daemon；需要调整 Agent 模型认证时，在远端配置。浏览器刷新或客户端关闭不停止远端Worker。

## Electron：安装后直接连接

Windows x64 安装包内置 Electron，不要求用户安装 Bun、Node.js 或 Git；使用内置 SSH 入口则需要系统 OpenSSH。仅从你信任的构建来源下载安装器；当前流程默认不签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。应核对构建来源与校验和，不要全局关闭系统保护。

1. 运行 NSIS 安装器，按向导为当前用户安装 Lush；启动菜单入口打开连接页。
2. SSH-only Linux 使用[内置 SSH 预检与部署](ssh-desktop.md)；已有 HTTPS Host 则填写根地址，点击“打开远程窗口”，不接受带账号密码、项目路径或查询参数的地址。
3. 在远端页面登录并选择项目。通过“连接”菜单可并行打开多个 Host 或项目窗口。

Windows 的“打开本地窗口”和对应菜单项不可用，页面会解释原因；主进程也拒绝本地启动，不会因点击入口尝试运行 Bun。远程窗口不暴露本地目录选择器或文件读写能力。完整证书、登录隔离、最近连接、通知和故障边界见[远程桌面部署](remote-desktop.md)。

桌面连接与提醒元数据保存在 Electron userData（通常为 `%APPDATA%\Lush\desktop\`），不是项目数据库。卸载不意味着删除这些偏好或远端项目；“仅移除记录”不清除 Cookie。需要退出远端登录时使用该 Host 页面中的退出入口。

## SSH 隧道

不开放公网 Host 时，优先使用[内置 SSH 入口](ssh-desktop.md)，复用系统密钥 / ssh-agent、显式确认用户目录部署。仍可自行建立隧道（需要 Windows OpenSSH 客户端）：

```powershell
ssh -N -p 2222 -L 127.0.0.1:4318:127.0.0.1:4318 user@remote-machine
```

随后浏览器或 Electron 打开 `http://127.0.0.1:4318`。若本地需要不同端口，先按[Host 指导](remote-host-agent.md#2-ssh-隧道路线)声明 SSH origin。手工隧道须保持窗口运行，Electron 不接管它；内置入口仅管理自有隧道，不保存密钥或绕过证书错误。不同远端使用不同端口，避免误用登录会话。

## 构建与交付

普通用户只需可信来源的安装器与校验和，不需要源码构建环境。维护者的 Windows 环境版本、构建 / 校验命令、CI 与产物位置统一见[Agent 构建指导](windows-client-agent.md#4-仅维护者构建与交付安装包)。

构建使用资源白名单，交付桌面连接壳、帮助资源及两架构可信 Linux 运行包；它们用于远端部署，不在 Windows 执行。不携带 `.lush`、Agent 凭证、用户项目代码或 Windows 本地后台。这既减少安装内容，也避免把开发机数据带给用户。

源码开发入口仍是 `bun run desktop`，Windows 同样仅支持远程连接。构建依赖不等于安装后运行时依赖；Linux staging 和模拟测试不能证明 Windows 安装器可用。当前默认不含签名与自动更新，正式发行需另外管理证书与发布权限，不要求普通用户调整系统保护。

## 发布前验证

自动测试覆盖模拟 Windows 的菜单/IPC 拒绝、本地按钮禁用、远程失败后显式重试、沙箱能力与构建资源闭包；模拟测试不等同于真实 Windows 桌面验收。安装包构建由 Windows CI 执行，本地 Linux 测试不能证明安装器能安装。

每次发布至少在 Windows 10 / 11 x64 上检查：

- 安装、启动、重启后 Cookie 与最近连接、卸载；确认无本机 Bun 仍可连接。
- HTTPS 登录、证书失败、内置 SSH 预检 / 安装 / 取消 / 重连与手工隧道、项目路径和多窗口隔离。
- 中文输入、键盘操作、缩放、执行记录与待决问卷；系统通知默认关闭，开启后点击回到来源窗口。
- 断线后输入保留与显式重连，关闭桌面后远端 Agent 继续运行；不能自动重发写操作。

本功能不提供 Windows 原生 Host / daemon、自动隧道重连、远程文件编辑器或交互终端。界面版本由远端 Host 决定；前端更新不替代远端 Host 与 daemon 的分别升级。

---

[返回部署索引](README.md) · [交给 Agent 配置 →](windows-client-agent.md)
