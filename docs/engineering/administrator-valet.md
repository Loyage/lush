# 项目内管家的单条密码提权

W363／D738 取代 D737 的设备级独立管理员方向：运行和权限都属于当前 canonical 项目；创建时的首条输入与后续追加均可选择**仅本条管理员权限**，下一条默认普通。提权重新验证当前 Lush Web 登录密码，不是系统 sudo／root，不开放跨项目或 Host／设备全局管理。当前入口位于项目输入与原生 V 管家详情，旧全局 ADM 页面仅保留历史兼容。

## 用户流程与界面

项目输入选择「管家」，默认仍是普通 Valet；增加未勾选的「仅本条提升为管理员权限」。选中后就地显示当前项目范围、风险及执行中不逐项询问权限。普通输入走原入口，不额外要求密码；提权输入核对完整内容、目标、模式与范围，并输入当前 Web 登录密码后提交。创建可在同一核对框明确确认“创建管家并执行首条指令”，不再先建空的全局管理员。

同一个项目管家保留原 V 编号与历史。详情默认显示本轮普通／管理员、运行／阻塞、首次失败／unknown 和紧急停止；输入框提供相同的单条提权选择。结果与执行记录默认显示，审计／收据／模型信息按需展开；窄屏单列、长文换行、控件至少44px。密码不进入指令、草稿、sessionStorage、模型、会话、审计或错误正文，取消及离页清空。内容／目标／模式／模型覆盖变化使旧核对失效；未知提交保留精确定义和请求身份，只读核对，不自动重发或换 key。

## 身份和入口授权

普通与高权限是**原生 management Worker 每个 occurrence 的独立执行身份**，不是把普通 token 永久增权。模型只收到当前已验证的权限摘要；运行凭据仍绑定真实 manager role、management task_kind、running invocation、未 abort 的 token 和当前 occurrence。用户不能通过普通 management.submit／worker.message、信号、Hook、CLI 或 RPC 自填 elevated:true 获权；模型和自动选择不能代答密码入口。普通 Valet 的实时逐项权限及历史确认不改写。

可信链路：当前 Web 会话与 Origin → 完整定义核对／确认 → 服务端重新校验登录密码和限速 → Host 签发项目／内容绑定的短期 proof → 当前项目 daemon 验签、去重与生命周期复核 → 保存独立提权 occurrence 和审计 → 固定项目管理员工具 → 原用户级业务处理器。密码仅由 Host 认证边界持有；daemon／Provider／工具不接收密码或密码哈希。

协议单一来源 `src/administrator/project-protocol.js`：

- 定义 `{kind:'submit'|'append',mode:'administrator',scope:'current_project',instruction,client_request_id,profile? | id}`。submit 可含原管理模型覆盖 profile；append 仅固定实际目标 id。正文不 trim；上限与原管家入口一致，为32000字符。
- HTTP 项目路径 `POST /p/<id>/api/management/elevate`（单项目绑定兼容无前缀），正文仅 `{definition,password,confirm:true}`。这是专用用户入口，不经通用 `/api/action` 代理，不接受 Agent token、客户端签名身份或免密参数。
- RPC `management.elevated_submit {proof}`、`management.elevated_append {proof}` 只接可信签名 proof，不接受密码／布尔批准；拒绝任何 Agent token。
- 只读 `GET /p/<id>/api/management/elevation-receipt?client_request_id=...` → 用户 RPC `management.elevation_receipt {client_request_id}`，返回 `{version:1,found,definition?,task?,instruction?}`。只证明原提交，不能作为执行成功或新授权。重新登录后可查原收据，但不能复用原确认获新权。
- 模型唯一高权限工具仍为 administrator；固定项目 bridge 调用 `manager.administrator_call {operation,params}`，actor 来自真实 invocation，不接收可替换身份、签名或目标项目覆盖。

