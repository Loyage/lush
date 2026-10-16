# Runner 内部协议

本章描述远端执行基础设施与 Project 接缝；用户入口见[Runner 管理接口](../reference/rpc/runners.md)，产品边界见[远端工作区设计](../design/remote-workspaces.md)。SSH 信任、预装 Runner 和专属 cgroup v2 子树由用户提供；不安装软件或修改系统设置。

## 共享骨架

`src/runner/protocol.js` 是版本、操作、能力与错误码唯一来源。版本 1 请求：

```json
{
  "version": 1,
  "request_id": "unique-operation-request",
  "method": "workspace.inspect",
  "identity": {
    "project_id": "opaque-central-project", "node_id": "node-a",
    "runner_id": "installation-uuid-from-handshake",
    "worker_id": 42, "workspace_id": "opaque-workspace", "generation": 1,
    "operation_id": "authorized-control-operation"
  },
  "auth": { "machine_token": "private", "control_token": "private" },
  "params": {}
}
```

`node_id` 是中央设备配置的节点注册 ID；节点 root 的 SQLite 独立持久保存 `runner_id` 安装身份。hello 返回安装身份并接受 `expected_runner_id`，其他请求必须在 identity 内携带匹配的 `runner_id`，工作区键和收据也绑定该身份，防止 SSH 别名换机后接纳旧现场。身份包含 `run_id` 或 `operation_id`，严格二选一。Run 请求用 `run_token` 替代 `control_token`。机器认证与项目控制／调用授权同时校验；缺失不具有用户权限。认证字段不可交模型、日志或返回正文。中央 RunnerService 在握手前后检查连接配置，并返回 `assertCurrent()` 供调用方在普通请求准入时核对该连接的节点身份、启用状态、预算和凭据摘要；仅名称改变不失效。此检查只核对配置版本、不授予权限；固定停止／撤销回调不经过它，以便旧连接仍能安全收尾。

`RunnerNode(config, {services, preflight})` 是传输无关执行边界。配置包含 `root`、`node_id`、`machine_token_hash`、`projects[project_id].control_token_hash`、`cgroup_root`、`max_commands`（默认 1）、`memory_reserve_bytes`（默认 512 MiB）。D653 已确认 SSH 外独立预置机器与项目控制凭据；中央明文仅存设备私有 credential snapshot，不进入公开 RunnerSettings。节点配置只存 SHA-256 小写十六进制。明文编码总长 32–256 个 ASCII 字符，接受偶数长度且至少 64 字符的 hex，或规范无 padding base64url（解码至少 32 字节）。推荐随机 32 字节编码；格式校验不证明随机熵，不能使用示例口令。哈希前不改变原始字节（包括 hex 大小写）。根目录与 cgroup 配置只来自节点用户预置资料，不来自请求路径。

`openSession()` 返回连接标识；`dispatch(frame, session_id)` 返回 `{version,request_id,result}` 或 `{version,request_id,error:{code,message,details?}}`；`disconnect(session_id)` 撤销连接租约并等待执行端收尾；`close()` 关闭本节点实例，不声称其他连接已停止。无执行服务时操作拒绝，不回退本地工具。握手只公布已安装操作。

`workspace.code.read({kind,branch,base_commit,iteration_base_commit?,expected_commit,options})` 是 control-only 只读操作；kind 为 state/tree/file，options 沿用[代码阅读器](code-reader.md)既有参数。固定分支／提交由中央 Worker 事实提供，节点仅从身份登记的独立仓库读取、核对已接收 tip 及比较基线的祖先关系，不接收路径根、任意 ref 或 Shell。它属于禁用后的观察通道，但拒绝活动／未知写入；采样不持突变锁、不写请求收据，前后复核身份和忙状态，不承诺原子快照。复用阅读器的隔离 Git、FD 路径安全、分页和响应预算，读取不可用不会触发中央提交回退。

`workspace.register` 用标识推导专属目录，不接受自选路径；工作区已有但未登记或身份变化则拒绝。同一项目 Worker 只有一个登记现场，不能用另一个 workspace_id 创建竞争代码副本。当前不允许盲目更换已有工作区代次。`lease.grant({run_id,run_token,ttl_ms?})` 创建绑定当前连接的租约；Run ID 单调增加，旧代不复活。续期／撤销／释放独立于命令退出事实。失效 Run 仅保留自己请求的状态／输出／停止读取权限，不能读写新代码。

