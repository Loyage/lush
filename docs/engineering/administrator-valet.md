# 独立管理员管家

W363／D737 的实施契约。用户选择独立设备级管理员执行服务和全局独立页面；Host 保持鉴权／路由，不持有管理员 Worker 权威事实。普通 Valet 继续遵守[原权限契约](hook-signals-management.md)，不从管理员身份继承授权。

## 授权边界

管理员与项目 Valet、开发 Worker 是不同的持久身份和 invocation，独立数据库、会话、运行目录与工具入口，不扩展旧 management token，不迁移旧权限或确认。设备指同一后台机器的同一系统用户，不是 OS root、其他系统用户或跨机器访问。

用户明确确认创建高权限身份；创建本身不包含执行指令、不启动模型。首条、追加及任何新的执行指令都经过同一独立输入确认，精确绑定正文（包括空白）、目标身份、administrator 模式、device_user 范围、客户端请求身份及当前用户会话；内容变化旧确认无效。确认有期限、一次消费和去重收据。只有用户鉴权入口可创建／确认；Agent、普通 Valet、自动选择、Hook 和管理员自身工具均无此入口。普通输入不升级。

已确认输入的执行不再做逐项权限弹窗，包括普通 Valet 被设置为 confirmation 的能力；不修改普通 Valet 的设备权限。预检／revision／生命周期／Git／资源归属／真实退出／未知副作用保护不是操作授权弹窗，仍然保留。管理员不能借普通 Notice 答复或其他入口向管理员身份注入新指令，不能批准管理员入口授权。认证材料由可信服务端管理，模型不取得控制凭据、原始 token、私有 Prompt 或账号密钥。

## 服务与接口接缝

纯浏览器／Node／Bun 协议源：`src/administrator/protocol.js`。模式、范围、风险文案、路由名、定义校验只有这一来源。HTTP 为全局根 `/api/host/administrator/`，不接受项目路径别名。Host 用户会话的不可伪造绑定由可信鉴权层交给控制客户端，模型 invocation 使用独立传输和短期凭据，不能构造用户会话或控制证明。读取不启动服务；用户显式创建预检可以启动独立服务。Host 退出仅释放连接，不停止管理员服务或项目 daemon。

页面与后端按以下接缝接线，读取和写入严格拒绝未知字段：

| 路由 | 请求 | 返回 |
| --- | --- | --- |
| GET status | 无 query | `{version:1,online:boolean,...}`；offline 不是历史不存在 |
| GET workers | `before?,limit?` | `{version:1,items,next_cursor,has_more}`；真实分页边界，最多100项 |
| GET worker | `id,before?,limit?` | `{version:1,worker,instructions,events,next_cursor,has_more}`；分页范围由返回 coverage 说明 |
| GET receipt | `client_request_id` | `{version:1,found:boolean,definition?,worker?,instruction?}`；已提交时返回同一事务保存的精确定义及当前收据；只读，不启动服务、不重发 |
| POST preview | `{definition}` | `{version:1,confirmation_id,expires_at,definition,risk}`；不创建身份、不提交执行 |
| POST commit | `{confirmation_id,definition,confirm:true}` | 创建返回 `{version:1,worker}`；输入返回 `{version:1,worker,instruction}`；未知写结果只读查证，不换 key 重发 |
| POST stop | `{id}` | `{version:1,worker}`；立即撤销未开始授权并请求 abort，stopping 不等于已退出 |

定义通过 `normalizeAdministratorDefinition` 精确规范化：create 仅含 name，input 仅含 id、instruction；二者均明确包含 kind、mode、scope、client_request_id。首条指令与后续指令都用 input，不允许 create 绕过首条确认。

commit 响应未知时，页面保存精确原定义与 client_request_id，禁止自动重发或换 key；通过 receipt 只读核对。只有 found:true 且返回精确定义与原稿完全一致，才证明该次提交已保存，展示实际 Worker／instruction 状态；不据提交收据推定执行成功。found:false、离线、查询失败或内容不符均保留未知状态，不作为新提交授权，也不证明原请求永远不会提交。收据与实际提交在同一事务保存；服务重启保留，不从相似正文或时间猜配对。只读收据与 list／detail 采用同一已登录设备用户读范围，Host 重启后重新登录仍可核对原请求；这不会放宽创建／输入确认的原会话绑定，也不会恢复执行授权。

公开 worker 最少包含 `{id,worker_number,name,mode,scope,status,created_at,updated_at,can_input,result,error}`，可包含安全阻塞说明；编号由服务持久分配，不从内部 ID 推算。instruction 包含 `{id,instruction,status,created_at,result,error,effect}`；event 包含 `{id,type,created_at,data}`，数据经可信安全出口处理。身份、失败／unknown、副作用确定性和紧急停止默认可见；授权审计／操作收据和模型设置按需展开。禁止把缺证据、断连、超时或正常 RPC 返回当作业务成功。

