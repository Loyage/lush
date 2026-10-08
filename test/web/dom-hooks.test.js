import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const catalogue = { version: 1, revision: 'catalogue-v1', triggers: [
  { id: 'worker.delivery_ready', label: 'Agent 完成工作后', description: '真实退出且全部交付条件满足。' },
  { id: 'worker.parent_ready', label: '可以创建子 Worker', description: '整体解冻并通过创建准入。' },
  { id: 'agent.failed', label: '调用异常结束', description: '保留现场，不自动重放。' },
], actions: [
  { type: 'request_merge', label: '申请合并', description: '冻结源提交，向父队列申请。', triggers: ['worker.delivery_ready'], modes: ['once', 'persistent'], agent_call: true },
  { type: 'create_worker', label: '预约 Worker', description: '创建时固定父提交。', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true },
  { type: 'notify', label: '发送告知', description: '纯 info，不唤醒 Agent。', triggers: [], modes: ['once', 'persistent'], agent_call: false },
  { type: 'message', label: '追加消息', description: '只允许当前或直接父子。', triggers: [], modes: ['once'], agent_call: true },
], templates: [] };
const model = { version: 1, worker_id: 20, revision: 'mount-v1', mounts: [
  { id: 'auto-merge', builtin: true, name: '自动合并', trigger: 'worker.delivery_ready', mode: 'persistent', enabled: false, locked: false, editable: true, actions: [{ type: 'request_merge' }], state: 'waiting' },
  { id: 'custom', builtin: false, name: '异常告知', trigger: 'agent.failed', mode: 'persistent', enabled: true, locked: false, editable: true,
    conditions: { statuses: ['failed'] }, actions: [{ type: 'notify', title: '<script>Title</script>', body: '留存现场' }], state: 'failed', reason: '目标仍须通过安全检查',
    last_execution: { id: 42, status: 'failed', created_at: '2026-01-01T00:00:00Z', error: '动作未完成' } },
] };
const task = { id: 20, task_kind: 'order', status: 'waiting', branch: 'feature', auto_merge: { enabled: false, locked: false, editable: true, reason: null }, hooks: model };
let intercept, actions;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url); const body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (body) { return json(body.method.startsWith('hooks.') ? catalogue : body.method === 'worker.auto_merge' ? { auto_merge: { ...task.auto_merge, enabled: body.params.enabled } } : model); }
  throw new Error(`unexpected read ${path}`);
} });
const { openHooks, workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const daemonModel = (enabled = false, revision = 'daemon-v1') => ({ version: 1, revision, mounts: [{ id: 'auto-select', name: '自动选择',
  trigger: 'notice.received', mode: 'persistent', builtin: true, enabled, editable: true }] });
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(button => button.textContent === label);
beforeEach(() => { closeDialog(); actions = []; intercept = null; catalogue.templates = []; catalogue.daemon_hooks = daemonModel();
  dom.location.pathname = '/'; ui.hooksPage = null; activateDetailView({ view: 'overview' }); });
afterAll(() => { closeDialog(); dom.restore(); });

test('Hooks page reads catalogue, explains costs and saves templates without mounting or calling an Agent', async () => {
  await openHooks();
  expect(dom.location.hash).toBe('#hooks'); expect(dom.node('hooks-open').getAttribute('aria-current')).toBe('page');
  expect(deepText(root())).toContain('模板可复用');
  expect(root().querySelector('.hooks-page-header').querySelector('.hook-help-link').href).toBe('#doc-docs-hooks');
  expect(deepText(root())).not.toContain('允许的触发节点');
  expect(deepText(root())).not.toContain('受控动作与代价');
  expect(deepText(root())).not.toContain('示例：');
  await btn('新建模板').onclick();
  const form = root().querySelector('.hook-form'); form.querySelector('[aria-label="Hook 名称"]').value = '收尾规则';
  expect(btn('保存模板').classList.contains('agent-call')).toBe(false);
  await btn('保存模板').onclick();
  expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ method: 'hooks.save', params: { expected_revision: 'catalogue-v1', template: { name: '收尾规则', trigger: 'worker.delivery_ready' } } });
  expect(actions.some(call => call.method.startsWith('worker.'))).toBe(false);
});

