# 桌面连接远程项目

本文面向使用本地 Electron 操作远程项目的用户，解释连接方式与设计取舍；环境配置与操作验收交给[桌面远程 Agent 指导](remote-desktop-agent.md)。桌面连接的是远程 **Lush Host**；Host 再通过远端 Unix socket 连接项目 lushd，不把 daemon RPC 暴露到网络。实现入口是 `src/ui/desktop/runtime.js`。

## 为什么桌面只连接 Host

项目、Git、编码 Agent 和数据库都留在后台，客户端只提供窗口、连接入口与窄通知能力。这样可以在另一台机器使用熟悉的界面，不需要同步工作区或把模型凭证搬到客户端；也不会因客户端关闭而中止后台开发。

浏览器已经能完成项目操作；选择 Electron 主要是为了独立窗口、最近连接和桌面通知，不是获得远程文件系统权限。它不是远程编辑器或终端。代价是需要维护客户端与连接环境，并分别考虑远端登录、证书和断线。

后台访问方式的选择与原因见[远程 Host 用户说明](remote-host.md)。

## 使用方式

1. SSH-only Linux 可先按[桌面 SSH 部署](ssh-desktop.md)预检并确认用户目录安装；已有后台也可手工准备 Lush、Bun、Git 及 Agent。Agent 模型认证在远端配置，项目必须存在于该机器。
2. 本地运行 `bun run desktop`，或使用[macOS](macos-client.md) / [Windows](windows-client.md) 客户端产物。首启显示连接页，macOS / Linux 可选择「打开本地窗口」，Windows 仅提供远程连接。输入远程 Host **根地址**，例如 `https://lush.example.com`；Windows 安装与构建见[Windows 客户端](windows-client.md)。
3. 远程窗口直接加载该 Host 的页面；有认证时先登录，再从远端项目列表选择项目。输入项目路径时，必须填写**远程机器的路径**，不能使用本地目录选择器。
4. 通过桌面「连接」菜单打开更多本地或远程窗口。一个工作窗口固定属于一个 Host，在该 Host 内打开其它项目会创建独立窗口，不替换已有输入。

桌面本地模式仅支持 macOS / Linux：源码启动需要本机 Bun，macOS 安装包携带私有 Bun；远程模式不启动本地 Host，也不需要本机 Bun。Windows 安装包直接运行内置 Electron；开发入口 `bun run desktop` 本身仍通过 Bun 启动 Electron。本地与多个远程窗口可以同时存在，无须同步项目目录、挂载文件系统或复制 `.lush`。

## HTTPS 与 SSH 隧道

- 公网 Host 必须配置认证、项目白名单和 HTTPS 反向代理，具体配置见[远程 Host Agent 指导](remote-host-agent.md)。仅连接你信任的 Lush Host。
- 远程地址仅允许 HTTPS；不会绕过无效或自签名证书。需要私有证书时，先在系统中建立可信证书链。
- 内置 [SSH 入口](ssh-desktop.md)管理自己的隧道与确认后的用户目录部署，使用系统密钥 / ssh-agent，不保存密钥或自动重连。
- 仍可自行建立 SSH 隧道，连接 `http://127.0.0.1:端口`、`http://localhost:端口` 或 `http://[::1]:端口`；该 URL 入口不管理手工隧道。
- 地址不得包含账号、密码、项目路径、查询参数或片段。现有 Web 资源使用根路径，因此也不支持把 Host 部署在任意 URL 子路径下。

例如，远端 Host 仅监听回环 `4318`，SSH 使用 `2222` 端口：

```bash
ssh -N -p 2222 -L 127.0.0.1:4318:127.0.0.1:4318 user@remote-machine
```

然后在桌面填 `http://127.0.0.1:4318`。默认无认证 Host 校验请求端口；本地端口若不同，必须按[Host 指导](remote-host-agent.md#2-ssh-隧道路线)显式声明 SSH origin，不能直接改转发端口。请保持隧道进程运行；为不同远端分配不同本地端口。隧道若指向未认证的回环 Host，任何能访问该本地转发端口的本机进程都能访问它，应按可信单用户环境使用。单项目绑定 Host 同样可连接，窗口直接进入该远程项目。

## 登录、记录与通知

- 登录 Cookie 和远程页面偏好按 Host origin 使用独立、持久化的 Electron 会话；本地模式使用另一会话分区。本地非通知受管界面偏好另外保存在桌面 userData 中，随机端口变化不会丢失；外观 / 行为本地共享、视图偏好按稳定项目 ID 隔离，远端 / 浏览器不共享，见[桌面偏好契约](../engineering/desktop-preferences.md)。相同 Host 的多个窗口共享登录，不同 Host 不共享。SSH 转发端口是 origin 的一部分；不要把同一本地端口复用为不同远端，否则会被视为同一个 Host。
- 最近连接最多保存 12 个地址，写在 Electron userData 下的 `connections.json`，仅保存入口元数据与按 Host 的通知开关、告知分类渠道偏好；本地受管 UI 偏好使用独立 `ui-preferences.json`，不保存密码、项目数据库或 Agent 凭证。分类设置与已读语义见[待决问题与告知](../reference/rpc/notices.md#页面告知条与分类设置)。
- 「仅移除记录」只移除快捷入口，不清除登录 Cookie、不关闭已打开窗口，也不停止服务。退出登录使用远端页面的退出入口。
- 系统通知默认关闭，在对应 Host 窗口的设置中开启；不同 Host 的开关独立。通知点击只聚焦发出通知的项目窗口，并打开该窗口的「待我处理」。窗口关闭后不再提醒，不提供后台推送。

## 安全与故障边界

工作窗口启用 Electron 沙箱、contextIsolation，禁用 Node 和 webview。远程页面仅有经过主 frame、窗口、页面路径及 origin 校验的窄通知 IPC，无本地目录选择、连接管理、文件读写或通用 IPC。连接管理仅可由随代码发布的本地连接页调用。独立预览窗口没有 preload；跨 origin 导航及重定向被阻止，HTTP(S) 外链交给系统浏览器，其它协议被拒绝。浏览器权限请求和下载默认拒绝。

关闭窗口、退出桌面或断线都不会停止远程 Host / lushd；项目 Agent 可以继续在远端执行。桌面退出只停止自己启动的本地临时 Host 和 SSH 隧道，不停止项目 daemon 或远端 Host。连接失败会在连接页保留地址并显示错误，可显式重试；运行中连接中断可通过「视图 → 重新加载」或连接菜单重新打开。不会自动重发写操作，超时后应先查看Worker状态，避免重复提交。

远程业务页面和 API 均由远程 Host 提供，适配器与 daemon 仍需在远端保持版本匹配。本功能不包含远程文件编辑器、交互终端、自动隧道重连或跨 origin 单点登录。

## 验证边界

自动测试覆盖地址校验、持久化、会话分区、模拟 Electron 的窗口 / 导航 / IPC / 通知、preload 能力，以及真实临时 Host 的启动与退出。SSH 验证范围与可选真实回环测试见[SSH 部署](ssh-desktop.md#验证边界)。模拟 Electron 测试不等价于真实桌面验证；发布前还应在实际 Electron 中验证登录 Cookie、证书、跨项目窗口、断线重载与系统通知。

---

[返回部署索引](README.md) · [交给 Agent 配置 →](remote-desktop-agent.md)
