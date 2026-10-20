import { defineCommands } from '../command-spec.js';
import { HOOK_REGISTER_SCHEMA, HOOK_ACTIONS_SCHEMA, HOOK_SCHEDULE_SCHEMA, TEMPORARY_AUTOMATION_CAPABILITIES } from '../../core/hook-registration.js';
import { HOOK_TRIGGERS } from '../../core/hooks.js';

const string = (maxLength = 256, minLength = 1) => ({ type: 'string', minLength, maxLength });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const uuid = { type: 'string', format: 'uuid' };
const id = { type: 'string', description: '真实整数或 W/V 编号；V 仅限操作本来支持的目标。' };
const revision = { ...string(), required: true, description: '从本命令列出的前置读取取得，不可互换 revision。' };
const scheduleSchema = HOOK_SCHEDULE_SCHEMA;
const commandSchema = object({ id: uuid, name: string(120), kind: { enum: ['shell','prompt'] }, command: string(16000), prompt: string(16000),
  default_worker_id: { type: ['integer','null'], minimum: 1 }, description: string(2000, 0), when_to_use: string(4000, 0),
  tags: { type: 'array', maxItems: 32, items: string(80, 0) }, examples: string(8000, 0), warnings: string(4000, 0),
}, ['name']);
commandSchema.description = 'kind 缺省沿原定义或 shell；shell 必须且只能有 command，prompt 必须且只能有 prompt；不能传 authorized、version 或路径。';
const templateSchema = object({ id: uuid, purpose: string(2000, 0), name: string(120),
  trigger: { enum: HOOK_TRIGGERS.map(item => item.id) }, mode: { enum: ['once','persistent'] }, enabled: { type: 'boolean' },
  conditions: object({ statuses: { type: 'array', items: { enum: ['queued','running','waiting','awaiting','paused','awaiting_acceptance','completed','failed','cancelled'] } },
    integrations: { type: 'array', items: { enum: ['none','pending','review','merging','merged','conflict','superseded'] } } }),
  actions: HOOK_ACTIONS_SCHEMA, schedule: scheduleSchema,
}, ['name','trigger','mode','enabled','actions']);
templateSchema.description = '触发点／动作／模式组合遵守 automation list 的同源 actions 目录；内置专属动作不可自定义。time.scheduled 必须提供 schedule，其他节点禁止 schedule。最多一个创建动作，Shell 与提示词动作不可混合；生命周期追加仅 once。';
const signalSchema = object({ id: uuid, name: string(200), enabled: { type: 'boolean' }, schedule: scheduleSchema }, ['name','schedule']);
const questionOption = object({ label: string(60), description: string(2000), preview: string(12000), previewHtml: string(16000) }, ['label','description']);
const questionsSchema = object({ questions: { type: 'array', minItems: 1, maxItems: 4, items: object({ header: string(16), question: string(2000),
  options: { type: 'array', minItems: 2, maxItems: 4, items: questionOption }, multiSelect: { type: 'boolean', default: false },
}, ['header','question','options']) } }, ['questions']);
const pos = (name, schema = string(), required = true) => ({ name, ...schema, required });
const jsonOptions = schema => ({ '--data': { type: 'json', schema, maxBytes: 40000, required: true } });
const payloadRule = '使用 --data JSON；不读取本地文件。';
const stop = '等待确认／waiting 后结束本轮；unknown 或缺少完成证据时仅按原收据读取，不自动重放。';
function details(rpc, { positionals = [], options = {}, rules = [], source = '无需前置读取。', effects = '只读；不隐式刷新、注册、挂载或执行。', identities = ['user','valet'], ...extra } = {}) {
  return { parameters: { positionals, options, rules }, identities, scope: 'current_project',
    sources: source, preconditions: source, effects, recovery: stop,
    modes: [{ id: 'default', rpc, when: '符合此叶命令参数契约', preconditions: source }], ...extra };
}
function payloadDetails(rpc, schema, source, effects, extra = {}) {
  return details(rpc, { options: jsonOptions(schema), rules: [payloadRule], source, effects, ...extra });
}

