import { defineCommands } from '../command-spec.js';
import { HOOK_MOUNT_REFERENCE_SCHEMA } from '../../core/hook-registration.js';
import { INPUT_EMIT_SCHEMA } from '../../core/input-emission-protocol.js';

const text = { type: 'string' }, positive = { type: 'integer', minimum: 1 }, nonnegative = { type: 'integer', minimum: 0 };
const worker = { type: 'string', pattern: '^(?:[1-9][0-9]*|W[1-9][0-9]*(?:-[1-9][0-9]*)*|V[1-9][0-9]*)$', description: '实际整数或持久 W/V 编号；不能由内部 ID 推算编号。' };
const rev = { type: 'string', minLength: 1, maxLength: 256, required: true };
const booleanValue = { type: 'string', enum: ['true','false'] };
const positional = (name, schema = text, required = true) => ({ name, required, schema });
const options = fields => Object.fromEntries(Object.entries(fields).map(([key, value]) => [`--${key.replaceAll('_', '-')}`, value]));
const params = (positionals = [], fields = {}) => ({ positionals, options: options(fields) });
const target = [positional('ID', worker)];
const storedProfile = INPUT_EMIT_SCHEMA.properties.profile.anyOf[0];
const safety = '编号仅解析真实身份；目标类型、最新权限、冻结、生命周期及 Git 安全门在执行时复核。示例 W5/REV 须以真实查询值替换。';
const recovery = '等待或待确认时结束调用；未知结果保留原收据，只读核对，不自动重放；请求返回不证明业务完成。';

