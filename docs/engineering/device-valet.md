# 设备管家：共享模型资源的单条密码授权

W400／D782 在全局工作台新增独立「设备管家」，管理当前后台机器同一系统用户共用的 Lush 模型与来源。它不是操作系统 root，也不是跨项目开发调度器。项目管家和项目单条管理员提权仍属于各自项目；旧全局管理员历史、确认和退役入口不迁移、不恢复。

## 用户入口与身份

全局侧栏进入 `#device-valet`。默认显示新建指令输入、核对执行按钮与有界最近列表；模型与高级设置默认收起，无明确托管来源／模型时展开并引导先配置来源。详情默认显示指令、结果、状态与错误／阻塞；追加与停止直达，模型和审计按需展开。窄屏单列、长文换行，触控目标至少 44px。

每条新建和追加都核对完整指令、明确来源／模型和设备影响范围，再重新验证当前 Lush Web 登录密码。本条执行中不逐项重复授权，但下一条不继承前次密码或凭据。只支持明确的托管 Pi 来源，不继承机器 Pi 认证、项目上下文、私有 Prompt／env、扩展、Skill、MCP 或普通文件／Shell 工具；每条输入使用独立模型会话。

设备管家保存真实 `worker_number`（如 DV1），显示时不从 UUID 或页面顺序推算编号。它有自己的 Worker、Message、Run、Event 与工具收据，不产生项目 Input、Git 分支或开发合并流程。

## 权威与能力边界

- Host 只负责现有登录／Origin 校验、密码重验及受信控制转发，不保存 Worker 权威事实，不运行或调度管家。
- 独立设备服务位于 `launcherStateDir(env)/shared/device-valet`，使用私有数据库、控制凭证、锁及本地 socket；不启动伪项目或依赖项目 daemon。读取页面、状态、列表或来源选项不启动 Agent，也不启动设备执行服务；首次验密提交才请求服务启动。
- 设备方法清单唯一来源是 `src/core/agent-resource-policy.js`，纯协议 `src/device-valet/protocol.js` 同源供模型扩展、bridge、服务和页面使用。模型只注册并激活 `device_valet`，先读取目录，再调用已审核的方法；没有任意 RPC 直通。
- 资源执行复用 `DeviceSettingsService` 的原参数校验及持久化边界。安全模型／来源查询是 read；共享元数据、模型登记、显式默认配置修改及联网刷新是 write。目录中的访问分类不替代真实 invocation、当前输入、参数及原资源安全门。
- 不开放 `agent.config`、凭证/token、私有 Prompt／环境变量读取；元数据保存与完整配置写入拒绝秘密和可执行资源字段。密码、认证、安装扩展、Shell、项目操作、Host 控制及新增授权入口不能由模型代理。真实用户仍可在原设置界面录入凭证。

服务用户控制通道只接受私有控制凭证；模型通道只接受单次 invocation token。库中只存 token 哈希，工具执行同时核对真实 running Run、未 abort owner、当前输入内容／模型的持久授权摘要。仅传 `scope`、声称来自全局页面或设置布尔字段不能获得设备身份。这是应用权限隔离，不是同 UID 恶意程序的 OS 沙箱。

## HTTP 与读面

接口固定在根 `/api/host/device-valet/`，项目前缀同名路径拒绝。全部沿用 Web 登录、Origin、JSON、no-store 和 Agent 凭据拒绝；密码仅进入专用 `submit`，不经通用 action 转发。

| 方法与后缀 | 语义 |
| --- | --- |
| GET `options` | 安全托管默认 profile、来源及模型目录／登记选项，不联网或启动管家 |
| GET `status`、`list` | 服务状态与有界最近 Worker，读取不启动离线服务 |
| GET `detail?id=...` | 当前 Worker、关联指令与有界 Event 页 |
| POST `submit` | 精确 `{definition,password,confirm:true}`；规范化 definition 含 create／append、完整原文、请求 ID、明确 profile，追加另含目标与预期 revision |
| GET `receipt?client_request_id=...` | 只读核对精确原提交，返回 found 和原 definition／Worker／指令，不证明执行成功 |
| POST `stop` | 精确 `{id}`，请求停止，不承诺操作或进程已退出 |

列表与详情 `limit` 默认 30、最大 100，`before`／`next_cursor` 为实际返回边界；继续读取不按请求页长推算。详情 `history_complete:false`，不能把已读页当完整历史。结果超过读面预算时显式标记 `worker.result_truncated`；关联指令避免重复大结果，返回 `result_available_on_worker`，详情的 Worker 结果只代表当前一轮。离线列表返回 `online:false` 和 `device_valet_offline_history_unread`，不是“历史为空”；离线收据未找到也不证明未执行。

密码错误或限速只在真实执行前返回固定 `elevation_password_rejected`／`elevation_password_rate_limited` 与 `execution:not_started`；页面只把对应 401／403／429 当可信未提交证据。其他失败、断连或不完整响应保留 unknown。密码只短暂存在本次 DOM／请求局部变量，取消、提交、内容／模型／目标变化、离页均清空，不进入模型、数据库、草稿或 sessionStorage。

## 去重、退出与恢复

新建及追加按持久 `client_request_id` 和完整规范化定义去重；同 ID 改内容、目标或模型拒绝。写工具请求按当前 Message 和规范化方法／参数去重；改变工具 call ID 或对象键顺序不重做同一写操作。已开始写入失去完成证明则留 unknown，不能根据相同异常文本推断未执行或自动重放。

浏览器在发送前保留不含密码的精确原定义与请求 ID。提交完成响应未知时锁住同类新建／同目标追加，只提供只读核对；迟到响应不得覆盖新页面。找到匹配原收据才解除未知提交锁，找到提交也不等于业务成功。

停止立即撤销新工具准入并中止 Provider，但运行 owner 一直保留到真实进程及已准入异步资源处理器收口。Provider 返回或停止请求返回不能提前宣布退出；写后错误仍保留 unknown。仅正常成功、无 owner／未知副作用且未停止的 Worker 可追加新一条密码授权。服务重启将历史 running 标为未知、未开始 queued 取消，不重放旧输入或未知写。新服务与旧 ADM 存储／控制凭证完全隔离。

## 验证与部署

`test/device-valet-runtime.test.js` 保留一条代表性真实链：Web 登录密码 → 新设备服务身份 → 可控 Node Provider → 唯一注册／激活工具 → 真实 Bun bridge → 资源服务读写 → 持久收据；同流程核对追加独立授权、去重、未知写不重放、实际停止 owner 和秘密不泄漏。原管理员／Host／来源专项保留退役与隔离回归。Web 默认层级、密码、未知收据与离页守卫复用 `test/web/dom-administrator-page.test.js`；真实浏览器布局与 DOM 联接真实 HTTP 的临时探针另留交付证据，不冒充付费模型验证。快速集成组合由 `scripts/test-integration.js` 单点维护，不能替代最终全量。

部署仍由用户选择安全点：Host 必须更新以获得新入口／密码路由，各项目 daemon 另行更新项目管家读写策略，不能仅刷新页面。设备服务是独立执行进程；已启动的旧代码不会因 Host 重启热换，需在确认实际执行与资源 owner 安全收口后由用户更新该服务。开发与测试不重启真实服务，不读取真实设备凭据。
