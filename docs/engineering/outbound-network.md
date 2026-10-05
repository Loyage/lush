# 项目出站网络代理

本文记录用户决定 #147 的施工契约：项目级网络设置覆盖后台账号请求及后续 Agent 调用。目标与凭证原则沿用[账号资源](../design/account-resources.md)和[工作台](../design/workbench.md)；真实发布验证以交付结果为准。

## 边界

- 网络代理是 HTTP(S) 正向代理，不是模型端点、Host 入站反向代理或 SSH 接入方式；不改变固定官方认证目的地或凭证授权。
- 不改整机代理，不启动或管理 Clash。`127.0.0.1` 指实际执行 daemon / Agent 的机器；远程环境不自动使用客户端代理。
- 首版支持 HTTP / HTTPS 代理（例如 Clash HTTP/混合端口），不实现 SOCKS-only 或 NO_PROXY CIDR。后台继承环境遇到实际路由将使用的、不支持的代理应明确失败，不静默直连；Agent 外部 CLI 自身支持情况另行验证。
- TLS 验证、拒绝重定向、超时、响应大小、取消、迟到凭证保护继续有效。显式代理不可用时不得重试直连。
- 回环和本地通信不得走出站代理；Host↔daemon RPC、SSH/Host 网关不是这份设置的消费者。
- 配置只作用于后续请求 / invocation；在途登录和 OAuth 兑换链固定同一网络策略。更新网络不覆盖现有账号凭证。

## 存储和用户接口

canonical 项目 `.lush/network.json`，版本 1，目录 0700 / 文件 0600；按现有私有文件模式验证 owner、权限、symlink / hardlink、有界读取和原子替换。文件不在 worktree，不进入 Git。

用户专属 RPC：

- `agent.network {}` → 安全配置投影。
- `agent.network.configure {config}` → 保存并返回安全配置投影。
- Web GET `/api/agent/network` 和 POST `/api/action` 的配置动作，沿用认证、Origin、JSON、no-store 与多项目/远端白名单边界。

安全读模型：

```json
{"version":1,"mode":"inherit","proxy_url":null,"no_proxy":[],"has_proxy_auth":false}
```

`mode` 为 `inherit` / `direct` / `proxy`，默认缺文件为 inherit。`proxy_url` 为无 userinfo、query、fragment 的 HTTP(S) 代理 origin（可有端口）；`no_proxy` 为有界字符串数组，接受 hostname、域名后缀、可选端口、IP（含 IPv6）或 `*`，不得接受任意 URL / 路径 / 控制字符。不支持的规则明确拒绝而不是猜测。

写配置字段：`version,mode,proxy_url,no_proxy,proxy_auth?`。`proxy_auth` 仅写，取 `{username,password}` 或 `null`；不允许在 `proxy_url` 内嵌秘密。省略认证仅在同一个 proxy origin 保留旧认证；更换 origin 必须清除，不能转发旧密码；非 proxy 模式清除代理地址和认证。读模型只能返回 `has_proxy_auth`，不得返回用户名、密码或密钥前缀。保存不得回显原始输入或上游错误。

Web 在项目 Agent 设置里提供独立“出站网络”面板，按需读；模式、地址、绕过规则和可选代理认证输入。密码不回填、不进 localStorage，保存后清空；明确已保存认证可保留/清除。旧 Host/daemon 返回不支持时只在面板就地提示更新，不影响其余设置。

## 配置示例

如果代理运行在项目后台机器的 `127.0.0.1:7897`，在“Agent 管理 → 设置 → 出站网络”点击“读取网络设置”，选择 HTTP(S) 代理，填 `http://127.0.0.1:7897` 后保存，再重新发起 Codex 登录。保存不等于代理已联网验证，不自动启动代理或发测试请求。

CLI 可从自己创建的私有 JSON 文件录入（文件不得提交 Git；含代理认证时也必须保护输入文件）：

```json
{"version":1,"mode":"proxy","proxy_url":"http://127.0.0.1:7897","no_proxy":[]}
```

```bash
bun run lush --project /absolute/project agent network set --file /private/network-input.json
bun run lush --project /absolute/project agent network show
bun run lush --project /absolute/project agent network reset
```