test('template catalogue scales with search by name, trigger and action while keeping mounts separate', async () => {
  catalogue.templates = Array.from({ length: 50 }, (_, index) => ({ id: `template-${index}`, name: `规则 ${index}`,
    trigger: 'agent.failed', mode: 'once', enabled: false, actions: [{ type: 'notify', title: '告知', body: '正文' }] }));
  await openHooks();
  const search = root().querySelector('[aria-label="查找 Hook 模板"]');
  const cards = () => root().querySelectorAll('.hook-template');
  expect(cards()).toHaveLength(50);
  search.value = '规则 49'; search.oninput();
  expect(cards().filter(card => !card.hidden)).toHaveLength(1);
  expect(deepText(cards().find(card => !card.hidden))).toContain('模板 · 尚未挂载');
  expect(root().querySelector('.project-hooks').querySelectorAll('.project-hook')).toHaveLength(3);
  for (const query of ['agent.failed', 'notify']) {
    search.value = query; search.oninput(); expect(cards().every(card => !card.hidden)).toBe(true);
  }
  search.value = '不存在'; search.oninput(); expect(cards().every(card => card.hidden)).toBe(true);
  search.value = ''; search.oninput(); expect(cards().every(card => !card.hidden)).toBe(true);
  expect(actions).toHaveLength(0);
});

test('daemon auto-select retains a visible failed execution without confusing enabled authorization with success', async () => {
  Object.assign(catalogue.daemon_hooks.mounts[0], { enabled: true, state: 'failed', last_execution: {
    id: 58, notice_id: 58, status: 'failed', created_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:00:01Z', error: '自动答复未完成；请检查问题。',
  } });
  await openHooks();
  const section = root().querySelector('.daemon-auto-select');
  expect(deepText(section)).toContain('已启用');
  expect(deepText(section)).toContain('执行失败');
  expect(deepText(section)).toContain('问题 #58');
  expect(deepText(section)).toContain('自动答复未完成；请检查问题。');
  expect(btn('关闭自动选择', section)).toBeTruthy();
  expect(actions).toHaveLength(0);
});

test('declarative editor constrains action compatibility, one-shot creation, conditions and four-action maximum', () => {
  const form = createHookForm(catalogue, { initial: { trigger: 'worker.parent_ready' } });
  const select = form.node.querySelector('[aria-label="动作类型"]');
  expect(select.children.map(option => option.value)).not.toContain('request_merge');
  select.value = 'create_worker'; select.onchange();
  expect(form.node.querySelector('[aria-label="挂载方式"]').value).toBe('once');
  expect(form.node.querySelector('[aria-label="挂载方式"]').disabled).toBe(true);
  form.node.querySelector('[aria-label="Hook 名称"]').value = '新工作'; form.node.querySelector('[aria-label="新 Worker 指令"]').value = '实现目标';
  const integration = form.node.querySelector('[aria-label="无集成"]'); integration.checked = true;
  expect(form.validate()).toBe(''); expect(form.collect()).toMatchObject({ mode: 'once', conditions: { integrations: ['none'] }, actions: [{ type: 'create_worker', start: true, references: [] }] });
  for (let at = 0; at < 3; at++) btn('添加动作', form.node).onclick();
  expect(form.node.querySelectorAll('.hook-action')).toHaveLength(4); expect(btn('添加动作', form.node).disabled).toBe(true);
});

