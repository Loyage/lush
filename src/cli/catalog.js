import { RUNNER_METHODS } from '../rpc/runner-methods.js';
// Code-owned public CLI catalogue. Main registration and generated help consume
// this same hierarchy; browser clients receive only the safe projection, never handlers.
export const COMMAND_MODULES = Object.freeze({
  runner: ['runner'],
  system: ['daemon', 'status', 'doctor', 'log', 'host:start', 'host:stop', 'host:restart', 'host:status'],
  intent: ['order'], worker: ['worker'], progress: ['progress'], notice: ['notice'],
  branch: ['branch'], agent: ['agent'], config: ['config'], hooks: ['hooks'], skills: ['skills'],
});
const entries = [];
const directories = {
  runner: '远端执行节点与项目授权；不安装或迁移工作区。',
  'runner ssh': '本机 SSH 别名发现与显式登录试连；不检查 Runner。',
  'runner nodes': '设备节点配置与显式诊断。', 'runner credentials': '设备私有控制凭据；只写秘密。',
  'runner project': '当前项目节点授权和默认节点。', 'runner worker': '显式核验当前项目的远端现场，不自动恢复调用。',
  daemon: '项目后台的启动、停止与代码身份。', host: '设备 Web 工作台的启动、停止与身份。',
  worker: '查看、沟通与管理持久 Worker。', branch: '查看分支、管理归并与资源。',
  notice: '发布问题、答复决定与读取告知。', progress: '活动 Agent 汇报里程碑。',
  skills: '无需项目的内置能力指南。', agent: '设备 Agent、模型来源与插件配置。',
  config: '设备调用限额与显式旧设置迁移。', hooks: '项目自动化模板、快捷指令与时间信号。',
  'worker hook': '管理单个 Worker 的自动化挂载。', 'hooks command': '仅供 Hook 执行的快捷指令目录。',
  'hooks signal': '管理具名时间信号，不证明额度恢复。', 'hooks management': '创建或启停信号绑定的 Valet。',
  'branch integrate': '一次性自主整合全部可准入的真实直接来源。',
  'branch convergence': '读取历史持续归并策略和旧在途。写入口已退休。', 'branch convergence defaults': '读取退休的历史归并默认。',
  'agent sources': '托管模型连接、缓存目录及显式认证。', 'agent network': '设备出站网络代理；认证不回显。',
  'agent packages': '安装或更新插件与 Skills，不自动启用。',
};
for (const [path, description] of Object.entries(directories)) entries.push({ path, description, directory: true });
function add(path, args, description, exampleArgs, rpc = [], kind = 'read', advanced = '') {
  entries.push({ path, description, directory: false, usage: `lush ${path}${args ? ` ${args}` : ''}`,
    example: `lush ${path}${exampleArgs ? ` ${exampleArgs}` : ''}`, rpc, kind, advanced });
}
for (const [method, spec] of Object.entries(RUNNER_METHODS)) {
  const args = spec.args ?? (spec.file ? '--file PATH' : method === 'runner.nodes.check' ? 'NODE_ID [--project-id PROJECT_ID]' : '');
  const example = spec.example ?? (spec.file ? `--file ${spec.file}` : method === 'runner.nodes.check' ? 'NODE_ID' : '');
  add(spec.cli, `${args}${spec.device ? ' [--scope device]' : ''}`.trim(), spec.description, example, [method], spec.readPath ? 'read' : 'write',
    spec.advanced ?? '仅用户；JSON 文件须 owner-only，包含 expected_revision。秘密不能放命令参数。--scope device 不发现项目、不启动 daemon；check 此时必须 --project-id。诊断不代表已绑定，未知结果先检查、不重试写入。');
}
add('help', '', '打印完整公开 CLI 帮助，不发现项目或发送 RPC。', '', [], 'local-read', '--help / -h 可放在任意位置，优先只打印帮助，不执行命令。');
for (const verb of ['start','stop','restart','status']) {
  add(`daemon ${verb}`, '', { start: '启动所选项目后台；已运行时不替换代码。', stop: '停止所选项目后台。', restart: '停止后重新启动所选项目后台。', status: '读取项目后台身份与状态。' }[verb], '',
    verb === 'stop' ? ['system.stop'] : verb === 'restart' ? ['system.stop','system.status'] : ['system.status'], verb === 'status' ? 'read' : 'local-write', '后台控制仅用户可用；停止／重启前确认项目安全空闲。');
  add(`host ${verb}`, '[PORT]', { start: '启动 Web Host；已有进程不替换。', stop: '停止 Web Host，不停止项目后台。', restart: '重新启动 Web Host，登录会话失效。', status: '读取真实 Web Host 代码身份。' }[verb], '', [], verb === 'status' ? 'local-read' : 'local-write', 'Host 控制是本地用户能力，不对应可授权的项目 RPC。start/restart 可用 --foreground；未指定项目进入全局工作台。');
}
add('status', '', '读取项目与 Worker 状态。', '', ['system.status']);
add('doctor', '[--verbose]', '核对当前磁盘、daemon 与 Host 的代码身份。', '', ['system.status'], 'local-read', '--verbose 显示完整诊断；包含本地进程检查，不只是 system.status。');
add('log', '', '读取所选项目 daemon 日志末尾 60 行。', '', [], 'local-read', '本地文件读取，不向 Valet 开放日志或 Shell。');
add('order', "'目标' [--branch NAME] [--runner-node UUID|local] [--profile-file PATH] [--management] [--buffer] [--append ID|Wn] [--quiet] [--exclusive] [--after-settled ID|Wn] [--after-merged ID|Wn] [--defer]", '提交开发指令、条件输入或即时 Valet 管理需求。', "'实现需求' --branch main", ['order.submit','input.emit','draft.add','management.submit','worker.lookup'], 'agent', '默认可靠挂载，安全准入后才创建／调用；--buffer 只保存草稿。--management 独立创建 Valet，不可与开发条件混用。条件可重复，profile 文件须 owner-only。--runner-node 随新建输入持久保存，支持条件与暂存，不用于追加、管理或旧 --defer。各 RPC 按实际选项分支调用，授权其中一个不等于开放全部命令。');
const workers = [
  ['list','[--brief] [--after N] [--limit N]','读取 Worker 列表，可选短摘要。','','worker.list'],
  ['tree','[ID|Wn]','查看 Worker 委派树；非 JSON 附带状态。','','worker.tree,system.status'],
  ['inspect','ID|Wn|Vn','查看完整 Worker 详情。','W5','worker.inspect'],
  ['spawn',"'目标' --parent ID|Wn [--name NAME] [--runner-node UUID|local]",'在活动指令或 child 下创建独立子 Worker。',"'专项实现' --parent W5",'worker.spawn','agent'],
  ['auto-title',"'标题'",'为自身一次性生成自动展示标题；仅活动指令／child Agent。',"'接口实现'",'worker.auto_title','write'],
  ['rename',"ID|Wn '标题'",'只修改展示标题；空标题恢复自动标题。',"W5 '接口实现'",'worker.rename','write'],
  ['message',"ID|Wn '说明'",'向既有 Worker 追加输入，可能唤醒 Agent。',"W5 '补充测试'",'worker.message','agent'],
  ['watch','ID|Wn|Vn [--after N]','终端内观看执行；q/Esc/Ctrl-C 退出。','W5','worker.inspect,worker.transcript_page','local-read'],
  ['transcript','ID|Wn|Vn [--after N]','单次读取执行记录，不跟随。','W5','worker.transcript'],
  ['history','ID|Wn|Vn [--after N]','读取 Worker 事件历史。','W5','worker.history'],
  ['wait','ID|Wn|Vn','用户终端等待结束；Agent 必须结束本轮而非等待。','W5','worker.inspect','local-read'],
  ['hooks','ID|Wn','读取实际挂载与修改 revision。','W5','worker.hooks'],
  ['completion','ID|Wn off|merge|accept --revision REV','设置最高自动环节；验收含资源回收。','W5 merge --revision REV','worker.completion','write'],
  ['auto-merge','ID|Wn on|off','设置持久自动合并开关；child 锁定。','W5 on','worker.auto_merge','write'],
  ['merge','ID|Wn','请求一次合并，不改变持久开关。','W5','worker.reserve','write'],
  ['merge-all','BRANCH','将分支下静息待合并 Worker 逐条入队。','main','worker.reserve_all','write'],
  ['merge-cancel','ID|Wn','撤销未发出的单次合并请求。','W5','worker.unreserve','write'],
  ['accept','ID|Wn','验收即归档：安全回收 worktree/ref，保留历史。','W5','worker.accept','destructive'],
  ['reopen','ID|Wn','恢复历史已合并 Worker 待验收，不调用 Agent。','W5','worker.reopen','write'],
  ['sync-parent','ID|Wn','安全同步父提交；冲突仅返回诊断。','W5','worker.sync_parent','write'],
  ['resolve-sync','ID|Wn','调用 Agent 修复已记录的同步冲突。','W5','worker.resolve_sync','agent'],
  ['clear-override','ID|Wn','清除独立运行覆盖，回到设备／角色默认。','W5','worker.clear_override','write'],
  ['cancel','ID|Wn|Vn','取消开发 Worker，或停止管家并撤销尚未执行的授权。','W5','worker.cancel','destructive'],
  ['retry','ID|Wn','显式重试失败 Worker，可能调用 Agent。','W5','worker.retry','agent'],
  ['interrupt','ID|Wn|Vn','请求在调用安全点暂停。','W5','worker.interrupt','write'],
  ['resume','ID|Wn','开始或继续暂停 Worker，可能调用 Agent。','W5','worker.resume','agent'],
  ['cleanup','ID|Wn [--keep-branch]','安全回收专属工作区。','W5 --keep-branch','worker.cleanup','destructive'],
  ['delete-preview','ID|Wn|Vn [--force]','只读预检开发子树或管家的彻底删除范围。','W5','worker.delete_preview'],
  ['delete','ID|Wn|Vn --confirm --revision REV [--force]','精确确认预检范围后，彻底删除开发子树或管家专属历史与资源。','W5 --confirm --revision REV','worker.delete','destructive'],
];
for (const [verb,args,description,example,rpc,kind] of workers) add(`worker ${verb}`,args,description,example,rpc.split(','),kind,
  '编号通过 worker.lookup 解析，RPC 仍用整数 ID。目标类型、冻结、生命周期与 Git 安全门保持；合并交给父 runtime 队列处理。');
