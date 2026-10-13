import { test, expect, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const failure = message => ({ ok: false, json: async () => ({ error: message }) });
const uuid = n => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const shell = () => ({ id: uuid(1), name: '测试 Shell', kind: 'shell', command: 'printf "<script>literal</script>"', version: 2, authorized: true,
  description: '执行模块测试', when_to_use: '修改完成后', tags: ['验证', '单元测试'], examples: '手动选择工作目录', warnings: '会修改文件', default_worker_id: 42, last_execution: null });
const prompt = () => ({ id: uuid(2), name: '审查提示词', kind: 'prompt', prompt: '检查代码 <img src=x onerror=alert(1)>', version: 3, authorized: true,
  description: '检查代码质量', when_to_use: '准备交付', tags: ['质量', 'review'], examples: '在 order 下审查', warnings: '可能产生费用', default_worker_id: null, last_execution: null });
const hook = () => ({ id: uuid(8), name: '一次性审查', trigger: 'worker.parent_ready', mode: 'once', enabled: false,
  actions: [{ type: 'prompt_command', command_id: uuid(2), command_version: 3 }] });
const execution = (patch = {}) => ({ id: uuid(10), event_id: 100, command_name: '审查提示词', command_version: 3, kind: 'prompt', worker_id: 42, worker_number: 'W8',
  source: 'manual', status: 'pending', created_at: '2026-10-12T00:00:00Z', ...patch });
const page = items => ({ version: 1, items, has_more: false, next_before: null });
let catalogue, calls, reads, history, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) calls.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.includes('/api/hooks/commands/export')) return json({ filename: 'review-SKILL.md', markdown: '# 审查\n<script>literal</script>' });
  if (path.includes('/api/hooks/commands/executions')) return json(page(history));
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (body?.method === 'hooks.command_save') {
    const definition = body.params.command, old = catalogue.commands.items.find(item => item.id === definition.id);
    const saved = { ...definition, id: old?.id || uuid(4), version: old ? old.version + 1 : 1, authorized: false, last_execution: null };
    catalogue.commands = { version: 1, revision: 'saved', items: old ? catalogue.commands.items.map(item => item.id === old.id ? saved : item) : [...catalogue.commands.items, saved] }; return json(catalogue);
  }
  if (body?.method === 'hooks.command_authorize') { catalogue.commands.revision = 'authorized'; catalogue.commands.items = catalogue.commands.items.map(item => item.id === body.params.id ? { ...item, authorized: body.params.authorized } : item); return json(catalogue); }
  if (body?.method === 'worker.hook_update') { catalogue.command_example.hooks.mounts[0].enabled = body.params.enabled; return json(catalogue.command_example.hooks); }
  throw new Error(`Unexpected ${path} ${body?.method}`);
} });
const { openHookTools: openHooks, workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { openProjectAutomation } = await import('../../src/ui/web/assets/render-project-automation.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { validCommands, commandReferencesIssue } = await import('../../src/ui/web/assets/shortcut-command-model.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const root = () => dom.node('detail');
const manager = () => root().querySelector('.shortcut-command-management');
const runs = () => root().querySelector('.shortcut-run-module');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const field = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const pick = async (name, node = manager()) => { if (node.querySelector('.shortcut-command-detail-page')?.hidden === false) await btn('返回指令列表', node).onclick(); await node.querySelectorAll('.shortcut-directory-pick').find(item => deepText(item).includes(name)).onclick(); };
const submitSearch = input => input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
async function ready() { await openHooks({ subpage: 'commands' }); await pick(catalogue.commands.items[0].name); }
beforeEach(() => {
  ui.hooksPage?.shortcutNode?.dispose?.(); closeDialog(); calls = []; reads = []; history = []; intercept = null; ui.hooksPage = null; dom.location.pathname = '/'; activateDetailView({ view: 'overview' });
  catalogue = { version: 1, revision: 'hooks-r1', commands: { version: 1, revision: 'commands-r1', items: [shell(), prompt()] },
    triggers: [{ id: 'worker.parent_ready', label: '父 Worker 可创建' }, { id: 'agent.returned', label: 'Agent 返回' }],
    actions: [{ type: 'command', label: 'Shell 指令', triggers: ['worker.parent_ready', 'agent.returned'], modes: ['once', 'persistent'], agent_call: false },
      { type: 'prompt_command', label: '提示词指令', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true }, { type: 'notify', label: '告知', modes: ['once', 'persistent'], agent_call: false }],
    templates: [], command_example: null };
});
afterAll(() => { ui.hooksPage?.shortcutNode?.dispose?.(); closeDialog(); dom.restore(); });

test('compact directory and separate single detail render safe metadata without a run module', async () => {
  await ready(); expect(manager().querySelectorAll('.shortcut-command')).toHaveLength(1); expect(runs()).toBeNull();
  expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(2);
  expect(deepText(manager())).toContain('调用场景：修改完成后'); expect(deepText(manager())).toContain('标签：验证、单元测试');
  await pick('审查提示词'); expect(manager().querySelectorAll('.shortcut-command')).toHaveLength(1);
  expect(deepText(manager())).toContain('风险：可能产生费用'); expect(deepText(manager())).toContain('<img src=x onerror=alert(1)>');
  expect(manager().querySelector('img')).toBeNull(); expect(manager().querySelector('.shortcut-directory').parentNode.hidden).toBe(true);
});

test('searches name, description, when_to_use and tags only when submitted; filters do not apply draft terms', async () => {
  await ready(); const input = field('查找管理指令'), type = field('查找管理指令类型');
  input.value = '没有'; type.value = 'prompt'; type.onchange(); expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(1);
  expect(deepText(manager().querySelector('.shortcut-directory'))).toContain('审查提示词');
  submitSearch(input); expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(0); expect(deepText(manager())).toContain('没有匹配');
  type.value = ''; type.onchange();
  for (const query of ['测试 Shell', '执行模块测试', '修改完成后', '单元测试']) { input.value = query; submitSearch(input); expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(1); }
  const authorization = field('查找管理指令授权'); authorization.value = 'no'; authorization.onchange(); expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(0);
  await btn('清空', manager().querySelector('.shortcut-directory')).onclick(); expect(authorization.value).toBe('no'); expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(0);
  authorization.value = ''; authorization.onchange(); expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(2); expect(calls).toHaveLength(0);
});

test('IME candidate confirmation never submits directory search', async () => {
  await ready();
  for (const label of ['查找管理指令']) {
    const input = field(label), directory = manager().querySelector('.shortcut-directory');
    input.value = '没有'; input.listeners.compositionstart[0](); submitSearch(input);
    expect(directory.querySelectorAll('.shortcut-directory-entry')).toHaveLength(2);
    input.listeners.compositionend[0](); input.listeners.keydown[0]({ key: 'Enter', isComposing: true, preventDefault() {} });
    expect(directory.querySelectorAll('.shortcut-directory-entry')).toHaveLength(2);
    input.listeners.keydown[0]({ key: 'Enter', keyCode: 229, preventDefault() {} }); expect(directory.querySelectorAll('.shortcut-directory-entry')).toHaveLength(2);
  }
});

test('modern metadata and prompt save submit only matching body, create unauthed version and never call Agent', async () => {
  await ready(); await pick('审查提示词'); await btn('编辑快捷指令').onclick();
  field('作用说明').value = '新的作用'; field('调用场景').value = '在发布前'; field('标签（每行一个）').value = '审查\n发布'; field('调用示例').value = 'main 下创建'; field('风险提醒').value = '<script>花费</script>';
  field('提示词正文', manager()).value = '检查\n代码'; expect(btn('保存快捷指令').classList.contains('agent-call')).toBe(false);
  await btn('保存快捷指令').onclick();
  expect(calls).toEqual([{ method: 'hooks.command_save', params: { expected_revision: 'commands-r1', command: { id: uuid(2), name: '审查提示词', kind: 'prompt', prompt: '检查\n代码',
    description: '新的作用', when_to_use: '在发布前', tags: ['审查', '发布'], examples: 'main 下创建', warnings: '<script>花费</script>' } } }]);
  expect(catalogue.commands.items[1]).toMatchObject({ version: 4, authorized: false }); expect(manager().querySelector('.shortcut-command').dataset.commandId).toBe(uuid(2)); expect(root().querySelector('script')).toBeNull();
});

const textLimits = [['快捷指令名称', 120], ['提示词正文', 16000], ['作用说明', 2000], ['调用场景', 4000], ['调用示例', 8000], ['风险提醒', 4000]];
for (const [label, limit] of textLimits) test(`${label} enforces ${limit} characters and rejects NUL without submitting or discarding the draft`, async () => {
  await ready(); await pick('审查提示词'); await btn('编辑快捷指令').onclick();
  const input = field(label, manager()); expect(input.maxLength).toBe(limit);
  for (const invalid of ['x'.repeat(limit + 1), 'invalid\0text']) {
    input.value = invalid; await btn('保存快捷指令').onclick();
    expect(calls).toHaveLength(0); expect(input.value).toBe(invalid); expect(input.disabled).toBe(false);
    expect(deepText(manager().querySelector('.shortcut-command-editor'))).toContain('草稿已保留');
    expect(deepText(manager().querySelector('.shortcut-command-editor'))).toContain(label);
  }
  input.value = 'x'.repeat(limit); await btn('保存快捷指令').onclick(); expect(calls).toHaveLength(1);
});

test('Shell body has the same 16000/NUL validation, including legacy service saves', async () => {
  catalogue.actions = catalogue.actions.filter(item => item.type !== 'prompt_command'); catalogue.commands.items = [{ id: uuid(1), name: '旧 Shell', command: 'echo old', version: 1, authorized: true }];
  await ready(); await btn('编辑快捷指令').onclick(); const input = field('Shell 命令'); expect(input.maxLength).toBe(16000);
  for (const invalid of ['x'.repeat(16001), 'echo\0bad']) { input.value = invalid; await btn('保存快捷指令').onclick(); expect(calls).toHaveLength(0); expect(input.value).toBe(invalid); }
  input.value = 'x'.repeat(16000); await btn('保存快捷指令').onclick(); expect(calls[0].params.command.command).toHaveLength(16000);
});

test('tag count, per-tag length and NUL checks preserve the multiline draft; exact boundary and ignored blank lines save', async () => {
  await ready(); await pick('审查提示词'); await btn('编辑快捷指令').onclick(); const input = field('标签（每行一个）'); expect(input.maxLength).toBe(32 * 81 - 1);
  for (const invalid of [Array(33).fill('tag').join('\n'), 'x'.repeat(81), 'tag\0bad']) {
    input.value = invalid; await btn('保存快捷指令').onclick(); expect(calls).toHaveLength(0); expect(input.value).toBe(invalid);
    expect(deepText(manager().querySelector('.shortcut-command-editor'))).toContain('标签最多 32 个，每个最多 80 字符');
  }
  input.value = Array.from({ length: 32 }, (_value, index) => `${index}`.padEnd(80, 'x')).join('\n');
  const tags = input.value.split('\n'); await btn('保存快捷指令').onclick(); expect(calls[0].params.command.tags).toEqual(tags);
  await btn('编辑快捷指令').onclick(); field('标签（每行一个）').value = '  tag A  \n\n   \n tag B \n'; await btn('保存快捷指令').onclick(); expect(calls[1].params.command.tags).toEqual(['tag A', 'tag B']);
});

test('changing type preserves each local body draft but saves only the new type body', async () => {
  await ready(); await btn('编辑快捷指令').onclick();
  field('Shell 命令').value = 'printf preserved'; const type = field('指令类型'); type.value = 'prompt'; type.onchange();
  field('提示词正文', manager()).value = 'prompt preserved'; type.value = 'shell'; type.onchange(); expect(field('Shell 命令').value).toBe('printf preserved');
  type.value = 'prompt'; type.onchange(); expect(field('提示词正文', manager()).value).toBe('prompt preserved');
  expect(field('默认父 Worker')).toBeNull(); await btn('保存快捷指令').onclick();
  expect(calls[0].params.command).toMatchObject({ id: uuid(1), kind: 'prompt', prompt: 'prompt preserved' }); expect(calls[0].params.command).not.toHaveProperty('command');
});

test('explicit refresh, list return, subpages and unrelated revisions retain selection, searches and original draft revision', async () => {
  await ready(); await pick('审查提示词'); const search = field('查找管理指令'); search.value = '质量'; submitSearch(search);
  await btn('编辑快捷指令').onclick(); const draft = field('提示词正文', manager()); draft.value = '保留草稿'; search.value = '未提交的词';
  await btn('返回指令列表').onclick(); catalogue.commands.revision = 'concurrent';
  await btn('刷新目录').onclick(); expect(field('查找管理指令')).toBe(search); expect(search.value).toBe('未提交的词'); expect(field('提示词正文', manager())).toBe(draft);
  expect(manager().querySelector('.shortcut-command-detail-page').hidden).toBe(true); expect(manager().querySelectorAll('.shortcut-directory-entry')).toHaveLength(1);
  await openHooks({ subpage: 'history' }); await openHooks({ subpage: 'commands' }); await btn('继续指令编辑').onclick(); expect(draft.value).toBe('保留草稿');
  intercept = (_path, body) => body?.method === 'hooks.command_save' ? failure('revision conflict') : null;
  await btn('保存快捷指令').onclick(); expect(calls[0].params.expected_revision).toBe('commands-r1'); expect(draft.value).toBe('保留草稿'); expect(draft.disabled).toBe(false);
  expect(deepText(manager().querySelector('.shortcut-directory'))).not.toContain('测试 Shell'); expect(calls).toHaveLength(1);
});

test('authorization pins the displayed prompt version and explains future costs without purple or immediate Agent call', async () => {
  catalogue.commands.items[1].authorized = false; await ready(); await pick('审查提示词');
  const authorizing = btn('授权当前版本').onclick(); expect(deepText(dom.node('modal'))).toContain('Hook 触发后'); expect(deepText(dom.node('modal'))).toContain('token');
  expect(dialogButton(dom, '授权此版本').classList.contains('agent-call')).toBe(false); expect(calls).toHaveLength(0);
  await dialogButton(dom, '授权此版本').onclick(); await authorizing;
  expect(calls[0]).toEqual({ method: 'hooks.command_authorize', params: { id: uuid(2), version: 3, authorized: true, expected_revision: 'commands-r1' } });
});


test('created prompt history links real Worker and O input, distinguishes creation success from Agent completion', async () => {
  history = [execution({ status: 'succeeded', created_worker_id: 109, created_worker_number: 'W28', input_id: 87, command_result: { stdout: 'SECRET' } })];
  await openHooks({ subpage: 'history' }); await until(() => root().querySelector('.shortcut-execution')); expect(deepText(root())).toContain('不是 Agent 工作完成'); expect(root().querySelectorAll('a').find(link => link.href === '#worker-109').textContent).toContain('W28');
  expect(deepText(root())).toContain('O87'); expect(deepText(root())).not.toContain('退出码'); expect(deepText(root())).not.toContain('SECRET');
});

test('no manual Shell or prompt entry, hidden worker picker, or execution request survives', async () => {
  await ready(); await pick('审查提示词'); await btn('编辑快捷指令').onclick();
  for (const label of ['创建并启动 Agent', '手动执行', '确认创建并启动', '确认执行一次']) expect(btn(label)).toBeUndefined();
  for (const label of ['默认父 Worker', '默认执行目录 Worker', '提示词父 Worker', '执行目录 Worker']) expect(field(label)).toBeNull();
  expect(reads.some(path => path.includes('input-parents') || path.includes('snapshot'))).toBe(false); expect(calls).toHaveLength(0);
});

test('export reads exact version, safely previews text and only offers download, no installation or mutation', async () => {
  await ready(); await pick('审查提示词'); await btn('导出 Markdown').onclick();
  expect(reads.at(-1)).toContain(`/api/hooks/commands/export?id=${uuid(2)}&version=3`); expect(deepText(manager())).toContain('<script>literal</script>'); expect(root().querySelector('script')).toBeNull();
  const link = manager().querySelector('a'); expect(link.download).toBe('review-SKILL.md'); expect(link.href).toStartWith('data:text/markdown'); expect(calls).toHaveLength(0);
  intercept = path => path.includes('/commands/export') ? failure('not found') : null; await btn('导出 Markdown').onclick(); expect(dom.node('error').textContent).toContain('不自动回退'); expect(calls).toHaveLength(0);
});

test('late export response cannot replace another selected command or an edit draft', async () => {
  await ready(); let resolve; intercept = path => path.includes('/commands/export') ? new Promise(done => { resolve = done; }) : null;
  const exporting = btn('导出 Markdown').onclick(); await until(() => resolve); await pick('审查提示词'); await btn('编辑快捷指令').onclick();
  const draft = field('提示词正文', manager()); draft.value = '编辑中'; resolve(json({ filename: 'late.md', markdown: 'LATE' })); await exporting;
  expect(field('提示词正文', manager())).toBe(draft); expect(draft.value).toBe('编辑中'); expect(deepText(manager())).not.toContain('LATE');
});

test('Hook type filters Shell and prompt versions separately, enforces once/parent_ready and retains stale reference', () => {
  const form = createHookForm(catalogue, { initial: hook() }), versions = field('快捷指令版本', form.node);
  expect(versions.children.map(item => item.value)).toEqual(['', `${uuid(2)}:3`]); expect(field('挂载方式', form.node).children.map(item => item.value)).toEqual(['once']);
  expect(form.agentCall()).toBe(true); expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual(hook().actions);
  const type = field('动作类型', form.node); type.value = 'command'; type.onchange(); expect(versions.children.some(item => item.value === `${uuid(1)}:2`)).toBe(true); expect(form.validate()).toContain('类型不匹配');
  versions.value = `${uuid(1)}:2`; expect(form.validate()).toBe(''); expect(form.agentCall()).toBe(false);
  field('触发节点', form.node).value = 'agent.returned'; field('触发节点', form.node).onchange(); expect(type.children.some(item => item.value === 'prompt_command')).toBe(false);
  const stale = createHookForm(catalogue, { initial: { ...hook(), actions: [{ type: 'prompt_command', command_id: uuid(2), command_version: 2 }] } });
  expect(field('快捷指令版本', stale.node).value).toBe(`${uuid(2)}:2`); expect(field('快捷指令版本', stale.node).children.at(-1).disabled).toBe(true); expect(stale.validate()).toContain('请选择当前已注册');
  expect(commandReferencesIssue({ ...hook(), mode: 'persistent' }, catalogue)).toContain('一次性');
  const child = createHookForm(catalogue, { workerId: 44, workerTaskKind: 'child' });
  expect(field('动作类型', child.node).children.some(item => item.value === 'prompt_command')).toBe(false);
});

test('prompt Hook enable is purple with future cost confirmation, Shell-only hooks remain non-Agent', async () => {
  const mount = { ...hook(), editable: true, removable: true, state: 'idle', last_execution: null };
  catalogue.command_example = { worker_id: 1, hook_id: mount.id, hooks: { version: 1, worker_id: 1, revision: 'mount-r1', mounts: [mount] } };
  await openProjectAutomation({ feature: 'push' }); const enable = btn('启用 Hook', root().querySelector('.command-hook-example'));
  expect(enable.classList.contains('agent-call')).toBe(true); expect(enable.getAttribute('data-help')).toContain('token');
  const enabling = enable.onclick(); expect(dialogButton(dom, '启用指令 Hook').classList.contains('agent-call')).toBe(true);
  await dialogButton(dom, '启用指令 Hook').onclick(); await until(() => dialogButton(dom, '授权并挂载')); await dialogButton(dom, '授权并挂载').onclick(); await enabling;
  expect(calls).toHaveLength(1); expect(calls[0].params).toMatchObject({ id: 1, enabled: true, expected_revision: 'mount-r1' });
});

test('Hook receipt uses the created identity, never labels the prompt parent as created Worker', () => {
  const mount = { ...hook(), editable: true, removable: true, state: 'succeeded', last_execution: execution({ status: 'succeeded', created_worker_id: 109, created_worker_number: 'W28', command_result: { status: 'succeeded', exit_code: 0 } }) };
  ui.hookCatalogue = catalogue; activateDetailView({ view: 'task', key: 'task-42' });
  root().replaceChildren(workerHooks({ id: 42, task_kind: 'order', status: 'waiting', hooks: { version: 1, worker_id: 42, revision: 'r1', mounts: [mount] } }));
  expect(deepText(root())).toContain('不代表 Agent 工作完成'); expect(btn('查看创建的 Worker W28')).toBeTruthy(); expect(btn('查看创建的 Worker W8')).toBeUndefined(); expect(deepText(root())).not.toContain('退出码');
  mount.last_execution.created_worker_id = null;
  root().replaceChildren(workerHooks({ id: 42, task_kind: 'order', status: 'waiting', hooks: { version: 1, worker_id: 42, revision: 'r2', mounts: [mount] } }));
  expect(btn('查看创建的 Worker W8')).toBeUndefined(); expect(btn('查看创建的 Worker W28')).toBeUndefined();
});

for (const status of ['succeeded', 'failed']) test(`runtime prompt Hook receipt (${status}) links its created Worker with the action receipt fields`, () => {
  // Project.recordHookAction stores the child identity here, unlike command history.
  const mount = { ...hook(), editable: true, removable: true, state: status,
    last_execution: { id: uuid(10), trigger: 'worker.parent_ready', status, worker_id: 109, worker_number: 'W28', input_id: 87 } };
  ui.hookCatalogue = catalogue; activateDetailView({ view: 'task', key: 'task-42' });
  root().replaceChildren(workerHooks({ id: 42, task_kind: 'order', status: 'waiting', hooks: { version: 1, worker_id: 42, revision: 'r1', mounts: [mount] } }));
  const link = btn('查看创建的 Worker W28'); expect(link).toBeTruthy(); expect(link.getAttribute('data-preview-worker')).toBe('109');
  expect(link.classList.contains('agent-call')).toBe(false); expect(btn('查看创建的 Worker W8')).toBeUndefined();
  expect(deepText(root())).toContain(status === 'succeeded' ? '不代表 Agent 工作完成' : '未知结果不自动重试');
});

test('legacy missing new fields validates as Shell only and never offers prompt editing', async () => {
  catalogue.commands.items = [{ id: uuid(1), name: '旧 Shell', command: 'printf old', version: 1, authorized: true }]; catalogue.actions = catalogue.actions.filter(item => item.type !== 'prompt_command');
  expect(validCommands(catalogue.commands)).toBe(true);
  for (const kind of ['unknown', null]) expect(validCommands({ ...catalogue.commands, items: [{ ...catalogue.commands.items[0], kind }] })).toBe(false);
  expect(validCommands({ ...catalogue.commands, items: [null] })).toBe(false);
  await ready(); await btn('编辑快捷指令').onclick(); expect(field('指令类型').children.map(item => item.value)).toEqual(['shell']); expect(deepText(manager())).toContain('旧后台仅支持 Shell');
});

test('refresh can upgrade a legacy read surface to prompt support without losing a legacy draft', async () => {
  const modern = structuredClone(catalogue);
  catalogue.actions = catalogue.actions.filter(item => item.type !== 'prompt_command'); catalogue.commands.items = [{ id: uuid(1), name: '旧指令', command: 'echo old', version: 1, authorized: true }];
  await ready(); await btn('编辑快捷指令').onclick(); const draft = field('Shell 命令'); draft.value = 'preserved'; catalogue = modern;
  await btn('刷新目录').onclick(); expect(field('Shell 命令')).toBe(draft); expect(draft.value).toBe('preserved'); expect(field('指令类型').children.map(item => item.value)).toEqual(['shell']);
  await btn('取消指令编辑').onclick(); await pick('审查提示词'); await btn('编辑快捷指令').onclick(); expect(field('指令类型').children.map(item => item.value)).toEqual(['shell', 'prompt']);
});

test('Hook alternatives prevent Shell/prompt mixing and multiple creation actions, without excluding compatible notify or Shell combinations', async () => {
  catalogue.actions.push({ type: 'create_worker', label: '预约创建 Worker', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true });
  const form = createHookForm(catalogue, { initial: hook() }); await btn('添加动作', form.node).onclick();
  const types = form.node.querySelectorAll('[aria-label="动作类型"]'), active = input => input.children.filter(option => !option.disabled).map(option => option.value);
  expect(active(types[1])).toEqual(['notify']); expect(types[1].value).toBe('notify');
  expect(active(types[0])).toContain('create_worker'); // Replacement of the sole creator is legitimate.
  types[0].value = 'command'; types[0].onchange();
  expect(active(types[1])).toContain('command'); expect(active(types[1])).toContain('create_worker'); expect(active(types[1])).not.toContain('prompt_command');
  types[1].value = 'create_worker'; types[1].onchange(); expect(active(types[0])).not.toContain('prompt_command'); expect(active(types[0])).not.toContain('create_worker');
  const shellAction = { type: 'command', command_id: uuid(1), command_version: 2 };
  const shells = createHookForm(catalogue, { initial: { ...hook(), actions: [shellAction, shellAction] } }); expect(shells.validate()).toBe(''); expect(shells.collect().actions).toEqual([shellAction, shellAction]);
});

test('invalid existing Shell/prompt combinations retain exact references, show immediate diagnosis and refuse save until explicitly corrected', () => {
  const shellAction = { type: 'command', command_id: uuid(1), command_version: 2 };
  const initial = { ...hook(), actions: [shellAction, hook().actions[0]] }, form = createHookForm(catalogue, { initial });
  expect(form.collect().actions).toEqual(initial.actions); expect(deepText(form.node)).toContain('不能混合 Shell 指令与提示词指令');
  expect(form.validate()).toContain('不能混合');
  const types = form.node.querySelectorAll('[aria-label="动作类型"]');
  for (const type of types) expect(type.children.find(option => option.value === type.value).disabled).toBe(true);
  types[1].value = 'notify'; types[1].onchange(); const row = form.node.querySelectorAll('.hook-action')[1];
  field('告知标题', row).value = '完成'; field('消息或告知正文', row).value = '审查结束';
  expect(form.validate()).toBe(''); expect(form.collect().actions[0]).toEqual(shellAction);
});

for (const creationTypes of [['prompt_command', 'prompt_command'], ['create_worker', 'prompt_command'], ['create_worker', 'create_worker']]) test(`creation limit diagnoses ${creationTypes.join('+')} and preserves source drafts`, async () => {
  catalogue.actions.push({ type: 'create_worker', label: '预约创建 Worker', triggers: ['worker.parent_ready'], modes: ['once'], agent_call: true });
  const actions = creationTypes.map((type, index) => type === 'prompt_command' ? hook().actions[0] : { type, content: `保留创建正文 ${index}`, start: true });
  const form = createHookForm(catalogue, { initial: { ...hook(), actions } });
  expect(form.collect().actions).toEqual(actions.map(action => action.type === 'create_worker' ? { ...action, references: [] } : action));
  expect(form.validate()).toContain('合计最多一个'); expect(form.node.querySelector('.hook-combination-note').classList.contains('error')).toBe(true);
  await btn('移除动作', form.node.querySelectorAll('.hook-action')[1]).onclick(); expect(form.validate()).toBe('');
  if (creationTypes[0] === 'create_worker') expect(field('新 Worker 指令', form.node).value).toBe('保留创建正文 0');
});

test('creation-only catalogue disables Add with accessible diagnosis instead of adding a duplicate prompt', async () => {
  catalogue.actions = catalogue.actions.filter(action => action.type === 'prompt_command');
  const form = createHookForm(catalogue, { initial: hook() }), add = btn('添加动作', form.node);
  expect(add.disabled).toBe(true); expect(add.parentNode.tabIndex).toBe(0); expect(add.parentNode.getAttribute('data-help')).toContain('合计最多一个');
  await add.onclick(); expect(form.node.querySelectorAll('.hook-action')).toHaveLength(1); expect(add.disabled).toBe(true);
  await btn('移除动作', form.node).onclick(); expect(add.disabled).toBe(false);
  await add.onclick(); expect(form.node.querySelectorAll('.hook-action')).toHaveLength(1); expect(add.disabled).toBe(true);
});

test('narrow-screen directory rules wrap long names and metadata, with one-column filters', () => {
  const css = readFileSync(new URL('../../src/ui/web/assets/styles-hooks.css', import.meta.url), 'utf8');
  expect(css).toContain('.shortcut-directory-pick { text-align: left; white-space: normal; overflow-wrap: anywhere; max-width: 100%; }');
  expect(css).toContain('.shortcut-command-metadata { white-space: pre-wrap; overflow-wrap: anywhere; }');
  expect(css).toContain('@media (max-width: 600px) { .shortcut-directory-filters { display: grid; grid-template-columns: minmax(0, 1fr); }');
});
