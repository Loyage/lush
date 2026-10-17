import { test, expect } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { renderRegistryAutomation, registeredMountPicker } from '../../src/ui/web/assets/automation-registry.js';
import { createHookForm } from '../../src/ui/web/assets/hook-form.js';
import { commandSummary } from '../../src/ui/web/assets/shortcut-command-model.js';
import { HOOK_REGISTER_CAPABILITY } from '../../src/core/hook-registration.js';

const item = (id, name, extra = {}) => ({ id, name, origin: 'custom', version: 1, versions: [1], purpose: '通知用途', mount_count: 0, targets: [], targets_complete: true, mountable: true, readonly: false, reason: null, ...extra });
const catalogue = items => ({ registration: HOOK_REGISTER_CAPABILITY, registry: { version: 1, revision: 'r1', upgrade_revision: 'u1', complete: true, total: items.length, legacy_mount_count: 0, items }, templates: [], triggers: [{ id: 'agent.returned', label: '返回' }, { id: 'worker.merge_received', label: '收到合并' }], actions: [{ type: 'notify', label: '通知', triggers: ['agent.returned'], modes: ['once', 'persistent'], agent_call: false }], commands: { version: 1, revision: 'c1', items: [] } });
const press = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label).onclick();

test('dynamic registry searches submitted name/purpose/origin, retains search and reports bounded targets/legacy', async () => {
  const data = catalogue([item('custom-one', '自定义任务'), item('system:signal', '系统规则', { origin: 'system', readonly: true, mountable: false }), item('builtin:completion', '成果自动合并与验收', { origin: 'builtin' })]);
  data.registry.legacy_mount_count = 3; data.registry.complete = false; data.registry.total = 9;
  data.registry.items[0] = item('custom-one', '自定义任务', { mount_count: 205, targets_complete: false, targets: [{ worker_id: 99, worker_number: 'W8-1', hook_id: 'h1', version: 1 }] });
  const reads = [], dom = installDom({ fetch: async url => { reads.push(url); return Response.json(data); } });
  dom.location.pathname = '/p/1111111111111111/';
  try {
    await openProjectAutomation(); const root = dom.node('detail'), entries = root.querySelectorAll('.automation-feature');
    expect(entries.map(row => row.dataset.feature)).toEqual(['custom-one', 'system:signal', 'completion']);
    expect(deepText(root)).toContain('205 个挂载'); expect(deepText(root)).toContain('3 个未登记挂载'); expect(deepText(root)).toContain('目录未列全');
    const search = root.querySelector('[aria-label="查找自动化功能"]'); search.value = '系统'; search.listeners.input[0](); expect(entries.every(row => !row.hidden)).toBe(true);
    search.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); expect(entries.filter(row => !row.hidden).map(row => row.dataset.feature)).toEqual(['system:signal']);
    await openProjectAutomation({ feature: 'custom-one' }); expect(deepText(root)).toContain('目标未列全：仅列出 1 / 205'); expect(deepText(root)).toContain('W8-1');
    await openProjectAutomation({ feature: 'system:signal' }); expect(deepText(root)).toContain('系统登记只读'); expect(root.querySelector('.registered-mount-picker')).toBeNull(); expect(root.querySelector('.registry-registration')).toBeNull();
    await openProjectAutomation(); expect(search.value).toBe('系统'); expect(reads).toHaveLength(1);
    search.value = '无匹配'; search.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); expect(deepText(root)).toContain('没有匹配的自动化功能。');
  } finally { ui.disposeProjectAutomation?.(); dom.restore(); }
});

test('empty and failed catalogues are distinct; late view reads do not paint', async () => {
  let resolve, fail = true;
  const dom = installDom({ fetch: async () => { if (fail) throw Error('offline'); return Response.json(catalogue([])); } });
  dom.location.pathname = '/p/1111111111111111/';
  try {
    await openProjectAutomation(); expect(deepText(dom.node('detail'))).toContain('读取失败：offline');
    fail = false; await press(dom.node('detail'), '重新读取目录'); expect(deepText(dom.node('detail'))).toContain('项目尚无登记功能。');
    ui.disposeProjectAutomation(); globalThis.fetch = () => new Promise(done => { resolve = done; });
    const reading = openProjectAutomation(); activateDetailView({ view: 'overview' }); dom.node('detail').replaceChildren();
    resolve(Response.json(catalogue([item('late', '迟到功能')]))); await reading; expect(deepText(dom.node('detail'))).not.toContain('迟到功能');
  } finally { ui.disposeProjectAutomation?.(); dom.restore(); }
});