for (const verb of ['attach','enable','disable','remove']) add(`worker hook ${verb}`, verb === 'attach' ? 'ID|Wn --file PATH --revision REV' : 'ID|Wn HOOK_ID --revision REV',
  { attach: '从私有 JSON 挂载规则。', enable: '启用未来自动动作。', disable: '停用未来动作，不撤回已执行动作。', remove: '移除未来自动化挂载。' }[verb],
  verb === 'attach' ? 'W5 --file hook.json --revision REV' : 'W5 HOOK_ID --revision REV', [`worker.hook_${verb === 'attach' ? 'attach' : verb === 'remove' ? 'remove' : 'update'}`], 'write', '先读 worker hooks 的 revision；child 流程 Hook 整体锁定。');
add('hooks install', 'ID|Wn --file PATH', '原子注册 Shell 快捷指令并挂载 Hook，不立即执行。', 'W5 --file automation.json',
  ['hooks.install'], 'write', '仅用户 CLI；管家通过 manager.call 精确确认一次。文件含 command、hook、expected_revisions（commands 与 worker_hooks）、client_request_id。同 key 同参数返回原收据，不重装已移除的配置；Shell 非沙箱。');
for (const [verb,args,description,example] of [
  ['list','','读取项目自动化目录。',''], ['save','--file PATH --revision REV','保存模板，不挂载或调用 Agent。','--file template.json --revision REV'],
  ['remove','TEMPLATE_ID --revision REV','删除模板，不影响已有实例。','TEMPLATE_ID --revision REV'],
  ['auto-select','on|off --revision REV','启停设备全局自动选择。','off --revision REV'],
]) add(`hooks ${verb}`,args,description,example,[`hooks.${verb.replaceAll('-','_')}`], verb === 'list' ? 'read' : 'write', '仅用户；JSON 文件须 owner-only。auto-select 使用 daemon_hooks.revision，开启也答复在线项目已有问题，可能继续消耗 token；设备作用域须明确。');
for (const [verb,args,description,example,rpc,kind] of [
  ['list','','读取快捷指令目录。','','hooks.list','read'],
  ['save','--file PATH --revision REV','保存 Shell 或提示词定义，未来自动化跟随最新定义。','--file command.json --revision REV','hooks.command_save','write'],
  ['export','ID --version N','只读导出单条 Skill 风格 Markdown，不安装或执行。','COMMAND_ID --version 1','hooks.command_export','read'],
  ['remove','ID --revision REV','删除快捷指令，阻止未来执行。','COMMAND_ID --revision REV','hooks.command_remove','destructive'],
  ['history','[--before CURSOR] [--limit N] [--execution UUID]','读取每次运行的安全摘要。','','hooks.command_history','read'],
  ['import','--file PATH --revision REV','显式导入旧内联命令并停用源 Hook。','--file source.json --revision REV','hooks.command_import','write'],
]) add(`hooks command ${verb}`,args,description,example,[rpc],kind,'读取 hooks.list.commands，修改使用 commands.revision。不提供手动运行入口。Shell 非沙箱；提示词执行会创建 Worker／消耗 token。history 的 execution 与 before 互斥；limit 1..100。');
for (const verb of ['save','remove']) add(`hooks signal ${verb}`, verb === 'save' ? '--file PATH --revision REV' : 'SIGNAL_ID --revision REV',
  verb === 'save' ? '保存时间信号，时间到达不证明额度恢复。' : '删除无启用绑定的信号。', verb === 'save' ? '--file signal.json --revision REV' : 'SIGNAL_ID --revision REV', [`hooks.signal_${verb}`], 'write', '使用 hooks.list 返回的 signals.revision；修改时须携带最新 revision。');
