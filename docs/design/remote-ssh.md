# SSH 远程接入与首次部署

## 用户目标与已确认范围

用户从本地 Electron 选择 SSH 服务器，在无 GUI 的远端安装并运行 Lush，打开远端项目。首期自动部署支持 Linux x64 / ARM64；复用系统 SSH 配置、已配置密钥及 ssh-agent。交互式密码、密钥解锁、主机信任建立留给终端；不能关闭主机身份校验。

首屏只读枚举本机用户 SSH config 及 Include 中的明确 Host，免去重填已有服务器。列表不是完整 SSH 配置解释器：不执行 Match exec / ProxyCommand，不展示原文、密钥或凭证；实际连接仍由系统 OpenSSH 解析所选别名。点击配置项或已有记录后自动预检，兼容且已安装则直接连接；首次安装必须展示计划并明确确认。手动输入保留独立预检 / 确认步骤。

允许经用户确认安装用户私有 Bun。安装 Lush 不等于 Agent 已就绪：Git、Pi/Codex 认证及项目构建环境要分别检查，不复制模型凭证、不调用模型验证连接。原有本地、HTTPS 与手工隧道入口保留。

首期实现与模拟 / 隔离 shell 测试已完成，可选真实回环 SSH 测试覆盖私有 Bun、Host、项目 daemon 与重连；跨机器服务器、ARM64、实际 Electron 和 Windows 发布仍需分别验收。使用见[桌面 SSH 部署](../deployment/ssh-desktop.md)。本章是实现契约，不把未验收功能描述成已发布能力。

## 边界

- Electron 新增接入与部署层；业务页面仍来自远端 Host，Host 通过远端 Unix socket 连接各项目 daemon。无新 Worker 实体、数据库副本、远程编辑器或文件同步。
- 不使用 sudo，不改系统 PATH、防火墙或现存配置，不默认安装 systemd 服务。远端运行包不含 Electron / node_modules / 用户项目 / 凭证。
- 安装位置属于当前 SSH 用户，使用版本化目录、完整性验证与原子落地；中途失败保留诊断，不覆盖运行中的版本或项目 `.lush/`。
- 复用匹配身份的后台；版本不兼容或现有后台忙碌时明确提示，不强杀、不隐式更新项目 daemon。断线可重新连接，但不得重放写操作。
- 桌面管理 SSH 隧道，不把 SSH 能力暴露给远端业务页面或预览窗口。只有随客户端发布的可信连接页可以调用连接与安装 IPC。
- 不保存 SSH 密钥、口令或模型凭证。首次安装需展示目标机器、安装目录、版本、私有 Bun 及后台进程范围，再显式确认。

## 运行包与发行接缝

由构建工具在原生 Linux x64 / ARM64 环境生成运行包。输入是可信源码检出和固定版本 Bun；发行渠道或可信客户端携带 manifest 与对应 archive。用户运行时不执行未经验证的网络安装脚本。

默认开发产物目录为 `node_modules/lush-remote-build/payload/`，与项目 `.lush/` 无关。桌面发行将产物放在独立 resources 的 `remote-payload/`；客户端只安装它所信任的随发行提供的产物。原生 Linux 开发检出可仅生成本机架构；Mac / Windows 开发者显式导入可信同检出的双架构 CI 包，不跨编译、不在启动时静默下载。缺少目标产物必须清晰报错，但不禁用本地 / URL 入口，不能假称全平台已验证。macOS 安装包另外携带本机架构的私有 Bun 与白名单后台，和 Linux 包分目录，Windows 不获得本机后台。发行 / 开发产物准备见[构建指导](../deployment/desktop-build-agent.md)。

manifest 接口（版本 1）：

```json
{
  "version": 1,
  "lush_version": "0.2.0",
  "fingerprint": "CODE_FINGERPRINT",
  "targets": {
    "linux-x64": {
      "file": "lush-remote-linux-x64.tar.gz",
      "sha256": "ARCHIVE_SHA256",
      "bun_version": "1.4.2",
      "bun_sha256": "BUN_SHA256"
    }
  }
}
```