test('Worker management is collapsed, groups actual mounts by node and keeps failure alerts visible outside it', async () => {
  activateDetailView({ view: 'task', key: 'task-20' });
  const section = workerHooks(task, { refresh() {} }); root().replaceChildren(section);
  const management = section.querySelector('.hook-management');
  expect(Boolean(management.open)).toBe(false);
  expect(management.querySelectorAll('.hook-trigger-group')).toHaveLength(2);
  expect(section.querySelector('.hook-mount-alert').textContent).toBe('异常告知：执行失败');
  expect(section.querySelector('.hook-mount-alert').getAttribute('data-help')).toBe('动作未完成');
  expect(deepText(section)).not.toContain('不是任意一轮返回');
  expect(section.querySelectorAll('.hook-trigger-group')).toHaveLength(2);
  expect(deepText(section)).toContain('持续'); expect(deepText(section)).toContain('动作未完成');
  expect(section.querySelector('script')).toBeNull(); expect(deepText(section)).toContain('<script>Title</script>');
  const input = section.querySelector('.auto-merge-toggle').querySelector('input'); input.checked = true; await input.onchange();
  expect(actions.at(-1)).toMatchObject({ method: 'worker.auto_merge', params: { id: 20, enabled: true } });
  const compact = workerHooks(task, { compact: true }); expect(compact.querySelector('input')).toBeNull();
  expect(compact.querySelector('button').classList.contains('agent-call')).toBe(false);
});

test('mount mutations use optimistic revision; removing preserves already-created effects and requires confirmation', async () => {
  activateDetailView({ view: 'task', key: 'task-20' });
  const section = workerHooks(task, { refresh() {} }); root().replaceChildren(section);
  await btn('停用 Hook', section).onclick();
  expect(actions.at(-1)).toEqual({ method: 'worker.hook_update', params: { id: 20, hook_id: 'custom', expected_revision: 'mount-v1', enabled: false } });
  const removing = btn('移除挂载', section).onclick();
  expect(actions).toHaveLength(1); expect(deepText(dom.node('modal'))).toContain('不会取消已开始的动作');
  await dialogButton(dom, '移除挂载').onclick(); await removing;
  expect(actions.at(-1)).toEqual({ method: 'worker.hook_remove', params: { id: 20, hook_id: 'custom', expected_revision: 'mount-v1' } });
});

test('ended Workers allow removal of future custom authorization but never enable it or remove the built-in Hook', async () => {
  activateDetailView({ view: 'task', key: 'task-20' });
  const section = workerHooks({ ...task, status: 'cancelled', hooks: { ...model, mounts: [{
    ...model.mounts[1], enabled: false, editable: false, removable: true, reason: 'Worker 已结束或归档',
  }] } }, { refresh() {} }); root().replaceChildren(section);
  expect(btn('启用 Hook', section).disabled).toBe(true);
  expect(btn('移除挂载', section).disabled).toBe(false);
  const removing = btn('移除挂载', section).onclick();
  await dialogButton(dom, '移除挂载').onclick(); await removing;
  expect(actions.at(-1).method).toBe('worker.hook_remove');
});

test('pure notify attachment remains non-Agent; failed save preserves all edited fields', async () => {
  activateDetailView({ view: 'task', key: 'task-20' });
  const section = workerHooks(task, { refresh() {} }); root().replaceChildren(section);
  await btn('挂载 Hook', section).onclick();
  const form = section.querySelector('.hook-form');
  form.querySelector('[aria-label="Hook 名称"]').value = '提醒';
  const type = form.querySelector('[aria-label="动作类型"]'); type.value = 'notify'; type.onchange();
  form.querySelector('[aria-label="告知标题"]').value = '完成'; form.querySelector('[aria-label="消息或告知正文"]').value = '消息正文';
  expect(btn('确认挂载', section).classList.contains('agent-call')).toBe(false);
  intercept = (_path, body) => body?.method === 'worker.hook_attach' ? { ok: false, json: async () => ({ error: 'revision conflict' }) } : null;
  await btn('确认挂载', section).onclick();
  expect(form.querySelector('[aria-label="消息或告知正文"]').value).toBe('消息正文');
  expect(dom.node('error').textContent).toContain('revision conflict');
  expect(section.querySelector('.hook-form')).toBe(form); expect(dom.node('modal').hidden).toBe(true);
});