for (const verb of ['create','enable','disable']) add(`hooks management ${verb}`, verb === 'create' ? '--file PATH' : 'ID|Vn --revision REV',
  verb === 'create' ? '创建并绑定 Valet，到信号时才调用 Agent。' : `${verb === 'enable' ? '启用' : '停用'} Valet 信号绑定。`,
  verb === 'create' ? '--file valet.json' : 'V1 --revision REV', [verb === 'create' ? 'management.create' : 'management.binding_update'], 'write', '保存不立即调用 Agent；默认一次性，持续复用原 Valet。启停使用该管家 management.revision，不是信号库 revision。未知副作用不重放，不能自复制或自提权。');
add('branch tree','[--verbose]','读取分支谱系，不等同 Worker 树。','',['branch.tree']);
add('branch show','BRANCH','读取单条分支详情。','main',['branch.show']);
add('branch bind','BRANCH COMMIT','显式绑定已有本地分支。','feature COMMIT',['branch.bind'],'write');
add('branch archive','BRANCH [--discard] [--continue]','清理特殊／失败分支资源；discard 丢弃脏现场。','feature',['branch.archive'],'destructive');
for (const [verb,args,description,example,rpc,kind] of [
  ['plan','BRANCH','只读预检全部可准入来源与排除原因。','main','branch.integrate_plan','read'],
  ['start','BRANCH --revision REV','固定完整集合并调用一个自主整合 Agent，最终一次 Squash。','main --revision REV','branch.integrate_start','agent'],
  ['show','ID','读取操作、完整固定成员及真实状态。','1','branch.integration','read'],
  ['cancel','ID --revision REV','安全停止整合，保留来源和私有代码。','1 --revision REV','branch.integrate_cancel','write'],
  ['retry','ID --revision REV','显式重试固定整合，重新适配并验证最终树。','1 --revision REV','branch.integrate_retry','agent'],
]) add(`branch integrate ${verb}`,args,description,example,[rpc],kind,'仅用户；目标必须是 main/owner/order/child 的真实本地分支。无冲突也调用整合 Agent；整合不改变来源父子关系，未知落地不重放。');
for (const [verb,args,description,example,rpc,kind] of [
  ['list','','读取历史归并配置与默认。','','branch.convergence_list','read'],
  ['show','BRANCH','读取历史单分支策略与 revision。','main','branch.convergence','read'],
  ['on','BRANCH --revision REV','已退休：拒绝开启持续归并。','main --revision REV','branch.convergence_set','write'],
  ['off','BRANCH --revision REV','已退休：拒绝修改历史归并启停。','main --revision REV','branch.convergence,branch.convergence_set','write'],
  ['mount','BRANCH --revision REV','已退休：拒绝挂载持续归并。','main --revision REV','branch.convergence,branch.convergence_set','write'],
  ['remove','BRANCH --revision REV','已退休：拒绝修改历史归并挂载。','main --revision REV','branch.convergence_set','write'],
  ['runs','BRANCH [--before N] [--limit N]','读取归并历史，默认20、最多50。','main','branch.convergence_runs','read'],
  ['retry','RUN_ID --revision REV','仅重试可恢复的旧在途，可能调用整合 Agent。','1 --revision REV','branch.convergence_retry','agent'],
  ['defaults show','','读取退休的历史归并默认与 revision。','','branch.convergence_defaults','read'],
  ['defaults set','--mounted true|false --enabled true|false [--scope main|all|user|none] --revision REV','已退休：拒绝修改持续归并默认。','--mounted false --enabled false --revision REV','branch.convergence_defaults_set','write'],
]) add(`branch convergence ${verb}`,args,description,example,rpc.split(','),kind,'历史兼容只读面和旧在途重试仍可用；持续策略和默认写入口已退休并明确拒绝。新普通合并始终串行，多来源使用 branch integrate。不接受旧 command/version 参数；旧引用仅后端在途兼容。');
for (const [verb,args,description,example,rpc,kind] of [
  ['list','','读取当前通知。','','notice.list','read'], ['post',"'标题' [--worker ID|Wn] [--body TEXT] [--questions-file FILE]",'发布问题或告知。',"'方案确认' --worker W5 --body '背景'",'notice.post','write'],
  ['answer','ID ANSWER | ID --answers-file FILE','答复固定通知，可能恢复 Agent。',"12 '答复'",'notice.answer','agent'],
  ['dismiss','ID','消除通知，不代表接受推荐方案。','12','notice.dismiss','write'], ['read','ID','标记告知已知，不执行动作。','13','notice.read','write'],
  ['example','','输出完整问卷 JSON，无需项目或后台。','','','local-read'],
  ['check','--questions-file FILE [--body TEXT]','本地预检问卷格式与限额，不发布。','--questions-file questions.json','','local-read'],
]) add(`notice ${verb}`,args,description,example,rpc ? [rpc] : [],kind,'D/N 只是展示前缀，Notice 参数仍用整数。answer 使用 --answers-file 时不再提供 ANSWER；本地预检不证明权限或状态。');
add('progress plan','KEY[:显示名]...','Agent 规划少量有序里程碑。','inspect:核对 implement:实现',['progress.plan'],'write','仅自身活动 invocation；完成前不可提前标完成。');
add('progress complete','KEY','Agent 标记实际已完成里程碑。','inspect',['progress.complete'],'write');
add('skills list','','读取代码内置能力指南目录。','',[],'local-read');
add('skills get','ID','读取 progress / delegation / auto-title / context 指南。','progress',[],'local-read','无需项目／daemon，不读取设备开启状态。');
for (const [verb,args,description,example,rpc,kind] of [
  ['show','[--scope device]','读取设备 Agent 配置。','','agent.config','read'],
  ['models','pi|codex [--scope device]','读取后端可用模型。','pi','agent.models','read'],
  ['set','TARGET --config-mode lush|pi [--agent pi|codex] [--connection UUID|off] [--model PROVIDER/MODEL] [--thinking LEVEL] [--default-prompt TEXT] [--append-prompt TEXT] [--budget-responses N|off] [--budget-tokens N|off] [--scope device]','保存设备默认或角色 Agent 配置。','default --config-mode pi','agent.config,agent.configure','write'],
  ['reset','ROLE [--scope device]','清除角色设置，继承设备默认。','agent','agent.config,agent.configure','write'],
  ['prompt','ROLE','本地读取最终组合 Prompt，仅用户。','agent','','local-read'],
  ['env','ROLE','本地读取环境键及来源，值脱敏。','agent','','local-read'],
  ['init','[ROLE] [--local]','创建补充约定文件，不覆盖已有文件。','agent','','local-write'],
  ['resources','[--scope device]','读取本地模型、来源与额度缓存，不联网。','','agent.selection.resources','read'],
]) add(`agent ${verb}`,args,description,example,rpc ? rpc.split(',') : [],kind,'仅用户；设备配置不接受 project scope。TARGET 为 default 或实际角色。Pi 默认模式不混入托管覆盖；补充 Prompt 使用 --append-prompt。init --local 创建设备私有补充。');
for (const [verb,args,description,example,rpc,kind] of [
  ['list','','读取托管来源安全列表。','','agent.connections.list','read'],
  ['show','ID','从安全列表查看指定来源。','CONNECTION_ID','agent.connections.list','read'],
  ['refresh','[ID]','显式联网查询来源额度，再读取列表。','','agent.connections.query,agent.connections.list','write'],
  ['models','ID','只读缓存模型目录，不联网刷新。','CONNECTION_ID','agent.connections.models','read'],
  ['models-refresh','ID','显式联网刷新并保存来源模型目录。','CONNECTION_ID','agent.connections.models.refresh','write'],
  ['save','--file PATH','从私有 JSON 保存连接与凭证，不经 argv 回显。','--file connection.json','agent.connections.save','write'],
  ['remove','ID','删除托管来源，不改历史调用。','CONNECTION_ID','agent.connections.remove','destructive'],
  ['login','ID [--callback | --poll LOGIN_ID | --cancel LOGIN_ID | --finish LOGIN_ID --url-file PATH]','显式设备或回调登录；认证材料仅用户。','CONNECTION_ID','agent.connections.device.start,agent.connections.device.poll,agent.connections.device.cancel,agent.connections.login.start,agent.connections.login.finish','write'],
]) add(`agent sources ${verb}`,args,description,example,rpc.split(','),kind,'可选 --scope device；scope 默认设备。登录分支一对多，不自动完成交互、不授权 Valet 认证。模型目录刷新失败不冒充缓存成功。');
for (const verb of ['show','set','reset']) add(`agent network ${verb}`, verb === 'set' ? '--file PATH [--scope device]' : '[--scope device]',
  { show: '读取设备出站代理设置，认证不回显。', set: '从 JSON 保存出站网络代理。', reset: '恢复继承后台启动环境。' }[verb], verb === 'set' ? '--file network.json' : '',
  [verb === 'show' ? 'agent.network' : 'agent.network.configure'], verb === 'show' ? 'read' : 'write', '后续后台请求与 Agent 生效，不热改旧调用。密码不能放命令参数。');
