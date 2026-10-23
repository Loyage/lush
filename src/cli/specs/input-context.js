import { defineCommands } from '../command-spec.js';
import { INPUT_EMIT_SCHEMA } from '../../core/input-emission-protocol.js';
import { CONTEXT_LIMITS } from '../../core/worker-context.js';

const text = { type: 'string' };
const positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonnegative = { ...positive, minimum: 0 };
const worker = { type: 'string', description: '真实 W/V 编号或正安全整数；编号由后台解析，不由整数推算。', pattern: '^(?:[1-9][0-9]*|W[1-9][0-9]*(?:-[1-9][0-9]*)*|V[1-9][0-9]*)$' };
const child = { ...worker, pattern: '^(?:[1-9][0-9]*|W[1-9][0-9]*(?:-[1-9][0-9]*)*)$', description: '真实直接 child 的整数 ID 或 W 编号；服务端再次核验亲缘。' };
const revision = { type: 'string', pattern: '^(?:[1-9][0-9]*|null)$', required: true,
  description: '来自 input draft show 的精确 revision；仅无版本历史草稿可显式 null，不是省略或随意置空。' };
const positional = (name, schema = text, required = true) => ({ name, required, ...schema });
const json = schema => ({ type: 'json', schema });
const file = schema => ({ type: 'string', format: 'path', local_file: true, ...(schema ? { content_schema: schema } : {}), description: '显式本地普通文件；Valet 不可读取。' });
const conditionOptions = {
  '--when-idle': { type: 'boolean', description: '调度条件：目标开发树彻底静息，不表示静默输出。' },
  '--after-settled': { ...worker, repeatable: true, description: 'AND 条件：指定开发 Worker 本轮安全收尾；不是仅 invocation 返回。' },
  '--after-merged': { ...worker, repeatable: true, description: 'AND 条件：指定开发 Worker 本轮成果到 main；不是仅合入直接父。' },
  '--conditions': { ...json(INPUT_EMIT_SCHEMA.properties.conditions), conflicts: ['--when-idle','--after-settled','--after-merged'], description: '完整条件数组；与条件旗标互斥。更新时替换已保存条件，[] 显式清空。' },
};
const saveOptions = {
  '--branch': { ...text, description: '新建工作保存的父分支；不是新分支名。与 --append-to 互斥。', conflicts: ['--append-to'] },
  '--append-to': { ...worker, conflicts: ['--branch'], description: '显式追加目标，固定 append 模式；不静默改投。' },
  '--references': json(INPUT_EMIT_SCHEMA.properties.references),
  ...conditionOptions,
  '--exclusive': { type: 'boolean', description: '仅新建：独占开发意愿，隐含静息等待，不提高合并授权。' },
};
const profileData = { ...json(INPUT_EMIT_SCHEMA.properties.profile), description: '显式运行配置，仅本次新建授权使用；追加不能覆盖，Valet 私有字段仍由后台拒绝。' };
// The order convenience fills the explicit Pi/lush identity before submitting
// the canonical profile; it never reads or merges a private saved profile.
const registeredOrderProfile = { ...INPUT_EMIT_SCHEMA.properties.profile.anyOf[0], required: [],
  properties: Object.fromEntries(Object.entries(INPUT_EMIT_SCHEMA.properties.profile.anyOf[0].properties)
    .filter(([key]) => !['connection_id','model'].includes(key)).map(([key, value]) => [key,
      key === 'agent' ? { const: 'pi' } : key === 'config_mode' ? { const: 'lush' } : value])),
  'x-lush-validator': undefined, description: '仅与 --registered-model 使用：补充 Pi lush 运行参数，不包含来源／模型。' };
