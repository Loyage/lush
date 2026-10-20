import { createHash } from 'node:crypto';
import { cliParameterError } from './parser.js';
import { isOptionIndex } from './args.js';

// Steps reference stable command IDs, not a second executable command list.
export const CLI_WORKFLOWS = Object.freeze([
  { id: 'conditional-input', title: '条件提交与可靠追加', keywords: '等待 另一个 工作 合并 条件 草稿 after merged input draft', views: ['user','valet'], steps: [
    ['input.targets', '读取合法目标；从真实 Worker 查询取得依赖，合并后不等于本轮结束。'],
    ['input.draft.create', '新建或 --append-to 保存草稿；保存不授权执行。'],
    ['input.draft.show', '读取保存的真实版本，revision 不从示例或旧状态复制。'],
    ['input.draft.submit', '提交该版本；只在新建模式通过 --data 显式覆盖运行配置，追加不覆盖配置。'],
  ], stop: '报告 saved/scheduled/delivered/unknown 的真实收据并结束；未知不换去重身份重发。直接追加可用 worker message，但不声称等价于可靠条件发射。' },
  { id: 'temporary-automation', title: '先复用，没有再建临时功能', keywords: '临时 一次性 自动化 查找 复用 回收 temporary automation reuse reclaim history', views: ['user','valet'], steps: [
    ['automation.list', '先查询并按名称、purpose 与动作寻找适用功能；按真实游标补足必要范围。已有适用项直接复用其固定版本，不创建重复临时项。'],
    ['automation.temporary.create', '仅无适用项时创建；默认 once、停用，临时与触发频率独立。创建不挂载、不执行；必须取得 created:true 和真实固定版本。'],
    ['worker.automation.show', '读取明确目标的真实挂载 revision；复用已有项也须独立目标授权。'],
    ['worker.automation.attach', '只传 template_id/template_version 与明确 enabled；不内联定义、运行参数，不视作已经执行。'],
    ['automation.temporary.history', '触发后按真实使用审计及 usage 检查；成功一次性仅清挂载，不自动回收定义。'],
    ['worker.automation.detach', '仍有任何挂载（含停用项）须独立撤销未来授权；不消除历史 unknown。'],
    ['automation.list', '回收前读取最新 registry.revision 和 usage；有引用、待执行、执行或 unknown 时停止。'],
    ['automation.temporary.reclaim', '用固定完整请求显式安全回收；不删除定义与审计，不自动迁移旧长期项。'],
    ['automation.temporary.history', '已回收仍可只读查询，或 list --include-reclaimed 按需查看。'],
  ], stop: '待确认／waiting 后结束本轮，unknown 不重放；创建／挂载不证明执行。长期 register/save 仍保留但不作为临时需求前提；回收不可重新挂载。' },
  { id: 'register-and-attach', title: '长期功能：先登记，再单独挂载', keywords: '自动化 注册 挂载 hook automation register attach', views: ['user','valet'], steps: [
    ['automation.list', '取得 registry 与 commands 的真实 revision。'], ['automation.register', '只登记定义；等待真实登记完成及固定版本。'],
    ['worker.automation.show', '取得目标挂载 revision。'], ['worker.automation.attach', '独立请求固定登记版本挂载，不内联执行参数。'],
  ], stop: '登记失败、待确认或 unknown 时停止，不继续挂载；挂载不是执行，失败或未知一次性动作不自动重放。' },
  { id: 'review-and-accept', title: '审查交付后安全验收', keywords: '验收 回收 接受 成果 accept review', views: ['user','valet','worker','worker-user'], steps: [
    ['worker.show', '读取真实成果、integration 与交付事实；终态不等于已合入。'],
    ['worker.accept', '合法验收并核对资源回收结果；失败不报成功。'],
  ], workerSteps: [['children.show', '检查直接 child 成果与测试、真实交付事实。'], ['children.accept', '默认保留 awaiting_acceptance 现场；只有目标稳定结束且确有回收必要或用户要求提前回收时才验收。']],
    stop: '脏现场、未交付、待决、暂存输入或资源回收失败均不是验收成功；流程不能代替质量判断或授权。' },
  { id: 'delegate-and-report', title: '委派、释放调用位与成果检查', keywords: '派工 子任务 child delegate spawn report 测试', views: ['worker'], steps: [
    ['children.spawn', '写明范围、专项与受影响回归、最终全量负责人。创建独立 Worker 后结束本轮，不等待或轮询。'],
    ['children.show', '在后续 invocation 收到交付后检查成果、测试证据与 integration。'], ['children.message', '需要补做时向原 child 集中追加，不取消重建。'],
  ], stop: '等待子 Worker 时结束本轮。成果检查不等于验收，默认不提前回收；父指令负责最终集成与全量。' },
  { id: 'ask-user', title: '决策提问与非阻塞告知', keywords: '问题 问卷 用户 决策 通知 告知 ask notice notify question', views: ['user','valet','worker'], steps: [
    ['notice.ask', '显式发布决策问题；问卷使用本视图允许的结构化输入。'], ['notice.notify', '纯信息告知，不带问卷、不阻塞等待。'],
  ], workerSteps: [['question.create', '本地创建并校验完整问题文件，保存 stdout；不创建服务端草稿。'], ['self.notice.ask', '发布已创建的 question-file，必须是本轮最后一个动作。']],
    valetSteps: [['valet.self.notice.ask', '只用内联 questions-json，不读本地文件。'], ['valet.self.notice.notify', '发布非阻塞告知，不夹带问卷。']],
    stop: '发布决策后结束本轮；dismiss 不是同意，不自行选择、不执行未确认方案。' },
]);

