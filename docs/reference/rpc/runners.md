# Runner 管理接口

这些接口管理设备节点、私有控制凭据及项目授权；显式部署／恢复另需下述冻结计划和独立批准，不迁移已有 Worker。远端执行／交付由 Project 生命周期负责；管理诊断通过不等于完整远端工作流已验收。架构与已确认范围见[设计](../../design/remote-workspaces.md)，节点部署要求和认证格式见[Runner 协议](../../engineering/runner-protocol.md)。

## 权限与入口

全部 `runner.*` 方法仅用户可用，普通 Agent、整合 Agent、Valet 直调及其受控管理代理均拒绝；不是可通过管理确认解锁的能力。`src/rpc/runner-methods.js` 是 RPC 参数、CLI 命令及 HTTP/Host 允许集的共享来源。读配置不发 SSH；`runner.ssh.test` 只测试 SSH 登录、不调用 Runner；诊断 `runner.nodes.check` 和现场核验 `runner.worker.reconcile` 只在显式调用时连接用户预装的 Runner。手工节点固定使用 SSH alias 和 `lush-runner serve`；受管节点仅使用原已确认安装的内部固定启动描述，不接受自定义传输、命令、安装脚本或远端配置路径，也不回退手工入口。

CLI 使用 `bun run lush runner … --json`，不支持 `lushc runner`。默认经所选项目的 RPC；设备命令加 `--scope device` 时直接使用设备服务，不发现项目、不启动 daemon，也不接受 `--project`。`runner project` 必须使用项目 RPC，不接受 `--scope`。写入使用 `--file PATH`，文件为 owner-only 普通 JSON 文件（拒绝符号链接，最多 128 KiB），包含完整 RPC 参数；除初始部署 plan 外，突变需要 `expected_revision`；不接受秘密 argv 或 stdin。确认结果直接返回，不自动追加读请求或重试突变。

## 参数与结果

| RPC | 参数 | CLI |
| --- | --- | --- |
| `runner.deployments.get` | `{}` | `runner deployments get` |
| `runner.deployments.plan` | `{ssh_alias,name,project_id}` | `runner deployments plan --file PATH` |
| `runner.deployments.apply` | `{id,expected_revision,approved_actions,confirm:true}` | `runner deployments apply --file PATH` |
| `runner.deployments.confirm` | `{id,expected_revision,runner_id,confirm:true}` | `runner deployments confirm --file PATH` |
| `runner.deployments.reconcile` | `{id,expected_revision}` | `runner deployments reconcile --file PATH` |
| `runner.deployments.recovery.plan` | `{id,expected_revision}` | `runner deployments recovery plan --file PATH` |
| `runner.deployments.recovery.apply` | `{id,expected_revision,recovery_id,approved_actions,confirm:true}` | `runner deployments recovery apply --file PATH` |
| `runner.deployments.recovery.reconcile` | `{id,expected_revision,recovery_id}` | `runner deployments recovery reconcile --file PATH` |
| `runner.ssh.discover` | `{}` | `runner ssh discover` |
| `runner.ssh.test` | `{ssh_alias}` | `runner ssh test SSH_ALIAS` |
| `runner.nodes.get` | `{}` | `runner nodes get` |
| `runner.nodes.set` | `{nodes,expected_revision}` | `runner nodes set --file PATH` |
| `runner.nodes.check` | `{node_id,project_id?}` | `runner nodes check NODE_ID [--project-id PROJECT_ID]` |
| `runner.credentials.get` | `{}` | `runner credentials get` |
| `runner.credentials.set` | `{node_id,machine_token?,project_id?,control_token?,expected_revision}` | `runner credentials set --file PATH` |
| `runner.credentials.remove` | `{node_id,project_id?,expected_revision}` | `runner credentials remove --file PATH` |
| `runner.project.get` | `{}` | `runner project get` |
| `runner.project.set` | `{allowed_node_ids,default_node_id,expected_revision}` | `runner project set --file PATH` |
| `runner.worker.reconcile` | `{id,expected_revision}` | `runner worker reconcile ID --expected-revision N` |