const listOptions = {
  '--cursor': { ...text, description: '上页 page.next_cursor；版本化绑定 view、筛选及原底层续读来源，不能跨视图使用。' },
  '--limit': { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  '--q': { type: 'string', maxLength: 1000, description: '后台全库正文搜索，不只查本页预览。' },
  '--status': { type: 'string', enum: ['draft','waiting_conditions','emitted','sent','emission_failed','unknown_dispatch','created','queued','running','waiting','awaiting','paused','awaiting_acceptance','completed','failed','cancelled','unknown'] },
  '--integration': { type: 'string', enum: ['merging','blocked','merged','none'], description: '按 merge_status 展示投影筛选，不把上轮落地当本轮已交付。' },
  '--modes': json({ type: 'array', uniqueItems: true, items: { type: 'string', enum: ['order','append','management'] }, maxItems: 3 }),
};
const questionSchema = { type: 'object', additionalProperties: false, required: ['question','header','options'], properties: {
  question: { type: 'string', minLength: 1, maxLength: 2000 }, header: { type: 'string', minLength: 1, maxLength: 16 },
  multiSelect: { type: 'boolean', default: false }, options: { type: 'array', minItems: 2, maxItems: 4, items: {
    type: 'object', additionalProperties: false, required: ['label','description'], properties: {
      label: { type: 'string', minLength: 1, maxLength: 60, description: '同题唯一；不要添加“其他／自定义答案”，界面自动提供。' },
      description: { type: 'string', minLength: 1, maxLength: 2000 },
      preview: { type: 'string', minLength: 1, maxLength: 12000 }, previewHtml: { type: 'string', minLength: 1, maxLength: 16000 },
    } } },
} };
const questionsSchema = { type: 'object', required: ['questions'], properties: {
  questions: { type: 'array', minItems: 1, maxItems: 4, items: questionSchema },
}, description: '规范化问卷最多64000 UTF-8字节；题目和选项文字非空，预览必须安全、静态、自包含。' };
const preparedQuestionSchema = { type: 'object', additionalProperties: false, required: ['version','title','body','questions'], properties: {
  version: { const: 1 }, title: { type: 'string', minLength: 1, maxLength: 32000 },
  body: { type: 'string', maxLength: 8000 }, questions: questionsSchema.properties.questions,
} };
const answersSchema = { type: 'object', additionalProperties: false, required: ['answers'], properties: {
  answers: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['selected'], properties: {
    selected: { type: 'array', uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 3 } },
    custom: { type: 'string', maxLength: 4000 },
  }, description: '每题一个答案；selected 为已存题目选项序号，或清空selected并给custom；服务端从原问卷生成标签。' } },
} };
const fileEnvelope = schema => ({ oneOf: [schema, { type: 'object', additionalProperties: false, required: ['version','data'],
  properties: { version: { const: 1 }, data: schema } }] });
const parameters = (positionals, options) => ({ positionals, options, mutuallyExclusive: Object.entries(options)
  .flatMap(([flag, spec]) => (spec.conflicts ?? []).map(other => [flag, other])) });
const recovery = '未知、断连或缺少完成证明时停止，不换身份重放。版本冲突重新读必要事实再判断；查询／帮助不代表执行授权。';
const userContract = (positionals = [], options = {}, extra = {}) => ({ parameters: parameters(positionals, options),
  identities: ['user','valet'], scope: 'current_project', preconditions: ['按模式核验真实目标、最新权限及原生命周期／冻结安全门。'], recovery, ...extra });
const contextContract = (positionals = [], options = {}, extra = {}) => ({ parameters: parameters(positionals, options),
  identities: ['active-worker-invocation'], scope: 'invocation_bound_direct_relations',
  preconditions: ['有效 invocation 绑定自身，parent由服务端确定，child必须真实直接后代；不接受自身ID、不枚举全项目。'], recovery, ...extra });

