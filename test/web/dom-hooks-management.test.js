import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const daily = { kind: 'daily', time: '00:05', timezone: 'Asia/Shanghai' };
const signal = { id: 'reset', name: '额度更新时间已到', enabled: true, schedule: daily, next_run_at: '2030-02-02T16:05:00Z', last_due_at: null, last_execution: null };
const manager = { id: 200, role: 'manager', task_kind: 'management', name: '半夜开始 W10', goal: '开始 W10；重试失败的 W11', status: 'waiting',
  management: { version: 1, revision: 'binding-1', signal_id: signal.id, mode: 'once', enabled: true, state: 'waiting', pending_signal: null, last_execution: null },
  model_selection: { agent: 'pi', config_mode: 'lush', connection_id: 'codex-source', model: 'openai-codex/codex-model', thinking: 'high' } };
const base = { version: 1, revision: 'templates-1', templates: [], triggers: [{ id: 'agent.failed', label: '调用异常', description: '不重放' }],
  actions: [{ type: 'notify', label: '告知', modes: ['once', 'persistent'], triggers: [], agent_call: false }],
  signals: { version: 1, revision: 'signals-1', items: [signal] }, management_workers: [manager] };
const settings = { default: { agent: 'codex', default_prompt: 'DEVELOPMENT PROMPT MUST NOT BE SHOWN' },
  resolved: { manager: { agent: 'pi', config_mode: 'lush', connection_id: 'codex-source', model: 'openai-codex/codex-model', thinking: 'high',
    default_prompt: 'HIDDEN PRIVATE PROMPT', env: { PRIVATE: 'SECRET' }, extensions: ['/private/extension'], skills: ['/private/skill'] } },
  options: { thinking: { pi: ['', 'low', 'medium', 'high'] }, agents: ['pi', 'codex'] } };
const source = { id: 'codex-source', label: '我的 Codex', enabled: true, provider: 'openai-codex', models: ['codex-model'],
  auth_type: 'oauth', endpoint: 'https://example.invalid', credential: { status: 'configured' }, default_model: 'codex-model', default_thinking: 'medium' };
