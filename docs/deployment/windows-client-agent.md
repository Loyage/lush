# Agent 指导：配置 Windows 客户端

本文交给帮助 Windows 用户连接 Linux/macOS Lush Host 的 AI coding agent。用户版的方案原因、使用限制与发布验收清单见[Windows 客户端](windows-client.md)。本篇不安装 Windows 原生后台；本机后台需求另按[WSL2 Agent 指导](windows-wsl2-agent.md)处理。

## 1. 确认最小使用方式

先确认用户选择浏览器还是 Electron、已有 Host 根地址、HTTPS / SSH 访问方式、Windows 版本和已有客户端。只连接现有 Host 不需要在 Windows 安装 Bun、Node.js、Git 或 Pi/Codex。

没有后台地址时先确认后台在哪里：远程机器按[Host Agent 指导](remote-host-agent.md)部署，同机 WSL 按 WSL2 指导部署。不要猜地址或把 `C:\...` 当成远端项目路径。

安装器、系统组件、SSH、证书变更均需用户同意；不关闭 SmartScreen、防火墙或证书校验。不把连接步骤升级成后台配置权限，不收集模型凭证、登录密码或 Cookie。

## 2. 浏览器路线

先使用已有的现代 Edge / Chrome / Firefox 打开用户确认的 HTTPS Host 根地址。SSH 用户先按[客户端隧道说明](windows-client.md#ssh-隧道)核对主机身份并建立回环转发，再打开相应回环 HTTP 地址。

让用户在可信的 Host 登录页认证，选择远端现存项目，读取项目状态。无需安装客户端；不要为了验证连接创建 Worker 或调用模型。

没有 Windows 浏览器操作权限时，请用户检查并反馈，不用 Linux 上的 HTTP 成功替代客户端验收。HTTPS 错误应修复证书 / 地址，不提供跳过检查的链接或命令。

## 3. Electron 安装路线

1. 从用户认可的发布来源取得 Windows x64 安装器与 `SHA256SUMS.txt`。校验和用于核对文件完整性，不能代替对发布来源的信任。
2. 在 Windows PowerShell 校验安装器文件，和可信来源的摘要比较：

```powershell
# 将 <version> 换成实际版本，或改为下载文件的实际路径。
Get-FileHash -Algorithm SHA256 -LiteralPath '.\Lush-<version>-windows-x64-setup.exe'
```

3. 当前安装包默认未签名，出现未知发布者 / SmartScreen 时向用户说明风险，让用户决定是否继续，不替用户绕过系统保护。
4. 经用户同意运行 NSIS 安装器，使用当前用户安装；启动菜单打开 Lush，在连接页填写 Host 根地址打开远程窗口。
5. 按[桌面远程 Agent 指导](remote-desktop-agent.md#3-打开连接并验证)验收登录、项目身份、重启后的偏好、多窗口与断线。Windows 的“本地窗口”禁用是预期，不启用隐藏开关或尝试启动本机 Bun 后台。

内置 SSH 安装 / 接入按[SSH Agent 指导](ssh-desktop-agent.md)执行；手工路线需保持隧道运行。Electron 不保存密钥，也不自动重连。卸载客户端不停止远端 Worker；不以删除 `%APPDATA%\Lush\desktop\` 作为默认排错方式。

## 4. 仅维护者：构建与交付安装包

普通用户使用安装器，无需此节。只有用户明确委托构建时，在真实 Windows x64 开发机使用可信仓库检出，按目标机环境约定准备 Bun 1.4.2 与 Node.js 24（CI 固定为 24.20.0），在源码目录执行：

```powershell
bun --version
node --version
bun install --frozen-lockfile
bun run desktop:build:win
bun run desktop:verify:win
```

构建前还必须把同一可信检出的原生 Linux x64 / ARM64 运行包汇总到 `node_modules/lush-remote-build/payload/`，通过 `bun run desktop:prepare DIR` 显式导入；来源与步骤见[跨平台构建指导](desktop-build-agent.md#2-mac--windows-源码开发准备)。缺包或身份不匹配会拒绝构建，Windows 不执行 Linux Bun。CI 自动复用原生运行包工作流，手工构建不能跳过这一步。

构建需要联网下载 Electron / NSIS。不得用 Linux staging 或模拟 Windows 测试声称完成 Windows 安装器构建。

产物在 `node_modules/lush-desktop-build/dist/`：交付 `Lush-<version>-windows-x64-setup.exe` 与 `SHA256SUMS.txt`。校验脚本检查 ASAR 资源白名单并生成摘要；`desktop:stage:win` 只准备资源，不能替代完整构建或安装验收。

仓库 `.github/workflows/windows-desktop.yml` 可手动或由相关 PR/main 更新触发，artifact 保留 14 天；默认不创建公开 Release。无本机 Windows 构建能力时，可在用户允许后使用 Windows CI，并报告运行与 artifact 来源，不能把尚未运行的工作流当成功证据。

默认不含签名或自动更新；用户需要签名 / 发布时，先确认证书、权限和交付范围，不把证书或 CI 密钥写入仓库，不自动发布。打包必须使用白名单，不能携带 `.lush`、项目代码或 Agent 凭证。

## 5. 验收与交付

按[用户版发布前清单](windows-client.md#发布前验证)在实际 Windows 验证；只做日常连接时报告与用户需求有关的项，构建发布时需完整验收。付费模型调用须另外同意，模拟 Electron 测试不替代真实安装、证书、中文输入和系统通知检查。

失败保留错误与完整日志，停止本轮未知副作用操作；断线不自动重发写请求。交付 Windows / 客户端版本、可信来源与摘要、Host 地址、实际验证与缺项、打开 / 退出步骤；维护者另交构建命令、日志与产物位置。不得包含密码、Cookie 或模型凭证。

---

[← 用户说明](windows-client.md) · [返回部署索引](README.md)
