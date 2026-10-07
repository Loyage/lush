import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';
import { scheduledInstant, scheduledWallTime, hookSchedule } from '../../src/ui/web/assets/hook-schedule.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const scheduledModes = { 'time.scheduled': ['once', 'persistent'] };
const catalogue = { version: 1, revision: 'catalogue-timer', triggers: [
  { id: 'agent.failed', label: '调用失败', description: '失败不重放。' },
  { id: 'worker.parent_ready', label: '可以创建', description: '安全创建点。' },
  { id: 'time.scheduled', label: '定时提交动作', description: '指定时间持久提交动作，不保证 Agent 准点开始。' },
], actions: [
  { type: 'create_worker', label: '创建 Worker', triggers: ['worker.parent_ready', 'time.scheduled'], modes: ['once'], modes_by_trigger: scheduledModes, agent_call: true },
  { type: 'message', label: '追加消息', triggers: ['agent.failed', 'time.scheduled'], modes: ['once'], modes_by_trigger: scheduledModes, agent_call: true },
  { type: 'retry_worker', label: '重试失败 Worker', triggers: ['time.scheduled'], modes: ['once', 'persistent'], agent_call: true },
  { type: 'resume_worker', label: '继续暂停 Worker', triggers: ['time.scheduled'], modes: ['once', 'persistent'], agent_call: true },
  { type: 'notify', label: '发送告知', triggers: [], modes: ['once', 'persistent'], agent_call: false },
], templates: [] };
const model = { version: 1, worker_id: 20, can_attach: true, revision: 'timer-mount', mounts: [] };
const task = { id: 20, task_kind: 'order', status: 'paused', branch: 'feature', hooks: model };
let actions, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (path.endsWith('/api/agent/config')) return json({ default: { agent: 'pi', config_mode: 'pi' }, options: { agents: ['pi', 'codex'] } });
  if (path.includes('/api/agent/models')) return json({ models: [] });
  if (path.endsWith('/api/agent/packages')) return json({ version: 1, packages: [], resources: {} });
  if (path.includes('/api/agent/connections')) return json({ connections: [] });
  if (body) { actions.push(body); return json(body.method.startsWith('hooks.') ? catalogue : model); }
  throw new Error(`unexpected ${path}`);
} });
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { workerHooks, openHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(button => button.textContent === label);
const input = (node, label) => node.querySelector(`[aria-label="${label}"]`);
const daily = { kind: 'daily', time: '00:05', timezone: 'Asia/Shanghai' };
const initial = (type = 'message') => ({ name: '半夜提交', trigger: 'time.scheduled', mode: 'persistent', schedule: daily,
  actions: [type === 'message' ? { type, target_id: 20, body: '继续工作' } : type === 'create_worker' ? { type, content: '新工作', start: true } : { type, target_id: 20 }] });
beforeEach(() => { actions = []; intercept = null; catalogue.templates = []; ui.hooksPage = null; activateDetailView({ view: 'task', key: 'task-20' }); });
afterAll(() => dom.restore());

test('one-shot conversion uses the explicitly selected timezone, including quarter-hour offsets', () => {
  expect(scheduledInstant('2030-02-03T00:05', 'Asia/Shanghai')).toBe('2030-02-02T16:05:00.000Z');
  expect(scheduledInstant('2030-02-03T00:05', 'Asia/Kathmandu')).toBe('2030-02-02T18:20:00.000Z');
  expect(scheduledWallTime('2030-02-02T16:05:06Z', 'Asia/Shanghai')).toBe('2030-02-03T00:05:06');
});

test('one-shot conversion rejects nonexistent and repeated DST wall times rather than silently adjusting them', () => {
  expect(() => scheduledInstant('2030-03-10T02:30', 'America/New_York')).toThrow('不存在');
  expect(() => scheduledInstant('2030-11-03T01:30', 'America/New_York')).toThrow('出现两次');
  expect(scheduledInstant('2030-11-03T02:30', 'America/New_York')).toBe('2030-11-03T07:30:00.000Z');
  expect(() => scheduledInstant('2030-10-06T02:15', 'Australia/Lord_Howe')).toThrow('不存在');
});

test('time helpers reject invalid dates, fields, timezone and date-line gaps', () => {
  expect(() => scheduledInstant('2030-02-30T01:00', 'UTC')).toThrow('日期无效');
  expect(() => scheduledInstant('2030-01-01T24:00', 'UTC')).toThrow('完整');
  expect(() => scheduledInstant('2030-01-01T01:00', 'Unknown/Zone')).toThrow('IANA');
  expect(() => scheduledInstant('2011-12-30T12:00', 'Pacific/Apia')).toThrow('不存在');
  expect(() => hookSchedule('daily', '', '24:00', 'UTC')).toThrow('HH:mm');
  expect(hookSchedule('daily', '', '00:05', ' Asia/Shanghai ')).toEqual(daily);
});

test('daily messaging uses trigger-specific catalogue modes and describes non-blocking submission and existing model selection', () => {
  const form = createHookForm(catalogue, { initial: initial(), workerId: 20 });
  expect(form.validate()).toBe(''); expect(form.collect()).toMatchObject({ mode: 'persistent', schedule: daily });
  expect(form.collect().actions[0]).toEqual({ type: 'message', target_id: 20, body: '继续工作' });
  expect(input(form.node, '挂载方式').disabled).toBe(true); expect(form.agentCall()).toBe(true);
  expect(deepText(form.node)).toContain('到点提交非阻塞动作'); expect(deepText(form.node)).toContain('跳过');
  expect(deepText(form.node)).toContain('现有运行设置'); expect(deepText(form.node)).toContain('不自动切换账号');
  input(form.node, '触发节点').value = 'agent.failed'; input(form.node, '触发节点').onchange();
  expect(form.collect().mode).toBe('once'); expect(form.collect()).not.toHaveProperty('schedule');
  expect(deepText(form.node)).toContain('无限付费循环');
});

test('daily creation is available only via the scheduled catalogue override and period drives once/persistent mode', () => {
  const form = createHookForm(catalogue, { initial: initial('create_worker') });
  expect(form.validate()).toBe(''); expect(form.collect().mode).toBe('persistent');
  input(form.node, '定时周期').value = 'once'; input(form.node, '定时周期').onchange();
  input(form.node, '执行日期和时间（所选时区）').value = '2030-02-03T00:05';
  expect(form.collect()).toMatchObject({ mode: 'once', schedule: { kind: 'once', at: '2030-02-02T16:05:00.000Z', timezone: 'Asia/Shanghai' } });
  expect(form.validate()).toBe('');
  input(form.node, '时区（IANA）').value = 'Asia/Kathmandu';
  expect(form.collect().schedule.at).toBe('2030-02-02T18:20:00.000Z');
  input(form.node, '触发节点').value = 'worker.parent_ready'; input(form.node, '触发节点').onchange();
  expect(form.collect().mode).toBe('once'); expect(form.collect()).not.toHaveProperty('schedule');
});

test('catalogue absence of a scheduled modes override never silently permits recurring Agent calls', () => {
  const limited = { ...catalogue, actions: catalogue.actions.map(action => action.type === 'message' ? { ...action, modes_by_trigger: undefined } : action) };
  const form = createHookForm(limited, { initial: initial() });
  expect(form.validate()).toContain('挂载方式不受');
  const notify = createHookForm(catalogue, { initial: { ...initial(), actions: [{ type: 'notify', title: '通知', body: '提交提醒' }] } });
  expect(notify.validate()).toBe(''); expect(notify.agentCall()).toBe(false);
});

test('schedule validation keeps bad timezone/date edits visible and never silently uses the browser timezone', () => {
  const form = createHookForm(catalogue, { initial: initial() });
  input(form.node, '时区（IANA）').value = 'Not/AZone'; expect(form.validate()).toContain('IANA');
  expect(input(form.node, '时区（IANA）').value).toBe('Not/AZone');
  input(form.node, '时区（IANA）').value = 'America/New_York';
  input(form.node, '定时周期').value = 'once'; input(form.node, '定时周期').onchange();
  input(form.node, '执行日期和时间（所选时区）').value = '2030-03-10T02:30'; expect(form.validate()).toContain('不存在');
});

test('metadata-only template edits preserve the exact one-shot instant and do not rebuild private profiles', () => {
  const schedule = { kind: 'once', at: '2030-11-03T06:30:00.123Z', timezone: 'America/New_York' };
  const form = createHookForm(catalogue, { initial: { ...initial('retry_worker'), id: 'retry-template', schedule, mode: 'once', actions: [
    { type: 'retry_worker', target_id: 20, model_selection: { agent: 'pi', connection_id: 'private-source', model: 'provider/codex' } },
  ] } });
  expect(input(form.node, '执行日期和时间（所选时区）').value).toBe('2030-11-03T01:30:00');
  expect(form.validate()).toBe(''); expect(form.collect().schedule).toEqual(schedule);
  expect(form.collect().actions[0]).toEqual({ type: 'retry_worker', target_id: 20 });
  expect(deepText(form.node)).toContain('保留模板已有私有覆盖');
  input(form.node, '执行日期和时间（所选时区）').value = '2030-11-03T01:31:00';
  expect(form.validate()).toContain('出现两次');
});

test('retry/resume are Agent actions with optional full overrides, not implicit default replacements', async () => {
  const form = createHookForm(catalogue, { initial: initial('resume_worker'), workerId: 20 });
  expect(form.agentCall()).toBe(true); expect(form.validate()).toBe('');
  expect(form.collect().actions[0]).toEqual({ type: 'resume_worker', target_id: 20 });
  expect(deepText(form.node)).toContain('不隐式换账号');
  await btn('显式覆盖目标 Worker 的运行参数', form.node).onclick();
  expect(form.collect().actions[0].profile).toMatchObject({ agent: 'pi', config_mode: 'pi' });
  const configure = btn('显式覆盖目标 Worker 的运行参数', form.node);
  expect(configure.disabled).toBe(true); expect(configure.parentNode.classList.contains('help-host')).toBe(true);
  expect(configure.parentNode.getAttribute('data-help')).toContain('下方编辑');
  form.setBusy(true); form.setBusy(false);
  expect(configure.disabled).toBe(true); expect(form.collect().actions[0].profile.config_mode).toBe('pi');
  const type = input(form.node, '动作类型'); type.value = 'message'; type.onchange();
  expect(form.collect().actions[0]).not.toHaveProperty('profile');
});

test('explicit retry override can select a managed Codex subscription without changing project defaults or starting a Worker', async () => {
  intercept = path => path.endsWith('/api/agent/config') ? json({ default: { agent: 'pi', config_mode: 'lush', thinking: 'high', env: { NOTE: 'full override' } },
    options: { agents: ['pi', 'codex'], thinking: { pi: ['', 'high'] } } })
    : path.endsWith('/api/agent/connections') ? json({ version: 1, connections: [{ id: 'codex-night', label: '半夜额度', provider: 'openai-codex',
      enabled: true, auth_type: 'oauth', credential: { status: 'configured' }, default_model: 'gpt-codex', models: ['gpt-codex'] }] }) : null;
  const form = createHookForm(catalogue, { initial: initial('retry_worker'), workerId: 20 });
  await btn('显式覆盖目标 Worker 的运行参数', form.node).onclick();
  await btn('读取项目连接', form.node).onclick();
  const connection = form.node.querySelector('[data-retry-field="connection_id"]'); connection.value = 'codex-night'; connection.onchange();
  expect(form.validate()).toBe(''); expect(form.collect().actions[0].profile).toMatchObject({ agent: 'pi', config_mode: 'lush',
    connection_id: 'codex-night', model: 'openai-codex/gpt-codex', thinking: 'high', env: { NOTE: 'full override' } });
  expect(actions).toHaveLength(0); expect(form.collect().actions[0]).not.toHaveProperty('model_selection');
});

test('moving or changing template retry/resume action requires an explicit replacement instead of borrowing another private profile', () => {
  const form = createHookForm(catalogue, { initial: { ...initial('retry_worker'), id: 'template', actions: [
    { type: 'notify', title: '通知', body: '已提交' }, { type: 'retry_worker', target_id: 20 },
  ] } });
  btn('移除动作', form.node).onclick(); expect(form.validate()).toContain('私有覆盖');
  const changed = createHookForm(catalogue, { initial: { ...initial('retry_worker'), id: 'template' } });
  input(changed.node, '动作类型').value = 'resume_worker'; input(changed.node, '动作类型').onchange();
  expect(changed.validate()).toContain('私有覆盖');
});

test('failed Worker narrow form offers only scheduled self-retry and notify, never other lifecycle actions or targets', () => {
  const form = createHookForm(catalogue, { failedSelf: true, workerId: 20 });
  expect(input(form.node, '触发节点').children.map(option => option.value)).toEqual(['time.scheduled']);
  expect(input(form.node, '动作类型').children.map(option => option.value)).toEqual(['retry_worker', 'notify']);
  const target = input(form.node, '目标 Worker 内部 ID（仅当前或直接父子）');
  expect(target.value).toBe(20); expect(target.disabled).toBe(true);
  input(form.node, 'Hook 名称').value = '重试自己';
  input(form.node, '执行日期和时间（所选时区）').value = '2030-02-03T00:05';
  expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual([{ type: 'retry_worker', target_id: 20 }]);
  form.setBusy(true); form.setBusy(false); expect(target.disabled).toBe(true);
  target.value = '21'; expect(form.validate()).toContain('自身'); target.value = '20';
  input(form.node, '动作类型').value = 'notify'; input(form.node, '动作类型').onchange();
  expect(form.validate()).toContain('只允许定时重试自身');
});

test('can_attach permits a failed Worker self-retry editor and filters incompatible templates', async () => {
  catalogue.templates = [
    { ...initial(), id: 'message', name: '不能复活失败目标' },
    { ...initial('retry_worker'), id: 'self', name: '重试自己' },
    { ...initial('retry_worker'), id: 'other', name: '重试其他', actions: [{ type: 'retry_worker', target_id: 21 }] },
  ];
  const section = workerHooks({ ...task, status: 'failed' }, { refresh() {} }); root().replaceChildren(section);
  expect(btn('挂载 Hook', section).disabled).toBe(false); await btn('挂载 Hook', section).onclick();
  const picker = input(section, '挂载模板'); expect(picker.children.map(option => option.value)).toEqual(['', 'self']);
  expect(input(section, '动作类型').value).toBe('retry_worker');
  picker.value = 'self'; picker.onchange(); expect(btn('原样挂载模板', section).classList.contains('agent-call')).toBe(true);
  expect(btn('原样挂载模板', section).getAttribute('data-help')).toContain('token');
  const attaching = btn('原样挂载模板', section).onclick();
  expect(deepText(dom.node('modal'))).toContain('不保证 Agent 准点开始');
  await dialogButton(dom, '授权并挂载').onclick(); await attaching;
  expect(actions.at(-1)).toEqual({ method: 'worker.hook_attach', params: { id: 20, expected_revision: 'timer-mount', hook: { template_id: 'self' } } });
});

test('completed, cancelled, archived and denied failed Workers never acquire a timer attach permission from a misleading local status', () => {
  for (const current of [{ ...task, status: 'completed' }, { ...task, status: 'cancelled' }, { ...task, archived: true },
    { ...task, status: 'failed', hooks: { ...model, can_attach: false } }, { ...task, status: 'failed', hooks: { ...model, can_attach: undefined } }]) {
    const section = workerHooks(current, { refresh() {} }); expect(btn('挂载 Hook', section).disabled).toBe(true);
    expect(btn('挂载 Hook', section).parentNode.classList.contains('help-host')).toBe(true);
  }
});

test('mount projections show explicit-zone schedule, next submission, pending occurrence, skipped diagnostic and retry target W number', () => {
  const section = workerHooks({ ...task, hooks: { ...model, mounts: [{ id: 'timer', name: '半夜重试', trigger: 'time.scheduled', mode: 'persistent', enabled: true,
    schedule: daily, next_run_at: '2030-02-03T16:05:00Z', pending_due_at: '2030-02-02T16:05:00Z', state: 'skipped', editable: true,
    reason: '目标分支冻结，等待安全点', actions: [{ type: 'retry_worker', target_id: 20, target_worker_number: 'W7' }],
    last_execution: { id: 99, status: 'skipped', created_at: '2030-02-02T16:05:00Z', due_at: '2030-02-02T16:05:00Z', error: '目标不在失败状态' },
  }] } }, { refresh() {} });
  const text = deepText(section); expect(text).toContain('每天 00:05 · Asia/Shanghai');
  expect(text).toContain('下次提交：2030-02-04 00:05:00 · Asia/Shanghai');
  expect(text).toContain('已到点提交，等待安全执行：2030-02-03 00:05:00');
  expect(text).toContain('已跳过'); expect(text).toContain('目标分支冻结'); expect(text).toContain('重试 W7');
  expect(text).toContain('目标不在失败状态'); expect(section.querySelector('.hook-mount-alert')).toBeTruthy();
});

test('enabling a scheduled retry/resume uses Agent purple and token help, disabling remains non-Agent', () => {
  for (const type of ['retry_worker', 'resume_worker']) {
    const section = workerHooks({ ...task, hooks: { ...model, mounts: [{ id: type, name: type, trigger: 'time.scheduled', schedule: daily,
      actions: [{ type, target_id: 20 }], enabled: false, editable: true, mode: 'persistent', state: 'idle' }] } }, { refresh() {} });
    const enable = btn('启用 Hook', section); expect(enable.classList.contains('agent-call')).toBe(true); expect(enable.getAttribute('data-help')).toContain('token');
  }
});

test('failed scheduled attachment keeps date, timezone, body and revision after a server rejection', async () => {
  const section = workerHooks(task, { refresh() {} }); root().replaceChildren(section); await btn('挂载 Hook', section).onclick();
  const form = section.querySelector('.hook-form'); input(form, 'Hook 名称').value = '午夜';
  input(form, '触发节点').value = 'time.scheduled'; input(form, '触发节点').onchange();
  input(form, '动作类型').value = 'message'; input(form, '动作类型').onchange();
  input(form, '时区（IANA）').value = 'Asia/Shanghai'; input(form, '执行日期和时间（所选时区）').value = '2030-02-03T00:05';
  input(form, '消息或告知正文').value = '保留正文';
  intercept = (_path, body) => body?.method === 'worker.hook_attach' ? { ok: false, json: async () => ({ error: 'revision changed' }) } : null;
  const attaching = btn('确认挂载', section).onclick(); await dialogButton(dom, '授权并挂载').onclick(); await attaching;
  expect(section.querySelector('.hook-form')).toBe(form); expect(input(form, '时区（IANA）').value).toBe('Asia/Shanghai');
  expect(input(form, '执行日期和时间（所选时区）').value).toBe('2030-02-03T00:05'); expect(input(form, '消息或告知正文').value).toBe('保留正文');
  expect(dom.node('error').textContent).toContain('revision changed');
});

test('late timer catalogue response cannot open an editor after navigation', async () => {
  let release;
  intercept = path => path.endsWith('/api/hooks') ? new Promise(resolve => { release = resolve; }) : null;
  const section = workerHooks(task, { refresh() {} }); root().replaceChildren(section);
  const loading = btn('挂载 Hook', section).onclick(); await until(() => release);
  activateDetailView({ view: 'overview' }); root().replaceChildren(document.createElement('article'));
  release(json(catalogue)); await loading; expect(section.querySelector('.hook-form')).toBeNull(); expect(actions).toHaveLength(0);
});

test('saving a timer template never mounts it or advertises an immediate Agent invocation', async () => {
  await openHooks(); await btn('新建模板').onclick(); const form = root().querySelector('.hook-form');
  input(form, 'Hook 名称').value = '日常重试'; input(form, '触发节点').value = 'time.scheduled'; input(form, '触发节点').onchange();
  input(form, '动作类型').value = 'retry_worker'; input(form, '动作类型').onchange();
  input(form, '目标 Worker 内部 ID（仅当前或直接父子）').value = '20'; input(form, '定时周期').value = 'daily'; input(form, '定时周期').onchange();
  expect(btn('保存模板').classList.contains('agent-call')).toBe(false); await btn('保存模板').onclick();
  expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ method: 'hooks.save', params: { template: { trigger: 'time.scheduled', mode: 'persistent', schedule: { kind: 'daily' }, actions: [{ type: 'retry_worker', target_id: 20 }] } } });
});
