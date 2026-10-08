# 选择快照与独立重选路线

用户决定 #283（W121）：结构化问卷自动保存作答前的代码现场与当时上下文，重选创建独立 Worker/分支，原路线与答案保留；不撤回已进入父分支或 main 的成果。

## 产品与安全边界

- 每份新 questionnaire 一个选择点（包括 Lush 自动答复），不是每题一个；question/plan/info 不建立选择点。旧记录不伪造回填。
- 保存源 Worker 专属工作区的已提交代码、未提交文件现场、非 ignored 未跟踪文件及可恢复的 Agent 上下文。排除内部数据、凭证、ignored 内容、外部进程与服务；不快照整个项目 DB 或其他 Worker/后代现场。
- 不移动源分支、不改源 index、不替用户提交当前分支。Git 对象/专属保护 ref 和私有会话副本属于 Notice 附属资源。大小、越界符号链接、submodule、冲突或上下文能力不满足完整恢复条件时，明确 unavailable，不能把缺失当成功。
- 问卷暂停后必须等真实 invocation 退出，在原 Worker 再次运行/子交付改变该分支前固定现场；自动答复和快速人工答复不得跳过此边界。快照失败不丢问题或答案，原流程可继续，但明确该选择点不可重选。重启不得把后来现场补拍成过去快照，也不重放未知恢复副作用。
- 重选保留原 Notice、旧答案、旧分支和成果，创建用户指令 Worker，自动合并默认关闭；新 Worker 用快照代码与选择前会话、新答案继续，不把旧答案后的会话带入。显式说明原路线不会自动暂停、旧成果不会从 main 撤回。
- 新路线目标为源 Worker 的原直接父 Worker/目标分支；父终态、归档、冻结等不满足创建门时明确拒绝，不静默改投 main，不复活源 Worker。复制所需上下文与规则，不共享可被源删除破坏的活动文件。无法准确恢复的后端/模式明确不可用，不静默降级为新会话。
- 归档源 Worker 不应使 ready 快照失效；彻底删除的预检必须覆盖附属资源和共享保护。恢复失败保留可诊断事实，不做强制清理或重试未知写操作。

## 首期恢复能力与限制

- 只有 Pi 的 Lush 模式，并且当前 invocation 留有可信上下文 marker，才能建立可恢复选择点。Codex、Pi 默认模式、缺少 marker 均明确 unavailable，不自动降级为无上下文的新会话。
- 文件上限为 10000 个、总量 64 MiB、单文件 8 MiB。符号链接、submodule、未解决冲突拒绝保存；明确凭证文件名和内部路径排除，遇到已跟踪的排除文件拒绝，不静默删除后冒充完整快照。
- 不清洗已有 Git 祖先历史，不能自动识别任意源码中嵌入的秘密。会话副本属于项目私有资料，不通过快照读 API 暴露正文；这不是仓库或会话内容的自动脱敏保证。
- 重选路线保留对源 Notice 的关联。彻底删除源 Worker 时，有范围外重选路线则阻止删除，需先处理这些路线；普通归档不删除选择点。不能为回收源资源而损坏独立路线。
- 管理型 Worker 不继承选择快照、不能发布问卷或调用用户重选接口。管理信号遇到正在创建的路线等待安全点，创建副作用未知的路线拒绝管理重试，避免把未完整恢复的代码当作普通暂停／失败开发任务。

## 跨分区接口（实施接缝）

用户专属：