archive 根目录包含 `bun`、`bin/`、完整 `src/`、`docs/`、`README.md`、`package.json` 和 `remote.json`。`docs/` 仅允许 Markdown 与 `scripts/build-remote.js` 中逐文件列出的已审核第三方许可证；源码采集与归档校验使用同一白名单，不泛化允许 `.txt`。`remote.json` 标记 version、target、lush_version、fingerprint、bun_version、bun_sha256，与 manifest 对应。不含外层目录、不跟随符号链接。保留源码以保持现有代码指纹一致，但不安装 Electron 二进制或任何 node_modules；远端执行仅使用 Bun 与现有服务入口。

## 模块接缝

- `scripts/build-remote.js` 与对应 packaging 测试：原生平台产物、白名单、manifest、校验与多架构汇总；`remoteSourceIdentity()` 不执行源码或外来运行时即可读取预期身份。
- `scripts/desktop-remote-payload.js`：Mac / Windows 桌面打包在独立 resources 中携带两架构 Linux 运行包，拒绝与客户端源码身份不一致、缺失架构、校验失败或包含额外文件的产物；afterPack 再比较实际包装与审核 staged 字节。Windows 只执行 Electron，不执行 Linux Bun。
- `scripts/desktop-local-runtime.js`：macOS 原生私有 Bun / 后台资源，Mach-O、系统依赖、哈希与身份检查；构建和包装后分别 smoke，拒绝 Nix 私有 dylib / RPATH，不把 runtime node_modules、项目或凭证打包。
- `scripts/prepare-desktop.js` / `start-desktop.js`：显式导入同检出 Linux CI 产物，替换旧生成物需 `--replace`；源码启动只给准备提示，不静默联网。
- `src/ui/desktop/ssh.js` 与对应 desktop 测试：Node 环境可用，不依赖 Bun；提供 `createSSHManager({payloadDir,userData,spawn?,...})`。
- Manager 接口：`list()` 返回仅元数据的连接记录；`inspect(profile)` 返回有界检查和安装计划；`connect(profile,{install:false|true})` 返回 `{url,profile,...}`，需要安装但未获授权时拒绝并指导先预检/确认；`disconnect(id)` 只停止自有 SSH 进程；`dispose()` 退出清理自有隧道，不停止远端 daemon。
- profile 输入：`{id?,alias}`，alias 是安全的 SSH Host 别名 / 主机名，首期不接受自由命令、URL、密码或附加 SSH 参数；id 由可信主进程生成。inspect 返回 `{profile,ready,requiresInstall,plan,warnings}`；plan 是白名单 JSON，展示远端用户目录、版本、平台、安装与启动范围，不含秘密。
- 已保存 profile 应保持稳定本地入口身份；不同服务器不能因复用回环端口而共享登录 Cookie。端口不可用时不静默改成另一个服务器的 origin。
- `src/host/`、CLI 与 Web 适配器的 SSH 回环接缝：可显式声明一个仅用于受控 SSH 转发的回环 origin，允许与远端监听端口不同；仍只监听远端回环，仍检查请求 Host 与 Origin，不接受任意域名或全接口监听。默认 Host 的严格行为不能被全局放宽。
- `src/ui/desktop/ssh-config.js` 只读本机用户配置并有界展开 Include；配置枚举仅经可信连接页的窄 IPC 暴露，不能由渲染器指定读取路径。读取失败或缺少配置不得禁用手动、本地和 URL 入口。不得在远端工作窗口增加通用本机执行 IPC。

## 验收

覆盖 SSH argv 与 shell 注入防护、未知主机 / 认证失败、超时与有界输出、重复点击与取消、源产物校验、安装中断、重复安装、缺少依赖、版本不匹配、端口冲突、并存窗口和退出所有权。安全测试证明新回环入口不削弱默认 Host、跨站保护与远端窗口 IPC 隔离。

真实 SSH、Linux ARM64、Windows/macOS 客户端、真实 Electron 与 Agent 模型调用分开报告。mock 测试和文件生成不等于真实跨机器验收。

[返回设计索引](README.md) · [三层边界](../engineering/host-boundary.md) · [现有远程部署](../deployment/remote-desktop.md)