for (const verb of ['list','install','remove','update']) add(`agent packages ${verb}`, `${verb === 'install' ? 'SOURCE ' : ['remove','update'].includes(verb) ? 'ID ' : ''}[--scope device]`,
  { list: '读取插件与 Skills 包目录。', install: '安装显式固定来源，不自动启用。', remove: '移除设备包。', update: '更新指定包。' }[verb], verb === 'install' ? './package' : ['remove','update'].includes(verb) ? 'PACKAGE_ID' : '',
  [`agent.packages.${verb}`], verb === 'list' ? 'read' : 'write', '远端来源固定校验由 daemon 执行；包可带可执行代码。');
add('config show','[--scope device]','读取设备调用／拆解限额。','',['system.status','system.settings'],'read','无 scope 读取 status.settings，显式 scope 读取 system.settings。旧路由只读，不恢复快速路由设置。');
add('config set','call-timeout|worker-call-limit|max-depth N [--scope device]','保存设备调用或拆解限额。','max-depth 4',['system.configure'],'write','正整数及上限由共享设置契约校验。');
add('config reset','[call-timeout|worker-call-limit|max-depth|all] [--scope device]','恢复指定或全部限额默认。','max-depth',['system.configure'],'write');
add('config migrate-preview','','只读预检旧项目设置到设备共享设置的迁移。','',['settings.migration.preview'],'read','不接受 --scope device；预检不执行迁移。');
add('config migrate','--confirm --revision REV','显式确认预检范围后迁移旧项目设置。','--confirm --revision REV',['settings.migration.apply'],'write','先运行 config migrate-preview；保留私有备份及旧 Markdown 原件，不接受 --scope device。未知结果先核对，不重放。');
// Lifecycle learning notes describe runtime safety, not additional RPC permissions.
const lifecycleNotes = {
  order: '即时 --management 从持久排队起占当前项目串行位；已有管家尚未安全收口时拒绝新建。等待未来信号的未触发绑定不占位。',
  'hooks management create': '当前项目已有管家排队、运行、待确认或未收口操作时拒绝新建绑定；未触发的未来绑定不占位。',
  'hooks management disable': '撤销尚未执行的动作与危险确认，不强杀模型、不撤回已开始操作；真实退出及在途操作收口前仍占串行位。',
  'worker cancel': '停止管家会撤销未执行授权并请求中止模型；cancelled 只表示停止已请求，不证明实际退出，不撤回已执行操作。',
  'worker completion': '验收不调用评审 Agent，脏工作区阻止自动回收；CLI 只接受 off/merge/accept。',
  'worker delete': '用户先运行 worker delete-preview ID 预检，再用 worker delete ID --confirm --revision REV 精确确认；强制模式两步均须 --force。管家须停用授权、模型真实退出且 occurrence／确认／受控操作安全收口后重新预检；unknown 副作用阻止删除。安全收口的 waiting 管家无需开发验收；仅删除专属非 Git 目录与历史，不删除其创建的开发 Worker 或时间信号。',
};
export const CLI_OPERATIONS = Object.freeze(['read', 'write']);
// Classification describes the whole CLI entry, independently of RPC authorization.
// Preparatory reads do not make a mutating command read-only.
const operationFor = entry => ['read', 'local-read'].includes(entry.kind) ? 'read' : 'write';
export const CLI_COMMANDS = Object.freeze(entries.map(entry => {
  const numbered = entry.path.startsWith('worker ') && !['worker list','worker auto-title','worker merge-all'].includes(entry.path)
    || ['notice post','hooks install','hooks management enable','hooks management disable'].includes(entry.path);
  return Object.freeze({ ...entry, operation: entry.directory ? null : operationFor(entry),
    advanced: [entry.advanced, lifecycleNotes[entry.path]].filter(Boolean).join(' '),
    risk: lifecycleNotes[entry.path],
    // ID below accepts the stable W/V forms described in shared help and detail notes.
    usage: entry.usage?.replaceAll('ID|Wn|Vn', 'ID').replaceAll('ID|Wn', 'ID').replaceAll('ID|Vn', 'ID'),
    format: entry.usage && (entry.path === 'notice answer' ? 'lush notice answer ID ANSWER' : entry.usage.replace(/\s*\[[^\]]*\]/g, ''))
      .replaceAll('ID|Wn|Vn', 'ID').replaceAll('ID|Wn', 'ID').replaceAll('ID|Vn', 'ID'),
    parent: entry.path.includes(' ') ? entry.path.slice(0, entry.path.lastIndexOf(' ')) : null,
    rpc: Object.freeze([...new Set([...(entry.rpc ?? []), ...(numbered && !entry.directory ? ['worker.lookup'] : [])])]),
  });
}));
// Public entry-point classification; the management policy consumes the same
// catalogue-derived RPC set as CLI dispatch/help and browser discovery.
export const LUSHC_PATHS = new Set([
  'help', 'status',
  'worker list', 'worker tree', 'worker inspect', 'worker spawn', 'worker auto-title',
  'worker message', 'worker transcript', 'worker history', 'worker accept',
  'branch tree', 'branch show', 'notice list', 'notice post', 'notice example', 'notice check',
  'progress plan', 'progress complete', 'skills list', 'skills get',
]);
export const SHARED_CLI_PATHS = new Set([
  'help', 'status', 'worker list', 'worker tree', 'worker inspect', 'worker transcript',
  'worker history', 'branch tree', 'branch show', 'notice list',
]);
export const LUSHC_METHODS = new Set(CLI_COMMANDS.filter(entry => LUSHC_PATHS.has(entry.path))
  .flatMap(entry => entry.rpc));

