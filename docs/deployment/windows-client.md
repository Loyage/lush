# Windows Web UI 与桌面客户端

本文面向 Windows 用户和安装包维护者，说明如何用浏览器或 Electron 操作远程 Linux / macOS Lush Host。Windows 仅运行前端，项目目录、Git、Agent、Host 与 lushd 都在远端；本次不提供 Windows 原生后台。桌面入口是 `src/ui/desktop/main.js`。

## 浏览器：无需安装客户端

1. 在远端按[部署指导](agent-guide.md#4-远程--公网访问)启动 Host，并配置认证、项目白名单和 HTTPS 反向代理。
2. 在 Windows 的现代 Edge、Chrome 或 Firefox 打开 Host 的 HTTPS 根地址，例如 `https://lush.example.com`。
3. 登录后选择远程项目；新增项目必须填写远程机器上的绝对目录，不是 `C:\...` 本地路径。

任务输入、执行记录、待决问卷、任务树和项目设置都使用远端提供的同一份 Web UI。浏览器不启动本机 Bun 或 daemon；需要调整 Agent 模型认证时，在远端配置。浏览器刷新或客户端关闭不停止远端任务。

## Electron：安装后直接连接

Windows x64 安装包内置 Electron，不要求用户安装 Bun、Node.js 或 Git。仅从你信任的构建来源下载安装器；当前流程默认不签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。应核对构建来源与校验和，不要全局关闭系统保护。

1. 运行 NSIS 安装器，按向导为当前用户安装 Lush；启动菜单入口打开连接页。
2. 填写 HTTPS Host 根地址，点击“打开远程窗口”；不接受带账号密码、项目路径或查询参数的地址。
3. 在远端页面登录并选择项目。通过“连接”菜单可并行打开多个 Host 或项目窗口。

Windows 的“打开本地窗口”和对应菜单项不可用，页面会解释原因；主进程也拒绝本地启动，不会因点击入口尝试运行 Bun。远程窗口不暴露本地目录选择器或文件读写能力。完整证书、登录隔离、最近连接、通知和故障边界见[远程桌面部署](remote-desktop.md)。

桌面连接与提醒元数据保存在 Electron userData（通常为 `%APPDATA%\Lush\desktop\`），不是项目数据库。卸载不意味着删除这些偏好或远端项目；“仅移除记录”不清除 Cookie。需要退出远端登录时使用该 Host 页面中的退出入口。

## SSH 隧道

不开放公网 Host 时，可先自行建立隧道（需要 Windows OpenSSH 客户端）：

```powershell
ssh -N -p 2222 -L 127.0.0.1:14318:127.0.0.1:4318 user@remote-machine
```

随后浏览器或 Electron 打开 `http://127.0.0.1:14318`。示例端口应按远端配置调整，必须保持隧道窗口运行。Electron 不代管 SSH、不保存密钥，也不绕过证书错误；不同远端应使用不同转发端口，避免误用共享登录会话。

## 构建与交付

安装包维护者在 Windows x64 开发机安装 Bun 1.4.2 与 Node.js 24（构建器使用 Node；CI 固定为 24.20.0），并检出仓库，执行：

```powershell
bun install --frozen-lockfile
bun run desktop:build:win
bun run desktop:verify:win
```

产物在 `node_modules/lush-desktop-build/dist/`：`Lush-<version>-windows-x64-setup.exe` 与 `SHA256SUMS.txt`。校验步骤核对 ASAR 资源白名单，并为安装器计算 SHA-256；`bun run desktop:stage:win` 仅准备资源，不能替代完整构建。安装包不应作为 `node_modules` 中的开发文件直接分发，应交付安装器与校验和。

开发源码入口仍是 `bun run desktop`，在 Windows 同样仅支持远程连接。构建依赖只用于生成安装包，不是安装后运行时依赖。构建 staging 使用白名单，只包含桌面连接壳与所需静态帮助资源，不携带 `.lush`、Agent 凭证、项目代码或本地后台。

仓库 `.github/workflows/windows-desktop.yml` 支持手动触发，以及相关文件的 PR / main 更新触发；成功后从该次 GitHub Actions 下载构建 artifact（保留 14 天），解压取得安装器及校验和。默认只上传 artifact，不自动创建公开 Release；维护者验证后可手工发布。锁文件固定依赖，构建需联网下载 Electron 和 NSIS 资源。生产发行应另配置代码签名证书和受保护的 CI 密钥；当前不包含签名证书或自动更新服务。

## 发布前验证

自动测试覆盖模拟 Windows 的菜单/IPC 拒绝、本地按钮禁用、远程失败后显式重试、沙箱能力与构建资源闭包；模拟测试不等同于真实 Windows 桌面验收。安装包构建由 Windows CI 执行，本地 Linux 测试不能证明安装器能安装。

每次发布至少在 Windows 10 / 11 x64 上检查：

- 安装、启动、重启后 Cookie 与最近连接、卸载；确认无本机 Bun 仍可连接。
- HTTPS 登录、证书失败、SSH 隧道、远程项目路径与多窗口隔离。
- 中文输入、键盘操作、缩放、执行记录与待决问卷；系统通知默认关闭，开启后点击回到来源窗口。
- 断线后输入保留与显式重连，关闭桌面后远端 Agent 继续运行；不能自动重发写操作。

本功能不提供 Windows 原生 Host / daemon、自动 SSH 隧道、远程文件编辑器或交互终端。界面版本由远端 Host 决定；前端更新不替代远端 Host 与 daemon 的分别升级。