## 私有配置与撤销

`readRunnerConfig()` 从节点预置 `LUSH_RUNNER_CONFIG` 或 `~/.config/lush-runner/config.json` 读取版本 1 的 owner-only 文件；协议不接收配置路径。安全 FD 读取拒绝符号链接、非普通文件、错误所有者、组/其他人权限及超过 64 KiB 的文件。配置包含 `version:1` 与前述节点字段；`projects` 是按不透明项目 ID 索引的 `{control_token_hash,enabled?}` 映射，不根据客户端提供的项目路径创建授权。

hello 同样要求机器凭据加项目 control 凭据，或当前连接有效的 Run 凭据；不存在匿名枚举。中央经受信控制连接注册工作区、授予该工作区本次 Run 的独立 token。token 不下发给命令环境；命令参数夹带当前控制/机器/Run 秘密会被拒绝，返回值、错误细节与请求结果收据在落盘前脱敏。SSH stderr 只计有界字节，不传播原文。

节点装配时可传 `refresh_config` 重新读取私有配置：每次准入重检，并每 250ms 独立检查撤销。将 `projects[id].enabled=false` 保留原哈希可撤销新准入，同时保留对账/停止；删除项目映射则完全拒绝该项目请求。禁用、删除映射或轮换机器/control 哈希均撤销对应租约并请求停止现有执行，配置不可读也失败关闭。root、node_id、cgroup_root 不允许在连接内热切换。中央授权撤销仍须立即调用 lease.revoke；断线时不声称远端已停止。

## 节点附属持久事实

`RunnerStore` 的 SQLite 只记录 workspace、lease、request、execution、output chunk 和 artifact；不复制中央 Worker 业务表。同步模式 FULL，跨进程共享事务和命令准入。首次建库先设置 busy_timeout，再在有界 POSIX 初始化互斥门内启用 WAL／建立表结构；此门只保护数据库启动，不跨命令、网络或模型调用，也不靠旧 PID 解锁。工作区持有目录 dev/ino 与 `busy_request`，未知收据保持屏障。