export const COMMANDS = defineCommands(add => {
  add('automation list', '[--include-reclaimed] [--after ID] [--limit N]', '查找可复用的固定版本功能、临时使用情况及真实 revision；默认隐藏已回收项。', '--limit 30', ['hooks.list'], 'read', '',
    details(['hooks.list'], { options: { '--include-reclaimed': { type: 'boolean', flag: true }, '--after': string(128), '--limit': { ...positive, maximum: 100, default: 100 } },
      source: '先查已有适用功能，按 registry.has_more/next_cursor 续读；after 是最后实际返回的功能 ID，不是偏移。',
      effects: '只读；registry.total/complete/has_more 表明实际覆盖，usage 是安全使用摘要而非完整执行记录。' }));
  const temporaryCreate = TEMPORARY_AUTOMATION_CAPABILITIES['hooks.temporary_create'];
  add('automation temporary create', '--data JSON', temporaryCreate.description, '--data JSON', ['hooks.temporary_create'], 'write', temporaryCreate.limitations.join('；'),
    payloadDetails(['hooks.temporary_create'], temporaryCreate.schema,
      '先 automation list 查找已有适用功能，确无适用项才创建；expected_revisions.registry 来自 registry.revision，新 Shell 还需 commands.revision；client_request_id 固定本份完整请求。',
      '创建临时固定 v1，不挂载、不执行；默认 once、停用，临时与频率独立，persistent 须明确授权。成功收据后独立授权目标挂载；定义不可改写，用完显式回收。'));
  const temporaryReclaim = TEMPORARY_AUTOMATION_CAPABILITIES['hooks.temporary_reclaim'];
  add('automation temporary reclaim', '--data JSON', temporaryReclaim.description, '--data JSON', ['hooks.temporary_reclaim'], 'write', '',
    payloadDetails(['hooks.temporary_reclaim'], temporaryReclaim.schema,
      'automation list.registry.revision 与临时项真实 ID、usage；先独立 detach 所有残留挂载（停用也算引用），client_request_id 固定本份回收请求。',
      '事务重检所有引用／待执行／真实执行／unknown；拒绝时不回收。成功只标记回收，默认目录隐藏，保留只读定义与审计，不可再次挂载；不删除共享命令。'));
  const historyProperties = TEMPORARY_AUTOMATION_CAPABILITIES['hooks.temporary_history'].schema.properties;
  add('automation temporary history', 'ID [--before N] [--limit N]', TEMPORARY_AUTOMATION_CAPABILITIES['hooks.temporary_history'].description, 'ID --limit 30', ['hooks.temporary_history'], 'read', '',
    details(['hooks.temporary_history'], { positionals: [pos('ID', historyProperties.id)], options: { '--before': historyProperties.before, '--limit': historyProperties.limit },
      source: '真实临时功能 ID；before 使用 audit.next_before 的实际排他 Event 游标，has_more 时按需续读。',
      effects: '活动／已回收均可查；保留 usage、字节截断与 history_complete:false，不恢复或重放执行。' }));
  add('automation register', '--data JSON', '仅注册新 Shell 指令及功能；不挂载或执行。', '--data JSON', ['hooks.register'], 'write',
    '先确认 registered:true 及固定 template_id/template_version，再独立挂载。Shell 非沙箱。',
    payloadDetails(['hooks.register'], HOOK_REGISTER_SCHEMA, 'automation list：commands.revision、registry.revision；client_request_id 为调用方本份定义的稳定身份。',
      '原子登记；同 key 同完整参数返回原收据，不重建已删除定义；未知结果不换 key 重发。'));
  add('automation save', '--data JSON --revision REV', '无 id 登记新功能，有 id 保存新版本，不静默升级挂载。', '--data JSON --revision REV', ['hooks.save'], 'write', '',
    payloadDetails(['hooks.save'], templateSchema, 'automation list.registry.revision；已有完整定义不能从脱敏摘要补私有覆盖。', '只保存定义；已有挂载固定原版本。',
      { options: { ...jsonOptions(templateSchema), '--revision': revision } }));
  add('automation remove', 'TEMPLATE_ID --revision REV', '删除未被挂载引用的功能定义。', 'TEMPLATE_ID --revision REV', ['hooks.remove'], 'write', '',
    details(['hooks.remove'], { positionals: [pos('TEMPLATE_ID', uuid)], options: { '--revision': revision }, source: 'automation list.registry.revision 和真实 mount_count。', effects: '有挂载时拒绝；不删除 Worker 或运行历史。' }));
  add('automation completion-defaults show', '', '读取未来新指令默认流程及真实 revision。', '', ['hooks.list'], 'read', '', details(['hooks.list']));
  add('automation completion-defaults set', 'on|off merge|accept --revision REV', '仅设置项目未来新指令的默认最高自动级别。', 'off merge --revision REV', ['hooks.completion_defaults'], 'write', '',
    details(['hooks.completion_defaults'], { positionals: [pos('ENABLED', { enum: ['on','off'] }), pos('LEVEL', { enum: ['merge','accept'] })], options: { '--revision': revision },
      source: 'automation completion-defaults show.revision。', effects: '不修改已有 Worker，不影响 child；accept 包含安全验收与资源回收。' }));
  add('automation command list', '', '读取快捷指令目录及 commands.revision；不提供手动运行入口。', '', ['hooks.list'], 'read', '', details(['hooks.list']));
  add('automation command save', '--data JSON --revision REV', '保存 Shell 或提示词指令新版本。', '--data JSON --revision REV', ['hooks.command_save'], 'write', '',
    payloadDetails(['hooks.command_save'], commandSchema, 'automation command list.revision；command 的 id 省略则新建。', '不执行，不静默升级已有固定挂载；Shell 非沙箱，提示词未来执行可能创建 Worker。',
      { options: { ...jsonOptions(commandSchema), '--revision': revision } }));
  add('automation command export', 'ID --version N', '导出固定版本 Skill 风格 Markdown，只读不安装。', 'COMMAND_ID --version 1', ['hooks.command_export'], 'read', '',
    details(['hooks.command_export'], { positionals: [pos('ID', uuid)], options: { '--version': { ...positive, required: true } }, source: 'automation command list 的真实 command id/version。' }));
  add('automation command remove', 'ID --revision REV', '移除快捷指令，阻止未来执行并保留原安全门。', 'COMMAND_ID --revision REV', ['hooks.command_remove'], 'destructive', '',
    details(['hooks.command_remove'], { positionals: [pos('ID', uuid)], options: { '--revision': revision }, source: 'automation command list.revision。', effects: '不撤销已开始副作用，不删除 Worker。' }));
  add('automation command history', '[--before N] [--limit N] [--execution UUID]', '读取快捷指令安全运行摘要，单次有界读取。', '--limit 30', ['hooks.command_history'], 'read', '',
    details(['hooks.command_history'], { options: { '--before': positive, '--limit': { ...positive, maximum: 100 }, '--execution': uuid }, rules: ['--execution 与 --before 互斥。'], source: 'before 为上一页真实游标；execution 为实际运行 UUID。' }));
  add('automation signal list', '', '读取时间信号及 signals.revision；时间到不证明额度恢复。', '', ['hooks.list'], 'read', '', details(['hooks.list']));
  add('automation signal save', '--data JSON --revision REV', '保存具名时间信号，不启动 Agent。', '--data JSON --revision REV', ['hooks.signal_save'], 'write', '',
    payloadDetails(['hooks.signal_save'], signalSchema, 'automation signal list.revision；一次性日期必须未来，显式 IANA timezone。', '仅保存时间意图；停机错过不补跑，不隐式查询额度。',
      { options: { ...jsonOptions(signalSchema), '--revision': revision } }));
  add('automation signal remove', 'SIGNAL_ID --revision REV', '删除无启用或未收口绑定引用的信号。', 'SIGNAL_ID --revision REV', ['hooks.signal_remove'], 'write', '',
    details(['hooks.signal_remove'], { positionals: [pos('SIGNAL_ID', uuid)], options: { '--revision': revision }, source: 'automation signal list.revision。', effects: '保留诊断与已发生副作用；引用安全门不变。' }));

  add('valet receipt show', 'EVENT_ID [--after N] [--limit N]', '读取真实管理收据和有界安全事件时间线。', '123 --limit 30', ['management.receipt'], 'read', '',
    details(['management.receipt'], { positionals: [pos('EVENT_ID', positive)], options: { '--after': { ...positive, minimum: 0 }, '--limit': { ...positive, maximum: 100, default: 30 } },
      source: '可信执行反馈的 receipt_id/call_id/request_event_id；after 使用时间线真实 next_cursor，不用 W/D/N 展示前缀。' }));
  add('valet context show', '[ID]', '真实管家 invocation 的安全跨树摘要或指定目标诊断。', 'W5', ['manager.query','worker.lookup'], 'read', '',
    details(['manager.query','worker.lookup'], { identities: ['valet'], positionals: [pos('ID', id, false)], source: '目标真实 W/V 编号或整数；不带 ID 返回有界摘要。', effects: '不读取原始执行正文、私有设置或跨项目内容。' }));
  add('valet context history', '[--worker ID] [--before N] [--limit N]', '真实管家的安全调用历史，不是原始会话。', '--limit 30', ['manager.history','worker.lookup'], 'read', '',
    details(['manager.history','worker.lookup'], { identities: ['valet'], options: { '--worker': id, '--before': positive, '--limit': { ...positive, maximum: 100 } },
      source: '真实目标编号；before 用上一页实际边界。', effects: '有界当前项目历史，不披露提示词、工具正文或凭证。' }));
  add('valet self title', "'标题'", '仅为当前管家设置一次性自动标题。', "'项目核对'", ['worker.auto_title'], 'write', '',
    details(['worker.auto_title'], { identities: ['valet'], positionals: [pos('TITLE', string(60))], effects: '只作用于真实自身；不是用户 rename，不接受任意目标。' }));
  add('valet self progress plan', 'KEY[:显示名]...', '规划当前管家自身里程碑。', 'inspect:核验', ['progress.plan'], 'write', '',
    details(['progress.plan'], { identities: ['valet'], positionals: [{ name: 'STEPS', type: 'string', required: true, variadic: true }], effects: '只写自身进度，不改变目标或执行授权。' }));
  add('valet self progress complete', 'KEY', '只标记当前管家实际完成的里程碑。', 'inspect', ['progress.complete'], 'write', '',
    details(['progress.complete'], { identities: ['valet'], positionals: [pos('KEY')], source: '自身实际已规划并完成的 key。', effects: '只写自身进度，不证明业务完成。' }));
  for (const verb of ['ask','notify']) add(`valet self notice ${verb}`, `'标题' [--body TEXT]${verb === 'ask' ? ' [--questions-json JSON]' : ''}`,
    verb === 'ask' ? '发布自身决策问题，然后结束本轮。' : '发布自身非阻塞告知，不得携带问卷。', "'核对结果' --body '背景与结论'", ['notice.post'], 'write', '',
    details(['notice.post'], { identities: ['valet'], positionals: [pos('TITLE', string(32000))], options: { '--body': { ...string(32000, 0), default: '' },
      ...(verb === 'ask' ? { '--questions-json': { type: 'json', schema: questionsSchema, maxBytes: 40000 } } : {}) },
      rules: ['不接受 --kind、目标 ID 或任何本地问题文件。', ...(verb === 'ask' ? ['携带 --questions-json 时 body 最多 8000 字，规范问卷总计最多 64000 字节；标签不重复，不设置 UI 已有的自定义答案占位项。'] : [])], effects: verb === 'ask' ? '固定 kind=question；有问卷时服务端规范为 questionnaire；答复仅恢复当前 occurrence；发布后结束本轮。' : '固定 kind=info；不暂停调用、不答复待决、不授权任何操作。',
      recovery: 'Notice 没有强幂等；响应未知时不得盲目重发。ask 发布后结束本轮，dismiss 不代表同意。' }));
});