已有安装需要先在安全空闲边界更新/重启 daemon 与 Host 才认识新增接口；之后保存代理配置无需重启。不要在活动调用期间强制重启。若登录仍返回 unauthorized，只能说明上游拒绝，不能仅凭分类判断账号权限或网络原因。

CLI 沿用 `agent` 入口：`agent network show` / `agent network set --file PATH` / `agent network reset`。show 和保存输出脱敏；set 从用户显式选择的 JSON 文件读取，避免把密码放命令行。reset 写 inherit 配置。全部用户专属，不允许 Agent token 配置代理。

## 请求和执行路径

- daemon 继承模式按其启动环境的 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 及 NO_PROXY（兼容大小写）选择；显式项目模式不受旧环境的代理残留影响。直连必须真正绕开进程默认代理，不只删除配置字段。
- 实测 Bun 1.4.2 的 `fetch` 空代理参数仍继承进程代理，显式代理亦受进程 NO_PROXY 影响。因此生产请求采用内置 Node HTTP(S) / TLS / CONNECT 的独立传输以实现快照隔离；不得临时修改全局环境来模拟 per-request 策略。保留 fetch mock 接缝用于既有协议测试，传输另做受控本机测试。
- 回环始终绕过。NO_PROXY 的匹配与端口/域名边界必须有测试，不能让 `notexample.com` 匹配 `example.com`。
- 后台账号请求包含设备码 start/poll、OAuth 回调兑换、托管及既有额度查询的刷新/查询；不可只接设备码 start。
- Agent 子进程的网络默认顺序为 daemon 环境 → 项目网络设置 → 既有 common / role env → Worker profile env。既有显式覆盖仍优先，跨大小写不能被另一层旧变量抢占。
- Pi / Codex 和模型目录子进程通过代理环境变量接入，不注入插件或 SDK，不在模型上下文中携带配置。外部 CLI / 工具实际支持情况分别验证，不能承诺所有工具都会使用代理。
- 查询的并发单飞键须包含私有网络策略摘要；更新配置后的新请求不能复用旧网络的在途结果。摘要不进入公共日志或历史账号身份。
- 固定网络快照只存在进程内部。代理认证加入代理连接，不放进发往服务商的 Authorization / Proxy-Authorization 自定义头。

## 并行文件分工

- 后端：新 `src/agent/network.js`（私有配置、网络快照、fetch/子进程适配），必要 `src/agent/{connections*,environment,provider,models,status,usage-*}.js`、`src/core/project/agents.js`、`src/rpc/{registry,handlers/system}.js`、`src/ui/web/server.js`；单元、Project、RPC、HTTP 与受控本机代理测试。不要改前端、CLI、docs。
- 前端/CLI：`src/ui/web/assets/render-settings.js` 与独立网络表单模块、必要样式，`src/cli/commands/agent.js` / `src/cli/help.js`，对应 DOM/CLI 测试。不要改后端、server、docs、共享 test fixture 公共签名。
- 父 Worker：契约、参考与模块索引文档，检查子成果、组合回归和收口；接口不一致先协调，不依赖手工修改其它 worktree。

## 验证

必须覆盖：三种模式、上下层覆盖、大小写变量、回环与 NO_PROXY、代理失败不直连、认证脱敏、私有文件拒绝、跨项目隔离、后台各 OAuth/查询链路、登录网络快照、配置热读和单飞失效、子进程继承，以及 Web/RPC 权限。真实本机临时代理验证 Bun 请求走代理，不使用真实凭证或用户项目。

受控测试已覆盖本机 HTTP/HTTPS 代理的真实 CONNECT、目标 TLS 证书信任/主机名/SNI、代理与目标认证分离、CONNECT/TLS 握手取消/截止时间、解压后的响应大小与拒绝重定向。PEM 是公开自签名测试 fixture，只在隔离子进程通过 `NODE_EXTRA_CA_CERTS` 信任；生产 TLS 校验未放宽。

本机传输/Mock 验证不等于真实 OpenAI、Pi/Codex CLI 联网、真实浏览器/Electron、跨机器 SSH、ARM 或 macOS 发布验收。不得为了测试自动修改用户当前代理或重启活动 daemon / Host。