test('late catalogue and template saves never repaint a new page or mount a rule implicitly', async () => {
  let resolve;
  intercept = path => path.endsWith('/api/hooks') ? new Promise(done => { resolve = done; }) : null;
  const loading = openHooks(); await until(() => resolve);
  activateDetailView({ view: 'overview' }); root().replaceChildren(document.createElement('article'));
  resolve(json(catalogue)); await loading; expect(root().querySelector('.hooks-page')).toBeNull(); expect(actions).toHaveLength(0);
});

test('locked automatic child Hook cannot be disabled and preserves keyboard/pointer explanation', async () => {
  const section = workerHooks({ ...task, task_kind: 'child', auto_merge: { enabled: true, locked: true, editable: false, reason: '派生子 Worker 不可关闭' } }, { refresh() {} });
  const toggle = section.querySelector('.auto-merge-toggle'), input = toggle.querySelector('input');
  expect(input.disabled).toBe(true); expect(toggle.parentNode.tabIndex).toBe(0);
  expect(toggle.parentNode.getAttribute('data-help')).toContain('派生子 Worker'); input.checked = false; await input.onchange();
  expect(input.checked).toBe(true); expect(actions).toHaveLength(0);
});

test('Hook labels follow W numbers while automatic-merge writes and creation links retain integer identity', async () => {
  activateDetailView({ view: 'task', key: 'task-20' });
  const numbered = { ...task, worker_number: 'W5', hooks: { ...model, mounts: [model.mounts[0], {
    ...model.mounts[1], actions: [{ type: 'message', target_id: 700, target_worker_number: 'W5-2', body: 'check' }],
    last_execution: { id: 42, status: 'succeeded', created_at: '2026-01-01T00:00:00Z', worker_id: 800, worker_number: 'W8' },
  }] } };
  const section = workerHooks(numbered, { refresh() {} }); root().replaceChildren(section);
  expect(deepText(section)).toContain('追加消息到 W5-2');
  const automatic = section.querySelector('[aria-label="Worker W5 自动合并"]');
  automatic.checked = true; await automatic.onchange();
  expect(actions.at(-1)).toEqual({ method: 'worker.auto_merge', params: { id: 20, enabled: true } });
  expect(btn('查看创建的 Worker W8', section)).toBeTruthy();
  const form = createHookForm(catalogue, { initial: { name: 'message', trigger: 'agent.failed', mode: 'once', actions: [
    { type: 'message', target_id: 700, target_worker_number: 'W5-2', body: 'check' },
  ] } });
  expect(deepText(form.node)).toContain('内部整数 ID');
  expect(form.collect().actions[0]).toEqual({ type: 'message', target_id: 700, body: 'check' });
});

test('template metadata edits preserve server-side private profiles without reconstructing or replacing them', () => {
  const form = createHookForm(catalogue, { initial: { id: 'private-template', name: '预设', trigger: 'worker.parent_ready', actions: [{ type: 'create_worker', content: '目标', start: true }] } });
  expect(form.validate()).toBe('');
  expect(deepText(form.node)).toContain('保留模板已保存的私有运行覆盖');
  expect(form.collect().actions[0]).not.toHaveProperty('profile');
});

test('moving a template creation action cannot silently lose its private profile', () => {
  const form = createHookForm(catalogue, { initial: { id: 'private-template', name: '预设', trigger: 'worker.parent_ready', actions: [
    { type: 'notify', title: '开始', body: '通知' }, { type: 'create_worker', content: '目标', start: true },
  ] } });
  btn('移除动作', form.node).onclick();
  expect(form.validate()).toContain('新增或移动创建动作');
});

test('detail polling preserves the live Hook editor and its optimistic revision rather than wiping typed rules', async () => {
  const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
  activateDetailView({ view: 'task', key: 'task-20' });
  const inspected = { ...task, goal: '目标', deps: [], dependents: [], children: [], messages: [], notices: [] };
  renderDetail(inspected, null, null, null);
  await btn('挂载 Hook').onclick(); const form = root().querySelector('.hook-form');
  form.querySelector('[aria-label="Hook 名称"]').value = '打了一半';
  renderDetail({ ...inspected, hooks: { ...model, revision: 'mount-v2' } }, null, null, null);
  expect(root().querySelector('.hook-form')).toBe(form); expect(form.querySelector('[aria-label="Hook 名称"]').value).toBe('打了一半');
  await btn('取消编辑').onclick(); renderDetail(inspected, null, null, null);
  expect(root().querySelector('.hook-form')).toBeNull();
});

