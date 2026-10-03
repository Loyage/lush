# Agent 指导：跨平台桌面构建与开发产物准备

本章面向构建客户端或准备源码开发环境的 Agent。Mac / Windows 的 SSH 客户端必须携带同检出生成的 Linux x64 / ARM64 运行包；macOS 客户端另携带原生私有 Bun 与后台，Windows 仅运行 Electron。用户说明见[macOS 客户端](macos-client.md)、[Windows 客户端](windows-client.md)和[桌面 SSH 部署](ssh-desktop.md)。

## 1. 可信产物链

- `.github/workflows/remote-payload.yml` 在原生 Linux x64 / ARM64 runner 使用固定 Bun 1.4.2 构建、烟测并汇总 `lush-remote-payload` artifact。
- Windows / macOS 桌面工作流复用该工作流的**同一源码检出**，显式导入产物，检查架构完整性、归档安全、文件哈希及源码指纹后打包。
- macOS 在原生 x64 / ARM64 runner 分别打包本机私有 Bun 和白名单后台源码；拒绝非 Mach-O、错架构、私有 dylib / RPATH、错误版本，不携带 Nix `/nix/store` 依赖。
- afterPack 和独立 verify 比较实际 ASAR / resources 与已审核 staged 字节；macOS 还执行实际包装内 Bun 的版本 / 身份 / runtime imports 烟测。CI 的可选原生测试用临时 HOME 启动与停止私有 Host，不连接用户项目。
- 产物只有 artifact，保留 14 天，无 Release、签名、公证或自动更新。工作流存在不等于已经运行成功；安装和真实桌面行为须另验收。

哈希与源码指纹只证明完整性和匹配，不能证明发布者可信。只能使用用户认可仓库、分支 / 提交和 CI 运行提供的产物；不从远端服务器获取“可信 manifest”，不默默选最新成功运行，不执行网络安装脚本。SSH 主机信任、首次部署授权和模型认证仍按[SSH 指导](ssh-desktop-agent.md)处理。

## 2. Mac / Windows 源码开发准备

默认 `bun run desktop` 只检查产物准备状态并启动 Electron，不联网下载、跨编译或自动安装远端。缺包 / 旧指纹时明确警告，本地与「远程 Host」入口仍可使用；SSH 自动部署仍拒绝未验证的包。

1. 将需要运行的可信源码提交用于上述 CI（触发远程 CI / 推送需用户授权），或按[原生构建指导](ssh-desktop-agent.md#源码开发准备运行包)自行构建并汇总。
2. 在该 CI 运行下载 `lush-remote-payload`，解压到一个独立目录。目录根应只有 `manifest.json` 和两份 `lush-remote-linux-*.tar.gz`，不要把 ZIP 本身或多层 artifact 外目录传给命令。
3. 在与产物对应的源码目录执行：

```bash
bun run desktop:prepare /absolute/path/to/unzipped-payload
bun run desktop
```

在 PowerShell 可使用带引号的 Windows 路径：

```powershell
bun run desktop:prepare 'C:\build-inputs\lush-remote-payload'
bun run desktop
```

只写入 `node_modules/lush-remote-build/payload/`，不修改 `.lush/` 或服务器。不执行 Linux Bun。两份架构缺项、哈希错误、额外文件、链接或不同源码身份均拒绝。macOS 的 `/tmp` / `/var` 可能是系统符号链接；严格构建输入使用其真实路径，不为便利放宽路径检查。

源码改变后，旧产物不能冒充当前检出。取得新检出的可信 CI 包后，只有用户明确同意替换自己的旧生成物才执行：

```bash
bun run desktop:prepare /absolute/path/to/new-payload --replace
```

先完整校验新输入，再替换指定生成目录；失败保留旧目录。未提交修改改变指纹时，需要从同一修改后的源码重新构建，不绕过校验。

## 3. macOS 原生构建

在对应架构的可信 macOS 检出准备固定开发依赖、Node.js 24（CI 为 24.20.0）与可移植 Bun 1.4.2，先执行上述 Linux 产物准备步骤。仅安装获用户批准的开发依赖，不改变机器默认包管理策略。

```bash
bun run desktop:build:mac --bun /absolute/path/to/trusted-portable-bun
bun run desktop:verify:mac
```

构建默认只生成本机架构，拒绝跨架构假验收；可显式传 `--arch x64` / `--arch arm64`。`desktop:stage:mac --bun PATH` 只准备资源，不代表安装包或 Electron 已验证。

产物在 `node_modules/lush-desktop-build/dist/`：`Lush-<version>-macos-<arch>.zip` 与 `SHA256SUMS.txt`。ZIP 内的 `Lush.app` 不需要系统 Bun；`Contents/Resources/local-runtime/` 提供本机后台，`remote-payload/` 提供授权 Linux SSH 部署。不会包含项目、凭证或后台 node_modules，也不会自动安装 Git / Pi / Codex。

可显式验证真实私有运行时与隔离 Host：

```bash
LUSH_MAC_TEST_BUN=/absolute/path/to/trusted-portable-bun \
  bun run test:serial test/packaging/desktop-local-runtime.test.js
```

`.github/workflows/macos-desktop.yml` 提供原生双架构测试 ZIP；未签名、未公证，Gatekeeper 可能阻止打开。让用户决定是否信任该测试产物，不关闭系统保护或批量移除 quarantine。

## 4. Windows 与交付验收

Windows x64 NSIS 构建命令及安装检查继续见[Windows 维护者指导](windows-client-agent.md#4-仅维护者构建与交付安装包)。Windows 不执行 Linux Bun，也不携带 macOS 本地运行时。

```bash
bun run test:packaging
bun run docs:check
```

交付报告分别列出：源码身份、CI 运行 / artifact 来源、目标架构、实际构建与校验和、原生 Bun / Host 烟测、真实 Electron / 安装、跨机器 SSH、模型调用。没有目标机器权限或可信运行时的项目标记未验证；不把静态 ELF/Mach-O fixture、ASAR 打包测试或 HTTP 成功当作完整桌面验收。默认不连接用户项目、不调用模型、不重启现有 daemon / Host。

[返回部署索引](README.md) · [macOS 用户说明](macos-client.md) · [SSH 指导](ssh-desktop-agent.md)