- **节点 get/set** 返回 `{version:1,revision,nodes}`。revision 为 64 字符小写 hex 字符串，不是整数。set 完整替换最多 64 个节点；省略的节点退出当前登记，历史 ID 不复用。新增节点省略 `id`，返回稳定 UUID；已有节点必须带原 ID，不允许自行指定新 ID。
- 节点字段为 `{id?,name,ssh_alias,expected_runner_id?,enabled,budgets:{max_commands,timeout_ms,output_bytes}}`。名称最多 80 字符；SSH alias 是最长 128 字符的单一安全别名，不是 `user@host`、选项或命令。预算为正整数，分别最多 64、86400000、67108864，执行时还受 Runner 更小的实际限额约束。节点身份的 alias 固定；`expected_runner_id` 初始为 null，用户显式保存后不可改写或清空，换机须登记新节点。
- **check** 返回 `{node_id,runner_id,checked_at,protocol_version,implementation_version,platform,arch,capabilities,limits,max_commands,memory_reserve_bytes,pinned}`。`limits`／`capabilities` 来自协议注册来源。它不保存检查时间或新 pin，不创建工作区、授予 Run 或调用模型；已 pin 的节点身份不匹配则失败。项目 RPC 默认使用该项目持久 `project_id`；Host／设备 CLI 必须显式给出配对 `project_id`。没有凭据不能匿名诊断。
- **凭据 get/set/remove** 只返回 `{version:1,revision,nodes:[{node_id,machine_configured,projects:[{project_id,control_configured}]}]}`，不含 token 或哈希。初始 revision 是字符串 `absent`，之后为随机 UUID。set 至少更新机器 token 或一个项目 control token；`project_id` 与 `control_token` 必须同时提供，缺省的其它凭据保持。remove 带 project_id 只删该项目 control token，不带则删该节点全部凭据。项目 ID 是最长 128 字符的不透明身份，不是路径。
- **project.get** 返回 `{version:1,project_id,revision,authorization_version,allowed_node_ids,default_node_id}`。未初始化时 project_id 为 null、revision 为 0、授权空、默认 `local`；读取不分配 ID。set 使用非负整数 revision，成功返回 `{policy,stop_bindings}`；policy 为新读模型，stop_bindings 为被撤销节点的绑定摘要，不代表已经停止。授权列表最多 64 个不重复的已登记节点 UUID；新选默认必须是 `local` 或列表中的节点。撤权可保留原默认节点，使后续默认创建明确失败，不能静默改投本地。首次显式保存分配稳定项目 UUID。

未知参数、错误类型、重复授权 ID、超限、陈旧 revision 均拒绝；没有 `force` 或无版本覆盖。保存返回是配置发布的确认，不是工作区回收或远端进程退出的证明。禁用、移除凭据、撤销授权会使新准入失败并通过中央服务请求停止已跟踪 Run；失联／未确认停止保持持久 unknown。设备配置由其它进程更新时，Project 服务的最新准入检查和独立监测负责撤销；Host 不枚举／调度各项目。

## SSH 别名发现与独立试连

`runner.ssh.discover` 返回 `{aliases,status,limited}`：status 为 `ok`、`missing` 或 `unavailable`；limited 表示跳过不支持／不安全配置或达到预算，不代表完整解析。仅读取 **Host 当前系统用户**（不是浏览器用户、项目目录或可传入路径）的 `~/.ssh/config`。只列最长 128 字符、安全的具体 Host 别名，忽略通配／否定项、Match 块及不安全 Host 子句；不返回主机地址、用户名、路径、配置正文、私钥或秘密。读取不联网，不运行 `ssh -G`、Match exec 或其它命令。

Include 仅支持 `.ssh` 内相对路径、`~/.ssh/` 或该目录的绝对路径；只允许末级文件名 `*`／`?`，不支持目录通配、转义、变量／百分号展开、续行、外部路径或符号链接。文件和目录必须属当前用户且不可被组／其它人写入；目录 FD 逐段 no-follow 校验，普通文件有界读取。最多 32 文件、128 KiB 总量、每文件 64 KiB、4 层 Include、256 个目录项和 256 别名；循环、私钥正文及超限会跳过并标 limited。无安全可读配置时明示状态，用户仍可手填别名。