test('message forces one-shot mode from the catalogue and explains why persistent messaging is unsupported', () => {
  const form = createHookForm(catalogue, { initial: { name: '一次追加', trigger: 'agent.failed', mode: 'persistent', actions: [{ type: 'message', target_id: 20, body: '检查现场' }] } });
  expect(form.node.querySelector('[aria-label="挂载方式"]').value).toBe('once');
  expect(form.node.querySelector('[aria-label="挂载方式"]').disabled).toBe(true);
  expect(deepText(form.node)).toContain('无限付费循环'); expect(form.validate()).toBe('');
  expect(form.collect().mode).toBe('once');
});

test('daemon auto-selection has independent authorization, cost markers and revision; enabling settles existing questions', async () => {
  intercept = (_path, body) => body?.method === 'hooks.auto_select' ? json({ ...catalogue, daemon_hooks: daemonModel(body.params.enabled, 'daemon-v2') }) : null;
  await openHooks();
  const node = root().querySelector('.daemon-auto-select');
  expect(deepText(node)).toContain('已有和新收到的问题'); expect(deepText(node)).toContain('Agent 调用费用');
  expect(deepText(node)).toContain('当前项目后台');
  expect(node.querySelector('.hook-help-link').href).toBe('#doc-docs-hooks');
  const enable = btn('开启自动选择');
  expect(enable.classList.contains('agent-call')).toBe(true); expect(enable.getAttribute('data-help')).toContain('消耗 token');
  const saving = enable.onclick();
  expect(actions).toHaveLength(0); expect(deepText(dom.node('modal'))).toContain('立即答复');
  const authorize = dialogButton(dom, '授权并开启');
  expect(authorize.classList.contains('agent-call')).toBe(true); expect(authorize.getAttribute('data-help')).toContain('消耗 token');
  await authorize.onclick(); await saving;
  expect(actions).toEqual([{ method: 'hooks.auto_select', params: { enabled: true, expected_revision: 'daemon-v1' } }]);
  expect(deepText(root().querySelector('.daemon-auto-select'))).toContain('已启用');
  const disable = btn('关闭自动选择'); expect(disable.classList.contains('agent-call')).toBe(false);
  await disable.onclick();
  expect(actions.at(-1)).toEqual({ method: 'hooks.auto_select', params: { enabled: false, expected_revision: 'daemon-v2' } });
  expect(actions.every(call => call.method === 'hooks.auto_select')).toBe(true);
  expect(deepText(root().querySelector('.daemon-auto-select'))).toContain('已关闭');
});

test('cancelled daemon authorization does not save; pending controls use focusable help hosts and reject duplicate writes', async () => {
  await openHooks();
  const enable = btn('开启自动选择'), confirming = enable.onclick();
  const blocked = btn('正在保存…'); expect(blocked.disabled).toBe(true);
  expect(blocked.parentNode.classList.contains('help-host')).toBe(true); expect(blocked.parentNode.tabIndex).toBe(0);
  expect(blocked.parentNode.getAttribute('data-help')).toContain('正在确认或保存');
  await enable.onclick(); expect(actions).toHaveLength(0);
  closeDialog(); await confirming;
  expect(actions).toHaveLength(0); expect(btn('开启自动选择').disabled).toBe(false);
  let resolve;
  intercept = (_path, body) => body?.method === 'hooks.auto_select' ? new Promise(done => { resolve = done; }) : null;
  const saving = btn('开启自动选择').onclick(); await dialogButton(dom, '授权并开启').onclick();
  await until(() => resolve); await btn('正在保存…').onclick(); expect(actions).toHaveLength(1);
  resolve(json({ ...catalogue, daemon_hooks: daemonModel(true, 'daemon-v2') })); await saving;
  expect(actions).toHaveLength(1); expect(btn('关闭自动选择').disabled).toBe(false);
});

