# 模块地图：CLI、RPC 与测试

本章定位命令分派、RPC 权限与测试接缝。公开白名单以 `src/rpc/registry.js`、CLI `help.js` 与[核心 API](core-api.md)为准；内部／退休模块存在不代表可调用。

> 模块地图：[总览](modules.md) → [Runtime 与持久化](modules-runtime.md) → [Web 前端](modules-web.md) → **CLI、RPC 与测试**

## 设备设置与迁移接缝

技术配置默认 device，显式 project 拒绝；无 scope 不构成 Agent 旁路。当前契约见[用户工作台](user-workspace.md)，旧根预检、confirm／revision 与私有备份见[设备迁移](device-settings.md)。CLI 直接读 Prompt／env 也须核验用户权限，不能因本地文件操作绕过 RPC 限制。

## CLI：`src/cli/main.js` + `src/cli/`

`main.js` 注册当前命令，`commands/` 按主题分派；`help.js` 是命令说明，`args.js`／`print.js` 管理参数和人类／JSON 输出。处理器统一为 `run(command,args,{client,json})`，返回 undefined 表示已打印，主流程不重复输出。

- Worker 身份在 `worker-number.js` 经只读 lookup 解析，底层 RPC 仍传整数，见[编号与 CLI](../reference/api.md#用户编号与-cli-身份)。
- `private-json.js` 集中有界、owner-only、no-follow 文件输入；配置、秘密与完整 Profile 不放进 argv／错误／公开摘要。
- `native-watch.js`／`native-pi.js` 仅用户显式终端观看时加载 Pi TUI，不创建 AgentSession、不执行工具、不写会话，见[观看器](../native-viewer.md)。
- `skills` 是无需 daemon 的固定公开指南读取，不接受任意路径，不查询设备开启状态，见[能力契约](agent-capabilities.md)。

`bin/lush` 固定项目管理入口，`bin/lushw` 固定 invocation 自身与直接父子事务入口；同源命令目录派生两入口的分发、帮助与学习页面，业务叶命令唯一归属，入口名称不能替代后端身份授权。命令与 RPC 的对应关系及迁移见[API 参考](../reference/api.md#开发与管理双入口)，不在地图复制注册表；历史命令与快捷入口不恢复别名。

## RPC：`src/rpc/protocol.js` + `src/rpc/`

| 入口 | 职责 |
|---|---|
| `protocol.js` | framing／帧上限，兼容 re-export Dispatcher |
| `registry.js` | 方法、参数和权限的唯一 RPC 白名单，未知项拒绝 |
| `dispatcher.js` | handler 装配查重／查漏、身份校验与安全输出 |
| `handlers/` | 按主题转发 Project／Store，不替代其生命周期和写门复核 |
| `public-result.js` | 隔离私有 Profile／Hooks 等；授权配置表面保留合法 env 键，不对普通 mutation 开例外 |
| `client.js`、`src/ui/client.js` | Unix RPC 与 CLI／Host 统一项目客户端 |

处理器签名 `(project,params,actor) => result | Promise<result>`。身份来自当前有效 invocation，不信任模型参数；管理／integration 的窄白名单分别见[管理](hook-signals-management.md)与[归并权限](../reference/rpc/convergence.md#专用整合-worker-的-rpc-能力)。HTTP 另有[读取与 mutation 白名单](../reference/web-routes.md)，不能只隐藏 UI 或仅登记 RPC。

客户端本地 `{signal}` 取消只关闭连接、清理监听／计时器，不取消 daemon 已派发操作，不重试、不进入线参数；未知写结果必须核对，不能把断连当失败重发。

## 开发与构建脚本：`scripts/`

`package.json` 保留工程脚本及固定 bins；源码业务命令统一 `bun run lush …`／`bun run lushw …`。`scripts/ops.js` 与原业务快捷包装已删除，不保留同义入口。性能测量见[读取性能报告](../contributing/read-performance.md)，原生观看专项见[观看器验证](../native-viewer.md)。Lush 不提供客户端安装包或远端部署产物；代码身份覆盖路径的 LF 检出由根 `.gitattributes` 保证。

## 测试：`test/`

[贡献指南](../contributing/README.md#分层测试与交付)统一验证责任、完整运行／证据复用、预算与 CI，不在模块地图复制测试流水或逐文件清单。

- 每个测试文件自给自足，fixture／world／DOM stub 不依赖其他文件先运行。规模边界在负责的后端测全，HTTP／DOM 用小数据验证参数、游标与交互；批量造库用事务，不关闭生产安全或持久化。
- `test/helpers.js`、`test/dom-stub.js` 是共享测试接缝，改签名须兼顾调用方。`helpers.env(extra)`／`git(root,...args)` 隔离 HOME／XDG、全局／系统 Git 配置及继承 GIT_*；自建 spawn 须同样隔离，不修改进程级环境或生产 Git。
- `test/session-fixture.js` 用纯临时会话文件验证只读投影，不为读取测试无谓创建 SQLite／worktree。
- Web 资源验证模块可加载、CSP、启动、Agent 标识与减动效契约，不锁定精确颜色／字体／CSS 排版；真实几何、键盘／触摸和浏览器策略不能由 DOM stub 代替。
- 临时项目／设备根与 mock／可控子进程是默认测试环境；测试退出清理自己的服务和文件，不操作用户开发项目、账号或服务。

回归按 `test/project/`、`test/workspaces/`、`test/agent/`、`test/web/`、`test/integration/` 定位；具体长期专项入口留在对应主题契约，精确断言在测试。文档改动运行 `bun run docs:check` 与受影响的文档检索／Web 回归。

---

[← 上一篇：Web 前端](modules-web.md) · [返回模块地图总览](modules.md)