export const CLI_EXECUTABLES = Object.freeze(['lush', 'lushc']);
export function commandExecutables(entry) {
  if (SHARED_CLI_PATHS.has(entry.path)) return CLI_EXECUTABLES;
  return LUSHC_PATHS.has(entry.path) ? ['lushc'] : ['lush'];
}

/** Entry-point views share the original relative paths, parameters and handlers. */
export function cliCommands(executable = 'lush') {
  if (!CLI_EXECUTABLES.includes(executable)) throw new Error('unknown CLI executable');
  const leaves = CLI_COMMANDS.filter(entry => !entry.directory && commandExecutables(entry).includes(executable));
  const paths = new Set(leaves.flatMap(entry => {
    const parts = entry.path.split(' ');
    return parts.map((_part, index) => parts.slice(0, index + 1).join(' '));
  }));
  return CLI_COMMANDS.filter(entry => paths.has(entry.path)).map(entry => {
    const qualify = value => value?.replace(/^lush(?=\s|$)/, executable);
    const operations = entry.directory
      ? CLI_OPERATIONS.filter(operation => leaves.some(leaf => leaf.path.startsWith(`${entry.path} `) && leaf.operation === operation))
      : [entry.operation];
    return Object.freeze({ ...entry, executable, operations: Object.freeze(operations), usage: qualify(entry.usage),
      format: qualify(entry.format), example: qualify(entry.example) });
  });
}

export function cliHelp(executable = 'lush') {
  const development = executable === 'lushc';
  const commands = cliCommands(executable);
  return `Lush — ${development ? '开发 Worker 协作接口' : '项目管理接口'}\n\n${executable} [--project PATH] [--json] <command>\n${commands.filter(entry => !entry.directory).map(entry => `  ${entry.usage.slice(executable.length + 1)}\n    ${entry.description}${entry.advanced ? ` ${entry.advanced}` : ''}`).join('\n')}\n\n${development ? 'lushc 提供开发协作；lush 管理项目。入口不替代 invocation、目标与生命周期权限核验。\n本地问卷示例：bun run lushc notice example > questions.json' : 'config show|set|reset 管理设备限额；不向 Agent token 开放管理入口。\n开发协作命令使用 lushc，不保留旧 lush 别名。'}\nWorker／Valet 可用整数或稳定编号 W5 / W5-1 / V1，RPC 身份仍为整数。\n原始输入显示 O5；Notice 显示 D/N，参数仍用整数。\n新指令只走 lush order；旧 Intent/Plan/Candidate、展示、介绍、托管、旧草稿命令和旧批量合并入口不再提供。\nJSON 配置文件须 owner-only；修改先读 revision，未知副作用不重放。\n`;
}
