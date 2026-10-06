# Windows 本机后台：WSL2 方案

本文面向 Windows 用户，解释为什么用 WSL2 运行 Lush 后台、需要准备什么，以及它对现有架构的影响。具体配置可以交给 Agent 按[WSL2 环境配置指导](windows-wsl2-agent.md)执行；远程服务器浏览器访问见[远程 Host](remote-host.md)。

## 这是什么方案

Windows 负责浏览器；WSL2 内的 Linux 负责 Host、项目 daemon、Git 和编码 Agent。它不是 Windows 原生 daemon，也不要求把项目送到远程服务器。

```text
Windows：浏览器
                 ↓ 本机 HTTP
WSL2 Linux：Lush Host
                 ↓ Unix socket
            每个项目一个 lushd
                 ↓
            项目 .lush/ + Git + Agent
```

所有项目事实仍在 WSL 内对应项目的 `.lush/`。Host 只登记项目、提供界面和转发请求，不接管 Worker 调度。设计边界仍是[UI → Host → lushd](../engineering/host-boundary.md)。

## 为什么不先做 Windows 原生后台

现有后台使用 Unix socket、Linux/macOS 文件权限、内核锁和进程组管理。原生 Windows 支持不仅是“让进程在后台启动”，还需要另一套通信、权限、安全文件读取和 Agent 子进程回收机制。

WSL2 提供 Linux 环境，可以先复用这些实现，不必改 Worker、消息、合并队列或数据库模型。代价是用户需要安装 WSL2，并在其中准备开发环境；这是一种部署方案，不是新的系统架构。

**当前提供配置指导，不承诺已经通过真实 Windows / WSL2 全流程验收。** Windows 版本、WSL 网络模式及发行版差异仍需在目标机器验证。

## 用户需要准备什么

- 支持 WSL2 的 Windows、可用的虚拟化环境，以及一个 Linux 发行版。
- 在 WSL 内安装 Bun、Git，以及已认证的 Pi 或 Codex。Windows 已安装的工具、PATH 和凭证不默认复用。
- 在 WSL 内取得 Lush 代码和要开发的项目；目标项目必须是有初始提交的 Git 工作区根目录。
- 启动 WSL 内的 Host / daemon，再用 Windows 浏览器打开 Host 地址。

不要求 Windows 侧另装 Bun 或 Git 来运行浏览器。Lush 不提供桌面安装包，也不自动启动或管理 WSL。

## 为什么建议把项目放在 Linux 文件系统

建议 Lush 代码和目标项目放在 WSL 的 `/home/<用户>/...`，不要默认放在 `/mnt/c/...`。

- Git worktree 和大量小文件操作更适合 Linux 文件系统。
- 避免 Windows 挂载盘的权限、大小写、链接和换行差异影响后台。
- 可以通过支持 WSL 的编辑器打开项目，不需要在 Windows 盘保留另一份同步副本。

Lush 界面填写的是 WSL 中的绝对路径，例如 `/home/alice/projects/demo`，不是 `C:\projects\demo`。

已有 Windows 项目应先决定是重新克隆还是另建副本；不得直接搬移正在使用的工作区。**已有 `.lush/` 绑定绝对项目路径，不能直接复制或搬到另一目录继续使用。** 新目录应作为独立项目初始化，原目录与历史状态保留。也不得让 Windows 和 WSL 两套后台同时操作同一份 `.lush/` 与 Git 工作区。

## 如何从 Windows 打开界面

通常先尝试 `http://localhost:4318`，由 Windows / WSL 的本机转发访问 WSL 内的 Host。Lush 默认只监听 WSL 的 `127.0.0.1`，不需要把项目 RPC 暴露到 Windows，也不需要开放局域网端口。

如果 WSL 内能访问、Windows 不能访问，应先检查 WSL 版本、网络模式、本机转发及端口冲突。**不得为了连通直接改成无认证的公网监听或关闭防火墙。** 需要局域网或公网访问时，另按[远程 Host 用户说明](remote-host.md)选择访问方式，再由 Agent 配置认证与网络。

Windows 上的代理也未必能从 WSL 用同一个 `127.0.0.1` 地址访问；代理和模型连接需要单独验证。

## 后台什么时候继续运行

关闭浏览器不会停止已启动的项目 daemon；正常后台启动也不要求一直保留那个启动终端。但这不意味着 WSL 在所有情况下都会一直运行。

Windows 重启、注销、WSL 终止或系统休眠可能中断后台或网络连接；不能把它当作持续在线的服务器。恢复后先检查状态，再决定是否继续 Worker，不要自动重发结果未知的写操作。

本方案默认手动、按需启动，不设置开机自启、Windows Service、计划任务或 WSL systemd 服务。未来若需要“一次安装、自动启动”，可以增加启动托管与安装引导，仍保持一项目一个 daemon，不引入整机 Worker 调度。

## 怎么判断配置成功

验收应分开记录：

1. WSL 内工具、Agent 认证和项目路径正确。
2. Host / daemon 启动，代码身份与当前 Lush 检出一致。
3. Windows 浏览器可以访问，项目页面能读取状态。
4. 用户选择的模型可用；真实 Agent 调用只在用户同意成本与改动后验证。

“页面能打开”不等于“Agent 已能开发”；Linux 测试通过也不等于真实 WSL2 验收。部署 Agent 应交付实际验证结果、日志位置、下次启动命令和仍未验证的部分。

---

[返回部署索引](README.md) · [交给 Agent 配置环境 →](windows-wsl2-agent.md)
