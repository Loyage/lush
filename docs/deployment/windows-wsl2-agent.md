# Agent 指导：配置 Windows / WSL2 的 Lush 环境

本文交给帮助用户部署的 AI coding agent：在 WSL2 内配置 Linux 后台，让 Windows 浏览器连接，默认不改 Lush 源码、不设置自启、不开放外网。设计与取舍见[用户说明](windows-wsl2.md)，通用配置见[Agent 部署指导](agent-guide.md)。

## 1. 先确认环境与范围

先确定当前执行终端属于 Windows、WSL，还是别的 Linux 主机；不能把普通 Linux 上的结果当作 WSL 验证。询问或从可靠上下文确认：目标发行版 / 用户、Lush 仓库或已有检出、目标项目、Pi/Codex 与模型选择。

- 先检查现状，再补缺少的环境；已有工具、凭证和后台不要重复安装或覆盖。
- 安装系统组件、提权、重启、搬移项目、变更网络或执行真实模型调用前取得用户同意。
- 遵守目标机已有环境管理约定；Nix 管理的机器必须优先使用 Nix，不自行切换到全局包安装。
- 不修改用户代码，不替用户提交 / stash，不删除 `.lush/`，不启动或停止无关项目。
- 配置凭证时由用户在可信终端完成认证，或使用既有安全配置；不要把密钥写进仓库、报告或命令日志。

## 2. Windows 侧检查 WSL2

以下命令在 **Windows PowerShell** 执行，不是在 Linux shell：

```powershell
wsl --status
wsl --list --verbose
```

