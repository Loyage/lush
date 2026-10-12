export const HELP = `Lush — Worker 中心开发

lush [--project PATH] [--json] <command>
  daemon start|stop|restart|status     项目 daemon
  doctor [--verbose]                 检查运行代码身份
  status                             项目与 Worker 状态
  host start|stop|restart|status [PORT]  整机 Lush Host（Web 工作台入口）

  order '目标' [--branch NAME] [--profile-file PATH] [--defer]  提交指令；--defer 授权父冻结时挂载预约发射
  worker list|tree|inspect ID         查看 Worker
  worker spawn '目标' --parent ID [--name NAME]  在指令/child 下派 agent 子 Worker
  worker auto-title '标题'           为自身生成一次自动标题（仅活动指令/子 Agent）
  worker rename ID '标题'            只改展示标题；空标题恢复自动标题（仅用户）
  worker message ID '说明'            给现有 Worker 追加消息
  worker watch ID [--after N]         终端内观看（仅用户；q/Esc/Ctrl-C 退出）
  worker transcript ID [--after N]    单次查询执行记录
  worker history ID                  查看事件
  worker hooks ID                    查看已挂载 Hook、自动级别与修改版本
  worker completion ID off|merge|accept --revision REV  设置最高自动级别（验收含归档回收；旧 archive 等价 accept）
                                      验收不调用评审 Agent；自动归档不丢弃未提交改动
  worker hook attach ID --file PATH --revision REV  从私有 JSON 挂载规则
  worker hook enable|disable|remove ID HOOK_ID --revision REV  启停或撤销未来动作（不撤回已执行动作）
  hooks list                        查看项目触发目录、动作、模板、快捷指令、daemon Hooks、时间信号与管理指令
  hooks command list                查看快捷指令目录（hooks.list.commands，修改使用 commands.revision）
  hooks command save --file PATH --revision REV  注册/修改 Shell 或提示词指令及元数据（不授权，修改即撤权）
  hooks command export ID --version N  只读导出单条 Skill 风格 Markdown（不安装、不授权）
  hooks command authorize|revoke ID --version N --revision REV  授权/撤权指定版本（不是沙箱）
  hooks command remove ID --revision REV  删除未来授权，已有 Hook 引用失效
  hooks command run ID --version N --worker ID --revision REV  同步执行已授权 Shell 版本（提示词请用 start）
  hooks command start ID --version N --worker ID --revision REV  异步提交；Shell 选择执行目录，提示词选择父 Worker 并创建/启动 Agent，消耗 token
  hooks command history [--before CURSOR] [--limit N] [--execution UUID]  查看每次运行安全摘要（execution 与 before 互斥）
  hooks command import --file PATH --revision REV  导入旧内联命令并停用源 Hook（用源模板或 Worker Hooks 版本）
  hooks auto-select on|off --revision REV  启停设备全局自动选择（使用 daemon_hooks.revision）
                                      开启也答复所有在线项目已有问题；不启动停止的项目，恢复后台后生效
                                      单选选第一项，多选/问答交给 Agent 自行判断，可能继续消耗 token
  hooks save --file PATH --revision REV  保存模板（不自动挂载或调用 Agent）
  hooks remove TEMPLATE_ID --revision REV  删除模板，不影响已有挂载实例
  hooks signal save --file PATH --revision REV  保存时间信号（使用 signals.revision，不证明额度恢复）
  hooks signal remove SIGNAL_ID --revision REV  删除无启用绑定的信号
  hooks management create --file PATH  创建并绑定管理指令；到信号时才调用 Agent，可能消耗 token
  hooks management enable|disable ID --revision REV  启停管理绑定（使用 management.revision）
                                      专用 Agent 仅查询、开始/继续暂停、重试失败；默认一次，不开发、不合并
  worker auto-merge ID on|off         设置 Worker 持久自动合并 hook；派生子 Worker 不可关闭
  worker reserve ID merge            发起一次合并意图（不改变自动合并开关）
  worker reserve-all BRANCH          一次把该分支下所有已静息、待合并 Worker 放入 merge 队列
  worker unreserve ID                撤销尚未发出的合并预约
  worker integrate CHILD COMMIT      历史 Worker 的父 Agent 确认固定子提交
  worker resolve-child-divergence ID 历史解分歧子 Worker
  worker resolve-divergence ID       历史指令解分歧入口
  worker approve-merge ID COMMIT BASELINE  历史请求的用户批准入口
  worker accept ID                   验收即归档：用户验收成果 / 父 Agent 确认 child；回收 worktree/ref，保留运行历史，脏现场阻止
  worker reopen ID                   历史已合并 Worker 恢复待验收（不调用 Agent）
  worker sync-parent ID              安全同步父提交；冲突只返回诊断
  worker resolve-sync ID             调用 Agent 解决已记录的同步冲突
  worker clear-override ID           清除本 Worker 的独立运行覆盖，回到设备/角色默认
  worker resolve ID                  指令验收的兼容入口（等同 accept，含归档回收）
  worker cancel|retry ID             停止或显式重试
  worker interrupt|resume ID         请求安全点暂停 / 非阻塞继续
  worker cleanup ID [--keep-branch]   安全回收工作区
  worker delete ID                   只读预检删除范围、资源与阻塞原因
  worker delete ID --confirm --revision REV  确认彻底删除（丢弃未交付代码）
  worker delete ID --force           强制删除预检（允许对应残留检出归属未知）
  worker delete ID --force --confirm --revision REV  确认强制删除记录与残留代码

  branch tree|show BRANCH            查看分支
  branch bind BRANCH COMMIT          显式绑定已有本地分支
  branch convergence list           查看分支归并自动化与项目默认（默认仅 main 挂载且关闭，仅用户）
  branch convergence show BRANCH    读取单分支策略与保存 revision
  branch convergence on BRANCH --revision REV  挂载并开启未来新交付归并，无需验证快捷指令
  branch convergence off BRANCH --revision REV  停用但保留挂载与历史，不撤销已开始的归并
  branch convergence mount|remove BRANCH --revision REV  挂载（初始关闭）或移除归并自动化，保留历史
  branch convergence defaults show  读取项目新 Worker 默认与 revision
  branch convergence defaults set --mounted true|false --enabled true|false --revision REV  仅影响之后新建 order/child；未挂载可记住默认启用，实际策略仍关闭
  开启可兼容 --command UUID --version N 保存旧精确引用；不执行验证命令、不隐式授权
  branch convergence runs BRANCH [--before N --limit N]  查看归并批次（默认20，最多50）
  branch convergence retry RUN_ID --revision REV  显式重试可恢复批次，可能调用整合 Agent；未知落地不重放
                                      开启／重试可能产生 Agent 费用；只影响目标分支，不提高 Worker 自动权限
  branch archive BRANCH [--discard] [--continue]  特殊/失败现场清理资源；--discard 明确丢弃脏现场，--continue 续办后代
  notice list|post|answer|dismiss|read    用户决策与告知已读（显示 D/N 编号，参数仍用整数 ID）
  notice post '标题' [--worker ID] [--body '正文']  发给指定 Worker（Agent 默认当前 Worker）
  progress plan|complete             Agent 汇报进度
  skills list|get ID                  内置能力按需指南（支持 --json；无需项目/daemon，不读取设备配置）
  agent show|models|set|reset|prompt|env|init|network  设备 Agent 配置（用户专属）
  agent prompt ROLE / agent env ROLE  用户检查最终 Prompt / 脱敏环境来源，不向 Agent token 开放
  agent init [ROLE] [--local]         --local 创建设备私有补充；否则创建项目可提交约定，不覆盖文件
  agent sources list|show ID|refresh [ID]|models ID [--refresh]  来源、额度与缓存模型目录
  agent sources save --file PATH|remove ID|login ID  托管连接管理与显式登录
  agent resources                          本地来源/模型/额度安全 JSON 读面（不联网）
  agent packages list|install SOURCE|remove ID|update ID  插件/Skills安装（不自动启用，可选 --scope device）
  agent set TARGET --config-mode lush|pi    默认 Lush 托管；显式 Pi 默认不混入托管设置
  agent network show                       读取设备出站代理设置（认证不回显）
  agent network set --file PATH             从私有 JSON 文件保存代理，不在参数中填写密码
  agent network reset                      恢复继承后台启动环境，后续请求与 Agent 生效
  agent set TARGET --connection UUID|off --model PROVIDER/MODEL  显式选择 Pi 账号连接（不自动路由）
  config show|set|reset              设备调用和拆解限额（call-timeout、worker-call-limit、max-depth）
  config migrate                    预检当前项目旧设置/私有 Markdown 补充；不改文件
  config migrate --confirm --revision REV  按预检确认迁移，保留私有备份与旧 Markdown 原件
  config ... / agent ... --scope device  可选设备 scope；省略仍选设备，project 覆盖已停用

Worker ID 可用原整数或稳定编号 W5 / W5-1；编号由 daemon 解析，不是整数 ID。
新输入按现有序列显示 O5，对应新指令 W5；派生子 Worker 为 W5-1，历史 Worker 编号不改。
输入与子 Worker 编号允许跳号且不复用；分页游标、Notice ID 仍为整数。

新指令只走 order；旧 Intent/Plan/Candidate、展示、介绍、托管、草稿和批量合并不再提供 API。
Hook 配置与读面为用户专属；JSON 文件须为 owner-only 普通文件。写入前先读取对应 revision，多标签过期版本拒绝。
预约只保存授权参数，不创建 Worker / worktree；父可创建时才发射，按启动设置调用 Agent，可能耗时并消耗 token。
旧数据不迁移；仅用户明确确认 worker delete 时清除所选 Worker 的专属历史与资源。
`;