export function catalogueVersion(commands, rules = {}) {
  return createHash('sha256').update(JSON.stringify({ commands, workflows: CLI_WORKFLOWS, rules })).digest('hex').slice(0, 20);
}
function paginate(items, options, binding) {
  const limit = options.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw cliParameterError('help limit must be 1..100');
  let start = 0;
  if (options.cursor) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()); } catch { throw cliParameterError('invalid help cursor'); }
    if (cursor.version !== 1 || cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length)
      throw cliParameterError('help cursor belongs to another catalogue/view/query');
    start = cursor.offset;
  }
  const end = Math.min(items.length, start + limit), has_more = end < items.length;
  return { items: items.slice(start, end), page: { limit, has_more, next_cursor: has_more ? Buffer.from(JSON.stringify({ version: 1, binding, offset: end })).toString('base64url') : null, total: items.length } };
}
function summary(entry, executable) {
  return { id: entry.id, path: entry.path, description: entry.description, directory: entry.directory, help: `${executable} help ${entry.path}` };
}
export function helpRequest(args) {
  const options = { topic: [] };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (isOptionIndex(args, index) && ['--all','--search','--limit','--cursor'].includes(value)) {
      const key = value.slice(2);
      if (Object.hasOwn(options, key)) throw cliParameterError(`duplicate ${value}`);
      if (key === 'all') options.all = true;
      else {
        if (!isOptionIndex(args, index + 1) || !args[index + 1] || args[index + 1].startsWith('--')) throw cliParameterError(`${value} requires a value`);
        options[key] = args[++index];
        if (key === 'limit') {
          if (!/^[1-9]\d*$/.test(options.limit)) throw cliParameterError('help limit must be 1..100');
          options.limit = Number(options.limit);
        }
      }
    } else {
      if (isOptionIndex(args, index) && value.startsWith('-')) throw cliParameterError(`unknown help option ${value}`);
      options.topic.push(value);
    }
  }
  if (Number(Boolean(options.all)) + Number(Boolean(options.search)) + Number(options.topic[0] === 'workflow') > 1)
    throw cliParameterError('help all/search/workflow modes are mutually exclusive');
  return options;
}

