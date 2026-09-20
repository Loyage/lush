export const HELP = `Lush — 项目级多 agent 开发

lush [--project PATH] [--json] <command>
  daemon start|stop|restart|status  一个项目一个进程
  status                          项目、agent、待合并改动
  doctor                          目录、工具链与代码版本
  say '你的意图'                    立即持久化并排入规划队列，不等待开发
  intent list                     查看意图：每条输入 + 它的 planner 拆解与 scheduler 编排进度（别名 intents）
  plan propose '标题' [--body '…']   planner 专用：这轮拆解请你先批准（影响面大 / 与现状冲突 / 没把握读懂意图）
  plan approve ID|NOTICE_ID        批准这一轮拆解，交给 scheduler 编排
  plan reject ID|NOTICE_ID '理由'   驳回：本轮 spec 作废，理由送回 planner 重拆
  input list                      查看用户输入（含 develop/explain 判定）
  input flow [TASK_ID] develop|explain  记录这条输入走哪条流程（agent 省略 TASK_ID 时用自己的任务）
  draft add '想法'                 先放进缓存，不规划
  draft list                      查看缓存（尚未提交）的输入
  draft edit ID '想法'             改一条缓存输入（别名 update）
  draft rm ID                     丢掉一条缓存输入
  draft commit [ID...]            把缓存交给意图分析：只提交给定 ID（无参即全部），一个 planner 拆成多个任务并建依赖
  task list [--after N] [--limit N] 分页任务列表（默认 200 条，只含开发任务；planner/scheduler 见 intent list）
  task tree [ID]                  多级任务树：依赖（⛓ 基线 / ⏳ 顺序）与兄弟间的并行关系
  task ladder                     交付队列：按目标分支分组，显示变更栈、当前来源与阻塞原因
  task timeline [--limit N]       并行时间轴：每个任务什么时候真的在跑，排队是在等依赖、等槽还是等子任务
  task inspect ID                 结果、agent、子任务、消息与工作区
  task history ID [--after N]      分页事件记录
  task transcript ID [--after N]   只读查看 agent 的思考、工具调用与工具输出（来自 pi 会话记录）
  task usage ID                   只读查看这个 agent 的模型、上下文占用与累计花费（同一批会话记录）
  task spawn '目标' [--parent ID] [--role worker|coordinator|research] [--name short-kebab-name] [--depends-on ID[:code|order]] [--spec SPEC_ID]
      --name 是任务的英文短名，决定 worktree 目录与分支 <id>-<name>；省略时按 goal 里的英文词回退。
      --spec 把这次 spawn 与拆解队列里的 spec 关联（scheduler 必须给）。
  spec list [--status pending|planned|dropped]  查看拆解队列（spec 是等 scheduler 编排的条目，task 才是真实任务）
  spec add '目标与验收标准' [--role worker|coordinator|research] [--name short-kebab-name] [--depends-on SPEC_ID[:code|order]]
      planner 专用：把拆解结果写进队列，不直接建任务。
  spec drop ID [--note '原因']      scheduler/planner 明确放弃一条 spec
  task message ID '补充说明'       追加输入，不打断当前 invocation
  task cancel|retry ID            取消子树 / 明确重试失败任务
  task wait ID                    仅阻塞此客户端，不占 agent 槽
  task merge ID [ID...]           用户明确批准交付到原目标分支；批量只接受同一目标分支，
                                  只按 code 基线排序（order 只影响执行），预检后逐个落地；
                                  内容冲突会开 resolver 并提问，完成后原任务 id 自动指向其结果；
                                  运行期遇到第一个冲突或失败即停下，剩余标为跳过。
  task verify ID                  为一个已完成的 worker 派只读 verifier：演示 worktree 结果并对照目标分支
  task cleanup ID [--keep-branch] 安全回收 worktree 与任务分支（--keep-branch 只回收 worktree）
  task clear                      删除全部已结束任务及 inputs/drafts/notices/events；有活动任务时拒绝
                                  同时按 cleanup 的安全门回收 worktree/分支，回收不掉的保留在磁盘上并列出原因
                                  分支名带着旧 task id，所以 id 不复用
  branch tree [--verbose]        分支谱系：谁从谁创建出来（不是 commit graph，也不是任务树）
  branch show BRANCH|TASK_ID     一条分支的 parent / fork commit / task / worktree 与祖先链
  branch import                  把现有本地分支登记成记录（只记存在与 worktree，不推断 parent）
  notice list                     待决问题与答复
  notice post '问题' [--task ID] [--body '背景']
  notice answer ID '答复'
  notice dismiss ID
  web [PORT]                      Web UI（默认仅本机；.lush/web.json 开启公网监听与登录认证）
  web-restart [PORT]              停掉端口上那个旧 Web 进程再起一个新的：Web 进程不会跟着代码
                                  换版本，改完 src/ui/web/ 用这条命令；只停命令行确实是 Lush Web 的进程

默认从当前目录向上发现项目；--project 或 LUSH_PROJECT 显式绑定。
状态固定保存在 <project>/.lush/，不再支持全局 LUSH_HOME。
实现任务需要已提交初始版本的 Git 仓库（提交输入时会从当前分支顶端建一条输入锚点，所以也不能是 detached HEAD）；合并要求主工作树干净。
依赖：一个任务最多一条 code 依赖。code（默认）把上游分支当作本任务 worktree 的基线，
因此看得到上游未合并的改动，但必须先合并上游再合并本任务；order 只等上游结束，代码仍从这条输入的锚点开始。
依赖不能指向自己的祖先任务（祖先在等子孙结束，双方会互相等死）。
Agent 默认 pi；LUSH_PROVIDER=mock 可离线验证。`;