`runner.ssh.test` 不依赖节点登记、Runner 安装、机器／项目控制凭据或项目授权，不保存配置。它重新读取上述文件，生成临时私有安全子集（Host、HostName、User、Port、用户 home 内 IdentityFile、IdentitiesOnly）；**不使用原配置或系统 SSH 配置**，不支持 Match、ProxyJump／ProxyCommand、Include 外部路径或其它扩展。支持普通双引号字面值和 Host 通配／否定继承，保留原有子句顺序；不解释单引号、反斜杠转义或百分号展开。Host／Match 块内的条件 Include 仅供发现，试连不将它静默展平为无条件配置。只要整个用户配置有被跳过／不支持内容或未完整读取（即使位于其它别名块），就保守返回 `config_unsupported`，**不启动 SSH、不忽略后尝试连接到其它目标**；手填别名也不绕过此门。配置不存在时可对手填安全别名使用 SSH 默认解析。依赖不支持功能的连接应由用户另行核验，不能把受限预检拒绝当作原生 SSH 一定不可用。临时文件 0600／目录 0700，结束删除；不读取 IdentityFile 的私钥正文。

通过配置安全门的显式调用只启动一次 SSH，远端命令固定 `true`，禁用交互、首次信任／host key 更新、代理、LocalCommand、KnownHostsCommand、转发、agent 转发、连接复用、密钥自动加入 agent、CanonicalizeHostname、PKCS11Provider 和 SecurityKeyProvider 扩展。严格已有 host key，连接尝试一次，连接超时 10 秒、总截止 12 秒，stdout/stderr 合计超过 16 KiB 即停止；原始输出不返回或记录。没有自动重试、安装、信任变更或失败后回退。服务内单飞；结果 `{ok,reason,checked_at}`，reason 为 `connected`、`not_confirmed`、`timeout`、`output_limit`、`config_unavailable` 或 `config_unsupported`。`ok:false` 是已返回的失败诊断，不是保存失败／未知写入。

**SSH 成功 ≠ Runner 可用**，也不授予项目权限或自动保存节点。新增节点弹窗可选发现的别名或手填，试连是独立可选动作；失败保留填写，输入变更／关闭／离页后的旧响应失效。可信远端的登录 shell 启动文件、SSH 服务端强制命令及认证设施仍由用户负责；固定 `true` 不承诺能阻止远端自己的登录副作用。真实 SSH／系统 OpenSSH 兼容性仍需用户授权实机验证。

## 显式部署与原安装恢复

部署入口均返回下节的单条收据白名单投影；HTTP 200／CLI 退出 0 只表示收到收据，必须检查 status、blockers 和对应恢复状态，不代表安装或恢复成功。所有步骤仅用户可用，支持设备作用域；不接受自选产物来源、远端路径、命令、配置正文或凭据。

- **plan** 显式允许取得固定已审查官方 Bun 与执行版本的 Runner 生产闭包，安全快照后只读探测 SSH；冻结目标、ABI／CPU、产物摘要、文件、完整系统事务、独立动作与节点预算。只返回 planned 或 blocked（不确定为 unknown），不安装、登记节点或生成配对凭据。配置受限／不完整时在产物和 SSH 前拒绝。临时产物仅属本进程，重启后不按旧路径重建／重传。
- **apply** 的 id 是原部署 UUID，expected_revision 是该收据当前正整数修订；approved_actions 必须恰好完整、不重复地列出 plan.actions 的所有 id。特权 Git 安装与 cgroup 准备各自独立批准，不能继承默认授权。发送前重检原快照与完整字节；仅支持完整的非交互系统子集。新节点先禁用／未 pin，生成独立私有配对，上传并验证真实 Runner、Bun／FFI、活命令原取消、完整输出和树停止屏障，再 seal 为 ready。没有项目执行授权。
- **confirm** 只处理原 ready 安装，runner_id 必须为该收据已验证的原 ID；重新检查原 seal／配置并认证 hello，才 pin／启用。不是项目授权，也不新开命令。部分写入／ACK 丢失仍为 unknown，不能通过换别名、UUID、重装或认领绕过已有安装保护。
- **reconcile** 仅记录独立观察并检查原请求；没有安装 intent 时不连接 SSH。不重放安装／sudo／命令，不补确认，不采用新描述或清除任何旧屏障。
- **recovery.plan** 只检查原 confirmed 安装并追加独立计划，不开始恢复。后续 id 仍是安装 UUID；recovery_id 来自新增 recoveries 条目，expected_revision 仍是根收据当前修订。
- **recovery.apply** 独立批准该恢复计划的全部动作（总有 bind_runtime_generation；需要时单独批准 start_original_unit 的原精确 path／SHA／摘要／影响）。先关持久普通准入门，再用一次性 provisional 入口认证原 ID、验证原取消与完整屏障、关闭验证连接、seal、中央 gated CAS 发布、激活原 publication，最后记录 ready／新代次。原身份、配置、产物、凭据、项目权及历史未知不变；不清旧 slot。新活动或快照漂移拒绝，不刷新授权。
- **recovery.reconcile** 仅观察原 recovery_id；即使看到 activated，也不补发布／激活、采纳新代次或打开 gate。恢复 running／unknown 在新控制器和进程重启后仍阻止普通连接及建 Worker；不能重试 apply 或另建计划解除。