proof 使用独立 `project-elevation-authority` 密钥命名空间，不沿用旧全局管理员的签名权。`project-elevation-proof.js` 固定项目、规范化精确定义、内容摘要、grant_id、会话派生绑定和五分钟准入期限；它不是模型可持有的永久 bearer 凭证。实际接受时在同一事务保存 request 去重与 `management.elevation_accepted` Event。私有 `pending_signal.elevation` 至少包含 `{version:1,mode,scope,project,grant_id,definition_hash,instruction_hash,occurrence_id,source_event_id,verified_at}`；source Event 含相同 grant_id、definition_hash、instruction_hash、occurrence_id。工具每次核对真实活跃 invocation 和这一代码生成的接受证据。

## 执行、隔离与未知副作用

已验证的单条提权输入不再逐项弹操作授权确认；原 Git／revision／资源归属／冻结／生命周期／真实退出门保留。允许当前项目用户级管理、开发、受控源码及必要诊断，不开放其他项目、共享设备设置、Host 生命周期、原始凭据／token／私有 Prompt 或任意 Shell；源码修改与测试经正式开发 Worker/worktree，不直接写 canonical。能力目录和方法集合由代码同源生成，退役及入口授权方法不能被代理。自动化写入仅保留项目内置生命周期设置；不允许注册／导入自定义 Shell、改写通用功能库或挂载／启用已有 Shell 功能，也不接受扩展／Skill 覆盖，以免间接持久化越权执行。普通管家原有权限不因此改变。

原生 management 的队列、一次性 occurrence、停止、急救和 unknown 保护继续适用。高权限调用复用现有 `control_calls`／Event 记录：先存开始，再调用，完成原子落地；稳定去重以当前 occurrence＋规范化 operation／params 为准，不信模型 tool-call ID。真实异步 owner 通过管理 control job／busy 跟踪至实际结束，Provider 返回不提前释放；写后异常与缺少完成证明均保留 unknown，不自动重放。首次安全错误采样与后续停止／恢复分别保存，不以最新状态覆盖原错。

普通和高权限使用不同模型会话和凭据，普通新轮次不得获得前次高权限结果、工具输出、私有状态或决策资料。提权 occurrence 正常结束后授权不沿用；普通追加和信号无提权标记。源任务结果仍供真实用户详情阅读，但普通 Provider 启动 JSON 必须剔除高权限结果，不能只靠提示词要求忽略。

## 旧全局管理员

D737 的设备级 ADM 数据、调用与收据只读保留，允许用户查看和安全停止；不自动迁移、删除、回填 V 身份或将旧确认转为新项目授权。全局创建／追加／模型执行入口退休；旧管理员签名 dispatch 不再授权新操作。项目输入与详情成为新能力唯一入口；旧全局地址可显示退役说明和历史，不伪造迁移完成。编码与验证不操作真实旧进程；部署由用户在安全点分别更新 Host 与相应项目 daemon。若仍运行旧版独立管理员服务，先由用户执行 `bun run lush administrator stop` 并只读核对实际退出；更新 Host／项目 daemon 不会热替换那个旧进程。停止不撤回既有副作用，未知结果继续保留，不重放。

这是应用身份／工具／RPC 隔离，不是同 UID 恶意程序的 OS 沙箱。Web 密码重新验证不能代替传输加密，远程访问应使用 HTTPS 或用户已有安全隧道；不记录真实密码，不改真实设备权限。

## 分工与验证

Host 密码门位于 Web 认证与项目专用路由；`project-elevation-proof.js` 负责签名与真实 invocation 校验，`management-elevation.js` 负责原生持久化入口，`project-execution.js` 与专用 bridge／extension 负责固定项目工具。Provider 为每个 occurrence 分离普通／管理员会话及启动文件，执行阅读与安全回收识别这些文件。最终集成与全量由顶层开发指令负责，子成果只提供专项和受影响回归证据。

复用／替换已有少量主流程：真实登录密码确认 → Host 签名 → native management occurrence → 可控 Provider → 固定 bridge → 权限／当前项目校验 → 用户级 handler → 原始结果／unknown；普通身份／错误密码／改内容与项目拒绝、下一条恢复普通、会话不泄漏、停止保留 owner。所有项目、密码和进程均为隔离夹具；不使用真实账号、付费模型或真实 Valet 失败调用。