export const COMMANDS = defineCommands(add => {
  const declare = (path, usage, description, example, rpc, kind = 'read', fields = {}, extra = {}) => add(path, usage, description, example,
    [...new Set([...rpc, ...(path.startsWith('worker ') && path !== 'worker list' ? ['worker.lookup'] : [])])], kind,
    safety, { parameters: fields, applicability: ['user','valet'], scope: 'current_project', sources: ['从同项目的列表或真实用户指定取得目标；示例值不是授权。'],
      preconditions: ['执行时重新检查真实身份、方法权限和目标准入。'], effects: kind === 'read' ? ['只读；摘要与覆盖范围以返回值为准。'] : ['只提交本命令明确动作，不重放未知副作用。'],
      recovery, ...extra });

  declare('worker list', '[--view recent|all|history] [--scope work|all] [--brief] [--cursor CURSOR] [--after N] [--before N] [--limit N]',
    '分页读取工作；默认 recent 为活动项加有界历史尾部，all 为完整升序枚举，history 仅历史终态。', '--view recent --limit 50',
    ['worker.activity','worker.list','worker.page'], 'read', params([], {
      view: { type: 'string', enum: ['recent','all','history'], default: 'recent' }, scope: { type: 'string', enum: ['work','all'], default: 'work' }, brief: { type: 'boolean' },
      cursor: { ...text, description: '上一页 page.next_cursor，绑定 view/scope/brief；不能与 before/after 混用。' }, after: nonnegative, before: positive,
      limit: { ...positive, maximum: 1000, description: 'recent/history 1..200 默认50；all 1..1000 默认200；brief 1..200 默认30；Valet all 实际最多100。' },
    }), { modes: [
      { id: 'recent', when: 'view=recent（默认），只可用scope；续读仅worker.page，不重新插入活动项。', rpc: ['worker.activity','worker.page'] },
      { id: 'all', when: 'view=all；brief/after仅此模式，不接受scope/before；使用原权限下paged读面保留真实条数与字节分页证据。', rpc: ['worker.list'] },
      { id: 'history', when: 'view=history；scope/before可用，不接受brief/after。', rpc: ['worker.page'] },
    ], sources: ['page.next_cursor 必须在相同 view、scope 和 brief 下原样续读；原 worker list 脚本须显式 --view all。', 'Valet recent 的活动项仅为有界摘要，实际历史limit可能收紧；完整升序枚举使用 --view all。保留原总数、active_total/active_truncated及bridge截断标志，不能将摘要视为全量。'] });
  declare('worker tree', '[ID]', '读取委派树；人类模式另读取状态以说明排队／调用。', '', ['worker.tree','system.status'], 'read', params([positional('ID', worker, false)]), {
    modes: [{ id: 'json', when: '--json', rpc: ['worker.tree','worker.lookup'] }, { id: 'human', when: '默认文本', rpc: ['worker.tree','system.status','worker.lookup'] }],
  });
  declare('worker show', 'ID', '读取单个 Worker 或 Valet 详情，保留真实身份对应的 coverage。', 'W5', ['worker.inspect'], 'read', params(target));
  for (const [name, method, description, fields] of [
    ['progress','worker.progress_history','分页读取里程碑历史，不是执行正文。',{ before: positive, limit: { ...positive, maximum: 100, default: 10 } }],
    ['relations','worker.relations','分页读取目标的直接关系，不枚举项目。',{ after: { ...nonnegative, default: 0 }, limit: { ...positive, maximum: 200, default: 50 } }],
    ['events','worker.history','读取安全事件历史，按真实身份保留有界读面。',{ after: nonnegative }],
    ['transcript','worker.transcript','单次读取执行正文／受限元数据，不持续跟随。',{ after: nonnegative }],
  ]) declare(`worker ${name}`, `ID ${Object.keys(fields).map(key => `[--${key} N]`).join(' ')}`, description, 'W5', [method], 'read', params(target, fields));
  declare('worker spawn', "'目标' --parent ID [--name NAME]", '在活动开发父下即时创建独立 child，可能调用 Agent。', "'专项实现' --parent W5", ['worker.spawn'], 'agent', params([positional('目标')], { parent: { ...worker, required: true }, name: text }));
  declare('worker rename', "ID '标题'", '仅修改展示标题；空串恢复自动标题，不改变目标或执行。', "W5 '接口实现'", ['worker.rename'], 'write', params([...target, positional('标题')]));
  declare('worker message', "ID '说明'", '直接追加；冻结时可可靠暂存，成功不表示已处理；Valet 追加仍限真实用户。', "W5 '补充测试'", ['worker.message'], 'agent', params([...target, positional('说明')]));

  declare('worker config set', 'ID (--registered-model NAME_OR_ID [--scope device] | --connection UUID --model PROVIDER/MODEL | --data JSON)', '保存下一次运行覆盖；登记选择冻结具体绑定，窄更新原子保留其它字段，不读取私有配置。', 'W5 --registered-model astra --scope device', ['worker.configure','agent.registered_models.resolve'], 'write', params(target, {
    registered_model: { ...text, conflicts: ['--connection','--model','--data'], description: 'agent model list 的精确名称或稳定 ID；不修改后端或配置模式。' },
    scope: { type: 'string', enum: ['device'], description: '仅与 --registered-model 使用，只传登记解析；Valet 必须显式 device 且本轮用户已授权设备范围。' },
    connection: { ...text, format: 'uuid' }, model: text, data: { type: 'json', schema: storedProfile },
  }), { modes: [{ id: 'registered', when: '--registered-model 与 --connection/--model/--data 互斥；--scope 仅用于登记解析', rpc: ['agent.registered_models.resolve','worker.configure','worker.lookup'] },
    { id: 'model', when: '--connection与--model同时提供，与--data互斥', rpc: ['worker.configure','worker.lookup'] },
    { id: 'profile', when: '--data完整显式覆盖，不接受--connection/--model', rpc: ['worker.configure','worker.lookup'] }],
    sources: ['已注册选择来自 agent model list；直接来源与模型来自 agent model choices；完整 profile 使用本叶 schema，Valet 仍拒绝私有字段。'],
    preconditions: ['登记解析仍须 Valet 本轮设备授权及显式 --scope device；后续项目动作独立检查原写权限和生命周期，不传设备 scope。', '窄更新仅支持已有 Pi lush 配置，不偷偷切换模式／后端。'],
    effects: ['仅保存具体 connection_id + model，不保存登记动态引用；不自动继续／重试／热换当前调用。'] });
  declare('worker config reset', 'ID', '清除 Worker 显式覆盖、恢复继承，不改设备默认或开始调用。', 'W5', ['worker.clear_override'], 'write', params(target));
  declare('worker sync start', 'ID', '程序同步固定父提交；冲突只返回诊断。', 'W5', ['worker.sync_parent'], 'write', params(target));
  declare('worker sync resolve', 'ID', '显式调用 Agent 修复已记录的父同步冲突。', 'W5', ['worker.resolve_sync'], 'agent', params(target));
  declare('worker merge show', 'ID', '读取本轮条件配置、状态及独立 revision。', 'W5', ['worker.merge_conditions'], 'read', params(target));
  declare('worker merge request', 'ID [--after-settled ID] [--after-merged ID] [--revision REV]', '一次合并请求，不开启持久开关、不证明代码已合入；条件为 AND。', 'W5', ['worker.reserve','worker.merge_after'], 'write', params(target, {
    after_settled: { ...worker, repeatable: true }, after_merged: { ...worker, repeatable: true }, revision: { ...rev, required: false },
  }), { modes: [
    { id: 'immediate', when: '没有条件，不接受revision', rpc: ['worker.reserve','worker.lookup'], preconditions: ['真实目标；不要求读取条件或挂载 revision。'] },
    { id: 'conditional', when: '至少一个after条件，必须revision', rpc: ['worker.merge_after','worker.lookup'], preconditions: ['先 worker merge show ID 获取条件revision；每个依赖必须真实存在。'] },
  ], sources: ['条件 revision 仅来自 worker merge show；不可与 worker automation show 的 revision 互换。'], effects: ['提交本轮意图，runtime 等待条件及原交付安全点；不改变持久自动化。'] });
  declare('worker merge cancel', 'ID', '只撤销合法未发出的本轮请求，不撤回既有合入。', 'W5', ['worker.unreserve'], 'write', params(target));
  declare('worker automation show', 'ID', '读取实际挂载、最高级别、合法状态及 revision。', 'W5', ['worker.hooks'], 'read', params(target));
  declare('worker automation completion', 'ID off|merge|accept --revision REV', '设置最高自动级别，不是立即完成；child 流程锁定，验收包括安全资源回收。', 'W5 accept --revision REV', ['worker.completion'], 'write', params([...target, positional('LEVEL', { enum: ['off','merge','accept'] })], { revision: rev }), { sources: ['先 worker automation show ID 取得 revision；授权不继承给 child。'] });
  declare('worker automation attach', 'ID --data JSON --revision REV', '只挂载已登记的固定功能版本，不注册或执行。', 'W5 --data \'{"template_id":"ID","template_version":1}\' --revision REV', ['worker.hook_attach'], 'write', params(target, { data: { type: 'json', schema: HOOK_MOUNT_REFERENCE_SCHEMA, required: true }, revision: rev }), {
    sources: ['revision 来自 worker automation show ID；template_id/version 来自 automation list 的真实登记完成证据。'], preconditions: ['仅接受 --data JSON；child 流程 Hook 锁定。'],
  });
  for (const verb of ['enable','disable','detach']) declare(`worker automation ${verb}`, 'ID MOUNT_ID --revision REV',
    { enable: '启用未来动作，不重放失败／未知的一次性挂载；auto-merge 保留既有最高级别。', disable: '停用未来动作，不撤回已经开始或完成的副作用。', detach: '解除实际挂载，不删除登记定义；系统与 child 流程仍保护。' }[verb],
    `W5 ${verb === 'detach' ? 'MOUNT_ID' : 'auto-merge'} --revision REV`, [verb === 'detach' ? 'worker.hook_remove' : 'worker.hook_update'], 'write', params([...target, positional('MOUNT_ID')], { revision: rev }), {
      sources: ['mount ID 与 revision 来自 worker automation show ID。旧 auto_merge 授权不自动变为 hook_update；最新权限仍逐方法检查。'],
    });

  for (const [verb, rpc, kind, description] of [
    ['pause','worker.interrupt','write','安全点暂停请求，不证明进程已退出。'], ['resume','worker.resume','agent','开始或继续合法暂停工作，可能调用 Agent。'],
    ['retry','worker.retry','agent','显式重试合法失败，不绕过 unknown 或旧调用门禁。'], ['cancel','worker.cancel','destructive','取消工作／撤销未开始授权；不保证既有副作用撤销或进程已退出。'],
    ['reopen','worker.reopen','write','用户恢复已合并历史工作待验收；不自动调用 Agent 或重建归档资源。'],
  ]) declare(`worker ${verb}`, 'ID', description, 'W5', [rpc], kind, params(target));
  declare('worker accept', 'ID', '验收即归档与安全回收；不跳过通知、交付或资源安全门。', 'W5', ['worker.accept'], 'destructive', params(target), {
    effects: ['安全核验整棵合法派生子树并回收资源；只有回收完成才报告验收完成。'] });
  declare('worker delete-preview', 'ID [--force]', '只读预检彻底删除的精确范围与 revision。', 'W5', ['worker.delete_preview'], 'read', params(target, { force: { type: 'boolean' } }));
  declare('worker delete', 'ID --confirm --revision REV [--force]', '精确确认预检后彻底删除专属历史与资源；不绕过共享／未知副作用保护。', 'W5 --confirm --revision REV', ['worker.delete'], 'destructive', params(target, { confirm: { type: 'boolean', required: true }, revision: rev, force: { type: 'boolean' } }), { sources: ['先 worker delete-preview ID；force 模式两步均必须 force，目标与 revision 必须对应。'] });

  declare('branch tree', '[--verbose]', '读取分支谱系。', '', ['branch.tree'], 'read', params([], { verbose: { type: 'boolean' } }));
  declare('branch show', 'BRANCH', '读取单分支详情。', 'main', ['branch.show'], 'read', params([positional('BRANCH')]));
  declare('branch merge-all', 'BRANCH', '逐项普通串行合并请求，不创建整合 Agent。', 'main', ['worker.reserve_all'], 'write', params([positional('BRANCH')]));

  declare('status', '[--detail] [--development true|false]', '默认读取当前项目有界概况；detail 读取完整安全状态，不能与development混用。', '', ['system.summary','system.status'], 'read', params([], { detail: { type: 'boolean' }, development: booleanValue }), {
    modes: [{ id: 'summary', when: '默认，可development筛选', rpc: ['system.summary'] }, { id: 'detail', when: '--detail，与development互斥', rpc: ['system.status'] }],
  });
  declare('project diagnostics', '', '读取当前项目用量速率／估算费用及覆盖不足，不是全设备统计。', '', ['system.diagnostics'], 'read', params());
  declare('project pause', '[--notify-completion on|off]', '持久项目维护门与安全点暂停，不强杀、不跨项目；完成告知默认on。', '', ['system.interrupt_all'], 'write', params([], { notify_completion: { type: 'string', enum: ['on','off'], default: 'on' } }));
  declare('project resume', '', '只恢复本次维护影响的合法范围，可能继续调用 Agent。', '', ['system.resume_all'], 'agent', params());
  declare('daemon request-stop', '', '仅提交当前项目受控停止 RPC，不运行本地进程工作流。', '', ['system.stop'], 'write', params());
  for (const verb of ['start','stop','restart']) declare(`daemon ${verb}`, '',
    { start: '启动所选项目；已有后台不替换代码。', stop: '本地等待停止工作流，先确认项目安全空闲。', restart: '安全停止后启动当前代码；不自动重启忙碌项目。' }[verb], '',
    verb === 'start' ? ['system.status'] : verb === 'stop' ? ['system.stop'] : ['system.stop','system.status'], 'local-write', params(), { applicability: ['user'], effects: ['用户本地生命周期；不能与 daemon request-stop 混用，不授予 Valet 本地进程控制。'] });
  declare('daemon log', '', '只读本地 daemon 日志末尾60行，不向 Valet 开放文件。', '', [], 'local-read', params(), { applicability: ['user'] });
  declare('doctor', '[--verbose]', '核对磁盘、daemon、Host 三份代码身份，不自动更新／重启。', '', ['system.status'], 'local-read', params([], { verbose: { type: 'boolean' } }), { applicability: ['user'] });
  for (const verb of ['start','stop','restart','status']) declare(`host ${verb}`, `[PORT]${['start','restart'].includes(verb) ? ' [--foreground]' : ''}`,
    { start: '启动本地 Web Host；无显式项目进入全局工作台，不替用户启动 daemon。', stop: '停止 Host，不停止项目后台。', restart: '重启 Host，会清空登录会话；不重启项目后台。', status: '只读真实 Host 进程身份，不能用 status 替代。' }[verb], '', [],
    verb === 'status' ? 'local-read' : 'local-write', params([positional('PORT', { ...nonnegative, maximum: 65535 }, false)], ['start','restart'].includes(verb) ? { foreground: { type: 'boolean' } } : {}), { applicability: ['user'], scope: 'local_host' });
});