突变先落请求指纹及接受记录，再执行。相同请求 ID、相同参数返回既有结果；不同参数拒绝。已接受但无结果返回 unknown，不启动第二次执行。凭据不保存为明文，参数指纹不等于命令 exactly-once 保证。显式 `request.status({request_id})` 可对账；控制权限可检查所属工作区，Run 仅能检查自己的调用。响应附原 identity、method、fingerprint 及该 Run 的工具副作用请求摘要 history（最多 256 条，另带 total/truncated），不返回请求参数或认证材料；旧节点缺少这些证据时不能完成新的工具对账。中央 Bridge 的 tool 收据在传输前记录实际预算归一化后的指纹，runner_runs.tool_journal 只为新调用保存版本及调用前内容／路径哈希，tool_count 与工具收据同步事务增长以辨别缺失；旧记录不回填。显式用户恢复边界见[现场核验](../reference/rpc/runners.md#显式核验远端现场)。

## 执行服务接缝（内部）

文件与命令服务返回 `services` 方法表，键复用操作注册表。每个处理函数为 `(ctx, params) => result | Promise<result>`，`ctx` 包含：

- `node/store/config`：共享节点与 `RunnerStore.db`（Bun SQLite）；
- `workspace`：已校验的登记行，含 `workspace_key/directory/dev/ino`；
- `identity/request/request_id/session_id`：固定本次身份；
- `authority`：`control` 或 `run`；`lease`：Run 的授权行；
- `authorization_expires_at`：本次执行必须遵守的授权上限。

文件服务另外提供 `check_context(ctx, params)`；对 `file.write/file.edit/command.start`，在突变前要求调用方确认已读取当前作用域规则。命令服务提供 `stop_workspace(key)`、`disconnect(session_id)`、`close()`，与节点撤销／退出合成真实停止屏障。

命令 start 被通用请求门持有工作区锁；命令服务在排队／执行期间保留同一 `request_id`，确认停止后调用 `store.unlock(workspace_key,request_id)`。普通文件突变完成即释放；未知结果不释放。请求 `completed` 仅表示 start 响应完成，不表示命令已退出。

## 客户端与传输

`RunnerClient({transport,identity,auth,expected_runner_id?,budgets?})` 先 `handshake()`，再 `call(method,params,{request_id?,signal?,timeout_ms?})`。返回 result；错误为带 code/details 的 RunnerError。创建客户端不会自动开始模型或命令。`forRun({run_id,run_token})` 复用同一连接的已确认握手；必须先经控制客户端 `lease.grant`。

用户专属 SSH 别名发现／独立试连不是 Runner 协议操作；安全读取和有界子进程由 `src/core/runner-ssh.js` 管理，注册／权限仍复用 `runner-methods.js`。试连使用无 Match／代理执行能力的私有配置子集与固定 `true`，不使用 `SshTransport`，不发送 Runner 认证、不分配节点或安装身份；能力限制见 [SSH 入口边界](../reference/rpc/runners.md#ssh-别名发现与独立试连)。它的通过不能证明下述 Runner 连接可用。

`SshTransport({ssh_alias})` 只接受单一安全别名；argv 禁止交互认证、首次主机信任、转发与 LocalCommand，远端启动字符串恒为 `lush-runner serve`。`StdioTransport({command,args,cwd,env})` 是显式独立进程接缝，env 不自动继承。两者使用有界 NDJSON、并发上限和请求截止；断线或已发送请求取消均为 unknown，关闭管道仅请求远端停止，不冒充停止确认。无自动重试；调用方保存 request_id，以新连接和固定 expected_runner_id 显式查询已登记收据。

`LocalTransport(node)` 复用同一权限／执行协议，仅用于明确创建的节点，不改变原有本地 Worker，也不是 SSH 失败后的回退。`serveConnection(node,{input?,output?})` 管理单条连接，EOF 先撤销授权，再等待已接纳请求及停止服务收尾。

预算字段是 `budgets:{max_commands,timeout_ms,output_bytes}`。客户端把 timeout_ms 映射到 command.start 的 command_ms；中央配置值作为上限，先收紧至 Runner 实现硬上限，再收紧至握手公布的节点限制，不因中央允许较大预算而提高节点预算。请求截止与命令执行预算分别计时。节点本机配置决定全局上限，客户端只能下调本次命令预算，不能提高节点值。`max_commands` 是节点级容量，不是模型槽数；节点输出总容量配置为 `output_storage_bytes`，默认 256 MiB，不自动删除未接收日志。

`workspace.barrier` 最多返回 32 条执行摘要，另带 total/truncated，不能把截断当已停止。Run 只得到本轮执行明细；stopped 仍取决于整个工作区的真实占用。lease.renew 必须通过未撤销且未过期的更新条件，未更新不能返回续期成功。

## 文件、上下文与产物

- `file.context({path?,scope?})`：path 是目标文件相对路径，空字符串表示根规则；scope 为 path（默认）或 workspace（全工作区嵌套规则）。返回 files、fingerprint、complete；每层优先 AGENTS.override.md。只读取文本，不加载或执行项目扩展。全工作区扫描有条数、深度及总字节预算，超限拒绝，不交付伪完整上下文。
- `file.read({path,format?,offset?,limit?,expected_sha256?})`：最大文件 1 MiB，text/auto/base64；文本分页 unit=utf16，二进制/图片 unit=byte，返回 sha256、next_offset、truncated、complete。续页必须固定 expected_sha256；图片返回 MIME 和 base64。
- `file.write({path,content,encoding?,expected_sha256,context_ack})` 与 `file.edit({path,edits,expected_sha256,context_ack})`：先确认当前规则指纹，再按内容前置条件原子发布；新文件 expected_sha256=null，已存在必须精确摘要。多编辑匹配原始内容中的唯一且不重叠区域。路径逐段 no-follow FD 校验；失败不覆盖，发布后不确定保留 unknown 与互斥门。
- `artifact.register({artifact_id,path,sha256,size,ttl_ms?})`：仅控制权限，核验受控工作区相对路径、完整摘要与大小后登记，默认保留一天、最多七天、最大对象 64 MiB。固定 ID 不改指向；注册不是导入 Git 对象或接收成果。
- `artifact.read({artifact_id,offset?,limit?,expected_sha256?})`：按 ID 查所属工作区和有效期，每次有界分页并核验完整摘要；无任意宿主绝对路径下载。续页必须固定摘要，过期不自动删除代码现场。

文件工具拒绝 .git/.lush、路径穿越、符号链接和非普通文件；Shell 仍是可信节点上的原生命令，不是恶意项目沙箱。命令启动使用 scope=workspace 的 context_ack，不能只读根规则后执行未知嵌套范围。

## 命令与停止

`command.start({script|argv,cwd?,env?,command_ms?,queue_ms?,output_bytes?,context_ack})` 二选一 script/argv，cwd 默认 `.`。返回持久 execution_id 与 queued 状态，启动响应不表示命令已退出。`command.status({execution_id})` 返回 state、reason、exit_code、stop_confirmed、output_complete 等；非零退出、timeout、queue_timeout、cancelled、unknown 分开。`command.cancel` 等待停止或返回不确定，不能把发信号当停止。

`command.output({execution_id,after?,limit?})` 按 seq 返回 base64 chunks、next_cursor、has_more、gap、truncated、complete 与 output_error；after 默认 0，每页最多 8 块，每块最多 64 KiB。完整传输和已发生输出截断是不同事实，调用方须同时检查 gap/truncated。节点容量包含每块 1 KiB 逻辑开销，并非 SQLite/WAL 物理磁盘配额。容量耗尽保留日志，拒绝新命令；运行中明确截断。

命令队列跨节点本机多个进程/项目共享 SQLite 槽，默认 1；排队和执行分别计时，并有内存保留门。环境不继承中央进程：固定 PATH/LANG/LC_ALL，HOME/TMPDIR 为命令专属目录；可预置 command_path 与 command_env_allowlist（默认 CI/TERM/NO_COLOR/FORCE_COLOR），敏感认证、LUSH/PI、动态加载及启动注入变量即使列入白名单也拒绝。

guard 在任何 OS 资源准备前持久独占初始化，并在同一事务登记未分配资源；启动前取消只有在该 guard 证明尚未创建 containment/bootstrap 时才能原子记录 not_started 和停止结果，不能仅凭 stopping 状态解锁，已有启动痕迹或未知状态不采用此捷径。未分配资源收据仍供后续回收核验。

生产命令使用独立 watchdog 与 Linux cgroup v2，持久记录 cgroup 的节点、启动代次/boot、目录 inode 与执行身份；重启不能只凭旧 PID 杀进程。租约失效、撤销、EOF 或超时请求停止，以实际空组确认，未知保留工作区屏障，不自动重跑。控制授权默认也有有界截止，不会成为永久后台命令许可。新命令在副作用前登记 `command_resources`：绑定安装、工作区、执行 ID，分别持久保存 cgroup／home 的创建阶段及归属凭据；home 与其 TMPDIR 别名固定父目录和自身 dev/ino。home 使用已登记的 `command-homes-v1` 容器，不认领旧目录；创建后尚未记下 inode 的中断保持 unknown。退出还核对 home 身份。停止与回收分开，历史请求／执行／输出收据保留，不通过 command 入口强制删除。

## Workspaces Git 内部接缝

`src/core/workspaces/remote.js` 提供受检远端 Git 操作；Project 已接入创建、invocation、固定交付队列、父同步及受检资源回收；Git 与远端收据边界分别见下文和[合并契约](merge.md)。中央只登记所属分支与 Runner binding，`tasks.workspace`／`branches.worktree` 保持 null，不创建第二份本地开发检出。旧本地 `ensure/finish/forkTaskUnsafe` 对已绑定远端的 Worker 明确拒绝；分支归档／回收须先取得远端资源已移除的凭据。

新增操作仍注册于 `protocol.js`，全部是 control-only：

- `artifact.upload({artifact_id,size,sha256,offset,data})`：规范 base64，每块最多 64 KiB，总 bundle 最多 64 MiB；顺序偏移、摘要、inode 和工作区所有权固定。每工作区最多 32 个传输对象、128 MiB 登记容量，不淘汰未知对象。
- `artifact.download({artifact_id,expected_sha256,offset?})`：固定摘要分页，不接受宿主路径。与原有 `artifact.register/read` 的工作区文件产物分开；传输文件位于节点私有登记资源中。
- `workspace.git.apply/inspect/export({steps,empty?,output_artifact?,capture_run_id?,require_no_lease?})`：Workspaces 生成固定 argv 与可选 `expect` 断言；Runner 校验有限 Git 语法并在同一工作区门内执行，最多 16 步、10 秒、每个流 1 MiB。没有 Shell 或任意 `git -C/--git-dir` 入口。apply 只允许初始化、固定对象导入和快进；inspect/export 可以在 Run 租约仍有效但无命令／未知写入时执行，为本轮派子接收提交，不必先结束 Agent。运行中接收同时固定并复核节点 capture_run_id 的当前有效租约；最终接收要求 require_no_lease，传输后再次核对，中央活跃 Run 不能替代节点租约。其他突变仍拒绝 live lease。
- `workspace.cleanup({steps})`：要求精确分支／HEAD、包括 ignored 的干净状态、无租约及未确认执行，只处理登记资源，不提供任意 rm 路径。新命令可回收其已登记 home／TMPDIR 内容与 cgroup，再回收传输对象和仓库，保留工作区登记目录 inode 作为 tombstone。生产端复核 cgroup 安装／boot／目录身份和空组，不凭 PID 或名字认领；home 链接根、替换目录、外部挂载、未确认停止或未知创建均拒绝。逐资源保存 removing／removed，已完成项不重复删除，删除后未持久确认的缺失目录不猜成功。**旧命令缺少资源凭据时仍返回 `partial:true, removed:false, reason:command_resource_identity_unrecorded` 并保留现场**，不迁移猜测；不能据此完成验收。未知请求／离线也不代表回收成功。

新增突变结果带绑定 method／identity／params 的 `request_fingerprint`。中央保存根 request_id，并派生各阶段／分块 ID；ACK 丢失先查询原 ID，仅复用指纹一致的 completed 结果，unknown 不重放。Git 检查拒绝链接化元数据、alternates 和不受支持的仓库配置，禁用 hooks、replace/grafts、全局配置及外部 helper；这不是恶意 Shell 沙箱。运行时 Git 崩溃留下持久 busy／unknown 屏障，不凭进程退出猜测可继续。64 MiB 是 bundle 传输预算，不是恶意压缩对象的硬解压磁盘配额。

Workspaces 方法精确签名：

```js
prepareRemoteBranchUnsafe(task, parentBranch, commit, options) // 调用方已持 exclusive
prepareRemoteWorkspace(options)
inspectRemoteWorkspace(options)
provideRemoteCommit(options) // 另带 commit/head_commit，仅分发固定修复对象，不推进源 HEAD
receiveRemoteCommit(options)
syncRemoteWorkspace(options)
cleanupRemoteWorkspace(options)
readRemoteFile(options, {path, expected_head, expected_sha256, offset = 0, limit = 16000})
```

共同 options 为 `{client, identity, guard, request_id, authorization_version}`：client 必须已经握手并固定安装身份的控制客户端；identity 包含项目／节点／安装／Worker／workspace／generation，以及 control operation_id 或当前 run_id。运行中接收使用 Run identity 留中央收据，但传输仍走私有控制客户端，控制凭据不交 Agent。不同种类的控制流程（如最终对象接收与资源回收）分别固定 operation_id；Store 不会把既有对象操作的授权扩展为 cleanup。guard 是同步抛错的最新授权／生命周期检查，调用前后以及中央串行区重检；不能用恒真 guard 代替 Project 安全门。

接线顺序：

1. 中央 Git 串行区固定父 tip、登记 binding 与分支后 `prepareRemoteBranchUnsafe`；离开锁调用 `prepareRemoteWorkspace` 分发仅该固定 tip 可达对象。节点初始化独立 SHA-1／SHA-256 仓库，不镜像其他 refs。
2. `receiveRemoteCommit` 另带 `{commit, old_commit, original_commit, final_delivery?, agent_exited?}`。完整 bundle 在独立隔离对象库核验摘要、大小、完整性及源祖先；网络传输不持中央 Git 锁或 DB 事务。短串行区导入隔离候选 ref，复核身份、原 tip、祖先后用 no-deref CAS 推进所属 Worker ref；远端不能 push 中央。Git 已推进而 DB 未确认时，只按同一持久 received 收据核对精确 tip 续办。
3. 最终交付另要求调用方通过 guard 证明 Agent 实际退出，并传 `final_delivery:true, agent_exited:true`；接收前后核验 Runner stopped 与干净现场。Run 释放／控制收据切换由 Project 完成，不由 Workspaces 猜测。父侧新增的 `RunnerToolBridge` 使用 forRun 客户端，其 drain/close 只证明工具停止，不释放租约；控制客户端仍须显式 lease.release，并登记 Store Run 释放，再执行最终接收／回收。Bridge 的 Run 工具白名单不包含本节 control-only Git／资源操作。
4. 父远端同步：调用方在中央 Squash 前用 Store 创建 `parent_sync/prepared`，固定 `{old_commit,new_commit,attempt_id}`；落地凭据核验后记 `landed`。`syncRemoteWorkspace` 只消费 landed/applying 收据，中央 ref 必须为 new_commit；节点须干净且精确处于 old 或已到 new。仅执行 `merge --ff-only`，不 reset/clean，不重复 Squash；ACK 丢失可核对新 HEAD 后进入 acknowledged。确认前 Project 必须阻止新 Run／后续交付。显式用户重排只有在中央仍为 old_commit、远端同一旧 HEAD 且干净无租约／写入均已核验时，才可将仍为 prepared 的收据记为 rejected 终态；须提供固定旧 HEAD、verified／clean／stopped 证据，不更新 binding HEAD。landed／applying／unknown 不得使用此出口，自动恢复也不据此释放执行位。
5. `cleanupRemoteWorkspace` 另带 `{head_commit,agent_exited:true,cleanup_attempt?}`，使用 Store cleanup 屏障；仅 removed 收据才允许后续中央分支回收。原 request_id 对账处理已完成但 ACK 丢失的回收；已知失败经显式处理后，可在同一中央收据下提供新的 cleanup_attempt 续办未完成项，不重放旧失败请求。节点 unknown／busy 不可借新 attempt 绕过，部分／未知回收保留屏障，不能自动验收。`readRemoteFile` 是固定 HEAD＋内容摘要的内部有界读接缝，无离线本机回退；公共代码阅读器由 Project 经 `workspace.code.read` 获取同源采样投影，不用文件工具拼接文件树。

专项：`bun run test test/workspaces/remote-git.test.js test/workspaces/remote-bridge-integration.test.js test/workspaces/remote-sync.test.js test/workspaces/remote-safety.test.js test/workspaces/remote-recovery.test.js test/workspaces/remote-resources.test.js test/runner/command-resources.test.js`，使用真实独立 stdio Runner 与两个独立仓库，命令 containment 为显式受控进程 adapter；不是 SSH/cgroup 实机证明。命令资源回收另覆盖目录替换／链接、创建收据缺失、开始／回收 ACK 丢失、未确认停止、部分失败与重复清理。上述底层专项不替代 Project 集成证据；旧未知资源仍须人工核查。

## 入口、证据与范围

公共导出从 `src/runner/index.js` 获取 RunnerClient、SshTransport、StdioTransport、LocalTransport、createRunnerNode、runRunner 及协议常量。`createRunnerNode(config,{refresh_config?})` 组装文件/命令服务并强制真实 cgroup preflight；无测试适配器参数或自动降级。`runRunner({config_file?,input?,output?})` 读取私有配置并服务一条连接。用户预装可执行 `bin/lush-runner`，唯一执行入口是 `lush-runner serve`；无自动安装、网络监听或系统设置修改。server 要求先成功 hello 再准入操作。

测试专用程序显式组装受控进程适配器，覆盖真实独立进程、完整注册/权限/文件/图片/命令链及编辑 ACK 丢失后的对账；它不是 SSH 或 cgroup 实机证明。生产入口不读取测试开关。当前工程提供执行基础设施及上述 Workspaces 内部 Git 中间交付，Provider 已有显式 `remote_workspace` 与受限 Bridge 接缝；Project 已接通固定节点创建、租约／Bridge 调用、按绑定读取代码，以及用户节点／凭据／授权管理与持久输入节点选择；递归交付、父同步、停止恢复及受检回收已接线；旧未知命令资源仍须人工核查，不能猜测成功或自动重放。真实用户授权 SSH 节点、cgroup 进程树和整体性能仍须单独验收。