test('registration success followed by failed refresh is not resubmitted; same-page calls retain draft', async () => {
  const data = catalogue([]), writes = [];
  const dom = installDom({ fetch: async (url, options) => { if (options?.body) { writes.push(JSON.parse(options.body)); return Response.json({ registered: true, template_id: 'new-id', template_version: 1 }); } if (writes.length) throw Error('refresh offline'); return Response.json(data); } });
  dom.location.pathname = '/p/1111111111111111/';
  try {
    await openProjectAutomation({ feature: 'register' }); const root = dom.node('detail');
    const name = root.querySelector('[aria-label="Hook 名称"]'); name.value = '草稿'; await openProjectAutomation({ feature: 'register' }); expect(root.querySelector('[aria-label="Hook 名称"]')).toBe(name); expect(name.value).toBe('草稿');
    const kind = root.querySelector('[aria-label="登记方式"]'); kind.value = 'shell'; kind.onchange();
    for (const [label, value] of [['功能名称', '注册功能'], ['指令名称', '注册命令'], ['Shell 指令正文', 'printf harmless']]) root.querySelector(`[aria-label="${label}"]`).value = value;
    const saving = press(root, '确认登记功能'); await dialogButton(dom, '只登记功能').onclick(); await saving;
    expect(writes).toHaveLength(1); expect(writes[0].method).toBe('hooks.register'); expect(writes[0].params).not.toHaveProperty('target');
    expect(deepText(root)).toContain('登记已成功，但刷新失败'); await press(root, '确认登记功能'); expect(writes).toHaveLength(1);
  } finally { ui.disposeProjectAutomation?.(); dom.restore(); }
});

test('register retries preserve exact idempotent request and draft; mount never accepts inline definitions', async () => {
  const data = catalogue([]), writes = [];
  const dom = installDom({ fetch: async (_url, options) => { writes.push(JSON.parse(options.body)); if (writes.length === 1) throw Error('ACK lost'); return Response.json({ registered: true, template_id: 'new', template_version: 1 }); } });
  try {
    const node = renderRegistryAutomation({ catalogue: data, mode: 'register', ownsPage: () => true, onSaved: async () => data });
    const kind = node.querySelector('[aria-label="登记方式"]'); kind.value = 'shell'; kind.onchange();
    for (const [label, value] of [['功能名称', '幂等功能'], ['指令名称', '命令'], ['Shell 指令正文', 'true']]) node.querySelector(`[aria-label="${label}"]`).value = value;
    const saving = press(node, '确认登记功能'); await dialogButton(dom, '只登记功能').onclick(); await saving; await press(node, '确认登记功能');
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    const picker = registeredMountPicker({ catalogue: catalogue([item('only', '唯一功能')]), workerId: 20, model: { revision: 'w1', can_attach: true } });
    expect(deepText(picker)).not.toContain('新建自定义规则'); expect(picker.querySelector('[aria-label="Hook 名称"]')).toBeNull(); expect(picker.querySelector('[aria-label="授权版本"]').value).toBe('');
  } finally { dom.restore(); }
});

for (const boundary of ['project', 'document']) test(`late registry reads are rejected after ${boundary} changes`, async () => {
  let resolve; const dom = installDom({ fetch: () => new Promise(done => { resolve = done; }) });
  dom.location.pathname = '/p/1111111111111111/'; const owner = globalThis.document;
  try {
    const reading = openProjectAutomation(), state = ui.automationPage;
    if (boundary === 'project') dom.location.pathname = '/p/2222222222222222/'; else globalThis.document = {};
    resolve(Response.json(catalogue([item('late', '不可污染的新功能')]))); await reading;
    expect(state.catalogue).toBeNull();
  } finally { globalThis.document = owner; ui.disposeProjectAutomation?.(); dom.restore(); }
});

test('explicit legacy upgrade uses upgrade_revision, preserves unknown result without replay', async () => {
  const data = catalogue([]), writes = []; data.registry.legacy_mount_count = 2;
  const dom = installDom({ fetch: async (_url, options) => { writes.push(JSON.parse(options.body)); throw Error('unknown ACK'); } });
  try {
    const node = renderRegistryAutomation({ catalogue: data, mode: 'upgrade', ownsPage: () => true, onSaved() {} });
    const saving = press(node, '显式升级旧规则'); expect(writes).toHaveLength(0); await dialogButton(dom, '确认补登记').onclick(); await saving;
    expect(writes[0]).toEqual({ method: 'hooks.upgrade', params: { expected_revision: 'u1' } });
    expect(deepText(node)).toContain('现场保留'); await press(node, '显式升级旧规则'); expect(writes).toHaveLength(1);
  } finally { dom.restore(); }
});