## 入口、运行与实际能力

全局工作台 `/#administrator` 提供独立列表、创建和详情。项目页仅新标签导航，不增加输入模式、不升级现有 V 编号。管理员持久编号为 ADM，独立于项目 W／V 计数；服务状态、当前调用和历史在设备私有 `<launcherStateDir>/shared/administrator/` 保存，不创建伪项目或修改 `LUSH_HOME`。首次创建预检显式启动服务；GET 不启动，关闭 Host 不停止服务。

用户终端只提供服务生命周期，不接受执行指令或免确认参数：

```bash
bun run lush administrator status
bun run lush administrator start
bun run lush administrator stop
```

三个命令不接受 `--project`；带普通／管理员 invocation 身份时拒绝。服务由固定 `src/administrator/main.js` 装配真实 runner／executor，使用独立 socket、私有控制证明和短期 invocation token；工具协议名来自 `runtime-protocol.js`，不加载开发 CLI。管理员模型使用设备已配置的 manager 模型默认值及托管 Pi 连接；复用的是模型选择，不是普通 Valet 身份、Prompt 或权限。没有托管来源时明确失败，不继承个人 Pi 认证或默默切换来源。请用户在现有「模型来源／Agent 配置」完成来源设置；创建身份本身不验证付费调用成功。

唯一模型工具 `administrator` 的注册、激活、operation 与 schema 共用 `tool-protocol.js`。实际能力及方法参数由 executor 的 catalog 根据当前注册源生成，而不是旧 CLI 删减清单或普通 Valet 权限表：

- 项目用户级、非退役、非 invocation 绑定的管理／开发／诊断 RPC，经独立签名委托到明确 canonical 目标；保留用户级数据而非普通 Valet 的元数据投影。请求在源设备签名，目标 daemon 核验项目、身份、时效与防重放收据，审计注明管理员 service／Worker／instruction／call，不伪造用户或开发 actor。
- 跨项目受控源码目录／分页正文读取；拒绝隐藏、认证／凭据／私有材料、日志／数据库等敏感路径及符号／硬链接，文本经凭据模式清理。不直接写 canonical 源码；源码修改和测试通过正式 order／child 和其正常 Git worktree 进行。
- 非私密设备配置，以及项目 daemon 和 Host 的真实生命周期适配；停止／重启仍走原服务安全门，不把权限免确认解释为强杀忙碌项目。

明确不开放：管理员创建／新输入／确认控制 API，退役能力，原始凭据／token／私有 Prompt／私密环境读取、任意 Shell 和直接 canonical 写入。交互 OAuth 登录流程目前不适配模型工具，须用户在已有设置实际登录；这是身份认证流程，不是管理员指令中新增逐项操作授权。管理员不能替用户答复普通 Valet 的授权或自身决策 Notice。上述排除由可信工具／RPC 代码执行，不只写提示词；不把这些未开放项宣称为已实现。

这是应用身份、工具和 RPC 隔离，**不是操作系统沙箱**。拥有同一系统用户任意本地代码执行／私有文件访问能力的外部程序仍处于系统用户信任边界内；不能以 owner-only 文件和 Agent token 校验宣称抵御同 UID 的恶意系统级程序。部署不自动更新已运行进程；用户应在安全点分别更新管理员服务、Host 和相关项目 daemon，不在开发中自动重启真实服务。

## 执行与审计责任

每条输入有独立持久执行身份；工具调用先持久记录开始，完成与结果保存后才能证明完成。可信签名执行返回的顶层 unknown 收据必须保持 tool／instruction／Worker unknown，保留原结果并禁止追加；查询结果中被查目标的嵌套 unknown 不等于本次查询失败。原始失败的安全采样放 `original_failure.detail:{source,error:{name?,code?,message?}}`，消息最多2048字符，保留采样来源和阶段，不采集 stack／cause／stderr／response／body／stdout，剔除服务凭据和私有 Prompt。停止／恢复与后续审计错误不覆盖首次已记录采样；UI 默认显示安全原错，审计按需展开。异常、重启和断连保留首次失败与副作用确定性，不自动重放已经开始的输入或未知操作。停止保留真实运行 owner 至实际退出，撤销未开始调用；已发生副作用不回滚，历史不抹除。多项目目标始终显式，不设置可变全局当前项目。源码和必要诊断数据走实际可信工具，不沿用普通 Valet 的元数据投影；私有材料的排除不能只靠模型提示词。

验证只用隔离设备目录、项目、可控 Provider 和真实工具 bridge，覆盖用户入口确认、精确内容绑定、跨项目调用、普通身份拒绝、免逐项确认、失败／unknown 与紧急停止。W363 负责各部分接线、集成和最终代码树全量；子 Worker 做各自专项及受影响回归，不逐层重复全量。