export const COMMANDS = defineCommands(add => {
  add('order', "'目标' [--branch NAME] [--registered-model NAME_OR_ID [--scope device]] [--data JSON] [--when-idle] [--exclusive] [--after-settled ID] [--after-merged ID] [--conditions JSON] [--references JSON]",
    '一步提交新建开发指令；可靠挂载，不承诺立即创建或调用。', "'实现登录' --branch main", ['order.submit','input.emit','worker.lookup','agent.registered_models.resolve'], 'agent',
    '只新建。直接追加用 worker message；需保留条件／可靠发射收据的追加用 input draft create → submit。不支持 management/buffer/append/defer/quiet。',
    userContract([positional('goal', INPUT_EMIT_SCHEMA.properties.content)], { ...Object.fromEntries(Object.entries(saveOptions).filter(([key]) => key !== '--append-to')), '--data': { ...profileData, schema: { anyOf: [...INPUT_EMIT_SCHEMA.properties.profile.anyOf, registeredOrderProfile] },
        description: '完整显式 profile；仅 --registered-model 模式可省略 agent/config_mode 并补其它合法参数，不能覆盖登记绑定。' },
      '--registered-model': { ...text, description: 'agent model list 中的精确 name/id；冻结具体绑定为 Pi lush profile。--data 可补其它合法运行参数，不能含 connection_id/model 或冲突 agent/config_mode。' },
      '--scope': { type: 'string', enum: ['device'], description: '仅与 --registered-model 使用，只传登记解析；Valet 须显式 device 且本轮用户已授权设备范围。' },
    }, {
      modes: [{ name: 'ordinary-new', rpc: ['order.submit'] }, { name: 'conditional-new', rpc: ['input.emit'], when: '显式条件／when-idle／exclusive' },
        { name: 'numbered-condition', rpc: ['worker.lookup','input.emit'], when: '条件使用W编号' },
        { name: 'registered-model', rpc: ['agent.registered_models.resolve','order.submit','input.emit','worker.lookup'], when: '--registered-model；设备解析之后仍用原项目写权限，不传scope' }],
      preconditions: ['登记解析是安全资源读取，可省略 --scope device 且无需设备关键词，仍检查最新只读权限；不自动改写冲突后端／模式，不读取私有 profile。', '项目提交仍检查原权限、目标及生命周期。'],
      sources: { '--branch': 'input targets', '--after-settled/--after-merged': 'worker show / worker list中的真实开发目标' },
      effects: ['持久授权新建需求，可能后续调用Agent；只有真实input_id/worker_id证明投递，不把挂载当已开始。'],
    }));
  add('input list', '[--cursor CURSOR] [--limit N] [--q TEXT] [--status STATUS] [--integration STATE] [--modes JSON]',
    '分页查已发送的原始输入、可信用户追加与即时管家输入。', '--limit 50', ['input.history'], 'read', '',
    userContract([], listOptions, { modes: [{ name: 'history', rpc: ['input.history'], view: 'history' }], effects: ['只读一页，不混草稿、不扫全项目、不将消息伪装为O编号。'] }));
  add('input show', 'input|message|management ID', '按明确来源读取已发送原话，正文不可改写。', 'input 5', ['input.get'], 'read', '',
    userContract([positional('kind', { type: 'string', enum: ['input','message','management'] }), positional('id', positive)], {}, { sources: { id: 'input list 的kind及整数id；O仅展示。' } }));
  add('input targets', '', '读取合法新建目标与冻结事实；只读不启动。', '', ['input.parents'], 'read', '', userContract());
  add('input draft list', '[--cursor CURSOR] [--limit N] [--q TEXT] [--status STATUS] [--integration STATE] [--modes JSON] [--conditional configured|mounted]',
    '分页查未发送意图；可显式查看保留的条件发射收据。', '--limit 50', ['input.history'], 'read',
    '--conditional 使用原窄读面，含已发送条件收据；不把这些记录称为普通未发送草稿。',
    userContract([], { ...listOptions, '--conditional': { type: 'string', enum: ['configured','mounted'] } }, {
      modes: [{ name: 'drafts', rpc: ['input.history'], view: 'drafts' }, { name: 'condition-receipts', rpc: ['input.history'], when: '--conditional', view: '原conditional读面，不传view' }],
      effects: ['保留后台全库筛选、截断与原游标；一次只读一页。'],
    }));
  add('input draft show', 'ID', '读取完整草稿、保存版本与真实发射收据。', '17', ['input.get'], 'read', '',
    userContract([positional('id', positive)], {}, { sources: { id: 'input draft list/create返回的原整数ID，不是草稿展示号。' } }));
  add('input draft create', "'内容' [--branch BRANCH | --append-to ID] [--when-idle] [--exclusive] [--after-settled ID] [--after-merged ID] [--conditions JSON] [--references JSON] [--client-request-id KEY]",
    '只保存新建或追加意图，不授权执行、不创建Worker。', "'合并后继续' --append-to W5 --after-merged W6", ['draft.add','worker.lookup'], 'write',
    'branch与append-to互斥；追加无独占或附件。运行覆盖只在submit时通过--data传。这里只创建开发草稿；management草稿写入与提交仍限真实用户Web/RPC入口。',
    userContract([positional('content', INPUT_EMIT_SCHEMA.properties.content)], { ...saveOptions,
      '--client-request-id': { ...INPUT_EMIT_SCHEMA.properties.client_request_id, description: '可选精确创建去重身份；同key同定义返回原草稿，不同定义拒绝，删除后不重建。未知结果不得换key重放。' },
    }, {
      modes: [{ name: 'new', rpc: ['draft.add'] }, { name: 'append/numbered-conditions', rpc: ['worker.lookup','draft.add'], when: 'W/V编号需要lookup；实际目标仍由原引擎核验' }],
      sources: { '--branch': 'input targets', '--append-to': 'worker show真实目标' }, effects: ['saved仅表示保存；下一步input draft show，再按精确revision submit。'],
    }));
  add('input draft update', "ID '内容' --revision N|null [--branch BRANCH | --append-to ID] [--mode new|append] [--conditions JSON] [--when-idle] [--after-settled ID] [--after-merged ID] [--exclusive on|off] [--references JSON]",
    '按保存版本编辑未挂载草稿，省略字段保持原值。', "17 '补充需求' --revision 3", ['draft.update','worker.lookup'], 'write',
    '显式改模式／去向仍由原版本和目标安全门校验；条件选项一旦提供即替换条件，[]可清空；不保存运行覆盖。',
    userContract([positional('id', positive), positional('content', INPUT_EMIT_SCHEMA.properties.content)], {
      ...saveOptions, '--revision': revision, '--mode': { type: 'string', enum: ['new','append'], description: 'new映射既有order；省略保留原模式，append必须有当前或新目标。' },
      '--exclusive': { type: 'string', enum: ['on','off'], description: '显式配置值；追加不能开启。' },
    }, { sources: { '--revision': 'input draft show ID 的revision' }, effects: ['更新保存版本，不重新投递、不改写Input或Message。'] }));
  for (const [verb, method, description] of [
    ['remove','draft.remove','移除未发送且未挂载的草稿，不删除已提交原话。'],
    ['submit','input.emit','授权保存的精确开发草稿版本；管理草稿须真实用户management.submit或密码提权入口，不能用此命令提交。'],
    ['cancel','input.emission_cancel','撤销尚未执行授权，不撤回已发生或未知副作用。'],
    ['release','input.exclusive_release','只释放独占意愿，不取消授权或已创建工作。'],
  ]) add(`input draft ${verb}`, `ID --revision N|null${verb === 'submit' ? ' [--data JSON]' : ''}`, description, '17 --revision 3', [method], verb === 'submit' ? 'agent' : 'write', '',
    userContract([positional('id', positive)], { '--revision': revision, ...(verb === 'submit' ? { '--data': profileData } : {}) }, {
      sources: { '--revision': 'input draft show ID 的revision，必须精确匹配保存版本' },
      effects: [description, ...(verb === 'submit' ? ['profile只应用于新建授权；追加模式由原引擎拒绝覆盖。scheduled/delivered/unknown依真实dispatch收据，不从CLI退出码猜测。'] : [])],
    }));

  add('notice list', '[--view current|history] [--status STATUS] [--before N | --cursor CURSOR] [--limit N]',
    '当前优先窗口或完整历史分页；两种视图不是等价查询。', '--view history --limit 30', ['notice.list','notice.page'], 'read',
    '默认current为原notice.list有界优先窗口，不能带history筛选／游标，也不证明全历史完整。',
    userContract([], { '--view': { type: 'string', enum: ['current','history'], default: 'current' },
      '--status': { type: 'string', enum: ['all','open','answered','dismissed','sent','unread','automatic'], default: 'all', when: '--view history' },
      '--before': { ...positive, conflicts: ['--cursor'], when: '--view history' }, '--cursor': { ...text, conflicts: ['--before'], when: '--view history', description: '同view/filter的page.next_cursor，不接受events游标。' },
      '--limit': { type: 'integer', minimum: 1, maximum: 100, default: 30, when: '--view history' },
    }, { modes: [{ name: 'current', rpc: ['notice.list'] }, { name: 'history', rpc: ['notice.page'], when: '--view history' }],
      effects: ['历史保留total/non_plan_total、原游标及字节截断续读；不在客户端过滤整库。'] }));
  add('notice events', '[--cursor CURSOR] [--limit N]', '增量读取Notice来源事件，保留epoch/reset及不透明检查点。', '--limit 100', ['notice.sync'], 'read', '',
    userContract([], { '--cursor': { ...text, description: '上次events的page.next_cursor，不能与list游标混用；即使has_more=false也可作后续增量检查点。' }, '--limit': { type: 'integer', minimum: 1, maximum: 100, default: 100 } }));
  for (const verb of ['ask','notify']) add(`notice ${verb}`, `'标题' --worker ID [--body TEXT]${verb === 'ask' ? ' [--questions-json JSON]' : ''}`,
    verb === 'ask' ? '向明确Worker发布需要用户答复的决策。' : '发布非阻塞信息，不暂停Worker、不接受问卷。', "'方案确认' --worker W5 --body '背景'", ['notice.post','worker.lookup'], 'write',
    verb === 'ask' ? '发布后结束本轮，不自答；dismiss不是同意，参数示例不是实际目标。' : '只报告已经发生的事实；成功只证明已保存，不保证外部系统提醒送达。',
    userContract([positional('title')], { '--worker': { ...worker, required: true }, '--body': { type: 'string', default: '' },
      ...(verb === 'ask' ? { '--questions-json': json(questionsSchema) } : {}) }, {
      effects: [verb === 'ask' ? '固定kind=question，可能暂停关联调用，等待真实用户选择。' : '固定kind=info；不执行、答复或验收其它动作。'],
    }));
  add('notice answer', 'ID ANSWER | ID --data JSON', '答复已有问题，可能恢复关联Agent；结构化答案与文字互斥。', "12 '采用第一项'", ['notice.answer'], 'agent', '',
    userContract([positional('id', positive), positional('answer', text, false)], { '--data': json(answersSchema) }, {
      modes: [{ name: 'text', rpc: ['notice.answer'], requires: ['answer'], forbids: ['--data'] },
        { name: 'questionnaire', rpc: ['notice.answer'], requires: ['--data'], forbids: ['answer'] }],
      sources: { id: 'notice list中真实整数Notice ID；D/N是展示前缀。' }, effects: ['只答复真实问题；不重放已发生动作。'],
    }));
  for (const [verb, rpc, description] of [['dismiss','notice.dismiss','消除决策，不表示接受推荐项。'], ['mark-read','notice.read','标记info已知，不读取正文、不答复或执行。']]) {
    add(`notice ${verb}`, 'ID', description, '12', [rpc], 'write', '', userContract([positional('id', positive)], {}, { effects: [description] }));
  }

  for (const relation of ['self','parent','children']) {
    for (const verb of relation === 'parent' ? ['show'] : ['show','events','transcript']) {
      const method = { show: 'inspect', events: 'history', transcript: 'transcript' }[verb];
      const pos = relation === 'children' ? [positional('child', child)] : [];
      const options = verb === 'show' ? {} : { '--after': { ...nonnegative, default: 0 }, ...(verb === 'transcript' ? { '--limit': { type: 'integer', minimum: 1, maximum: CONTEXT_LIMITS.transcript, default: 100 } } : {}) };
      add(`${relation} ${verb}`, `${relation === 'children' ? 'ID ' : ''}${verb === 'show' ? '' : `[--after N]${verb === 'transcript' ? ' [--limit N]' : ''}`}`.trim(),
        `读取${{ self: '自身', parent: '直接父', children: '直接child' }[relation]}${{ show: '安全详情', events: '事件元数据', transcript: '执行记录' }[verb]}。`, relation === 'children' ? 'W5-1' : '', [`context.${method}`], 'read',
        '详情coverage=worker_context，不包含完整收件箱／嵌套关系；events仅元数据，不能冒充执行正文。',
        contextContract(pos, options, { user_context_rpc: `worker.${method}`, effects: ['单次有界读取，保留coverage/omitted/truncation及原续页事实；不轮询等待。'] }));
    }
  }
  for (const relation of ['parent','children']) add(`${relation} message`, `${relation === 'children' ? 'ID ' : ''}'说明'`,
    '向真实直接父／子追加；main/owner不是普通收件箱。', relation === 'children' ? "W5-1 '补充验证'" : "'需要接口决定'", ['context.message'], 'agent',
    '冻结时可持久暂存，发送成功不等于Agent已收到／处理。拒绝保留原文，不能换目标绕过。',
    contextContract([...(relation === 'children' ? [positional('child', child)] : []), positional('body')], {}, { user_context_rpc: 'worker.message', effects: ['可靠追加可能唤醒目标，不改变真实亲缘。'] }));
  add('children list', '[--after N] [--limit N]', '分页列真实直接child，不枚举兄弟或孙辈。', '--limit 50', ['context.children'], 'read', '',
    contextContract([], { '--after': { ...nonnegative, default: 0 }, '--limit': { type: 'integer', minimum: 1, maximum: CONTEXT_LIMITS.children, default: 50 } }, { user_context_rpc: 'worker.relations', effects: ['保留items/total/cursor/has_more/limit；省略摘要不证明完整。'] }));
  add('children spawn', "'目标' [--name NAME]", '在自身活动order/child下派出独立Worker；派出后结束本轮。', "'专项实现与测试责任' --name api-child", ['context.spawn'], 'agent',
    'goal写明改动范围、专项／受影响回归及顶层全量负责人；不等待／轮询child。收到成果后检查，默认保留待验收现场。',
    contextContract([positional('goal')], { '--name': text }, { user_context_rpc: 'worker.spawn',
      sources: { goal: '当前目标可独立分工的范围；不能依赖尚未实际合入的兄弟实现。' },
      preconditions: ['自身必须是允许派工的活动order/child；父身份由有效invocation确定，不能传parent。'],
      effects: ['创建独立worktree/分支与child，默认child自动合并Hook；runtime串行交付，不代表本轮已合入。'],
    }));
  add('children accept', 'ID', '安全验收已交付直接child；默认保留，不在收到成果后自动回收。', 'W5-1', ['context.accept'], 'destructive', '',
    contextContract([positional('child', child)], {}, { user_context_rpc: 'worker.accept',
      sources: { child: 'children list和show中的真实直接child，并核对成果、测试及交付事实。' },
      effects: ['安全检查通过后归档并回收worktree/ref；不丢脏现场、不吞未读输入，不验收自己或指令Worker。'],
    }));
  add('self title', "'标题'", '自身一次性自动标题，不是用户rename。', "'接口实现'", ['context.auto_title'], 'write', '', contextContract([positional('title')]));
  add('self notice list', '[--before N] [--limit N]', '分页读自身Notice，不接受其它目标。', '--limit 30', ['context.notices'], 'read', '',
    contextContract([], { '--before': positive, '--limit': { type: 'integer', minimum: 1, maximum: CONTEXT_LIMITS.notices, default: 30 } }));
  add('self notice notify', "'标题' [--body TEXT]", '发布自身非阻塞结果告知，不接受问卷或目标。', "'结果就绪' --body '结论与限制'", ['context.notice'], 'write', '',
    contextContract([positional('title')], { '--body': { type: 'string', default: '' } }, { user_context_rpc: 'notice.post', effects: ['固定kind=info，不暂停或等待答复；未知写结果不能盲目重发。'] }));
  add('self notice ask', '--question-file FILE', '发布本地question create生成的自身问题；必须是本轮最后一个动作。', '--question-file decision.json', ['context.notice'], 'write',
    '不能另传标题／body/kind或目标；发布后结束本轮，等待真实用户答复；dismissed不代表接受推荐。',
    contextContract([], { '--question-file': { ...file(fileEnvelope(preparedQuestionSchema)), required: true } }, { user_context_rpc: 'notice.post',
      sources: { '--question-file': 'lushw question create 的完整JSON输出，不是只有questions的输入模板。' },
      effects: ['固定kind=question，标题/正文/问题全部取已校验文件；不保存选择快照或开放重选。'],
    }));
  add('self progress plan', 'KEY[:显示名]...', '规划本轮自身里程碑，不提前报告完成。', 'inspect:核验 implement:实现', ['context.progress_plan'], 'write', '',
    contextContract([positional('steps', { type: 'string', repeatable: true, minItems: 1, maxItems: 32, description: '稳定key为小写英文/数字/下划线/短横线；显示名1..160字符。' })]));
  add('self progress complete', 'KEY', '只标记实际完成的自身步骤。', 'inspect', ['context.progress_complete'], 'write', '', contextContract([positional('step')]));
  add('question example', '', '离线输出可编辑题目JSON模板，不创建项目或发送。', '', [], 'local-read', '',
    { ...contextContract(), identities: ['offline-local'], scope: 'explicit_files_only', effects: ['stdout为本地题目模板；不连接daemon。'], output_schema: questionsSchema });
  add('question create', "'标题' --questions-file FILE [--body TEXT]", '离线校验并输出完整问题，尚未发布。', "'方案确认' --questions-file questions.json --body '背景'", [], 'local-read',
    '将stdout保存到文件，再self notice ask --question-file FILE；发布问题必须是本轮最后一个动作。',
    { ...contextContract([positional('title')], { '--questions-file': { ...file(fileEnvelope(questionsSchema)), required: true }, '--body': { type: 'string', maxLength: 8000, default: '' } }),
      identities: ['offline-local'], scope: 'explicit_files_only', effects: ['只读显式文件，输出完整问题；本地校验不证明发布准入。'], output_schema: preparedQuestionSchema });
  add('question check', '--question-file FILE', '本地校验完整问题，不发送或暂停Worker。', '--question-file decision.json', [], 'local-read', '',
    { ...contextContract([], { '--question-file': { ...file(fileEnvelope(preparedQuestionSchema)), required: true } }), identities: ['offline-local'], scope: 'explicit_files_only', effects: ['只输出valid及question_count，不改文件、不授权发布。'] });
  add('skills list', '', '离线读取随代码发布的能力指南目录。', '', [], 'local-read', '',
    { ...contextContract(), identities: ['offline-local'], scope: 'builtin_guides', effects: ['不读设备启停设置，不授予任何执行权限。'] });
  add('skills show', 'ID', '按需读固定内置能力指南，不加载任意文件。', 'progress', [], 'local-read', '',
    { ...contextContract([positional('id')]), identities: ['offline-local'], scope: 'builtin_guides', sources: { id: 'skills list中的固定指南ID。' }, effects: ['关闭推荐能力不删除已有child的安全收尾规则。'] });
});
