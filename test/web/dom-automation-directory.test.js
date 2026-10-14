import { test, expect, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => Response.json(value);
const uuid = n => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const shell = () => ({ id: uuid(1), name: '测试 Shell', kind: 'shell', command: 'printf "<script>literal</script>"', version: 2,
  description: '执行模块测试', when_to_use: '修改完成后', tags: ['验证', '单元测试'], examples: '手动选择工作目录', warnings: '会修改文件', default_worker_id: 42, last_execution: null });
const prompt = () => ({ id: uuid(2), name: '审查提示词', kind: 'prompt', prompt: '检查代码 <img src=x onerror=alert(1)>', version: 3,
  description: '检查代码质量', when_to_use: '准备交付', tags: ['质量', 'review'], examples: '在 order 下审查', warnings: '可能产生费用', default_worker_id: null, last_execution: null });
const hook = () => ({ id: uuid(8), name: '一次性审查', trigger: 'worker.parent_ready', mode: 'once', enabled: false,
  actions: [{ type: 'prompt_command', command_id: uuid(2), command_version: 3 }] });
const execution = (patch = {}) => ({ id: uuid(10), event_id: 100, command_name: '审查提示词', command_version: 3, kind: 'prompt', worker_id: 42, worker_number: 'W8',
  source: 'manual', status: 'pending', created_at: '2026-10-12T00:00:00Z', ...patch });
let catalogue, calls, reads;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) calls.push(body); else reads.push(path);
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (body?.method === 'worker.hook_update') { catalogue.command_example.hooks.mounts[0].enabled = body.params.enabled; return json(catalogue.command_example.hooks); }
  throw new Error(`Unexpected ${path} ${body?.method}`);
} });
const { workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { openProjectAutomation } = await import('../../src/ui/web/assets/render-project-automation.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { commandDirectory, commandDetail } = await import('../../src/ui/web/assets/shortcut-command-directory.js');
const { validCommands, commandReferencesIssue, referencedCommand, commandSummary } = await import('../../src/ui/web/assets/shortcut-command-model.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const field = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const submitSearch = input => input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
beforeEach(() => {
  closeDialog(); calls = []; reads = []; ui.hooksPage = null; dom.location.pathname = '/'; activateDetailView({ view: 'overview' });
  catalogue = { version: 1, revision: 'hooks-r1', commands: { version: 1, revision: 'commands-r1', items: [shell(), prompt()] },
    triggers: [{ id: 'worker.parent_ready', label: '父 Worker 可创建' }, { id: 'agent.returned', label: 'Agent 返回' }],
    actions: [{ type: 'command', label: 'Shell 指令', triggers: ['worker.parent_ready', 'agent.returned'], modes: ['once', 'persistent'], agent_call: false },
      { type: 'prompt_command', label: '提示词指令', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true }, { type: 'notify', label: '告知', modes: ['once', 'persistent'], agent_call: false }],
    templates: [], command_example: null };
});
afterAll(() => { closeDialog(); dom.restore(); });

// These pure read components remain available to the push reference projection;
// they do not create an independently reachable directory or definition editor.
test('read-only definition cards render safe literal metadata and have no edit, export or run controls', () => {
  for (const item of [shell(), prompt()]) {
    const node = commandDetail(item); root().replaceChildren(node);
    expect(node.querySelectorAll('button')).toHaveLength(0); expect(node.querySelectorAll('textarea')).toHaveLength(0);
    expect(deepText(node)).toContain(item.when_to_use); expect(deepText(node)).toContain(item.warnings);
    expect(deepText(node)).toContain(item.command || item.prompt); expect(node.querySelector('script')).toBeNull(); expect(node.querySelector('img')).toBeNull();
  }
  expect(calls).toHaveLength(0); expect(reads).toHaveLength(0);
});

test('pure loaded-directory filter submits name, metadata and tags explicitly, preserves draft terms through type changes', async () => {
  const directory = commandDirectory({ model: catalogue.commands, label: '查找管理指令' }); root().replaceChildren(directory.node);
  const input = field('查找管理指令'), type = field('查找管理指令类型'), entries = () => directory.node.querySelectorAll('.shortcut-directory-entry');
  input.value = '没有'; type.value = 'prompt'; type.onchange(); expect(entries()).toHaveLength(1); expect(deepText(directory.node)).toContain('审查提示词');
  submitSearch(input); expect(entries()).toHaveLength(0); expect(deepText(directory.node)).toContain('没有匹配'); type.value = ''; type.onchange();
  for (const query of ['测试 Shell', '执行模块测试', '修改完成后', '单元测试']) { input.value = query; submitSearch(input); expect(entries()).toHaveLength(1); }
  type.value = 'prompt'; type.onchange(); await btn('清空', directory.node).onclick(); expect(type.value).toBe('prompt'); expect(entries()).toHaveLength(1);
  type.value = ''; type.onchange(); expect(entries()).toHaveLength(2); expect(calls).toHaveLength(0); expect(reads).toHaveLength(0);
});

test('IME candidate confirmation never submits a pure directory search', () => {
  const directory = commandDirectory({ model: catalogue.commands, label: '查找管理指令' }); root().replaceChildren(directory.node);
  const input = field('查找管理指令'); input.value = '没有'; input.listeners.compositionstart[0](); submitSearch(input);
  expect(directory.node.querySelectorAll('.shortcut-directory-entry')).toHaveLength(2);
  input.listeners.compositionend[0](); input.listeners.keydown[0]({ key: 'Enter', isComposing: true, preventDefault() {} });
  expect(directory.node.querySelectorAll('.shortcut-directory-entry')).toHaveLength(2);
  input.listeners.keydown[0]({ key: 'Enter', keyCode: 229, preventDefault() {} }); expect(directory.node.querySelectorAll('.shortcut-directory-entry')).toHaveLength(2);
  expect(reads).toHaveLength(0);
});

for (const authorized of [undefined, false, true, 'obsolete']) test(`latest ID+kind validation ignores authorized=${authorized} and legacy version`, () => {
  for (const item of catalogue.commands.items) if (authorized !== undefined) item.authorized = authorized;
  expect(validCommands(catalogue.commands)).toBe(true);
  for (const [type, item] of [['command', shell()], ['prompt_command', prompt()]]) {
    for (const version of [undefined, 1, 99]) {
      const action = { type, command_id: item.id, ...(version === undefined ? {} : { command_version: version }) };
      const rule = { ...hook(), enabled: true, actions: [action] };
      expect(commandReferencesIssue(rule, catalogue)).toBeNull(); expect(referencedCommand(action, catalogue)?.version).toBe(item.version);
      const form = createHookForm(catalogue, { initial: rule });
      expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual([{ type, command_id: item.id }]);
      expect(commandSummary(action, catalogue)).toContain(`当前 v${item.version}`); expect(commandSummary(action, catalogue)).toContain('未来执行跟随最新定义');
    }
  }
});

test('deleted or changed-kind references remain explicit and block validation without silent reselection', () => {
  const initial = { ...hook(), enabled: true }; catalogue.commands.items[1] = { ...shell(), id: uuid(2), name: '已改成 Shell' };
  expect(commandReferencesIssue(initial, catalogue)).toContain('类型不匹配'); expect(commandSummary(initial.actions[0], catalogue)).toContain('类型不匹配');
  const mismatched = createHookForm(catalogue, { initial }); expect(field('快捷指令', mismatched.node).value).toBe(uuid(2)); expect(mismatched.validate()).toContain('类型不匹配');
  catalogue.commands.items = [shell()]; expect(commandReferencesIssue(initial, catalogue)).toContain('已删除'); expect(commandSummary(initial.actions[0], catalogue)).toContain('不存在');
  const deleted = createHookForm(catalogue, { initial }); expect(field('快捷指令', deleted.node).value).toBe(uuid(2)); expect(deleted.validate()).toContain('已删除');
  expect(deleted.collect().actions).toEqual([{ type: 'prompt_command', command_id: uuid(2) }]); catalogue.commands = null;
  expect(commandReferencesIssue(initial, catalogue)).toContain('目录不可用'); expect(commandSummary(initial.actions[0], catalogue)).toContain('目录不可用'); expect(commandSummary(initial.actions[0], catalogue)).not.toContain('已删除');
});

test('Hook type filters Shell and prompt IDs separately, enforces once/parent_ready and ignores stale version', () => {
  const form = createHookForm(catalogue, { initial: hook() }), commands = field('快捷指令', form.node);
  expect(commands.children.map(item => item.value)).toEqual(['', uuid(2)]); expect(field('挂载方式', form.node).children.map(item => item.value)).toEqual(['once']);
  expect(form.agentCall()).toBe(true); expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual([{ type: 'prompt_command', command_id: uuid(2) }]);
  const type = field('动作类型', form.node); type.value = 'command'; type.onchange(); expect(commands.children.some(item => item.value === uuid(1))).toBe(true); expect(form.validate()).toContain('类型不匹配');
  commands.value = uuid(1); expect(form.validate()).toBe(''); expect(form.agentCall()).toBe(false);
  field('触发节点', form.node).value = 'agent.returned'; field('触发节点', form.node).onchange(); expect(type.children.some(item => item.value === 'prompt_command')).toBe(false);
  const stale = createHookForm(catalogue, { initial: { ...hook(), actions: [{ type: 'prompt_command', command_id: uuid(2), command_version: 2 }] } });
  expect(field('快捷指令', stale.node).value).toBe(uuid(2)); expect(field('快捷指令', stale.node).children.at(-1).disabled).not.toBe(true); expect(stale.validate()).toBe('');
  expect(commandReferencesIssue({ ...hook(), mode: 'persistent' }, catalogue)).toContain('一次性');
  const child = createHookForm(catalogue, { workerId: 44, workerTaskKind: 'child' }); expect(field('动作类型', child.node).children.some(item => item.value === 'prompt_command')).toBe(false);
});

test('prompt Hook enable is purple with future cost confirmation, Shell-only hooks remain non-Agent', async () => {
  const mount = { ...hook(), editable: true, removable: true, state: 'idle', last_execution: null };
  catalogue.command_example = { worker_id: 1, hook_id: mount.id, hooks: { version: 1, worker_id: 1, revision: 'mount-r1', mounts: [mount] } };
  await openProjectAutomation({ feature: 'push' }); const enable = btn('开启', root().querySelector('.command-hook-example'));
  expect(enable.classList.contains('agent-call')).toBe(true); expect(enable.getAttribute('data-help')).toContain('token');
  const enabling = enable.onclick(); expect(dialogButton(dom, '启用指令 Hook').classList.contains('agent-call')).toBe(true);
  expect(deepText(dom.node('modal'))).toContain('未来节点满足后');
  await dialogButton(dom, '启用指令 Hook').onclick(); await until(() => dialogButton(dom, '授权并挂载'));
  expect(calls).toHaveLength(0); expect(dialogButton(dom, '授权并挂载').classList.contains('agent-call')).toBe(true);
  expect(dialogButton(dom, '授权并挂载').getAttribute('data-help')).toContain('token');
  await dialogButton(dom, '授权并挂载').onclick(); await enabling;
  expect(calls).toHaveLength(1); expect(calls[0].params).toMatchObject({ id: 1, enabled: true, expected_revision: 'mount-r1' });
});

test('Hook receipt uses the created identity, never labels the prompt parent as created Worker', () => {
  const mount = { ...hook(), editable: true, removable: true, state: 'succeeded', last_execution: execution({ status: 'succeeded', created_worker_id: 109, created_worker_number: 'W28', command_result: { status: 'succeeded', exit_code: 0 } }) };
  ui.hookCatalogue = catalogue; activateDetailView({ view: 'task', key: 'task-42' });
  const paint = revision => root().replaceChildren(workerHooks({ id: 42, task_kind: 'order', status: 'waiting', hooks: { version: 1, worker_id: 42, revision, mounts: [mount] } }));
  paint('r1'); expect(deepText(root())).toContain('不代表 Agent 工作完成'); expect(btn('查看创建的 Worker W28')).toBeTruthy(); expect(btn('查看创建的 Worker W8')).toBeUndefined(); expect(deepText(root())).not.toContain('退出码');
  mount.last_execution.created_worker_id = null; paint('r2'); expect(btn('查看创建的 Worker W8')).toBeUndefined(); expect(btn('查看创建的 Worker W28')).toBeUndefined();
});

for (const status of ['succeeded', 'failed']) test(`runtime prompt Hook receipt (${status}) links its created Worker with the action receipt fields`, () => {
  const mount = { ...hook(), editable: true, removable: true, state: status, last_execution: { id: uuid(10), trigger: 'worker.parent_ready', status, worker_id: 109, worker_number: 'W28', input_id: 87 } };
  ui.hookCatalogue = catalogue; activateDetailView({ view: 'task', key: 'task-42' });
  root().replaceChildren(workerHooks({ id: 42, task_kind: 'order', status: 'waiting', hooks: { version: 1, worker_id: 42, revision: 'r1', mounts: [mount] } }));
  const link = btn('查看创建的 Worker W28'); expect(link).toBeTruthy(); expect(link.getAttribute('data-preview-worker')).toBe('109');
  expect(link.classList.contains('agent-call')).toBe(false); expect(btn('查看创建的 Worker W8')).toBeUndefined(); expect(deepText(root())).toContain(status === 'succeeded' ? '不代表 Agent 工作完成' : '未知结果不自动重试');
});

test('legacy missing command-kind fields validate only Shell; malformed kinds and null records fail closed', () => {
  catalogue.commands.items = [{ id: uuid(1), name: '旧 Shell', command: 'printf old', version: 1, authorized: true }];
  expect(validCommands(catalogue.commands)).toBe(true);
  for (const kind of ['unknown', null]) expect(validCommands({ ...catalogue.commands, items: [{ ...catalogue.commands.items[0], kind }] })).toBe(false);
  expect(validCommands({ ...catalogue.commands, items: [null] })).toBe(false);
});

test('Hook alternatives prevent Shell/prompt mixing and multiple creation actions, without excluding compatible notify or Shell combinations', async () => {
  catalogue.actions.push({ type: 'create_worker', label: '预约创建 Worker', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true });
  const form = createHookForm(catalogue, { initial: hook() }); await btn('添加动作', form.node).onclick();
  const types = form.node.querySelectorAll('[aria-label="动作类型"]'), active = input => input.children.filter(option => !option.disabled).map(option => option.value);
  expect(active(types[1])).toEqual(['notify']); expect(types[1].value).toBe('notify'); expect(active(types[0])).toContain('create_worker');
  types[0].value = 'command'; types[0].onchange(); expect(active(types[1])).toContain('command'); expect(active(types[1])).toContain('create_worker'); expect(active(types[1])).not.toContain('prompt_command');
  types[1].value = 'create_worker'; types[1].onchange(); expect(active(types[0])).not.toContain('prompt_command'); expect(active(types[0])).not.toContain('create_worker');
  const shellAction = { type: 'command', command_id: uuid(1), command_version: 2 }, shells = createHookForm(catalogue, { initial: { ...hook(), actions: [shellAction, shellAction] } });
  expect(shells.validate()).toBe(''); expect(shells.collect().actions).toEqual([shellAction, shellAction].map(({ command_version, ...action }) => action));
});

test('invalid existing Shell/prompt combinations retain exact references and refuse save until explicitly corrected', () => {
  const shellAction = { type: 'command', command_id: uuid(1), command_version: 2 }, initial = { ...hook(), actions: [shellAction, hook().actions[0]] }, form = createHookForm(catalogue, { initial });
  expect(form.collect().actions).toEqual(initial.actions.map(({ command_version, ...action }) => action)); expect(deepText(form.node)).toContain('不能混合 Shell 指令与提示词指令'); expect(form.validate()).toContain('不能混合');
  const types = form.node.querySelectorAll('[aria-label="动作类型"]'); for (const type of types) expect(type.children.find(option => option.value === type.value).disabled).toBe(true);
  types[1].value = 'notify'; types[1].onchange(); const row = form.node.querySelectorAll('.hook-action')[1]; field('告知标题', row).value = '完成'; field('消息或告知正文', row).value = '审查结束';
  expect(form.validate()).toBe(''); expect(form.collect().actions[0]).toEqual({ type: 'command', command_id: uuid(1) });
});

for (const creationTypes of [['prompt_command', 'prompt_command'], ['create_worker', 'prompt_command'], ['create_worker', 'create_worker']]) test(`creation limit diagnoses ${creationTypes.join('+')} and preserves source drafts`, async () => {
  catalogue.actions.push({ type: 'create_worker', label: '预约创建 Worker', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true });
  const actions = creationTypes.map((type, index) => type === 'prompt_command' ? hook().actions[0] : { type, content: `保留创建正文 ${index}`, start: true });
  const form = createHookForm(catalogue, { initial: { ...hook(), actions } });
  expect(form.collect().actions).toEqual(actions.map(({ command_version, ...action }) => action.type === 'create_worker' ? { ...action, references: [] } : action));
  expect(form.validate()).toContain('合计最多一个'); expect(form.node.querySelector('.hook-combination-note').classList.contains('error')).toBe(true);
  await btn('移除动作', form.node.querySelectorAll('.hook-action')[1]).onclick(); expect(form.validate()).toBe('');
  if (creationTypes[0] === 'create_worker') expect(field('新 Worker 指令', form.node).value).toBe('保留创建正文 0');
});

test('creation-only catalogue disables Add with accessible diagnosis instead of adding a duplicate prompt', async () => {
  catalogue.actions = catalogue.actions.filter(action => action.type === 'prompt_command'); const form = createHookForm(catalogue, { initial: hook() }), add = btn('添加动作', form.node);
  expect(add.disabled).toBe(true); expect(add.parentNode.tabIndex).toBe(0); expect(add.parentNode.getAttribute('data-help')).toContain('合计最多一个');
  await add.onclick(); expect(form.node.querySelectorAll('.hook-action')).toHaveLength(1); expect(add.disabled).toBe(true);
  await btn('移除动作', form.node).onclick(); expect(add.disabled).toBe(false); await add.onclick(); expect(form.node.querySelectorAll('.hook-action')).toHaveLength(1); expect(add.disabled).toBe(true);
});

test('read-only command metadata wraps on narrow screens', () => {
  const css = readFileSync(new URL('../../src/ui/web/assets/styles-hooks.css', import.meta.url), 'utf8');
  expect(css).toContain('.shortcut-command-metadata { white-space: pre-wrap; overflow-wrap: anywhere; }');
});
