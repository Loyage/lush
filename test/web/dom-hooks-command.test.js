import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => Response.json(value);
const command = { id: 'push-hook', name: '合并后推送', trigger: 'worker.merge_received', mode: 'persistent', enabled: false,
  builtin: false, editable: true, removable: true, conditions: { statuses: [], integrations: [] },
  actions: [{ type: 'command', command_id: 'push-command', command_version: 1 }], state: 'idle', last_execution: null };
const baseModel = { version: 1, worker_id: 1, revision: 'main-revision', can_attach: true, mounts: [command] };
const template = { ...command, id: 'push-template' };
let catalogue, model, actions, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) actions.push(body);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (path.endsWith('/api/worker/1/hooks')) return json(catalogue.command_example.hooks);
  if (body?.method === 'worker.hook_update') {
    model = { ...model, revision: 'main-revision-2', mounts: model.mounts.map(mount => mount.id !== body.params.hook_id ? mount : {
      ...mount, ...(body.params.hook || { enabled: body.params.enabled }),
    }) }; catalogue.command_example.hooks = model; return json(model);
  }
  if (body?.method === 'worker.hook_remove') { model = { ...model, revision: 'removed', mounts: [] }; catalogue.command_example.hooks = model; return json(model); }
  if (body?.method === 'worker.hook_attach') return json(model);
  if (body?.method === 'hooks.save') return json(catalogue);
  throw new Error(`Unexpected request ${path} ${body?.method || ''}`);
} });
const { openHooks: openAutomation, openHookTools, workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const openProjectPush = options => openAutomation({ feature: 'push', ...options });
const openHooks = async () => { activateDetailView({ view: 'task', key: 'task-1' }); return drawExample(); };
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { api } = await import('../../src/ui/web/assets/api.js');
const { renderDetail } = await import('../../src/ui/web/assets/render-detail.js');
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const field = (node, label) => node.querySelector(`[aria-label="${label}"]`);
const example = () => root().querySelector('[data-feature="push"]');
const exampleTask = () => ({ id: 1, task_kind: 'main', branch: 'main', status: 'waiting', goal: 'main', deps: [], dependents: [], children: [], messages: [], notices: [],
  hooks: { ...model, push: { worker_id: 1, hook_id: command.id } } });
function drawExample() {
  const node = workerHooks(exampleTask(), { async refresh() { model = await api('/api/worker/1/hooks'); drawExample(); } });
  root().replaceChildren(node); example().querySelector('.worker-feature-advanced').open = true; return node;
}
function main() {
  activateDetailView({ view: 'task', key: 'task-1' });
  const node = workerHooks({ id: 1, task_kind: 'main', status: 'waiting', hooks: model }, { refresh() {} });
  root().replaceChildren(node); return node;
}
beforeEach(() => {
  closeDialog(); intercept = null; actions = []; dom.location.pathname = '/'; ui.hooksPage = null;
  model = structuredClone(baseModel);
  catalogue = { version: 1, revision: 'template-revision', automation_settings: { version: 1, revision: 'automation-r1',
    completion_defaults: { enabled: false, level: 'merge' }, acceptance_notice_defaults: { enabled: true },
    display_principles: { completion: 'all', push: 'all', convergence: 'all', acceptance_notice: 'all' } }, triggers: [
    { id: 'worker.merge_received', label: '收到合并', description: '父 Worker 成功收到合并后。' },
    { id: 'agent.failed', label: '调用失败', description: '未知副作用不重放。' },
    { id: 'worker.parent_ready', label: '可创建', description: '安全创建点。' },
  ], actions: [
    { type: 'command', label: 'Shell 命令', description: '执行所引用指令的最新定义。', triggers: ['worker.merge_received', 'agent.failed'], modes: ['once', 'persistent'], agent_call: false },
    { type: 'notify', label: '告知', triggers: [], modes: ['once', 'persistent'], agent_call: false },
    { type: 'create_worker', label: '创建 Worker', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true },
    { type: 'message', label: '追加消息', triggers: [], modes: ['once'], agent_call: true },
  ], commands: { version: 1, revision: 'commands-revision', items: [
    { id: 'push-command', name: 'Git 推送', command: 'git push', version: 1, last_execution: null },
    { id: 'tags-command', name: '推送标签', command: 'git push --tags', version: 1, last_execution: null },
  ] }, templates: [structuredClone(template)], command_example: { template_id: template.id, worker_id: 1, hook_id: command.id, hooks: model } };
  ui.hookCatalogue = catalogue; activateDetailView({ view: 'overview' });
});
afterAll(() => { closeDialog(); dom.restore(); });

test('command reference picker is catalogue driven, emits IDs and respects trigger compatibility', () => {
  const form = createHookForm(catalogue, { initial: command });
  field(form.node, '快捷指令').value = 'tags-command';
  expect(field(form.node, 'Shell 命令')).toBeNull();
  expect(field(form.node, '快捷指令').tagName).toBe('SELECT');
  expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual([{ type: 'command', command_id: 'tags-command' }]);
  expect(form.agentCall()).toBe(false); expect(field(form.node, '挂载方式').children.map(option => option.value)).toEqual(['once', 'persistent']);
  expect(deepText(form.node)).toContain('不是沙箱'); expect(deepText(form.node)).toContain('daemon 用户权限');
  field(form.node, '快捷指令').value = ''; expect(form.validate()).toContain('请选择当前已注册');
  field(form.node, '触发节点').value = 'worker.parent_ready'; field(form.node, '触发节点').onchange();
  expect(field(form.node, '动作类型').children.map(option => option.value)).not.toContain('command');
});

test('example reads main mount fixture, confirms future execution risk and uses mount revision rather than template revision', async () => {
  await openHooks(); expect(deepText(example())).toContain('停用'); expect(deepText(example())).toContain('main 成功收到合并');
  expect(example().querySelector('.hook-help-link').href).toBe('/#doc-docs-hooks');
  expect(deepText(example())).toContain(command.name); expect(deepText(example())).not.toContain('示例');
  const enabling = btn('启用 Hook', example()).onclick();
  expect(actions).toHaveLength(0); await until(() => dialogButton(dom, '启用指令 Hook')); expect(deepText(dom.node('modal'))).toContain('git push');
  const authorize = dialogButton(dom, '启用指令 Hook');
  expect(authorize.classList.contains('agent-call')).toBe(false); expect(btn('启用 Hook', example()).classList.contains('agent-call')).toBe(false);
  await authorize.onclick(); await enabling;
  expect(actions).toEqual([{ method: 'worker.hook_update', params: { id: 1, hook_id: command.id, expected_revision: 'main-revision', enabled: true } }]);
  expect(btn('停用 Hook', example()).disabled).toBe(false);
  await btn('停用 Hook', example()).onclick();
  expect(actions.at(-1).params).toEqual({ id: 1, hook_id: command.id, expected_revision: 'main-revision-2', enabled: false });
  expect(dom.node('modal').hidden).toBe(true);
});

test('example refresh rereads authoritative revision after runtime observation advances beyond mutation response', async () => {
  await openHooks();
  intercept = (_path, body) => {
    if (body?.method !== 'worker.hook_update' || body.params.enabled !== true) return null;
    const response = { ...model, revision: 'mutation-revision', mounts: [{ ...command, enabled: true }] };
    catalogue.command_example.hooks = { ...response, revision: 'observed-revision' };
    return json(response);
  };
  const enabling = btn('启用 Hook', example()).onclick(); await until(() => dialogButton(dom, '启用指令 Hook')); await dialogButton(dom, '启用指令 Hook').onclick(); await enabling;
  await btn('停用 Hook', example()).onclick();
  expect(actions.at(-1).params.expected_revision).toBe('observed-revision');
});

test('push settings no longer contain template or legacy default editors', async () => {
  catalogue.completion_defaults = { version: 1, enabled: false, level: 'merge', revision: 'defaults-revision' };
  await openProjectPush();
  expect(btn('新建模板')).toBeUndefined(); expect(root().querySelector('.completion-defaults')).toBeNull();
  expect(root().querySelectorAll('.hook-mount').filter(node => node.dataset.hookId)).toHaveLength(0); expect(root().querySelector('.hook-execution')).toBeNull();
  expect(root().querySelector('.push-command-reference').hidden).toBe(true);
  expect(root().querySelector('a[href="#hook-tools"]')).toBeNull();
  const projectSetting = root().querySelector('.command-hook-example');
  const enabling = btn('启用 Hook', projectSetting).onclick(); await dialogButton(dom, '确认启用推送').onclick(); await enabling;
  expect(deepText(projectSetting)).toContain('git push'); expect(actions.some(call => call.method === 'hooks.completion_defaults')).toBe(false);
});

test('command result displays safe exit and timeout diagnostics without raw output', async () => {
  Object.assign(model.mounts[0], { state: 'failed', last_execution: { id: 9, status: 'failed', created_at: '2026-10-08T00:00:00Z',
    command_result: { status: 'failed', exit_code: 9, reason: 'timeout' } } });
  await openHooks(); expect(deepText(example())).toContain('退出码 9'); expect(deepText(example())).toContain('超时');
  expect(deepText(example())).toContain('原始输出不公开');
});

test('cancelled enabling and stale project confirmation never grant command execution', async () => {
  await openHooks(); const cancelled = btn('启用 Hook', example()).onclick(); await until(() => dialogButton(dom, '启用指令 Hook')); closeDialog(); await cancelled;
  expect(actions).toHaveLength(0); expect(btn('启用 Hook', example()).disabled).toBe(false);
  const stale = btn('启用 Hook', example()).onclick(); await until(() => dialogButton(dom, '启用指令 Hook')); dom.location.pathname = '/p/2222222222222222/';
  await dialogButton(dom, '启用指令 Hook').onclick(); await stale; expect(actions).toHaveLength(0);
});

test('main and example full edit use hook_update without enabled parameter, retain failed drafts and render literal command text safely', async () => {
  const node = main(); await btn('编辑挂载', node).onclick();
  const form = node.querySelector('.hook-form'); field(form, '快捷指令').value = 'tags-command';
  field(form, 'Hook 名称').value = '自己设计'; field(form, '触发节点').value = 'agent.failed'; field(form, '触发节点').onchange();
  field(form, '挂载方式').value = 'once'; field(form, '静息').checked = true;
  expect(btn('保存挂载', node).classList.contains('agent-call')).toBe(false);
  intercept = (_path, body) => body?.method === 'worker.hook_update' ? { ok: false, json: async () => ({ error: 'revision conflict' }) } : null;
  await btn('保存挂载', node).onclick();
  expect(actions.at(-1)).toMatchObject({ method: 'worker.hook_update', params: { id: 1, hook_id: 'push-hook', expected_revision: 'main-revision', hook: {
    name: '自己设计', trigger: 'agent.failed', mode: 'once', enabled: false, conditions: { statuses: ['waiting'] },
    actions: [{ type: 'command', command_id: 'tags-command' }],
  } } });
  expect(actions.at(-1).params).not.toHaveProperty('enabled'); expect(node.querySelector('.hook-form')).toBe(form);
  expect(field(form, '快捷指令').value).toBe('tags-command'); expect(root().querySelector('script')).toBeNull();
  expect(dom.node('error').textContent).toContain('revision conflict'); expect(node.dataset.hookEditing).toBe('true');
});

test('editing enabled Hook confirms latest referenced definition; copies remain disabled without execution or receipts', async () => {
  model.mounts[0].enabled = true; const node = main(); await btn('编辑挂载', node).onclick();
  field(node.querySelector('.hook-form'), '快捷指令').value = 'tags-command';
  const saving = btn('保存挂载', node).onclick(); expect(deepText(dom.node('modal'))).toContain('git push --tags');
  await dialogButton(dom, '启用指令 Hook').onclick(); await saving; expect(actions[0].params.hook.enabled).toBe(true);
  main(); await btn('复制为停用挂载').onclick(); const form = root().querySelector('.hook-form');
  field(form, '启用此 Hook').checked = true; field(form, '启用此 Hook').onchange();
  await btn('保存停用副本').onclick();
  const copy = actions.at(-1); expect(copy.method).toBe('worker.hook_attach'); expect(copy.params.hook.enabled).toBe(false);
  expect(copy.params).not.toHaveProperty('hook_id'); expect(copy.params.hook).not.toHaveProperty('id');
  expect(copy.params.hook).not.toHaveProperty('last_execution'); expect(copy.params.hook.actions).toEqual([{ type: 'command', command_id: 'tags-command' }]);
  expect(dom.node('modal').hidden).toBe(true);
});

test('retired template entry has no edit or copy controls and preserves stored templates and actual mount', async () => {
  const before = structuredClone(catalogue); await openHookTools();
  expect(dom.location.hash).toBe('#hooks'); expect(dom.node('error').textContent).toContain('入口已移除');
  for (const label of ['编辑模板', '保存模板', '复制为停用模板', '保存停用模板副本']) expect(btn(label)).toBeUndefined();
  expect(root().querySelector('.hook-form')).toBeNull(); expect(actions).toHaveLength(0); expect(catalogue).toEqual(before);
});

test('enabled command template attachment needs risk confirmation; disabled template saves never do', async () => {
  catalogue.templates[0].enabled = true; const node = main(); await btn('挂载 Hook', node).onclick();
  const picker = field(node, '挂载模板'); picker.value = template.id; picker.onchange();
  const attaching = btn('原样挂载模板', node).onclick(); expect(actions).toHaveLength(0);
  await dialogButton(dom, '启用指令 Hook').onclick(); await attaching;
  expect(actions.at(-1)).toEqual({ method: 'worker.hook_attach', params: { id: 1, expected_revision: 'main-revision', hook: { template_id: template.id } } });
});

test('deleted example mount never reappears and failures/unknown remain visible from real execution records', async () => {
  Object.assign(model.mounts[0], { state: 'unknown', reason: '副作用未知，不重放', last_execution: {
    id: 9, trigger: command.trigger, status: 'unknown', created_at: '2026-10-08T00:00:00Z', error: '无法确认命令结果',
  } });
  await openHooks(); expect(deepText(example())).toContain('无法确认命令结果'); expect(deepText(example())).toContain('副作用未知');
  const removing = btn('移除挂载', example()).onclick(); await dialogButton(dom, '移除挂载').onclick(); await removing;
  expect(deepText(example())).toContain('不会自动重装'); expect(btn('启用 Hook', example())).toBeUndefined();
  expect(actions.map(item => item.method)).toEqual(['worker.hook_remove']);
});

test('frozen mounts show disabled help hosts and cannot mutate configuration or enable through stale callbacks', async () => {
  model.can_attach = false; Object.assign(model.mounts[0], { editable: false, removable: false, reason: '合并冻结中' });
  await openHooks();
  for (const label of ['启用 Hook', '编辑挂载', '复制为停用挂载']) {
    const control = btn(label, example()); expect(control.disabled).toBe(true); expect(control.parentNode.classList.contains('help-host')).toBe(true);
    await control.onclick();
  }
  expect(actions).toHaveLength(0); expect(root().querySelector('.hook-form')).toBeNull();
});

test('safe profile metadata edits omit secrets; copies require explicit full replacement rather than summary reconstruction', () => {
  const initial = { id: 'private', name: '创建', trigger: 'worker.parent_ready', mode: 'once', enabled: false,
    actions: [{ type: 'create_worker', content: '目标', start: false, model_selection: { agent: 'pi', model: 'not-a-profile' } }] };
  const edit = createHookForm(catalogue, { initial }); expect(edit.validate()).toBe(''); expect(edit.collect().actions[0]).not.toHaveProperty('profile');
  const copy = createHookForm(catalogue, { initial, copying: true }); expect(copy.validate()).toContain('不能从安全摘要重建');
  expect(copy.collect().actions[0]).not.toHaveProperty('model_selection'); expect(copy.collect().actions[0]).not.toHaveProperty('profile');
});

test('late Worker full edit response cannot repaint a new page; explicit reads cannot silently discard a live push editor', async () => {
  await openHooks(); await btn('编辑挂载', example()).onclick(); const form = example().querySelector('.hook-form');
  field(form, '快捷指令').value = 'tags-command';
  await btn('读取推送设置').onclick();
  expect(dom.node('modal').hidden).toBe(true); expect(example().querySelector('.hook-form')).toBe(form);
  expect(field(form, '快捷指令').value).toBe('tags-command');
  let resolve; intercept = (_path, body) => body?.method === 'worker.hook_update' ? new Promise(done => { resolve = done; }) : null;
  const saving = btn('保存挂载', example()).onclick(); await until(() => resolve);
  activateDetailView({ view: 'overview' }); const next = document.createElement('p'); next.textContent = '新页面'; root().replaceChildren(next);
  resolve(json(model)); await saving; expect(root().children).toEqual([next]);
});

test('Worker detail polling and advanced folding retain unsaved push edits and their captured optimistic revision', async () => {
  await openHooks(); renderDetail(exampleTask(), null, null, null);
  example().querySelector('.worker-feature-advanced').open = true;
  await btn('编辑挂载', example()).onclick(); const form = example().querySelector('.hook-form');
  field(form, '快捷指令').value = 'tags-command';
  const advanced = example().querySelector('.worker-feature-advanced'); advanced.open = false;
  renderDetail({ ...exampleTask(), hooks: { ...exampleTask().hooks, revision: 'polled-newer-revision' } }, null, null, null);
  expect(example().querySelector('.worker-feature-advanced')).toBe(advanced); advanced.open = true;
  expect(example().querySelector('.hook-form')).toBe(form); expect(field(form, '快捷指令').value).toBe('tags-command');
  await btn('保存挂载', example()).onclick(); expect(actions.at(-1).params.expected_revision).toBe('main-revision');
});

test('mixed Agent actions retain unified purple help while command-only and disabled saves have no Agent cost', async () => {
  const node = main(); await btn('编辑挂载', node).onclick(); await btn('添加动作', node).onclick();
  const rows = node.querySelectorAll('.hook-action'), last = rows.at(-1);
  field(last, '动作类型').value = 'message'; field(last, '动作类型').onchange();
  field(last, '消息或告知正文').value = '检查结果';
  expect(btn('保存挂载', node).classList.contains('agent-call')).toBe(false);
  const enabled = field(node, '启用此 Hook'); enabled.checked = true; enabled.onchange();
  expect(btn('保存挂载', node).classList.contains('agent-call')).toBe(true);
  expect(btn('保存挂载', node).getAttribute('data-help')).toContain('消耗 token');
  const saving = btn('保存挂载', node).onclick(), confirm = dialogButton(dom, '启用指令 Hook');
  expect(confirm.classList.contains('agent-call')).toBe(true); expect(confirm.getAttribute('data-help')).toContain('所配置的 Agent 动作');
  expect(confirm.getAttribute('data-help')).not.toContain('提示词引用'); expect(confirm.getAttribute('data-help')).toContain('消耗 token');
  closeDialog(); await saving; expect(actions).toHaveLength(0);
});