当前验证覆盖真实用户 CLI／HTTP 到受控 SSH 的 fail-closed 链及独立产物／Runner 专项；完整上传生产 Runner、专属真实 cgroup 停止和重启恢复正向链仍需明确授权的隔离环境验收。受控进程／系统适配器不等于该证明，不得借现有用户管理器 cgroup 或伪造 seal 跳过。

## 部署收据只读入口

`runner.deployments.get {}` 返回设备私有部署历史的白名单投影 `{version:1,items,truncated}`，最多 64 条；未知／执行中记录优先，其余按最近更新时间排列。读取不创建配置目录、下载产物、连接 SSH、安装、对账或重放。项目入口和 `--scope device` 读取同一设备历史；其中的 project_id 不授予项目执行权限。

每条包含 `{id,revision,status,ssh_alias,name,project_id,node_id?,runner_id?,created_at,updated_at,plan,stages}`。revision 是该收据的正整数修订，不是节点或凭据 revision；status 为 `planned/blocked/running/ready/confirmed/failed/unknown`。plan 仅公开目标摘要、固定安装位置、运行时／Runner 版本及摘要／大小、文件清单、动作与阻塞、依赖和 cgroup 摘要；存在时，`node_budgets` 公开固定的 `max_commands/timeout_ms/output_bytes`，用于核对批准时的节点上限，不随当前默认设置变化。特权动作可包含精确 unit 路径／摘要／作用说明；Git 动作可包含有界依赖包版本事务及截断标志。不返回凭据及其哈希、私有证据、产物本地文件、unit 正文、脚本、argv、仓库资料或原始 SSH 输出。

存在原请求观察时可附 `observation:{id,status,created_at,completed_at?,local?,remote?}`：local 仅含登记／配对是否匹配；remote 仅含完整性／封存／原描述匹配、固定阶段状态及有界系统 installer 终止观察，不含新描述、凭据指纹或 invocation。observation 的 complete 只是本次观察完成，不提升原收据状态、不补 pin／授权或清除旧执行屏障；unknown 也不表示远端没有副作用。私有对账每次保留独立 intent／原请求关联，最多 16 次，达限拒绝而不覆写历史；GET 不发起上述写操作。

已检查原安装恢复时可附 `runtime_generation`（已确认代次数）、`recoveries:[{id,status,created_at,updated_at,plan,stages,observation?}]` 与 `recoveries_truncated`，最多 16 份，不滚动覆盖；恢复 running／unknown 也优先展示。plan 仅含 from/to_generation、boot_changed、前后 cgroup 路径／changed、supported、固定动作／blockers、verification_budgets 及 old_commands 摘要。特权启动动作单列原 unit path／SHA／摘要／影响，其余私有计划哈希、boot／机器／配置／凭据指纹、原命令 ID／proof／完整单元或脚本不公开。原安装仍为 confirmed 不表示新恢复成功；ready 才表示该恢复已完成独立验证、封存、中央发布与原代次激活，unknown 不能重试或另建计划绕过。恢复 observation.complete 也只是查完原请求，不能解除旧屏障、补激活或授项目权；GET 始终不发起检查或恢复。

持久 running 收据没有活动操作锁时，读取结果保守显示 unknown，不改写原收据、释放保护或推断进程已停止。有活动锁时保留 running；未完成 observation 同样只在失去操作锁时投影 unknown。跨进程并发读不抢占操作。私有存储不安全或不可验证时拒绝，不自动修正权限或覆盖文件。ready／confirmed 不是项目授权；读取到任何状态都不是安装、停止或后续 Worker 执行成功的替代证明。

## HTTP

