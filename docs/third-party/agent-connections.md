# Agent 连接器的开源协议参考与改编

新连接器不加载这些项目的插件、终端 UI、凭证扫描器或模型探测。以下已固定并审查的 MIT 源码提供部分协议和解析逻辑，改编后作为 Lush 的结构化数据接口维护；不是“自动跟随上游”的运行时依赖。

| 上游 | 固定版本 | 使用范围 | 保留许可 |
|---|---|---|---|
| [pi-usage-meters](https://github.com/Quigleybits/pi-usage-meters/blob/83f8df3531285dd20894470fcbe495456639a18d/extensions/core.js) | `83f8df3531285dd20894470fcbe495456639a18d`（0.5.0） | Kimi 显式 duration/timeUnit、Z.AI unit/number 窗口与 usage/currentValue、Codex 使用接口/账号请求头 | [MIT](licenses/pi-usage-meters.txt) |
| [@mtrojnar/pi-usage](https://github.com/mtrojnar/pi-usage/blob/bab49aed024f76b60877bc08f6854a8ffcb6d4b1/src/openrouter.ts) | `bab49aed024f76b60877bc08f6854a8ffcb6d4b1`（0.2.0） | OpenRouter UTC reset 计算、预算 used=limit-limit_remaining，而非 lifetime usage、Key 与 credits 独立读取 | [MIT](licenses/mtrojnar-pi-usage.txt) |
| [Pi AI](https://github.com/earendil-works/pi/blob/d86654abb8862e201933517d6f1fce9f88dd117f/packages/ai/src/auth/oauth/openai-codex.ts) | `v0.99.1` / `d86654abb8862e201933517d6f1fce9f88dd117f` | Codex client ID、PKCE 授权参数、手动回调、设备码申请/状态/退避、token 兑换/刷新、账号 claim 提取 | [MIT](licenses/pi.txt) |

审查时源文件 SHA-256：

- pi-usage-meters `extensions/core.js`：`2e8b110518a0e585d08835e98ff5f3f3b8824b7e433e2f9ee21abbd0b05cd15c`。
- @mtrojnar/pi-usage `src/openrouter.ts`：`ba158e1a6d6dd66ce4b0d1114ab028e38f44f6a10eff198bc66ef6f5790c5a06`。
- 安装的 Pi AI 0.99.1 `dist/auth/oauth/openai-codex.js`：`0740315fb80f9c90ccee677b3cfdce4bce289610090b64b74af8f002e230868f`。

## 审查后刻意不同的行为

- 新网络边界限制目标、重定向、响应大小和完整 body 的截止时间；上游错误响应原文从不返回。
- API Key、OAuth access/refresh token 只保存在 canonical 项目的私有文件，不读取/覆盖外部 Pi、Codex 或浏览器秘密。
- 手动 OAuth 回调必须匹配固定 origin/path、唯一 state/code、有效时间与一次性消费；不接受裸授权码，不启动 callback HTTP 服务。
- 设备码追加仍审查同一 Pi AI 0.99.1 固定源（上述 SHA-256 已再次核对）；使用固定 `auth.openai.com` usercode/token/codex-device 路径和设备码 token 兑换 redirect。403/404 按其协议视作等待，pending/slow_down 只保留状态，不暴露错误原文。不同于上游持续循环，本项目只在用户设备码页面发来的显式 poll action 中执行一次检查；服务端校验间隔、15 分钟寿命与取消/配置 revision，成功兑换单飞且一次性，短期保留安全完成态。
- 没有浏览器抓取、后台 CLI 或付费 1-token 模型探测；套餐窗口未知就保留未知。
- 不默认把 Kimi 顶层 membership 叫作周额度，也不把 Z.AI 月窗口换算成固定 30 天。
- 现金余额、Key预算/消费与套餐百分比分别保留 kind/scope/unit；保留可得的绝对数字，不用归一化百分比覆盖它们。
- 查询/刷新结果通过完整配置与凭证内容的安全 revision 指纹、账号摘要和端点摘要隔离；内部 `identity(id)` 同步热读真实文件，不进入公开配置/RPC。即使外部可信写者没更新随机 revision 标记，删除或更换期间也不会写回旧凭证。
- `prepareRuntime()` 要求 OAuth access 至少超过 5 分钟有效期，否则协调刷新；刷新后仍不足则拒绝交付。专用额度 GET 只要求 30 秒有效期，不为低风险查询提前轮换凭证。

这些未公开的订阅接口和客户端 OAuth 流程没有上游稳定兼容承诺。自动测试只使用合成凭证、临时项目和 mock 网络；真实账号、服务商授权范围与实际登录可用性需用户另行验证。
