# macOS 桌面客户端

本文面向希望在 Mac 上打开本地项目或远程 Linux 项目的用户。macOS 客户端有 x64 / ARM64 两种测试产物，携带本机私有 Bun 与后台，以及 Linux 双架构 SSH 运行包；构建与验收交给[桌面构建 Agent 指导](desktop-build-agent.md)。当前只提供 CI artifact 接缝，不是已签名、公证或公开发布的应用。

## 安装测试产物

1. 从你认可的仓库与 CI 运行取得对应 Mac 架构的 `Lush-<version>-macos-<arch>.zip` 和 `SHA256SUMS.txt`。Apple Silicon 使用 ARM64，Intel 使用 x64。
2. 对照可信来源的 SHA-256 校验 ZIP：

```bash
shasum -a 256 Lush-<version>-macos-<arch>.zip
```

校验和不能替代对产物来源的信任。解压后取得 `Lush.app`；复制到应用目录等安装操作由用户确认，不覆盖未知旧安装。

3. 打开应用。当前产物未签名、未公证，Gatekeeper 可能阻止打开；先核对来源与系统提示，不关闭系统保护。测试产物与正式发布验收分开。

## 本地与远程

- **打开本地窗口**：使用应用携带的私有 Bun 启动临时回环 Host，不要求系统 PATH 中有 Bun。项目、Git、Agent 和 `.lush/` 位于本机；开发仍需本机 Git、项目环境和已认证 Pi / Codex，不会自动安装或复制认证。
- **通过 SSH 打开服务器**：复用系统 OpenSSH 配置与密钥，使用随客户端携带的 Linux 包，首次安装必须确认计划。无需在 Mac 构建或执行 Linux Bun。完整步骤见[桌面 SSH 部署](ssh-desktop.md)。
- **远程 Host**：连接已有 HTTPS Host，或先手工建立 SSH 隧道再填写回环 HTTP 根地址。详见[远程桌面](remote-desktop.md)。远端项目路径属于服务器，不是 Mac 路径。

本地和多个远端可同时打开。退出应用只停止自己持有的本地临时 Host 和 SSH 隧道，不停止项目 daemon / Worker 或远端服务。不自动接管或升级已有后台；版本不匹配时先核对活动工作。

## 源码启动与验收边界

`bun run desktop` 的源码本地模式仍使用开发者提供的 Bun；它不等同于安装包内置运行时。SSH 自动部署缺包时，预检展示匹配源码身份的固定 GitHub Release，用户确认安装后才自动下载并校验；启动和预检不下载。离线 / 手工准备仍可显式取得同检出的 Linux CI 产物并执行 `bun run desktop:prepare DIR`，见[开发产物准备](desktop-build-agent.md#2-mac--windows-源码开发准备)。

CI 分别构建原生架构、校验 ASAR / resources 并烟测 Bun / Host；真实 Electron、安装 / Gatekeeper、项目选择、中文输入、通知、跨机器 SSH 和模型调用须单独验收。工作流尚未运行、模拟窗口测试或文件生成不能被描述为已可发布。

[返回部署索引](README.md) · [交给 Agent 构建与验证](desktop-build-agent.md)