- 项目：`GET /api/runner/deployments`、`/api/runner/ssh/aliases`、`/api/runner/nodes`、`/api/runner/credentials`、`/api/runner/project`，不接受查询参数；全局工作台需带现有 `/p/<项目路由ID>/` 前缀。所有写入、SSH 试连及显式 check 使用 `POST /api/action`，body 为 `{method,params}`。
- Host 无项目：`GET /api/host/settings/runner/deployments`、`/api/host/settings/runner/ssh/aliases`、`/api/host/settings/runner/nodes`、`/api/host/settings/runner/credentials`；可选既有 `scope=device`。设备写入／SSH 试连／check 使用 `POST /api/host/settings/action`，相同 body；不提供 project.get/set。Host check 必须显式 project_id，不为此打开或启动项目。
- 沿用登录、同源校验、128 KiB 请求限制与 `Cache-Control: no-store`。Runner action 不接受查询参数、额外 envelope 字段、Agent token 或任意路径。公共结果统一白名单投影，原始认证响应不会作为错误或日志返回。HTTP scope 不是跨项目授权。

## 创建节点选择接缝

`order.submit` 与 `worker.spawn` 增加可省略的 `runner_node_id`：只接受节点 UUID 或 `local`，不接受 null／空串；省略由 Project 创建时选择，不能迁移已有 Worker。CLI 分别为 `lush order '目标' --runner-node UUID|local` 和 `lushc worker spawn '目标' --parent ID --runner-node UUID|local`。节点授权、继承与固定由 Project 创建实现负责，不由参数转发证明已经生效。

普通 `order.submit`／CLI order 保持可靠发射语义：显式节点随 `input.emit` 的 order 模式保存到 `drafts.input_options`，支持条件、独占与 `--buffer` 暂存；挂载收据及草稿读面返回 runner_node_id，不冒充已创建 Worker。`draft.add/update` 使用同源字段，编辑省略保留原节点；仅 `draft.update` 的显式 `runner_node_id:null` 表示清除覆盖，持久选项中删除该键，在实际创建时解析项目默认，而不是固定编辑或挂载时预览的节点。该操作仍要求匹配版本且草稿未挂载、未提交；仅 order 模式接受，不将 null 扩展到创建／发射入口。旧草稿省略不回填，不改变旧请求指纹。append／management 不接受节点选择。已挂载输入不能编辑；相同 client_request_id 改节点或从显式改成省略都拒绝，失败／未知后不自动改投或重放。

发射已有草稿时只能使用 `{draft_id,expected_revision,...}`，节点从草稿取，不能在请求中临时覆盖。携带节点选择的草稿不支持旧 `start:false` 直接提交／defer Hook；应经 input.emit 发射。显式 CLI `--defer` 与节点选择同样拒绝，避免旧 Hook 丢失字段。没有显式选择时保留原默认语义，在实际创建时使用当时项目默认节点。远端 Worker 不支持挂载 Shell 命令 Hook 的本地执行路径；即使外部 Git 操作签出了其中央 ref，也必须拒绝，不能在那里执行远端代码命令。

接口接缝：RPC `order.submit {content,start:false,runner_node_id}` 直接创建传递第九个 Project.order 参数；spawn 传递第七个 Project.spawn 参数；可靠发射从已保存 options 向 sendOrder 第十三参传递节点。发射挂载在解析有效 profile 后、派发前及创建 guard 均复用 Project 的 selectCreationRunner 检查当前授权与支持矩阵，失败保留已选节点和原文；最终创建再次核对固定身份。`test/project/runner-emission-chain.test.js` 验证真实用户 CLI → RPC → 持久选择非默认节点 → Project 创建 → 租约／Bridge → 独立 Runner 提交 → 中央对象接收；可控 Provider 与 containment 不代表 SSH／cgroup 实机或完整递归交付验收。

## Worker 位置读面

`worker.inspect`、列表／树及启动上下文的远端 Worker 增加 `runner:{node_id,runner_id,workspace_id,generation,revision,state,head_commit,authorized,barriers}`。`state` 是持久绑定状态（preparing／ready／unknown／removed）；`head_commit` 是中央已接收提交，不冒充远端实时 HEAD；`barriers` 为 Store 各类未结算项的计数，零计数不证明在线。`authorized` 只表示当前项目授权，设备启用及连接可用性仍须分别核对。读此投影不连接节点或读取秘密。没有 `runner` 字段的历史／本地 Worker 保持本地行为，不随项目默认迁移。

