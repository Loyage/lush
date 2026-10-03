# Agent 指导：桌面 SSH 接入与运行包

用户行为与限制见[桌面 SSH 部署](ssh-desktop.md)。只操作用户批准的目标机器 / 目录，先检查现有环境，不默认接管服务、安装系统软件、更新已有版本或调用模型。

## 客户端与服务器

- 客户端需 Electron 与系统 OpenSSH。首期仅已配置公钥 / ssh-agent，主机身份须由用户在终端核对；不关闭 StrictHostKeyChecking、不读出私钥、不保存密码。
- 远端需 Linux x64 / ARM64、兼容的 CPU / glibc、shell、GNU tar/gzip、sha256sum、base64、stat、id、uname、head、tr、mktemp 等工具。Git 和已认证 Pi/Codex 是开发前置，不是连接成功的证据。
- SSH 别名不得预设端口转发。ProxyJump / ProxyCommand 沿用用户可信的系统配置，不代为修改全局 SSH 文件。
- 本地连接记录在 Electron userData 的 `ssh-connections.json`，项目数据库留在远端项目。SSH 记录损坏时保留文件与错误，不重置记录或复用旧端口。

按用户版顺序预检、展示计划、显式确认、打开项目。取消安装后先检查已落地状态，不重放结果未知的步骤。没有实际 GUI / 服务器权限时明确交付未验证项。

## 源码开发准备运行包

**Mac / Windows 不直接构建 Linux 包。** 正常 SSH 连接可在用户确认安装计划后自动下载 `Loyage/lush` 中匹配客户端版本 / 源码指纹的固定 Release，严格校验后缓存并上传；启动和预检不下载。本地 / URL 入口不依赖 Linux 运行包。日常开发、离线准备及打包仍可使用可信同源码的本地构建包或 CI 的 `lush-remote-payload`，执行 `bun run desktop:prepare DIR`，无需发布 tag 或联网；替换自己的旧产物须显式 `--replace`。来源信任、指纹匹配与双平台打包步骤统一见[桌面构建与开发准备](desktop-build-agent.md)。

在可信 Lush 检出中，通过原生 Linux 构建目标架构。运行包只使用固定版本可移植 Bun 1.4.2；Nix-patched ELF 的 `/nix/store` loader / RPATH 会被拒绝，不尝试修改 Nix 环境或把它当成通用运行时。

```bash
bun run remote:build --bun /absolute/path/to/trusted-portable-bun
bun run remote:verify --smoke
bun run desktop
```

可移植二进制应来自可信、固定哈希的来源；这些命令不下载或安装运行时。默认输出 `node_modules/lush-remote-build/payload/`，开发连接页从该目录读取。单机可以仅准备本机架构；连接其它架构缺包时必须报缺项。源码变化后从新输出目录重建，再明确替换自己的旧生成物，不能覆盖不同身份的产物。

汇总两个同一检出生成的目录：

```bash
bun run remote:merge /path/to/x64-payload /path/to/arm64-payload --out /path/to/combined-payload
bun run remote:verify /path/to/combined-payload
```

Windows 与 macOS 打包均需将两架构产物放在默认目录。构建链验证源码身份、哈希、ELF、ustar、完整架构及实际包装字节，然后将它们放在独立 `resources/remote-payload/`；Windows 不执行 Linux Bun。安装器因此增加两份压缩运行包的体积，而不是增加一套本地后台。维护者构建见[Windows Agent 指导](windows-client-agent.md#4-仅维护者构建与交付安装包)。

CI 的 `remote-payload.yml` 在原生 x64 / ARM64 runner 构建与烟测；`windows-desktop.yml` / `macos-desktop.yml` 复用并下载合并产物，显式 `desktop:prepare` 校验同检出身份。桌面构建仍仅上传 artifact；独立 `publish-remote-payload.yml` 只在正式版本 tag 的校验及原生构建成功后发布固定身份运行包 Release；普通 push、PR 和手动构建只有 artifact，发布步骤见[正式发布 tag](desktop-build-agent.md#5-正式发布-tag)，不设置客户端自动更新。不把工作流存在当作已执行成功。

## 日志与停止范围

远端安装与 profile 目录由预检计划提供，`profiles/<id>/host.log` 为入口日志。项目 daemon 日志在对应 `<project>/.lush/daemon.log`。不得因为入口错误删除项目状态。

桌面「断开隧道」不是停止后台。只有用户确认没有需要保留的活动工作后，才可用计划中的私有 Bun / CLI 停止匹配 profile 或指定项目。运行包不含源码仓库的 `scripts/ops.js`，因此内部使用 `bun bin/lush`，不要对运行包调用 `bun run host`。不要靠手工改绑定、覆盖目录或强杀来更新版本。

## 验证

常规完整套件与文档：

```bash
bun run test:all
bun run docs:check
```

有可信可移植 Bun 和可运行的本机 sshd 时，可显式执行隔离回环 SSH 验证：

```bash
LUSH_SSH_LIVE_TEST=1 LUSH_REMOTE_TEST_BUN=/absolute/path/to/trusted-portable-bun \
  bun run test:serial test/integration/ssh-remote-live.test.js
```

测试只创建临时回环 sshd、专属密钥 / SSH 配置、HOME 与 Git 项目；不修改用户 SSH 文件、不连接用户项目、不调用模型。临时服务不用 PAM；因 `/tmp` 祖先限制，测试服务仅对自己的私有 fixture 关闭 StrictModes，客户端主机校验仍严格。此设置绝不用于用户部署。测试结束停止自己的服务并清理临时资源；失败保留完整日志。

验收分别报告普通测试、真实回环 SSH、真实跨机器服务器、ARM64、Electron / Windows 安装与模型调用。没有用户同意不得执行真实付费模型调用。

[返回部署索引](README.md) · [用户说明](ssh-desktop.md)