目标发行版的 VERSION 必须是 `2`。命令不可用、虚拟化未启用或 Windows 不支持时，按 [Microsoft WSL 安装指导](https://learn.microsoft.com/windows/wsl/install)处理；不得猜测完成状态。

仅在用户确认安装新的 Ubuntu 发行版后，执行下面示例；发行版名称可换成用户明确选择的名称。已有 WSL2 不需要重装。

```powershell
wsl --install -d Ubuntu
# 若系统提示重启，由用户确认并完成；首次启动由用户创建 Linux 账号。
wsl -d Ubuntu
```

不要默认转换已有 WSL1、改变默认发行版或执行 `wsl --shutdown`；这些可能影响其它工作。进入后用 `uname -a`、`whoami`、`pwd` 核对目标环境。

## 3. WSL 内准备工具与项目

以下步骤都在 **WSL Linux shell**、普通 Linux 用户身份下进行：

```bash
command -v bun git
bun --version
git --version
command -v pi codex   # 至少所选的一种可用；另一种缺失不算部署失败
```

缺少工具时，按目标机环境约定安装。Bun / Git 的上游入口是 [Bun 安装](https://bun.sh/docs/installation)与 [Git 安装](https://git-scm.com/downloads)。Bun 至少满足通用部署要求；新环境可参考[仓库构建环境使用的 Bun 版本](windows-client-agent.md#4-仅维护者构建与交付安装包)，但构建版本不代表 WSL 已实测。Pi/Codex 使用用户认可的发行来源，在 WSL 内安装并认证；不要默认调用 Windows `.exe` / `.cmd` 或复制 Windows 凭证目录。

取得用户提供的 Lush 仓库 / 检出，优先放在 Linux home 下。没有仓库地址时问用户，不猜下载来源；克隆认证也使用 WSL 用户的环境。在 Lush 源码目录执行 `bun install --frozen-lockfile` 安装依赖（可能下载 Electron；使用 Windows 浏览器不要求启动 WSL Electron）。

目标项目应是 Linux 文件系统内的 Git 工作区根目录，并有初始提交：

```bash
git -C /home/alice/projects/demo rev-parse --show-toplevel
git -C /home/alice/projects/demo rev-parse --verify HEAD
git -C /home/alice/projects/demo status --short
git -C /home/alice/projects/demo config --get user.name
git -C /home/alice/projects/demo config --get user.email
```

上面路径是占位示例，必须换成用户项目。Git 提交身份缺失时向用户确认姓名 / 邮箱与配置作用域，再配置，不猜身份或覆盖全局设置。未提交改动只记录，不自动处理；项目没有提交时停下来让用户决定。已有 Windows 项目优先由用户选择重新克隆或另建副本，不直接搬移；已有 `.lush/` 的迁移限制见[用户说明](windows-wsl2.md#为什么建议把项目放在-linux-文件系统)。

## 4. 启动与选择 Agent

从实际 Lush 源码目录执行下面命令，把两个示例路径换成已确认路径。采用显式单项目模式，避免误选项目；不修改 `LUSH_PROJECT` / `LUSH_HOME` 等绑定变量。发现继承环境与目标冲突时先报告，让用户在独立终端按正确作用域启动。

```bash
cd /home/alice/tools/lush
bun run start --project /home/alice/projects/demo
bun run lush host start 4318 --project /home/alice/projects/demo
bun run doctor --project /home/alice/projects/demo
bun run lush host status --project /home/alice/projects/demo
bun run lush --project /home/alice/projects/demo agent show
```

显式单项目 Host 不替用户启动 daemon，所以必须先 `start`。已有 daemon 的 `start` 不会自动更换运行代码；身份不匹配时先检查活动 invocation，经用户同意后用 `daemon-restart`，Host 单独用 `bun run lush host restart`。不要因为状态检查失败就强杀进程。

默认后端为 Pi。如果用户选择 Codex，或需要指定 Pi 模型，先读取可用模型目录，再按明确选择配置；不要照抄占位模型：

```bash
bun run lush --project /home/alice/projects/demo agent models pi
# 仅在用户选定 backend 和 model 后执行；backend 可以是 pi 或 codex。
bun run lush --project /home/alice/projects/demo agent set default --agent <backend> --model <model>
```

读取模型目录不证明真实调用成功。已有角色覆盖可能不跟随 default；必须复查 `agent show`，仅按用户选择调整。Agent 专属代理等变量可通过项目环境配置热加载，见[Agent 环境与权限](../reference/agent-environment.md)；不得覆盖 runtime 保留变量。

## 5. 验证 Windows 连通与排错

先在 WSL 内只读检查 HTTP，再在 Windows PowerShell 检查：

```bash
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:4318/
```

```powershell
(Invoke-WebRequest -Uri http://localhost:4318/ -UseBasicParsing).StatusCode
```

用 Windows 浏览器打开 `http://localhost:4318`，确认项目页面能读取状态。Electron 用户按[Windows 客户端说明](windows-client.md)填这个 Host 地址打开连接窗口，不使用禁用的“本地窗口”。没有 Windows 执行 / 浏览器权限时，请用户验证并记录反馈，不能自行报通过。

| 现象 | 优先检查 |
|---|---|
| WSL 内 HTTP 失败 | `bun run lush host status`、它报告的日志、端口冲突、现有认证配置 |
| WSL 成功、Windows 失败 | WSL 版本 / 网络模式 / localhost 转发；参考 [WSL 网络说明](https://learn.microsoft.com/windows/wsl/networking) |
| Agent 找不到或认证失败 | WSL 用户、Linux PATH、所选 CLI 的认证和实际启动环境 |
| 模型网络失败 | WSL 内的 DNS / 代理；Windows 代理地址在 NAT 模式下不一定能用 Linux `127.0.0.1` 访问 |
| 页面 API 404 或代码身份不匹配 | 是否旧 Host / daemon，按上节分别重启并复验 |

不得用 `0.0.0.0` 无认证监听、关闭防火墙或自动端口映射作为默认修复。需要远程访问时另走[远程 Host 配置指导](remote-host-agent.md)。

## 6. 交付配置结果

默认验收不提交 `order`、不创建测试 Worker、不调用付费模型。用户同意后才可在隔离临时项目做真实 Agent 烟测，说明费用与文件改动范围，并仅清理自己创建的资源。仓库测试如需运行，必须完整执行 `bun run test` 并保留失败日志；Linux 测试不能替代 Windows 连通验证。

报告：Windows / WSL / 发行版信息、工具版本、Lush 与项目路径、Agent 配置（不含密钥）、Host 地址、代码身份检查、实际验证和未验证项、日志位置。明确这是 Linux 后台方案，不是 Windows 原生后台认证。

交付下次启动命令，以及下面的停止命令（在 Lush 源码目录执行）；停止只在用户确认、无须保留活动工作时操作。默认不配置自启 / systemd / Windows Service。

```bash
bun run lush host stop --project /home/alice/projects/demo
bun run stop --project /home/alice/projects/demo
```

关闭页面不停止 daemon；Windows 重启或 WSL 终止后先检查状态，不自动重发结果未知的写操作。

---

[← 用户说明](windows-wsl2.md) · [返回部署索引](README.md)