## 显式核验远端现场

D656 采用独立用户动作，不并入 retry；unknown 绑定的 retry 必须先通过此核验。`runner.worker.reconcile` 的 id 是当前项目 Worker 整数 ID；expected_revision 是 `worker.inspect.runner.revision` 的正整数绑定修订，不是项目授权 revision。陈旧修订、活动调用、并发同步／核验等准入错误拒绝请求；网络核验失败不自动重放。项目使用既有 `POST /api/action`；Host device、Agent、lushc、远端协作工具和 Valet 管理代理均无此权限。

结果白名单：`{worker_id,node_id,runner_id,generation,revision,state,reconciled,blocked_reason,checked,pending}`。checked 为本次查询的原请求数；pending 为尚存绑定／Run／操作屏障计数，非活动 Worker 数。`reconciled:false` 与 `blocked_reason:"evidence_incomplete_or_changed"` 明确表示尚未恢复，不能因 HTTP 200 就显示核验成功。返回不公开内部收据、参数、路径、脚本、文件正文或凭据。

核验固定安装／工作区／代次、中央 HEAD、真实停止和已登记工具请求的身份、方法、参数摘要、完整历史。它只查询原 request_id，不重新发送原文件写入／编辑／命令。新的 Bridge 在发送前固定中央 tool 收据，command.start 的 ACK 不等于停止；未知或收据落盘失败禁止后续新写入。准备记录失败不发请求；收到 ACK 后落盘失败也保留屏障。中央只保存路径哈希、内容哈希等核验元数据，不备份未提交内容；旧 Run 没有完整 journal 时不能补猜历史。新 journal 的持久计数与工具收据在同一事务内增长，区分确实未发工具与收据丢失；发送前落盘失败、计数仍为零时可核验固定现场，不据旧空表推断安全。不同的对象、父同步或清理屏障不得借工具核验覆盖。

只有完整请求历史、调用前元数据及已确认文件结果能解释的未提交文件可保留并解除对应 unknown；不存在全局允许 unknown dirty 的开关。读取与历史均有界（最多 256 个工具请求及 256 个脏路径，文件仍受 Runner 文件预算）；无法核验的暂存 index、删除、忽略目录、超限、缺失／不完整收据、未知停止、身份漂移或额外脏文件仍阻塞，绝不 reset/clean。凭据仍有效时，撤销中央项目执行授权不禁止固定证据核验，但核验不重新授予执行权限。

成功仅更新对应工具收据、Run 停止事实和绑定状态，**不改变 Worker 生命周期／calls，不启动模型，不自动 retry/resume，也不表示工作区干净、已交付或已验收**。用户需另行决定是否重试；按钮应刷新返回的绑定 revision。核验期间使用逻辑门与 revision CAS 排除重试／验收／交付竞争，网络等待不持中央 Git 锁或 SQLite 事务。

## 手工预装节点首次配对与失败处理

1. 对所选中央项目读 project.get；若 project_id 为空，显式保存空授权和 `default_node_id:"local"`，获得项目 ID。
2. 在设备登记 SSH alias（不含 pin）。用户按协议在远端预装 Runner、配置 Linux cgroup v2 专属子树及节点 ID；Lush 不替用户设置系统。
3. 用户用密码学随机源生成独立机器／项目控制秘密（推荐各 32 随机字节编码为 hex 或规范无 padding base64url），把原始秘密写入中央私有 JSON 输入文件，经 credentials.set 保存。节点配置只保存对**原始编码字符串字节**的 SHA-256 小写 hex，项目映射使用第 1 步的 ID。不要把秘密放 Shell argv、聊天、版本库或日志；秘密轮换不等于确认旧进程停止。
4. 显式 check，用户核对安装身份后，在 nodes.set 中保存该 runner_id 为 expected_runner_id。check 自己不接受／更新 pin。
5. 明确保存项目授权和默认节点。后续 Worker 准入还需支持的 Pi 配置、固定绑定、工作区及租约安全门。

写请求断线／结果未知时先读配置和项目／节点诊断，不盲目重放。成功 ACK 后另一次刷新失败，不撤销已发布配置也不再提交同一写入。已 pin 节点的身份异常、离线或未知执行没有本地回退；只读对账、停止和受检回收的权限边界仍由生命周期控制。独立进程测试不证明真实 SSH、cgroup 或跨机性能。