- `notice.snapshot {id}` → `Project.noticeSnapshot(id)`，HTTP `GET /api/notice/<id>/snapshot`。只读，无 Agent 或 Git 写行为。
- 返回 `{notice_id,status:'pending'|'ready'|'unavailable',revision:string,reason:string|null,created_at:string|null,source_task_id:number,source_worker_number:string|null,commit:string|null,context_mode:string|null,can_rechoose:boolean,blockers:string[],limitations:string[]}`。旧问卷/非问卷返回 unavailable 与说明。不公开私有会话路径/内容、凭证或完整 profile。
- `notice.rechoose {id,answer,revision,request_id}` → `Project.rechooseNotice(id,answer,revision,requestId)`，通过 Web action。同原 questionnaireAnswer 输入 `{answers:[{selected:[零基序号],custom:''}]}`，服务端规范化。revision 固定快照，request_id 为客户端一次操作的 UUID（并发/重复/响应丢失后同一 key 不重复创建；不同答案复用 key 拒绝）。
- 返回 `{notice_id,task, reused:boolean}`，task 至少含 id/worker_number；相同 request 重试返回原 Worker，不重复 Agent 调用。
- 只有已 answered/dismissed 的 questionnaire 可重选；ready 不等于可准入，读面 blockers 和写时重检一致。重选不是重新打开或改写原 Notice，不走 daemon 自动选择覆盖用户新答案。

## Web 操作

在「待我处理」的已回答／已忽略问卷，或 Worker 详情的历史决策记录中，展开原问题后点击「查看快照与重选」。查看和刷新只读取状态；ready 且通过创建门时，点击「重新选择」填写一份独立草稿，最终「确认新选择并创建 Worker」才启动新路线。原答案继续只读展示，成功后跳转新 Worker。

请求失败保留选择和请求身份；「继续上次重选」使用同一身份查询/重试，避免响应丢失时重复创建。修改答案会形成另一请求，旧请求可能已成功；成功后「再次从此处重选」明确新建另一条路线。浏览器不能持久保存请求时会提示勿刷新，不能承诺跨刷新去重。旧记录或不可用后端显示原因，不开放虚假的恢复按钮。

## 文件分工

- Runtime 子 Worker：`src/core/`、`src/persistence/`、`src/agent/` 及对应 tests；负责快照 Git/上下文、安全调度、幂等创建、删除资源保护。可新增附属列/表/模块，但不新增核心业务实体。不改 RPC/CLI/Host/assets 和本契约；实现差异先消息给父 Worker。
- UI 子 Worker：`src/ui/web/assets/`、DOM tests；历史 Notice 与 Worker 详情共用重选入口、只读快照状态、复用问卷选择与确认、成功导航新 Worker。只读查看不调用 Agent；最终创建按钮带 agent-call/agentHelp。重选草稿与原问卷草稿隔离，失败保留输入，重复提交沿用 request_id。维护 `modules-web.md` 中新增模块条目。
- 父 Worker：RPC registry/handlers、CLI、Host routes 与接口测试、文档和集成验证。维护本契约和模块总入口。

## 验证

合入固定父基线后实际执行 `bun run test`：2329 项通过，覆盖 307 个文件；`bun run docs:check` 通过。`test/web/choice-snapshot-flow.test.js` 经实际 HTTP、RPC、SQLite、Git 验证新路线恢复、选择前上下文、新答案、并发/响应丢失去重以及源代码、index、main 不变。provider 为可控测试实现；另有受控 Pi 子进程验证 `--fork` 参数，DOM 回归验证界面操作。

合并适配参考固定父提交 `5fde024`、源提交 `c091c03`（共同祖先 `68785f0`）：父侧新增管理型 Worker 隔离与时间信号、Worker 树关注度排序，无整体改名或既有公开接口迁移。保留排序和管理能力；合并 Provider fork 门、HTTP 写白名单，新增 `test/project/choice-management-compat.test.js` 覆盖管理调用与选择点的权限／创建安全门，管理 Agent 不得继承开发快照。

尚未验证真实模型调用与真实浏览器，不把受控进程或 DOM stub 当作这两项验收。测试不连接用户项目或重启用户服务。

验收范围：临时项目与可控 provider；实际完整运行测试，覆盖 dirty/untracked/binary/deletion/mode、源 HEAD/index 不变、快照上下文不串旧答案、自动答复与真实退出、失败/重启与 unavailable、归档/彻底删除、权限/冻结/父准入、幂等并发、同一选择点多条路线、原路线历史不变。UI 覆盖历史/旧记录、未就绪/失败说明、单多选、自定义、新草稿隔离、失败重试和调用标识。真实模型、浏览器与外部副作用不由 mock 测试冒充验证。
