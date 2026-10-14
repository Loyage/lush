import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { gate, until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const signal = { id: 'reset', name: '额度更新时间已到', enabled: true, schedule: { kind: 'daily', time: '00:05', timezone: 'Asia/Shanghai' }, next_run_at: '2030-02-02T16:05:00Z' };
const manager = { id: 200, role: 'manager', task_kind: 'management', name: '半夜开始 W10', goal: '开始 W10；重试失败的 W11', status: 'waiting',
  management: { version: 1, revision: 'binding-1', signal_id: signal.id, mode: 'once', enabled: true, state: 'waiting', pending_signal: null, last_execution: null },
  model_selection: { agent: 'pi', config_mode: 'lush', connection_id: 'codex-source', model: 'openai-codex/codex-model', thinking: 'high' } };
const settings = { default: { agent: 'codex', default_prompt: 'DEVELOPMENT PROMPT MUST NOT BE SHOWN' },
  resolved: { manager: { agent: 'pi', config_mode: 'lush', connection_id: 'codex-source', model: 'openai-codex/codex-model', thinking: 'high',
    default_prompt: 'HIDDEN PRIVATE PROMPT', env: { PRIVATE: 'SECRET' }, extensions: ['/private/extension'], skills: ['/private/skill'] } },
  options: { thinking: { pi: ['', 'low', 'medium', 'high'] }, agents: ['pi', 'codex'] } };
const source = { id: 'codex-source', label: '我的 Codex', enabled: true, provider: 'openai-codex', models: ['codex-model'],
  auth_type: 'oauth', endpoint: 'https://example.invalid', credential: { status: 'configured' }, default_model: 'codex-model', default_thinking: 'medium' };
let actions, reads, intercept, detailCalls;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/agent/config')) return json(settings);
  if (path.endsWith('/api/agent/connections')) return json({ version: 1, connections: [source] });
  if (path.includes('/api/agent/connections/models')) return json({ version: 1, status: 'cached', models: [] });
  throw new Error(`unexpected read/action ${path} ${body?.method}`);
} });
const { workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { createSignalForm, createManagementForm } = await import('../../src/ui/web/assets/hook-signals.js');
const { createManagementProfileForm } = await import('../../src/ui/web/assets/management-profile-form.js');
const { renderManagementState } = await import('../../src/ui/web/assets/management-state.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { worktreeLabel, ROLE } = await import('../../src/ui/web/assets/format.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { syncComposer } = await import('../../src/ui/web/assets/composer.js');
const restoreNavigation = registerNavigation({ refresh: async () => {}, detail: id => detailCalls.push(id) });
const root = () => dom.node('detail');
const inlineText = node => node.classList?.contains('message-original') ? '' : node.childNodes.length ? node.childNodes.map(inlineText).join('') : node.textContent;
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const input = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const fillManagement = form => { input('管理指令名称', form.node).value = '自动开跑'; input('管理指令', form.node).value = '重试失败的 W11'; input('绑定时间信号', form.node).value = signal.id; };
beforeEach(() => { actions = []; reads = []; intercept = null; detailCalls = []; dom.location.pathname = '/'; activateDetailView({ view: 'overview' }); root().replaceChildren(); });
afterAll(() => { restoreNavigation(); dom.restore(); });

// Independent settings-page mutation cases are retired. Core read projections and
// reusable signal/profile validation below remain covered; backend authorization tests are unchanged.
test('Valet identity is non-development and shared safe management state never creates an editable Hook surface', () => {
  const node = renderManagementState(manager); root().append(node);
  expect(workerHooks(manager)).toBeNull(); expect(worktreeLabel({ ...manager, workspace: '/private/management' })).toBe('管理工作目录'); expect(ROLE.manager).toBe('Valet');
  expect(node.querySelectorAll('button')).toEqual([]); expect(actions).toEqual([]); expect(reads).toEqual([]);
});

test('immediate-source capability receipts show actual confirmation kind, omitted counts and unknown non-replay facts safely', () => {
  const binding = { ...manager.management, origin: 'input', signal_id: null, state: 'waiting_actions', pending_signal: {
    id: 50, due_at: signal.next_run_at, actions: [], control_calls_count: 4, control_calls_truncated: true,
    control_calls: [{ method: 'worker.cancel', status: 'pending_confirmation', notice_id: 40, params: { env: { PRIVATE: 'MUST_NOT_DISPLAY' } } }, { method: 'input.emit', status: 'unknown' }] } };
  const node = renderManagementState({ ...manager, management: binding }); root().append(node); const text = deepText(node);
  expect(text).toContain('来源：即时 Valet 输入，不等待时间信号'); expect(text).not.toContain('原信号已移除');
  expect(text).toContain('已提交待处理'); expect(text).toContain('待用户确认（尚未执行）');
  expect(text).toContain('确认提醒 N40'); expect(text).not.toContain('D40');
  expect(text).toContain('结果待核验，不自动重放'); expect(text).toContain('管理能力摘要：显示 2 / 4 项');
  expect(text).not.toContain('MUST_NOT_DISPLAY'); expect(actions).toEqual([]);
});

test('capability history preserves safe status meanings without raw parameters or active calls', () => {
  const node = renderManagementState({ ...manager, management: { ...manager.management, last_execution: { actions: [], status: 'succeeded',
    control_calls: [{ method: 'input.emit', status: 'approved' }, { method: 'worker.cancel', status: 'rejected' }, { method: 'worker.delete', status: 'failed' }, { method: 'draft.add', status: 'succeeded' }] } } });
  root().append(node); const text = deepText(node);
  for (const label of ['授权已通过，等待安全点', '未获授权', '未执行，预检或授权已变化', '管理能力 draft.add：已执行']) expect(text).toContain(label);
  expect(node.querySelectorAll('button')).toEqual([]); expect(actions).toEqual([]);
});

for (const state of [{ status: 'paused', agent_wakes: 0 }, { status: 'paused', agent_wakes: 1 }, { status: 'failed' },
  { status: 'running' }, { status: 'running', interrupt_state: 'requested' }, { status: 'queued', interrupt_state: 'resuming' }]) {
  test(`management detail allows safe lifecycle controls without development actions for ${state.status}/${state.interrupt_state || state.agent_wakes || 'idle'}`, async () => {
    const row = { ...manager, ...state, calls: 1, children: [], deps: [], dependents: [], created_at: '2030-02-02T16:05:00Z', updated_at: '2030-02-02T16:06:00Z',
      result: '重试请求已提交，等待安全点', error: state.status === 'failed' ? '缺少管理模型来源' : null, workspace: '/project/.lush/management/200',
      branch_archive: { archivable: true }, model_selection: { ...manager.model_selection, explicit: true } };
    activateDetailView({ view: 'task', key: 'task-200' }); ui.selected = 200; ui.composerTask = row;
    renderDetail(row, { events: [{ id: 500, type: 'management.signal_submitted', created_at: row.created_at, data: { due_at: row.created_at } }] }, null, null); syncComposer();
    expect(deepText(root())).toContain('可停止、停用授权并预检删除');
    expect(root().querySelector('.management-settings-link')).toBeNull();
    expect(root().querySelector('.worker-versions')).toBeNull();
    const goal = root().querySelector('.conversation-input').querySelector('.conversation-prose'); expect(inlineText(goal)).toBe(manager.goal);
    expect(goal.querySelectorAll('.worker-link').map(node => node.getAttribute('href'))).toEqual(['#worker-number-W10', '#worker-number-W11']);
    expect(deepText(root())).toContain(row.result); const lifecycle = root().querySelector('[data-conversation-filter="lifecycle"]');
    expect(lifecycle.getAttribute('aria-pressed')).toBe('false'); expect(deepText(root())).not.toContain('管理信号已提交待执行');
    await lifecycle.onclick(); expect(deepText(root())).toContain('管理信号已提交待执行'); expect(deepText(root())).not.toContain('管理工作目录');
    expect(root().querySelector('.detail-diff')).toBeNull(); expect(root().querySelector('.worker-relations')).toBeNull();
    expect(root().querySelector('.task-actions').querySelectorAll('button').map(item => item.textContent)).toEqual(
      ['停用授权', ...(state.status === 'failed' ? [] : ['停止管家']), '删除', '刷新详情']);
    for (const label of ['停用授权', '删除', ...(state.status === 'failed' ? [] : ['停止管家'])]) {
      expect(btn(label).classList.contains('agent-call')).toBe(false);
      expect(btn(label).getAttribute('data-help')).toBeTruthy();
    }
    expect(btn('删除').disabled).toBe(['running', 'queued'].includes(state.status));
    for (const label of ['开始', '继续', '调整运行设置', '放弃 Worker', '中断', '检查后重试', '追加输入', '合并', '验收', '归档', '启用管理绑定', '停用管理绑定']) expect(btn(label)).toBeUndefined();
    expect(root().querySelector('.worker-hooks')).toBeNull(); expect(btn('打开执行详情')).toBeTruthy();
    expect(dom.node('input').disabled).toBe(false); expect(dom.node('input-form').dataset.mode).toBe('create');
    await btn('刷新详情').onclick(); expect(detailCalls).toEqual([200]); expect(actions).toEqual([]);
  });
}

test('management identity fails closed against malformed legacy development projections', () => {
  for (const identity of [{ role: 'manager', task_kind: 'order' }, { role: 'agent', task_kind: 'management' }]) {
    renderDetail({ ...manager, ...identity, status: 'paused', calls: 0, children: [], deps: [], dependents: [], created_at: '2030-02-02T16:05:00Z', updated_at: '2030-02-02T16:06:00Z',
      integration: 'pending', branch_archive: { archivable: true }, hooks: { version: 1, revision: 'fake', mounts: [] } }, null, null, null);
    expect(root().querySelector('.task-actions').querySelectorAll('button').map(item => item.textContent)).toEqual(['刷新详情']);
    expect(root().querySelector('.worker-hooks')).toBeNull(); expect(root().querySelector('.management-readonly')).toBeTruthy();
  }
  expect(actions).toEqual([]);
});

for (const field of ['pending_signal', 'last_execution']) {
  test(`compact ${field} receipt summary discloses omitted actions and does not invent a missing W number`, () => {
    const binding = { ...manager.management, [field]: { id: 50, due_at: signal.next_run_at, status: 'succeeded', actions_count: 32, actions_truncated: true,
      actions: [{ receipt_id: 1, action: 'start', target_id: 10, target_worker_number: 'W10', status: 'succeeded' },
        { receipt_id: 2, action: 'retry', target_id: 11, target_worker_number: null, target_worker_number_truncated: true, status: 'waiting' }] } };
    const node = renderManagementState({ ...manager, management: binding }); root().append(node);
    expect(deepText(node)).toContain('操作摘要：显示 2 / 32 项；完整记录请查看调用历史。');
    expect(deepText(node)).toContain('开始／继续 W10：已处理'); expect(deepText(node)).toContain('重试 #11：等待信号或安全点');
    expect(node.querySelectorAll('button')).toEqual([]); expect(actions).toEqual([]);
  });
}

test('legacy pending summaries retain last-action fallback without guessed totals; complete summaries stay untruncated', () => {
  const node = renderManagementState({ ...manager, management: { ...manager.management, pending_signal: { id: 51, due_at: signal.next_run_at },
    last_execution: { id: 50, status: 'succeeded', actions_truncated: true, actions: [{ action: 'retry', target_id: 11, target_worker_number: 'W11', status: 'succeeded' }] } } });
  expect(deepText(node)).toContain('重试 W11：已处理'); expect(deepText(node)).toContain('操作摘要：仅显示部分'); expect(deepText(node)).not.toContain('undefined');
  expect(renderManagementState(manager).querySelector('.management-actions-truncated')).toBeNull();
});

test('management detail retains full instruction instead of replacing it with the loaded list preview', () => {
  const goal = '管理长指令'.repeat(4000) + '最后一句完整保留';
  renderDetail({ ...manager, goal, calls: 0, children: [], deps: [], dependents: [], created_at: '2030-02-02T16:05:00Z', updated_at: '2030-02-02T16:06:00Z' }, null, null, null);
  expect(deepText(root())).toContain(goal); expect(deepText(root())).toContain('可停止、停用授权并预检删除');
  expect(root().querySelector('.task-actions').querySelectorAll('button').map(item => item.textContent)).toEqual(['停用授权', '停止管家', '删除', '刷新详情']); expect(actions).toEqual([]);
});

test('retained signal form validates explicit timezone, strict future conversion and exact metadata-only instant', () => {
  const form = createSignalForm(); input('信号名称', form.node).value = '刷新'; input('信号时区（IANA）', form.node).value = 'Asia/Kathmandu'; input('信号日期与时间', form.node).value = '2030-02-03T00:05';
  expect(form.validate()).toBe(''); expect(form.collect()).toEqual({ name: '刷新', enabled: true, schedule: { kind: 'once', at: '2030-02-02T18:20:00.000Z', timezone: 'Asia/Kathmandu' } });
  input('信号时区（IANA）', form.node).value = 'Not/AZone'; expect(form.validate()).toContain('IANA'); expect(input('信号时区（IANA）', form.node).value).toBe('Not/AZone');
  input('信号时区（IANA）', form.node).value = 'America/New_York'; input('信号日期与时间', form.node).value = '2030-03-10T02:30'; expect(form.validate()).toContain('不存在');
  input('信号日期与时间', form.node).value = '2030-11-03T01:30'; expect(form.validate()).toContain('出现两次');
  const ambiguous = { id: 'old', name: '原定', enabled: false, schedule: { kind: 'once', at: '2030-11-03T06:30:00.123Z', timezone: 'America/New_York' } };
  const preserved = createSignalForm(ambiguous); input('信号名称', preserved.node).value = '新名字'; expect(preserved.validate()).toBe(''); expect(preserved.collect().schedule).toEqual(ambiguous.schedule);
  expect(actions).toEqual([]);
});

test('retained management form validates one-shot authorization and stable recovery identity without executing or opening retired settings', () => {
  const clock = Date.now;
  try {
    Date.now = () => Date.parse('2030-02-02T16:04:59Z');
    const form = createManagementForm([{ ...signal, schedule: { kind: 'once', at: '2030-02-02T16:05:00Z', timezone: 'UTC' } }]); fillManagement(form);
    expect(input('信号绑定方式', form.node).value).toBe('once'); expect(form.validate()).toBe(''); const request = form.collect(); form.noteSubmitted();
    Date.now = () => Date.parse('2030-02-02T16:05:01Z'); expect(form.validate()).toBe(''); expect(form.collect()).toEqual(request);
    const second = createManagementForm([signal]); fillManagement(second); expect(second.collect().client_request_id).not.toBe(request.client_request_id);
    expect(request.client_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(actions).toEqual([]);
  } finally { Date.now = clock; }
});

test('one-shot helper validation refuses consumed/past subscriptions but preserves a rescheduled future signal without replaying old history', () => {
  const clock = Date.now;
  try {
    Date.now = () => Date.parse('2030-02-02T16:06:00Z');
    const consumed = { ...signal, schedule: { kind: 'once', at: '2030-02-02T16:05:00Z', timezone: 'UTC' }, last_due_at: '2030-02-02T16:05:00Z', last_execution: { status: 'emitted', due_at: '2030-02-02T16:05:00Z' } };
    const unavailable = createManagementForm([consumed]); fillManagement(unavailable); expect(unavailable.validate()).toContain('已发出或错过');
    const future = { ...consumed, schedule: { kind: 'once', at: '2030-02-03T16:05:00Z', timezone: 'UTC' }, next_run_at: '2030-02-03T16:05:00Z' };
    const saved = structuredClone(future), ready = createManagementForm([future]); fillManagement(ready); expect(ready.validate()).toBe('');
    expect(ready.collect()).toMatchObject({ signal_id: signal.id, mode: 'once' }); expect(future).toEqual(saved);
    const metadata = createSignalForm(future); input('信号名称', metadata.node).value = '未来刷新';
    expect(metadata.validate()).toBe(''); expect(metadata.collect().schedule).toEqual(future.schedule); expect(actions).toEqual([]);
  } finally { Date.now = clock; }
});

test('retained management profile excludes developer secrets and requires an explicit compatible source', async () => {
  const form = createManagementProfileForm(settings); expect(form.validate()).toContain('读取项目连接');
  expect(deepText(form.node)).not.toContain('HIDDEN PRIVATE PROMPT'); expect(deepText(form.node)).not.toContain('DEVELOPMENT PROMPT'); expect(deepText(form.node)).not.toContain('/private/extension');
  await btn('读取项目连接', form.node).onclick(); expect(form.validate()).toBe('');
  input('Valet 配置模式', form.node).value = 'pi'; input('Valet 配置模式', form.node).onchange(); expect(form.collect()).toEqual({ agent: 'pi', config_mode: 'pi' });
  expect(input('Valet 模型名称', form.node).disabled).toBe(true); input('Valet 配置模式', form.node).value = 'lush'; input('Valet 配置模式', form.node).onchange();
  expect(input('Valet 模型名称', form.node).value).toBe('openai-codex/codex-model'); expect(form.collect().connection_id).toBe('codex-source');
  for (const key of ['default_prompt', 'append_prompt', 'extensions', 'skills', 'env']) expect(form.collect()).not.toHaveProperty(key);
  input('Valet 模型名称', form.node).value = 'wrong/model'; expect(form.validate()).toContain('匹配'); expect(actions).toEqual([]);
});

test('late profile read stays bound to its form owner and cannot populate replacement management controls', async () => {
  const pending = gate(); let owns = true; intercept = path => path.endsWith('/api/agent/config') ? pending.promise : null;
  const form = createManagementForm([signal], { ownsPage: () => owns }); root().append(form.node);
  const loading = btn('Valet 运行设置', form.node).onclick(); await until(() => reads.some(path => path.endsWith('/api/agent/config')));
  owns = false; const replacement = createManagementForm([signal]); root().replaceChildren(replacement.node);
  pending.resolve(json(settings)); await loading;
  expect(root().querySelector('.management-profile-form')).toBeNull(); expect(root().querySelector('.management-form')).toBe(replacement.node); expect(actions).toEqual([]);
});
