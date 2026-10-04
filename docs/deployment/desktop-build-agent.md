# Agent 指导：跨平台桌面构建与开发产物准备

本章面向构建客户端或准备源码开发环境的 Agent。Mac / Windows 的 SSH 客户端必须携带同检出生成的 Linux x64 / ARM64 运行包；macOS 客户端另携带原生私有 Bun 与后台，Windows 仅运行 Electron。用户说明见[macOS 客户端](macos-client.md)、[Windows 客户端](windows-client.md)和[桌面 SSH 部署](ssh-desktop.md)。

## 1. 可信产物链

- `.github/workflows/remote-payload.yml` 在原生 Linux x64 / ARM64 runner 使用固定 Bun 1.4.2 构建、烟测并汇总 `lush-remote-payload` artifact。
- Windows / macOS 桌面工作流复用该工作流的**同一源码检出**，显式导入产物，检查架构完整性、归档安全、文件哈希及源码指纹后打包。
- macOS 在原生 x64 / ARM64 runner 分别打包本机私有 Bun 和白名单后台源码；拒绝非 Mach-O、错架构、私有 dylib / RPATH、错误版本，不携带 Nix `/nix/store` 依赖。
- afterPack 和独立 verify 比较实际 ASAR / resources 与已审核 staged 字节；macOS 还执行实际包装内 Bun 的版本 / 身份 / runtime imports 烟测。CI 的可选原生测试用临时 HOME 启动与停止私有 Host，不连接用户项目。
- 桌面安装器仍只有 14 天 artifact，无签名、公证或自动更新。独立 `publish-remote-payload.yml` 仅由本仓库正式 `vX.Y.Z` tag 触发，校验版本与 main 历史后复用原生构建，再把同 tag 提交 / 同运行验证的包发布为固定身份 `payload-v<version>-<fingerprint>` GitHub prerelease（不设为 latest）。普通 push、PR、手动 / 复用构建只生成 artifact；已有匹配 Release 不覆盖。工作流存在不等于已发布，安装和真实桌面行为须另验收。

哈希与源码指纹只证明完整性和匹配，不能证明发布者可信。只能使用用户认可仓库、分支 / 提交和 CI 运行提供的产物；不从远端服务器获取“可信 manifest”，不默默选最新成功运行，不执行网络安装脚本。SSH 主机信任、首次部署授权和模型认证仍按[SSH 指导](ssh-desktop-agent.md)处理。

## 2. Mac / Windows 源码开发准备

默认 `bun run desktop` 只检查产物准备状态并启动 Electron，不在启动或 SSH 预检时下载、跨编译或安装远端。缺包 / 旧指纹时，连接页会展示与当前源码身份匹配的固定 GitHub Release 计划；用户确认安装后才下载目标架构包，校验后缓存并上传。缓存只写桌面 userData，不替换检出内的手工产物。本地与「远程 Host」入口仍可使用，未验证包仍拒绝安装。未发布源码没有对应 Release 时会报缺发布，不回退旧包；本机已准备的同源码包仍优先使用，完全不依赖 Release。

已发布客户端可自动下载；以下步骤也用于日常开发，不必打发布 tag。离线准备、GitHub 不可达及桌面打包沿用同一入口（导入 / 打包仍要求双架构 resources）：

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

仓库 `.gitattributes` 固定运行时源码为 LF，新 Windows / macOS / Linux 检出应具有相同字节与指纹。若已有 Windows 工作区仍含 CRLF，先保留自己的修改，再以 LF 保存相关源码或使用新的干净检出；不要用 reset / clean 覆盖工作区，也不要绕过指纹校验。

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

## 5. 正式发布 tag

先把需要发布的代码提交到 main，确认 `package.json` 版本为 `X.Y.Z`，再推送对应的带说明 tag。例如当前版本为 `0.2.0`：

```bash
git push origin main
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

仅推代码不会创建 Release。正式 tag 必须是无前导零的 `vX.Y.Z`，与 package.json 完全匹配，且提交在 main 历史中；`-rc` / `+build` 等 tag 不发布。tag 固定已提交的代码，不包含工作区修改；发新版本须先修改版本并提交，不移动或覆盖已发布 tag。

tag 工作流重新构建 / 烟测双架构包，成功后创建一份用于下载的固定身份 payload Release（标题包含正式版本），不额外创建一份 `vX.Y.Z` 同名 Release。下载地址仍以源码指纹定位，不取 latest，也不自动发布桌面安装器。

日常开发继续从 main / PR / 手动 CI 下载同检出 artifact，或在原生 Linux 构建本地 payload，再按[源码准备](#2-mac--windows-源码开发准备)导入。开发代码不需要修改版本或发布 tag；有未提交源码修改时必须用完全相同的修改后源码重建，两边指纹不匹配仍拒绝安装。

[返回部署索引](README.md) · [macOS 用户说明](macos-client.md) · [SSH 指导](ssh-desktop-agent.md)
