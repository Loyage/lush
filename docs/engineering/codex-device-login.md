# Codex 设备码登录

用户决定 #135：项目托管连接默认使用设备码，原 PKCE 浏览器回调登录作为显式备用，不自动切换。凭证隔离、模型不探测与私有文件约束沿用[账号资源连接器](agent-connections.md)。

## 接口契约

保留原 `agent.connections.login.start/finish` 不变；新增全部 USER_ONLY 的 POST `/api/action`：

- `agent.connections.device.start {id}` → `{id,login_id,verification_uri,user_code,expires_at,interval_seconds}`。
- `agent.connections.device.poll {id,login_id}` → `{id,login_id,status:'pending',interval_seconds,expires_at}` 或 `{id,login_id,status:'complete',connection}`（connection 为现有公开连接，不含 token）。
- `agent.connections.device.cancel {id,login_id}` → `{id,login_id,status:'cancelled'}`；当前会话取消幂等，不能取消别的连接会话。

Manager 方法 `deviceStart(id)`、`devicePoll(id,login_id)`、`deviceCancel(id,login_id)`；Service 同名；Project 方法 `startConnectionDeviceLogin`、`pollConnectionDeviceLogin`、`cancelConnectionDeviceLogin`。所有写回通过现有项目写入准入，poll 为显式 action，不增加 GET 或后台 daemon 采样。失败只返回固定安全错误，不把上游响应、设备授权秘密、token 或设备码放入错误、审计事件与历史。

## 协议与生命周期

固定 OpenAI HTTPS 目的地、现有 Codex public client ID：POST `/api/accounts/deviceauth/usercode` 获取设备授权 ID、用户短码及间隔；POST `/api/accounts/deviceauth/token` 检查授权，返回授权 code/verifier 后 POST `/oauth/token`，redirect_uri 固定 `https://auth.openai.com/deviceauth/callback`。用户授权页固定 `https://auth.openai.com/codex/device`。网络请求拒绝重定向、有界响应与超时，使用 mock 自动测试，不读取真实凭证。

登录最多 15 分钟，服务端内存保存设备授权 ID（不向 Web 返回）、连接 revision 与短码；按连接限制一个活动登录，设备码与旧回调登录相互替代。配置更新、删除、重新登录、取消、stop、超时使会话失效；迟到请求不能保存已取消或旧账号凭证。授权兑换最多一次，并发 poll 单飞，未到服务端规定时间返回 pending 而不联网。403/404 按已审查 Pi 协议视作等待；识别 authorization_pending、slow_down（退避）、过期/拒绝，其他失败安全结束。成功后清除设备授权秘密；短期保留安全完成态供迟到重复 poll，不再次兑换。应有界清理终态会话，daemon 重启不恢复未完成登录。

## Web

默认卡片“登录 / 重新登录”启动设备码；旁边明确备用回调入口。显示短码（可复制）、官方授权链接、到期与等待状态，不要求粘贴回调。提示用户可能需要在 ChatGPT 安全设置允许 Codex 设备码登录，只认可本人发起的设备码、不分享。授权成功自动加载连接列表。

按返回间隔使用有界计时器发送 poll action；不密集轮询。页面不再属于当前视图、取消、更换编辑或新登录时停止旧计时器并尽可能取消服务端会话；不保存码到 localStorage。当前面板关闭后不后台续登，重新进入可发起新登录。登录不调用 Agent 或模型，按钮有 data-help、不加 agent-call；复制失败提供手动选择短码。

## 文件分工

后端 Worker：`src/agent/connections*.js`、`src/core/agent-connections.js`、`src/core/project/agents.js`、`src/rpc/{registry.js,handlers/system.js}`、`src/ui/web/server.js`；对应 Agent/Project/RPC/API 测试。更新 `docs/third-party/agent-connections.md` 中固定源协议审查记录（设备码参考 Pi AI 已安装版本），不引入 SDK 运行时依赖。

Web Worker：`src/ui/web/assets/render-agent-connections.js`、必要连接样式、对应 DOM 测试。不得改 server/RPC/后端或此契约。

父 Worker：工程契约、模块文档、组合回归与验收。真实账号的设备码授权与实际调用尚需用户验收，mock 测试不等于真实登录验证。