test('daemon revision failures never imply success and preserve a template editor for explicit refresh', async () => {
  await openHooks(); await btn('新建模板').onclick();
  const form = root().querySelector('.hook-form'); form.querySelector('[aria-label="Hook 名称"]').value = '未保存规则';
  intercept = (_path, body) => body?.method === 'hooks.auto_select' ? { ok: false, json: async () => ({ error: 'daemon revision changed' }) } : null;
  const saving = btn('开启自动选择').onclick(); await dialogButton(dom, '授权并开启').onclick(); await saving;
  expect(dom.node('error').textContent).toContain('daemon revision changed'); expect(dom.node('error').textContent).toContain('刷新目录');
  expect(btn('开启自动选择').disabled).toBe(false); expect(btn('关闭自动选择')).toBeUndefined();
  expect(root().querySelector('.hook-form')).toBe(form); expect(form.querySelector('[aria-label="Hook 名称"]').value).toBe('未保存规则');
});

test('daemon authorization cannot cross project identity or repaint a newer page after its save', async () => {
  await openHooks();
  const confirming = btn('开启自动选择').onclick();
  dom.location.pathname = '/p/2222222222222222/';
  await dialogButton(dom, '授权并开启').onclick(); await confirming; expect(actions).toHaveLength(0);
  await openHooks(); expect(ui.hooksPage.project).toBe('/p/2222222222222222/api/hooks'); expect(btn('开启自动选择')).toBeTruthy();
  dom.location.pathname = '/'; await openHooks();
  let resolve;
  intercept = (_path, body) => body?.method === 'hooks.auto_select' ? new Promise(done => { resolve = done; }) : null;
  const saving = btn('开启自动选择').onclick(); await dialogButton(dom, '授权并开启').onclick(); await until(() => resolve);
  activateDetailView({ view: 'overview' }); const next = document.createElement('article'); next.textContent = '新的页面'; root().replaceChildren(next);
  resolve(json({ ...catalogue, daemon_hooks: daemonModel(true) })); await saving;
  expect(root().children).toEqual([next]); expect(deepText(root())).toBe('新的页面');
});

test('older daemon responses show unknown automatic-selection availability without inventing a setting', async () => {
  delete catalogue.daemon_hooks; await openHooks();
  expect(deepText(root())).toContain('自动选择状态暂不可用'); expect(btn('开启自动选择')).toBeUndefined();
  expect(btn('新建模板')).toBeTruthy(); expect(actions).toHaveLength(0);
  for (const invalid of [{ version: 1, revision: '', mounts: daemonModel().mounts }, { version: 1, revision: 'valid', mounts: {} }]) {
    catalogue.daemon_hooks = invalid; ui.hooksPage = null; await openHooks();
    expect(deepText(root())).toContain('自动选择状态暂不可用'); expect(btn('开启自动选择')).toBeUndefined();
  }
});

test('original template attachment sends only template identity and never reconstructs its private profile from the read projection', async () => {
  const template = { id: '11111111-1111-4111-8111-111111111111', name: '固定运行参数', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
    actions: [{ type: 'create_worker', content: '模板目标', start: false, model_selection: { agent: 'pi', config_mode: 'lush', model: 'provider/template-model' } }] };
  catalogue.templates = [template];
  activateDetailView({ view: 'task', key: 'task-20' }); const section = workerHooks(task, { refresh() {} }); root().replaceChildren(section);
  await btn('挂载 Hook').onclick(); const picker = section.querySelector('[aria-label="挂载模板"]'); picker.value = template.id; picker.onchange();
  expect(section.querySelector('.hook-form')).toBeNull(); expect(deepText(section)).toContain('provider/template-model');
  expect(btn('原样挂载模板').classList.contains('agent-call')).toBe(false);
  await btn('原样挂载模板').onclick();
  expect(actions.at(-1)).toEqual({ method: 'worker.hook_attach', params: { id: 20, expected_revision: 'mount-v1', hook: { template_id: template.id } } });
});