let catalogue, actions, reads, intercept, detailCalls;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (path.endsWith('/api/agent/config')) return json(settings);
  if (path.endsWith('/api/agent/connections')) return json({ version: 1, connections: [source] });
  if (path.includes('/api/agent/connections/models')) return json({ version: 1, status: 'cached', models: [] });
  if (body?.method.startsWith('hooks.signal_')) return json(catalogue);
  if (body?.method === 'management.create') return json({ task: { ...manager, id: 201 } });
  if (body?.method === 'management.binding_update') return json({ ...manager, management: { ...manager.management, enabled: body.params.enabled, revision: 'binding-2' } });
  throw new Error(`unexpected read/action ${path} ${body?.method}`);
} });
const { openHooks, workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { createSignalForm, createManagementForm } = await import('../../src/ui/web/assets/hook-signals.js');
const { createManagementProfileForm } = await import('../../src/ui/web/assets/management-profile-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { registerNavigation } = await import('../../src/ui/web/assets/navigate.js');
const { worktreeLabel, ROLE } = await import('../../src/ui/web/assets/format.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const { syncComposer } = await import('../../src/ui/web/assets/composer.js');
const restoreNavigation = registerNavigation({ refresh: async () => {}, detail: id => { detailCalls.push(id); } });
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const input = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const newManagement = async () => {
  await openHooks(); await btn('新建管理指令').onclick();
  input('管理指令名称').value = '自动开跑'; input('管理指令').value = '重试失败的 W11'; input('绑定时间信号').value = signal.id;
};
beforeEach(() => { closeDialog(); actions = []; reads = []; intercept = null; detailCalls = []; catalogue = structuredClone(base);
  dom.location.pathname = '/'; ui.hooksPage = null; activateDetailView({ view: 'overview' }); });
afterAll(() => { closeDialog(); restoreNavigation(); dom.restore(); });

test('Hooks page separates time signals and manager instructions from development, with safe source and history projections', async () => {
  await openHooks();
  expect(actions).toHaveLength(0); expect(reads).toEqual(['/api/hooks']);
  expect(deepText(root())).toContain('默认输入框仍用于开发任务');
  expect(deepText(root())).toContain('不是实际额度已恢复的观测');
  expect(deepText(root())).toContain('每天 00:05 · Asia/Shanghai');
  expect(deepText(root())).toContain('2030-02-03 00:05:00 · Asia/Shanghai');
  expect(deepText(root())).toContain('来源 codex-source');
  expect(btn('删除时间信号').disabled).toBe(true);
  expect(btn('删除时间信号').parentNode.getAttribute('data-help')).toContain('先停用绑定');
  await btn('查看指令、结果与调用历史').onclick(); expect(detailCalls).toEqual([200]); expect(actions).toHaveLength(0);
  expect(workerHooks(manager)).toBeNull(); expect(worktreeLabel({ ...manager, workspace: '/private/management' })).toBe('管理工作目录'); expect(ROLE.manager).toBe('管理');
  expect(root().querySelectorAll('button').some(item => ['合并', '验收', '归档'].includes(item.textContent))).toBe(false);
});

for (const state of [{ status: 'paused', agent_wakes: 0 }, { status: 'paused', agent_wakes: 1 }, { status: 'failed' },
  { status: 'running' }, { status: 'running', interrupt_state: 'requested' }, { status: 'queued', interrupt_state: 'resuming' }]) {
  test(`management detail is strictly read-only for ${state.status}/${state.interrupt_state || state.agent_wakes || 'idle'}`, async () => {
    const row = { ...manager, ...state, calls: 1, children: [], deps: [], dependents: [],
      created_at: '2030-02-02T16:05:00Z', updated_at: '2030-02-02T16:06:00Z', result: '重试请求已提交，等待安全点',
      error: state.status === 'failed' ? '缺少管理模型来源' : null, workspace: '/project/.lush/management/200',
      branch_archive: { archivable: true }, model_selection: { ...manager.model_selection, explicit: true } };
    activateDetailView({ view: 'task', key: 'task-200' }); ui.selected = 200; ui.composerTask = row;
    const history = { events: [{ id: 500, type: 'management.signal_submitted', created_at: row.created_at,
      data: { due_at: row.created_at } }] };
    renderDetail(row, history, null, null); syncComposer();
    expect(deepText(root())).toContain('管理指令详情只读'); expect(deepText(root())).toContain('绑定启停仅在自动化页面');
    expect(deepText(root())).toContain(manager.goal); expect(deepText(root())).toContain(row.result);
    expect(deepText(root())).toContain('管理信号已提交待执行'); expect(deepText(root())).toContain('管理工作目录');
    expect(root().querySelector('.task-actions').querySelectorAll('button').map(item => item.textContent)).toEqual(['刷新详情']);
    for (const text of ['开始', '继续', '调整运行设置', '放弃 Worker', '中断', '检查后重试', '向该 Worker 追加输入', '删除', '合并', '验收', '归档', '启用管理绑定', '停用管理绑定']) expect(btn(text)).toBeUndefined();
    expect(root().querySelector('.worker-hooks')).toBeNull(); expect(btn('打开执行详情')).toBeTruthy();
    expect(dom.node('input').disabled).toBe(false); expect(dom.node('input-form').dataset.mode).toBe('create');
    await btn('刷新详情').onclick(); expect(detailCalls).toEqual([200]); expect(actions).toHaveLength(0);
  });
}

test('management identity alone fails closed against malformed legacy development projections', () => {
  for (const identity of [{ role: 'manager', task_kind: 'order' }, { role: 'agent', task_kind: 'management' }]) {
    renderDetail({ ...manager, ...identity, status: 'paused', calls: 0, children: [], deps: [], dependents: [],
      created_at: '2030-02-02T16:05:00Z', updated_at: '2030-02-02T16:06:00Z',
      integration: 'pending', branch_archive: { archivable: true }, hooks: { version: 1, revision: 'fake', mounts: [] } }, null, null, null);
    expect(root().querySelector('.task-actions').querySelectorAll('button').map(item => item.textContent)).toEqual(['刷新详情']);
    expect(root().querySelector('.worker-hooks')).toBeNull(); expect(root().querySelector('.management-readonly')).toBeTruthy();
  }
  expect(actions).toHaveLength(0);
});

for (const field of ['pending_signal', 'last_execution']) {
  test(`compact ${field} receipt summaries explicitly disclose omitted instruction and actions`, async () => {
    catalogue.management_workers[0].goal = '开始 W10；';
    Object.assign(catalogue.management_workers[0], { goal_truncated: true, goal_length: 32000 });
    catalogue.management_workers[0].management[field] = { id: 50, due_at: signal.next_run_at, status: 'succeeded',
      actions_count: 32, actions_truncated: true, actions: [
        { receipt_id: 1, action: 'start', target_id: 10, target_worker_number: 'W10', status: 'succeeded' },
        { receipt_id: 2, action: 'retry', target_id: 11, target_worker_number: null, target_worker_number_truncated: true, status: 'waiting' },
      ] };
    await openHooks();
    expect(deepText(root())).toContain('指令仅显示摘要；完整指令请打开下方详情。');
    expect(deepText(root())).toContain('操作摘要：显示 2 / 32 项；完整操作记录请查看下方详情与调用历史。');
    expect(deepText(root())).toContain('开始／继续 W10：已处理'); expect(deepText(root())).toContain('重试 #11：等待信号或安全点');
    expect(btn('停用管理绑定').disabled).toBe(false);
    await btn('查看指令、结果与调用历史').onclick(); expect(detailCalls).toEqual([200]); expect(actions).toHaveLength(0);
  });
}

test('all 64 enabled compact authorizations remain individually visible and revocable without loading full instructions', async () => {
  catalogue.management_workers = Array.from({ length: 64 }, (_, index) => ({ ...structuredClone(manager), id: 200 + index,
    goal: '管'.repeat(160), goal_truncated: true, goal_length: 32000,
    management: { ...structuredClone(manager.management), mode: 'persistent',
      pending_signal: { id: 50, due_at: signal.next_run_at, actions_count: 32, actions_truncated: true,
        actions: [{ action: 'start', target_id: 10, target_worker_number: 'W10', status: 'succeeded' },
          { action: 'retry', target_id: 11, target_worker_number: 'W11', status: 'waiting' }] } } }));
  await openHooks();
  expect(root().querySelectorAll('.hook-manager')).toHaveLength(64);
  expect(root().querySelectorAll('.management-goal-truncated')).toHaveLength(64);
  expect(root().querySelectorAll('.management-actions-truncated')).toHaveLength(64);
  expect(root().querySelectorAll('button').filter(item => item.textContent === '停用管理绑定' && !item.disabled)).toHaveLength(64);
  expect(reads).toEqual(['/api/hooks']); expect(actions).toHaveLength(0);
  await btn('停用管理绑定').onclick();
  expect(actions).toEqual([{ method: 'management.binding_update', params: { id: 200, enabled: false, expected_revision: 'binding-1' } }]);
});

test('legacy pending summaries without receipts retain last-action fallback and do not guess missing totals', async () => {
  Object.assign(catalogue.management_workers[0].management, {
    pending_signal: { id: 51, due_at: signal.next_run_at },
    last_execution: { id: 50, status: 'succeeded', actions_truncated: true,
      actions: [{ action: 'retry', target_id: 11, target_worker_number: 'W11', status: 'succeeded' }] },
  });
  await openHooks(); expect(deepText(root())).toContain('重试 W11：已处理');
  expect(deepText(root())).toContain('操作摘要：仅显示部分'); expect(deepText(root())).not.toContain('undefined');
});

test('legacy complete summaries do not invent truncation notices', async () => {
  await openHooks();
  expect(root().querySelector('.management-goal-truncated')).toBeNull();
  expect(root().querySelector('.management-actions-truncated')).toBeNull();
});

test('management details retain the full instruction while Hooks uses a truncated preview', () => {
  const goal = '管理长指令'.repeat(4000) + '最后一句完整保留';
  renderDetail({ ...manager, goal, calls: 0, children: [], deps: [], dependents: [],
    created_at: '2030-02-02T16:05:00Z', updated_at: '2030-02-02T16:06:00Z' }, null, null, null);
  expect(deepText(root())).toContain(goal); expect(deepText(root())).toContain('管理指令详情只读');
  expect(root().querySelector('.task-actions').querySelectorAll('button').map(item => item.textContent)).toEqual(['刷新详情']);
  expect(actions).toHaveLength(0);
});

test('missing signal capability never falls back to development orders or pretends management is available', async () => {
  delete catalogue.signals; await openHooks();
  expect(btn('新建时间信号')).toBeUndefined(); expect(btn('新建管理指令')).toBeUndefined();
  expect(deepText(root())).toContain('不会回退到开发输入或直接启动'); expect(actions).toHaveLength(0);
});

test('signal form uses explicit timezone, strict future date conversion and retains exact metadata-only instant', () => {
  const form = createSignalForm();
  input('信号名称', form.node).value = '刷新'; input('信号时区（IANA）', form.node).value = 'Asia/Kathmandu';
  input('信号日期与时间', form.node).value = '2030-02-03T00:05';
  expect(form.validate()).toBe(''); expect(form.collect()).toEqual({ name: '刷新', enabled: true, schedule: { kind: 'once', at: '2030-02-02T18:20:00.000Z', timezone: 'Asia/Kathmandu' } });
  input('信号时区（IANA）', form.node).value = 'Not/AZone'; expect(form.validate()).toContain('IANA');
  expect(input('信号时区（IANA）', form.node).value).toBe('Not/AZone');
  input('信号时区（IANA）', form.node).value = 'America/New_York'; input('信号日期与时间', form.node).value = '2030-03-10T02:30';
  expect(form.validate()).toContain('不存在'); input('信号日期与时间', form.node).value = '2030-11-03T01:30'; expect(form.validate()).toContain('出现两次');
  const ambiguous = { id: 'old', name: '原定', enabled: false, schedule: { kind: 'once', at: '2030-11-03T06:30:00.123Z', timezone: 'America/New_York' } };
  const preserved = createSignalForm(ambiguous); input('信号名称', preserved.node).value = '新名字';
  expect(preserved.validate()).toBe(''); expect(preserved.collect().schedule).toEqual(ambiguous.schedule);
});

test('daily signal saves only editable definition with independent signals revision and never calls a Worker', async () => {
  await openHooks(); await btn('新建时间信号').onclick();
  input('信号名称').value = '零点'; input('信号周期').value = 'daily'; input('信号周期').onchange();
  input('信号每日时间').value = '00:05'; input('信号时区（IANA）').value = 'Asia/Shanghai';
  const save = btn('保存时间信号'); expect(save.classList.contains('agent-call')).toBe(true); expect(save.getAttribute('data-help')).toContain('保存时不立即');
  await save.onclick(); expect(actions).toEqual([{ method: 'hooks.signal_save', params: { signal: { name: '零点', enabled: true, schedule: daily }, expected_revision: 'signals-1' } }]);
});

test('signal save failure preserves timezone, date and text edits for revision conflict', async () => {
  await openHooks(); await btn('新建时间信号').onclick();
  input('信号名称').value = '新信号'; input('信号日期与时间').value = '2030-02-03T00:05'; input('信号时区（IANA）').value = 'Asia/Shanghai';
  const form = root().querySelector('.signal-form');
  intercept = (_path, body) => body?.method === 'hooks.signal_save' ? { ok: false, json: async () => ({ error: 'signal revision conflict' }) } : null;
  await btn('保存时间信号').onclick();
  expect(root().querySelector('.signal-form')).toBe(form); expect(input('信号名称').value).toBe('新信号'); expect(input('信号时区（IANA）').value).toBe('Asia/Shanghai');
  expect(input('信号日期与时间').value).toBe('2030-02-03T00:05'); expect(dom.node('error').textContent).toContain('signal revision conflict');
  expect(btn('保存时间信号').disabled).toBe(false);
});

test('signal ticks keep configuration revisions distinct and expose missed or emitted outcomes without replay controls', async () => {
  catalogue.signals.items = [{ ...signal, id: 'old', name: '错过的半夜', enabled: false, next_run_at: null, schedule: { kind: 'once', at: '2000-01-01T00:05:00Z', timezone: 'UTC' }, last_due_at: '2000-01-01T00:05:00Z',
    last_execution: { status: 'skipped', due_at: '2000-01-01T00:05:00Z', reason: '停机错过，不补发。' } }];
  await openHooks(); expect(deepText(root())).toContain('已跳过／错过'); expect(deepText(root())).toContain('停机错过，不补发');
  expect(btn('启用时间信号').disabled).toBe(true); expect(btn('启用时间信号').parentNode.getAttribute('data-help')).toContain('不重放历史');
  expect(catalogue.signals.revision).toBe('signals-1'); expect(actions).toHaveLength(0);
});

test('deleting an unreferenced signal requires confirmation and does not delete management history', async () => {
  catalogue.management_workers[0].management.enabled = false; await openHooks();
  const removing = btn('删除时间信号').onclick(); expect(actions).toHaveLength(0);
  await dialogButton(dom, '删除时间信号').onclick(); await removing;
  expect(actions).toEqual([{ method: 'hooks.signal_remove', params: { id: 'reset', expected_revision: 'signals-1' } }]);
  expect(btn('查看指令、结果与调用历史')).toBeTruthy(); expect(btn('新建时间信号').disabled).toBe(false);
});

test('manager creation defaults to once, explicitly authorizes later invocation and never submits development input', async () => {
  await newManagement(); expect(input('信号绑定方式').value).toBe('once');
  expect(deepText(root())).toContain('不创建或追加开发任务');
  const save = btn('创建并绑定管理指令'); expect(save.classList.contains('agent-call')).toBe(true); expect(save.getAttribute('data-help')).toContain('不立即调用');
  const creating = save.onclick(); expect(actions).toHaveLength(0);
  expect(deepText(dom.node('modal'))).toContain('一次性绑定');
  const confirm = dialogButton(dom, '授权并创建管理指令'); expect(confirm.classList.contains('agent-call')).toBe(true);
  await confirm.onclick(); await creating;
  expect(actions).toEqual([{ method: 'management.create', params: { client_request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), name: '自动开跑', instruction: '重试失败的 W11', signal_id: 'reset', mode: 'once' } }]);
  expect(reads).toEqual(['/api/hooks']); expect(btn('新建管理指令').disabled).toBe(false);
  expect(ui.hooksPage.catalogue.management_workers.map(item => item.id)).toEqual([201, 200]);
});

test('persistent manager creation explains repeated fees and cancel keeps draft without any action', async () => {
  await newManagement(); input('信号绑定方式').value = 'persistent'; const form = root().querySelector('.management-form');
  const creating = btn('创建并绑定管理指令').onclick(); expect(deepText(dom.node('modal'))).toContain('持续绑定'); expect(deepText(dom.node('modal'))).toContain('每次信号');
  await dialogButton(dom, '取消').onclick(); await creating;
  expect(root().querySelector('.management-form')).toBe(form); expect(input('信号绑定方式').value).toBe('persistent'); expect(actions).toHaveLength(0);
  expect(btn('创建并绑定管理指令').disabled).toBe(false);
});

test('manager uses its own restricted source form, not development prompt, extensions or the target account', async () => {
  await newManagement(); await btn('管理 Agent 运行设置').onclick();
  expect(reads).toContain('/api/agent/config'); expect(reads.some(path => path.includes('/packages') || path.includes('/resources'))).toBe(false);
  expect(root().querySelector('[data-retry-field="default-prompt"]')).toBeNull();
  expect(deepText(root())).not.toContain('HIDDEN PRIVATE PROMPT'); expect(deepText(root())).not.toContain('DEVELOPMENT PROMPT'); expect(deepText(root())).not.toContain('/private/extension');
  await btn('读取项目连接').onclick();
  input('管理 Agent 思考深度').value = 'high';
  const creating = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await creating;
  expect(actions[0]).toMatchObject({ method: 'management.create', params: { profile: { agent: 'pi', config_mode: 'lush', connection_id: 'codex-source', model: 'openai-codex/codex-model', thinking: 'high' } } });
  for (const key of ['default_prompt', 'append_prompt', 'extensions', 'skills', 'env']) expect(actions[0].params.profile).not.toHaveProperty(key);
});

test('Pi-default manager profile strips managed fields and validates managed source before accepting', async () => {
  const form = createManagementProfileForm(settings); expect(form.validate()).toContain('读取项目连接');
  await btn('读取项目连接', form.node).onclick(); expect(form.validate()).toBe('');
  input('管理 Agent 配置模式', form.node).value = 'pi'; input('管理 Agent 配置模式', form.node).onchange();
  expect(form.collect()).toEqual({ agent: 'pi', config_mode: 'pi' }); expect(form.validate()).toBe('');
  expect(input('管理 Agent 模型名称', form.node).disabled).toBe(true);
  input('管理 Agent 配置模式', form.node).value = 'lush'; input('管理 Agent 配置模式', form.node).onchange();
  expect(input('管理 Agent 模型名称', form.node).value).toBe('openai-codex/codex-model'); expect(form.collect().connection_id).toBe('codex-source');
  input('管理 Agent 模型名称', form.node).value = 'wrong/model'; expect(form.validate()).toContain('匹配');
});

test('management create failure preserves instruction, persistent mode and selected source without enabling retry loops', async () => {
  await newManagement(); await btn('管理 Agent 运行设置').onclick(); await btn('读取项目连接').onclick(); input('信号绑定方式').value = 'persistent';
  const form = root().querySelector('.management-form');
  intercept = (_path, body) => body?.method === 'management.create' ? { ok: false, json: async () => ({ error: 'creation refused' }) } : null;
  const creating = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await creating;
  expect(root().querySelector('.management-form')).toBe(form); expect(input('管理指令').value).toBe('重试失败的 W11'); expect(input('信号绑定方式').value).toBe('persistent');
  expect(input('管理 Agent 模型来源').value).toBe('codex-source'); expect(dom.node('error').textContent).toContain('creation refused');
  expect(btn('创建并绑定管理指令').disabled).toBe(false); expect(actions).toHaveLength(1);
});

test('lost management creation response retries the same form key and recovers its original Worker exactly once', async () => {
  await newManagement();
  let originalRequest = null, createdCount = 0;
  intercept = (_path, body) => {
    if (body?.method !== 'management.create') return null;
    if (!originalRequest) {
      originalRequest = structuredClone(body); createdCount++;
      return Promise.reject(new Error('connection lost after successful creation'));
    }
    expect(body).toEqual(originalRequest);
    return json({ task: { ...manager, id: 201 } });
  };
  const first = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await first;
  expect(root().querySelector('.management-form')).toBeTruthy(); expect(deepText(root())).toContain('重试使用同一创建标识');
  expect(dom.node('error').textContent).toContain('先检查已有管理 Worker');
  const retry = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await retry;
  expect(actions).toHaveLength(2); expect(actions[1].params.client_request_id).toBe(actions[0].params.client_request_id);
  expect(createdCount).toBe(1); expect(ui.hooksPage.catalogue.management_workers.map(item => item.id)).toEqual([201, 200]);
  expect(root().querySelector('.management-form')).toBeNull();
});

test('editing an already-submitted management instruction keeps the original key and exposes definition conflict', async () => {
  await newManagement();
  let originalKey;
  intercept = (_path, body) => {
    if (body?.method !== 'management.create') return null;
    if (!originalKey) { originalKey = body.params.client_request_id; return Promise.reject(new Error('response lost')); }
    expect(body.params.client_request_id).toBe(originalKey);
    return { ok: false, json: async () => ({ error: 'client_request_id definition conflict; inspect original Worker' }) };
  };
  const first = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await first;
  input('管理指令').value = '开始 W15';
  const retry = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await retry;
  expect(actions).toHaveLength(2); expect(actions[1].params.instruction).toBe('开始 W15');
  expect(actions[1].params.client_request_id).toBe(actions[0].params.client_request_id);
  expect(input('管理指令').value).toBe('开始 W15'); expect(dom.node('error').textContent).toContain('definition conflict');
  expect(dom.node('error').textContent).toContain('勿另建重复指令');
});

test('receipt recovery is not locally refused after a submitted one-shot signal passes its deadline', () => {
  const clock = Date.now;
  try {
    Date.now = () => Date.parse('2030-02-02T16:04:59Z');
    const form = createManagementForm([{ ...signal, schedule: { kind: 'once', at: '2030-02-02T16:05:00Z', timezone: 'UTC' } }]);
    input('管理指令名称', form.node).value = '恢复收据'; input('管理指令', form.node).value = '开始 W10'; input('绑定时间信号', form.node).value = 'reset';
    expect(form.validate()).toBe(''); const request = form.collect(); form.noteSubmitted();
    Date.now = () => Date.parse('2030-02-02T16:05:01Z');
    expect(form.validate()).toBe(''); expect(form.collect()).toEqual(request);
  } finally { Date.now = clock; }
});

test('distinct management forms receive distinct creation keys without affecting other mutations', async () => {
  await newManagement();
  const first = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await first;
  await btn('新建管理指令').onclick(); input('管理指令名称').value = '第二项'; input('管理指令').value = '开始 W20'; input('绑定时间信号').value = 'reset';
  const second = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await second;
  expect(actions).toHaveLength(2); expect(actions[0].params.client_request_id).not.toBe(actions[1].params.client_request_id);
});

test('manager binding toggles use its own revision, preserve selected model and do not recreate any profile', async () => {
  await openHooks(); expect(btn('停用管理绑定').classList.contains('agent-call')).toBe(false);
  await btn('停用管理绑定').onclick();
  expect(actions[0]).toEqual({ method: 'management.binding_update', params: { id: 200, enabled: false, expected_revision: 'binding-1' } });
  expect(btn('启用管理绑定').classList.contains('agent-call')).toBe(true);
  const enabling = btn('启用管理绑定').onclick(); await dialogButton(dom, '授权并启用绑定').onclick(); await enabling;
  expect(actions[1]).toEqual({ method: 'management.binding_update', params: { id: 200, enabled: true, expected_revision: 'binding-2' } });
  expect(deepText(root())).toContain('openai-codex/codex-model'); expect(reads).toEqual(['/api/hooks']);
});

test('pending manager requests and unknown effects remain visible, escaped and non-replayable', async () => {
  Object.assign(catalogue.management_workers[0].management, { enabled: false, can_enable: false, state: 'unknown', reason: '旧调用副作用未知',
    pending_signal: { id: 50, due_at: '2030-02-02T16:05:00Z', actions: [{ action: 'retry', target_id: 11, target_worker_number: 'W11', status: 'waiting', reason: '分支冻结' }] },
    last_execution: { status: 'unknown', created_at: '2030-02-02T16:05:00Z', error: '<script>unknown</script>' } });
  await openHooks(); expect(deepText(root())).toContain('已提交信号 #50'); expect(deepText(root())).toContain('重试 W11：等待信号或安全点 · 分支冻结');
  expect(deepText(root())).toContain('旧调用副作用未知'); expect(deepText(root())).toContain('<script>unknown</script>'); expect(root().querySelector('script')).toBeNull();
  expect(btn('启用管理绑定').disabled).toBe(true); expect(btn('启用管理绑定').parentNode.getAttribute('data-help')).toContain('旧调用副作用未知');
  expect(actions).toHaveLength(0);
});

test('late manager profile reads cannot replace a different editor or paint a different project', async () => {
  await newManagement(); let resolve;
  intercept = path => path.endsWith('/api/agent/config') ? new Promise(done => { resolve = done; }) : null;
  const loading = btn('管理 Agent 运行设置').onclick(); await until(() => resolve);
  await btn('新建时间信号').onclick(); const form = root().querySelector('.signal-form');
  resolve(json(settings)); await loading; expect(root().querySelector('.signal-form')).toBe(form); expect(root().querySelector('.management-profile-form')).toBeNull();
  intercept = null; await newManagement();
  intercept = path => path.endsWith('/api/agent/config') ? new Promise(done => { resolve = done; }) : null;
  const another = btn('管理 Agent 运行设置').onclick();
  dom.location.pathname = '/p/2222222222222222/'; await openHooks(); const next = root().querySelector('.hooks-page');
  resolve(json(settings)); await another; expect(root().querySelector('.hooks-page')).toBe(next); expect(root().querySelector('.management-profile-form')).toBeNull(); expect(actions).toHaveLength(0);
});

test('late signal save cannot corrupt a different project catalogue or navigation', async () => {
  await openHooks(); await btn('新建时间信号').onclick(); input('信号名称').value = 'Late'; input('信号周期').value = 'daily'; input('信号周期').onchange();
  let resolve; intercept = (_path, body) => body?.method === 'hooks.signal_save' ? new Promise(done => { resolve = done; }) : null;
  const saving = btn('保存时间信号').onclick(); await until(() => resolve);
  dom.location.pathname = '/p/2222222222222222/'; await openHooks(); const next = root().querySelector('.hooks-page');
  resolve(json({ ...base, signals: { version: 1, revision: 'OLD PROJECT', items: [] } })); await saving;
  expect(root().querySelector('.hooks-page')).toBe(next); expect(ui.hooksPage.catalogue.signals.revision).toBe('signals-1'); expect(dom.location.hash).toBe('#hooks');
});

test('successful manager creation is not misreported when an unrelated overview refresh would fail', async () => {
  const restore = registerNavigation({ refresh: async () => { throw new Error('overview is unavailable'); }, detail: async () => {} });
  try {
    await newManagement();
    const creating = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await creating;
    expect(actions).toHaveLength(1); expect(ui.hooksPage.catalogue.management_workers[0].id).toBe(201);
    expect(root().querySelector('.management-form')).toBeNull(); expect(dom.node('error').textContent).not.toContain('overview is unavailable');
  } finally { restore(); }
});

test('late management creation result cannot add an old project Worker to a new project page', async () => {
  await newManagement(); let resolve;
  intercept = (_path, body) => body?.method === 'management.create' ? new Promise(done => { resolve = done; }) : null;
  const creating = btn('创建并绑定管理指令').onclick(); await dialogButton(dom, '授权并创建管理指令').onclick(); await until(() => resolve);
  dom.location.pathname = '/p/2222222222222222/'; await openHooks(); const next = root().querySelector('.hooks-page');
  resolve(json({ task: { ...manager, id: 999 } })); await creating;
  expect(root().querySelector('.hooks-page')).toBe(next); expect(ui.hooksPage.catalogue.management_workers.map(item => item.id)).toEqual([200]);
  expect(actions).toHaveLength(1);
});

test('one-shot historical signal cannot be subscribed by a newly created management instruction', async () => {
  catalogue.signals.items = [{ ...signal, enabled: false, schedule: { kind: 'once', at: '2030-02-02T16:05:00Z', timezone: 'UTC' }, last_due_at: '2030-02-02T16:05:00Z',
    last_execution: { status: 'emitted', due_at: '2030-02-02T16:05:00Z' } }];
  await newManagement();
  expect(input('绑定时间信号').children.find(item => item.value === 'reset').disabled).toBe(true);
  await btn('创建并绑定管理指令').onclick(); expect(deepText(root())).toContain('这个一次性信号已发出或错过'); expect(actions).toHaveLength(0);
  await btn('启用时间信号').onclick(); expect(actions).toHaveLength(0);
});

test('backend can_enable projection distinguishes revoked unstarted work from consumed once authorization', async () => {
  Object.assign(catalogue.management_workers[0].management, { enabled: false, can_enable: true, state: 'stopped',
    last_execution: { status: 'skipped', reason: '未开始的信号授权已撤销' } });
  await openHooks(); expect(btn('启用管理绑定').disabled).toBe(false);
  const enabling = btn('启用管理绑定').onclick(); await dialogButton(dom, '授权并启用绑定').onclick(); await enabling;
  expect(actions).toEqual([{ method: 'management.binding_update', params: { id: 200, enabled: true, expected_revision: 'binding-1' } }]);
});

test('rescheduled one-shot retains historical emission but allows a new future binding', async () => {
  const rescheduled = { ...signal, schedule: { kind: 'once', at: '2031-02-02T16:05:00Z', timezone: 'UTC' },
    next_run_at: '2031-02-02T16:05:00Z', last_due_at: '2030-02-02T16:05:00Z',
    last_execution: { status: 'succeeded', due_at: '2030-02-02T16:05:00Z' } };
  catalogue.signals.items = [rescheduled];
  await newManagement();
  expect(deepText(root())).toContain('最近信号：已发出');
  expect(input('绑定时间信号').children.find(item => item.value === 'reset').disabled).toBe(false);
  const creating = btn('创建并绑定管理指令').onclick();
  await dialogButton(dom, '授权并创建管理指令').onclick(); await creating;
  expect(actions[0].method).toBe('management.create');
  const form = createSignalForm({ ...rescheduled, enabled: false });
  input('启用时间信号', form.node).checked = true;
  expect(form.validate()).toBe(''); expect(form.collect().schedule).toEqual(rescheduled.schedule);
});

for (const unavailable of [{ enabled: false }, { next_run_at: null }, { next_run_at: '2000-01-01T00:05:00Z' }]) {
  test(`new management binding needs an enabled future runtime deadline: ${JSON.stringify(unavailable)}`, async () => {
    catalogue.signals.items = [{ ...signal, ...unavailable }]; await newManagement();
    expect(input('绑定时间信号').children.find(item => item.value === 'reset').disabled).toBe(true);
    await btn('创建并绑定管理指令').onclick();
    expect(actions).toHaveLength(0); expect(deepText(dom.node('modal'))).not.toContain('授权并创建管理指令');
  });
}

for (const state of ['queued', 'running', 'waiting_actions', 'stopped']) {
  test(`disabled binding with unfinished ${state} occurrence still protects its signal from removal`, async () => {
    Object.assign(catalogue.management_workers[0].management, { enabled: false, can_enable: false, state,
      pending_signal: { id: 50, due_at: signal.next_run_at, status: state } });
    await openHooks();
    const removing = btn('删除时间信号');
    expect(removing.disabled).toBe(true); expect(removing.parentNode.getAttribute('data-help')).toContain('等待调用及操作收口');
    await removing.onclick(); expect(actions).toHaveLength(0);
    if (state === 'stopped') { expect(deepText(root())).toContain('已停用'); expect(deepText(root())).not.toContain('stopped'); }
  });
}

for (const state of ['failed', 'unknown']) {
  test(`disabled ${state} diagnostic retains history without indefinitely protecting a signal`, async () => {
    Object.assign(catalogue.management_workers[0].management, { enabled: false, can_enable: false, state,
      pending_signal: { id: 50, due_at: signal.next_run_at, status: state } });
    await openHooks(); expect(btn('删除时间信号').disabled).toBe(false);
    const removing = btn('删除时间信号').onclick();
    await dialogButton(dom, '删除时间信号').onclick(); await removing;
    expect(actions[0].method).toBe('hooks.signal_remove');
    expect(btn('启用管理绑定').disabled).toBe(true); expect(deepText(root())).toContain('已提交信号 #50');
  });
}

test('already-consumed once bindings never offer replay, even with a future signal and no unsafe developer actions', async () => {
  Object.assign(catalogue.management_workers[0].management, { enabled: false, state: 'succeeded', last_execution: { status: 'succeeded', finished_at: '2030-02-02T16:05:00Z' } });
  await openHooks(); expect(btn('启用管理绑定').disabled).toBe(true); expect(btn('启用管理绑定').parentNode.getAttribute('data-help')).toContain('新建管理指令');
  expect(deepText(root())).toContain('最近处理：已处理'); expect(actions).toHaveLength(0);
});