export function describeHelp({ commands, allCommands = commands, executable, view, catalog_version }, args = []) {
  const options = helpRequest(args), topic = options.topic.join(' ');
  const base = { catalog_version, view };
  const workflowEntries = CLI_WORKFLOWS.filter(flow => flow.views.includes(view)).map(flow => {
    const steps = ['worker','worker-user'].includes(view) && flow.workerSteps ? flow.workerSteps : view === 'valet' && flow.valetSteps ? flow.valetSteps : flow.steps;
    return { ...flow, steps: steps.map(([command_id, instruction]) => {
      const command = commands.find(item => item.id === command_id);
      return command ? { command_id, instruction, help: `${executable} help ${command.path}`, parameters: command.parameters } : null;
    }).filter(Boolean) };
  }).filter(flow => flow.steps.length);
  const binding = `${catalog_version}:${view}:${JSON.stringify({ topic, all: options.all, search: options.search })}`;
  if (options.all || options.search || topic === 'workflow') {
    let items;
    if (topic === 'workflow') items = workflowEntries.map(flow => ({ id: flow.id, kind: 'workflow', title: flow.title, description: flow.stop, help: `${executable} help workflow ${flow.id}` }));
    else {
      items = commands.filter(entry => !entry.directory).map(entry => ({ ...summary(entry, executable), kind: 'command', keywords: entry.keywords ?? '' }));
      if (options.search) {
        items.push(...workflowEntries.map(flow => ({ id: flow.id, kind: 'workflow', description: flow.title, keywords: flow.keywords, help: `${executable} help workflow ${flow.id}` })));
        if (view === 'valet') items.push(...allCommands.filter(entry => !entry.directory && !commands.some(item => item.id === entry.id))
          .map(entry => ({ id: entry.id, path: entry.path, kind: 'command', keywords: entry.keywords ?? '',
            description: `${entry.description} 此能力需真实用户处理，不向管家开放；帮助不授予权限。`,
            available_in_view: false, help: `${executable} help ${entry.path}` })));
        const words = options.search.toLowerCase().split(/\s+/).filter(Boolean);
        items = items.filter(item => {
          const text = `${item.path ?? ''} ${item.description} ${item.keywords}`.toLowerCase();
          return words.every(word => text.includes(word)) || text.replace(/\s+/g, '').includes(options.search.toLowerCase().replace(/\s+/g, ''));
        });
      }
    }
    const { items: pageItems, page } = paginate(items, options, binding);
    return { version: 1, data: { ...base, kind: options.search ? 'search' : topic === 'workflow' ? 'workflow' : 'index', query: options.search ?? null, items: pageItems }, page };
  }
  if (options.limit || options.cursor) throw cliParameterError('pagination applies only to search/workflow index/--all');
  if (topic.startsWith('workflow ')) {
    const flow = workflowEntries.find(item => item.id === options.topic[1]);
    if (!flow || options.topic.length !== 2) throw cliParameterError('unknown workflow for this view');
    const { views, workerSteps, valetSteps, ...safe } = flow;
    return { version: 1, data: { ...base, kind: 'workflow', ...safe } };
  }
  const entry = commands.find(item => item.path === topic);
  if (topic && !entry) {
    const unavailable = allCommands.find(item => item.path === topic);
    if (unavailable && view === 'valet') return { version: 1, data: { ...base, kind: 'command', path: topic, available_in_view: false,
      description: '此能力需真实用户处理；本地文件、认证、服务或 invocation 边界不向管家开放。静态帮助不授予权限。' } };
    const suggestions = commands.filter(item => item.path.includes(options.topic.at(-1) ?? '')).slice(0, 5).map(item => `${executable} help ${item.path}`);
    throw cliParameterError(`unknown help topic; ${suggestions.length ? suggestions.join('; ') : `run ${executable} help`}`);
  }
  if (entry && !entry.directory) {
    return { version: 1, data: { ...entry, ...base, kind: 'command', command_kind: entry.kind,
      applicability: { executable, view, authorization: '实时许可未知；执行时重新检查 invocation、scope、逐项权限、revision、目标和生命周期。' },
      purpose: entry.description, non_goals: entry.non_goals ?? '命令可见不授予权限；请求返回不证明后续工作或副作用完成。',
      sources: entry.sources ?? ['真实目标来自同域 list/show；示例编号与 REV 不是可执行授权。'],
      preconditions: entry.preconditions ?? ['执行时核验身份、项目／设备范围、目标状态与必要 revision。'],
      effects: entry.effects ?? { operation: entry.operation, kind: entry.kind },
      recovery: entry.recovery ?? '参数错误查本叶帮助；权限不足问用户；等待则结束本轮；未知仅核对原收据，不换身份重放。',
    } };
  }
  const items = commands.filter(item => item.parent === (topic || null)).map(item => summary(item, executable));
  return { version: 1, data: { ...base, kind: topic ? 'group' : 'index', path: topic, description: entry?.description ?? '按对象发现命令；help --search / help workflow / help --all 按需读取。', items,
    workflows: topic ? undefined : workflowEntries.map(flow => ({ id: flow.id, title: flow.title, help: `${executable} help workflow ${flow.id}` })) } };
}

export function renderHelp(document, executable) {
  const value = document.data, lines = [`Lush — ${executable === 'lushw' ? '开发 Worker 协作接口' : '项目管理接口'}`, `${executable} [--project PATH] [--json] <command>`,
    `目录 ${value.catalog_version} · 视图 ${value.view} · 静态适用性不代表实时授权`, ''];
  if (value.kind === 'command') {
    lines.push(value.usage ?? value.path, value.description, '');
    if (value.available_in_view !== false) {
      for (const [title, data] of [['用途与非目标', value.non_goals], ['CLI 参数', value.parameters], ['模式与实际能力', value.modes], ['值的来源', value.sources], ['前置条件', value.preconditions], ['效果与代价', value.effects], ['结果与恢复', value.recovery]])
        if (data) lines.push(`${title}：${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);
      if (value.advanced) lines.push(value.advanced);
      if (value.example) lines.push(`示例（先查真实值）：${value.example}`);
    }
  } else if (value.kind === 'workflow' && value.steps) {
    lines.push(value.title, ...value.steps.map((step, index) => `${index + 1}. ${step.instruction}\n   ${step.help}`), `停止与恢复：${value.stop}`);
  } else {
    if (value.description) lines.push(value.description);
    for (const item of value.items ?? []) lines.push(`  ${item.path ?? item.id} — ${item.description ?? item.title}\n    ${item.help}`);
    for (const flow of value.workflows ?? []) lines.push(`  流程 ${flow.id} — ${flow.title}\n    ${flow.help}`);
  }
  if (document.page) lines.push(`分页：${document.page.items ?? document.page.limit} / total ${document.page.total}；has_more=${document.page.has_more}${document.page.next_cursor ? `\n续读：--cursor ${document.page.next_cursor}` : ''}`);
  lines.push('', 'Worker 用真实 W/V 编号或整数；O/D/N 仅展示，Input/Notice/游标仍用原整数。', '业务结构化参数仅用内联 JSON；lushw 问卷文件须安全权限。等待或待确认时结束本轮，未知副作用不重放。');
  return lines.join('\n');
}