test('definition editor preserves pinned command versions and does not rebuild private profiles', () => {
  const dom = installDom();
  try {
    const data = catalogue([]); data.actions.push({ type: 'command', label: 'Shell', triggers: ['agent.returned'], modes: ['once', 'persistent'], agent_call: false });
    data.commands.items = [{ id: 'cmd', name: 'command', kind: 'shell', version: 2, command: 'current-body-only' }];
    const form = createHookForm(data, { initial: { id: 'existing', name: 'fixed', trigger: 'agent.returned', mode: 'once', enabled: false, actions: [{ type: 'command', command_id: 'cmd', command_version: 1 }] } });
    expect(form.collect().actions[0].command_version).toBe(1);
    const version = form.node.querySelector('[aria-label="指令授权版本"]'); version.value = '2'; expect(form.collect().actions[0].command_version).toBe(2);
    expect(commandSummary({ type: 'command', command_id: 'cmd', command_version: 1 }, data)).not.toContain('current-body-only');
    data.triggers.push({ id: 'worker.parent_ready', label: 'ready' }); data.actions.push({ type: 'create_worker', label: 'create', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true });
    const privateForm = createHookForm(data, { initial: { id: 'private', name: 'preserve', trigger: 'worker.parent_ready', mode: 'once', enabled: false, actions: [{ type: 'create_worker', content: 'goal', start: true, model_selection: { model: 'public-summary' } }] } });
    expect(privateForm.validate()).toBe(''); expect(privateForm.collect().actions[0]).not.toHaveProperty('profile'); expect(privateForm.collect().actions[0]).not.toHaveProperty('model_selection');
  } finally { dom.restore(); }
});

test('Shell registration choices use the register endpoint schema, not the broader command action catalogue', () => {
  const dom = installDom();
  try {
    const data = catalogue([]);
    data.actions.push({ type: 'command', triggers: ['agent.returned', 'worker.merge_received'], modes: ['once', 'persistent'], agent_call: false });
    const node = renderRegistryAutomation({ catalogue: data, mode: 'register', ownsPage: () => true, onSaved() {} });
    const trigger = node.querySelector('[aria-label="Shell 触发节点"]');
    expect(trigger.querySelectorAll('option').map(option => option.value)).toEqual([data.registration.schema.properties.hook.properties.trigger.const]);
    expect(trigger.value).toBe('worker.merge_received');
    expect(node.querySelector('[aria-label="Shell 规则方式"]').querySelectorAll('option').map(option => option.value)).toEqual(data.registration.schema.properties.hook.properties.mode.enum);
  } finally { dom.restore(); }
});

test('mount requires explicit version, marks Agent authorization and blocks unknown writes', async () => {
  const data = catalogue([item('registered', 'Agent 功能', { versions: [1, 2], version: 2 })]), writes = [];
  const dom = installDom({ fetch: async (_url, options) => { writes.push(JSON.parse(options.body)); throw Error('lost mount response'); } });
  try {
    const node = registeredMountPicker({ catalogue: data, templateId: 'registered', workerId: 18, model: { revision: 'worker-version', can_attach: true } });
    await press(node, '确认挂载'); expect(writes).toHaveLength(0);
    const version = node.querySelector('[aria-label="授权版本"]'); version.value = '1'; version.onchange();
    const enabled = node.querySelector('[aria-label="启用挂载"]'); enabled.checked = true; enabled.onchange();
    const save = node.querySelectorAll('button').find(button => button.textContent === '确认挂载'); expect(save.classList.contains('agent-call')).toBe(true); expect(save.getAttribute('data-help')).toContain('token');
    const saving = save.onclick(); await dialogButton(dom, '授权挂载').onclick(); await saving;
    expect(writes[0].params.hook).toEqual({ template_id: 'registered', template_version: 1, enabled: true });
    await save.onclick(); expect(writes).toHaveLength(1); expect(save.disabled).toBe(true); expect(deepText(node)).toContain('结果须只读核验');
  } finally { dom.restore(); }
});
