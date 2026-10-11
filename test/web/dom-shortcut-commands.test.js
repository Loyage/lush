import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => ({ ok: true, json: async () => structuredClone(value) });
const failure = message => ({ ok: false, json: async () => ({ error: message }) });
const push = () => ({ id: 'push-command', name: '推送', command: 'git push', version: 1, authorized: false, last_execution: null });
const hook = () => ({ id: 'main-push', name: '合并后推送', trigger: 'worker.merge_received', enabled: false, mode: 'persistent',
  editable: true, removable: true, builtin: false, conditions: {}, state: 'idle', last_execution: null,
  actions: [{ type: 'command', command_id: 'push-command', command_version: 1 }] });
const executionId = 'c8c8c8c8-0000-4000-8000-000000000001';
const execution = (patch = {}) => ({ event_id: 100, id: executionId, command_id: 'push-command', command_name: '推送', command_version: 1,
  worker_id: 42, worker_number: 'W8', source: 'manual', status: 'succeeded', created_at: '2026-10-09T00:00:00Z', finished_at: '2026-10-09T00:00:40Z', command_result: { status: 'succeeded', exit_code: 0 }, ...patch });
const historyPage = (items = []) => ({ version: 1, items, has_more: false, next_before: null });
let catalogue, calls, reads, history, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) calls.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.includes('/api/hooks/commands/executions')) return json(historyPage(history));
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (path.endsWith('/api/snapshot')) return json({ tasks: [{ id: 44, branch: 'child', task_kind: 'child', status: 'waiting', worker_number: 'W8-1' }] });
  if (path.endsWith('/api/input-parents')) return json({ items: [{ id: 1, branch: 'main', worker_number: null },
    { id: 42, branch: 'work', worker_number: 'W8' }, { id: 43, branch: 'frozen', worker_number: 'W9', freeze: {} }] });
  if (body?.method === 'hooks.command_save') {
    const definition = body.params.command, old = catalogue.commands.items.find(item => item.id === definition.id);
    const item = { ...definition, id: definition.id || 'new-command', version: old ? old.version + 1 : 1, authorized: false, last_execution: old?.last_execution || null };
    catalogue.commands = { ...catalogue.commands, revision: 'commands-next', items: old ? catalogue.commands.items.map(entry => entry.id === item.id ? item : entry) : [...catalogue.commands.items, item] };
    return json(catalogue);
  }
  if (body?.method === 'hooks.command_authorize') {
    catalogue.commands = { ...catalogue.commands, revision: 'authorization-next', items: catalogue.commands.items.map(item => item.id === body.params.id ? { ...item, authorized: body.params.authorized } : item) };
    return json(catalogue);
  }
  if (body?.method === 'hooks.command_remove') { catalogue.commands.items = []; catalogue.commands.revision = 'removed'; return json(catalogue); }
  if (body?.method === 'hooks.command_start') { history = [execution()]; return json({ execution_id: executionId, execution: history[0], commands: { ...catalogue.commands, revision: 'manual-next' } }); }
  if (body?.method === 'hooks.command_import') {
    const target = body.params.source.template_id ? catalogue.templates[0] : catalogue.command_example.hooks.mounts[0];
    target.actions = hook().actions; target.enabled = false;
    return json({ ...catalogue, imported_command_ids: ['push-command'], worker_hooks: catalogue.command_example.hooks });
  }
  if (body?.method === 'worker.hook_update') {
    catalogue.commands.revision = 'external-revision'; return json(catalogue.command_example.hooks);
  }
  throw new Error(`Unexpected request ${path} ${body?.method || ''}`);
} });
const { openHooks, workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const section = () => root().querySelector('.shortcut-commands');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const field = (label, node = root()) => node.querySelector(`[aria-label="${label}"]`);
const mainExample = () => root().querySelector('.command-hook-example');
async function openRun() { await until(() => btn('手动执行') && !btn('手动执行').disabled); await btn('手动执行').onclick(); }
beforeEach(() => {
  closeDialog(); ui.hooksPage?.shortcutNode?.dispose?.(); calls = []; reads = []; history = []; intercept = null; dom.location.pathname = '/'; ui.hooksPage = null;
  const mounted = hook();
  catalogue = { version: 1, revision: 'templates-revision', triggers: [{ id: 'worker.merge_received', label: '收到合并' }],
    actions: [{ type: 'command', label: '快捷指令', description: '引用授权版本', modes: ['once', 'persistent'], triggers: ['worker.merge_received'], agent_call: false }],
    templates: [{ ...hook(), id: 'push-template' }], commands: { version: 1, revision: 'commands-revision', items: [push()] },
    command_example: { worker_id: 1, hook_id: mounted.id, template_id: 'push-template', hooks: { version: 1, worker_id: 1, can_attach: true, revision: 'main-revision', mounts: [mounted] } },
    daemon_hooks: { version: 1, revision: 'daemon-revision', mounts: [{ id: 'auto-select', enabled: true, editable: true }] } };
  activateDetailView({ view: 'overview' });
});
afterAll(() => { ui.hooksPage?.shortcutNode?.dispose?.(); closeDialog(); dom.restore(); });

test('page subtitle and separate commands: opening does not authorize or run, unauthorized controls explain denial', async () => {
  await openHooks(); await until(() => section().querySelector('.shortcut-execution-records').children.length); expect(root().querySelector('.hooks-page-subtitle').textContent).toBe('快捷指令和 Hook');
  expect(dom.node('view-hint').textContent).toBe('快捷指令和 Hook');
  expect(deepText(section())).toContain('不是沙箱'); expect(deepText(section())).toContain('daemon 用户权限');
  expect(btn('手动执行', section()).disabled).toBe(true); expect(btn('手动执行', section()).parentNode.getAttribute('data-help')).toContain('未授权');
  expect(btn('启用 Hook', mainExample()).disabled).toBe(true);
  await btn('手动执行', section()).onclick(); await btn('启用 Hook', mainExample()).onclick();
  expect(calls).toHaveLength(0);
});

test('run, management and history are independent modules; collapsing preserves drafts and keyboard controls', async () => {
  await openHooks();
  const runs = section().querySelector('.shortcut-run-module'), manager = section().querySelector('.shortcut-command-management'), history = section().querySelector('.shortcut-history-module');
  expect(runs.moduleOpen).toBe(true); expect(manager.moduleOpen).toBe(true); expect(history.moduleOpen).toBe(true);
  expect(runs.querySelector('.shortcut-execution-history')).toBeNull(); expect(runs.querySelector('[role="tab"]')).toBeNull();
  expect(btn('编辑快捷指令', runs)).toBeUndefined(); expect(btn('注册快捷指令', runs)).toBeUndefined();
  expect(btn('手动执行', manager)).toBeUndefined(); expect(btn('删除快捷指令', manager)).toBeTruthy();
  await btn('编辑快捷指令', manager).onclick(); const draft = field('Shell 命令'); draft.value = 'echo preserved';
  const toggle = manager.querySelector('.automation-module-toggle'); toggle.focus(); await toggle.onclick();
  expect(manager.moduleBody.hidden).toBe(true); expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(toggle.getAttribute('aria-controls')).toBe(manager.moduleBody.id);
  expect(runs.moduleBody.hidden).toBe(false); expect(history.moduleBody.hidden).toBe(false);
  await toggle.onclick(); expect(field('Shell 命令')).toBe(draft); expect(draft.value).toBe('echo preserved'); expect(calls).toHaveLength(0);
});

test('catalogue changes retain the history component and do not restart reads or reset module folds', async () => {
  await openHooks(); await until(() => section().querySelector('.shortcut-execution-records').children.length);
  const original = section(), runModule = original.querySelector('.shortcut-run-module'); await runModule.querySelector('.automation-module-toggle').onclick();
  const authorizing = btn('授权当前版本').onclick(); await dialogButton(dom, '授权此版本').onclick(); await authorizing;
  expect(section()).toBe(original); expect(runModule.moduleOpen).toBe(false);
  expect(reads.filter(path => path.includes('/api/hooks/commands/executions'))).toHaveLength(1);
  expect(btn('撤销授权').disabled).toBe(false); expect(btn('删除快捷指令').disabled).toBe(false); expect(btn('注册快捷指令').disabled).toBe(false);
  expect(btn('手动执行').disabled).toBe(false);
});

test('register preserves literal multiline Shell, remains unauthorized, does not run or call Agent', async () => {
  await openHooks(); await btn('注册快捷指令', section()).onclick();
  const text = 'echo "<script>literal</script>"\n# W8\ngit push';
  field('快捷指令名称').value = '新指令'; field('Shell 命令').value = text;
  expect(btn('保存快捷指令').classList.contains('agent-call')).toBe(false);
  await btn('保存快捷指令').onclick();
  expect(calls).toEqual([{ method: 'hooks.command_save', params: { command: { name: '新指令', command: text, default_worker_id: null }, expected_revision: 'commands-revision' } }]);
  expect(deepText(section())).toContain(text); expect(root().querySelector('script')).toBeNull();
  expect(catalogue.commands.items.at(-1).authorized).toBe(false); expect(dom.node('modal').querySelector('button')).toBeNull();
  expect(section().querySelector('[data-worker-links="off"]')).toBeTruthy();
});

test('explicit authorization and revocation pin exact version and commands revision, never toggle the Hook', async () => {
  await openHooks(); const authorizing = btn('授权当前版本').onclick();
  expect(calls).toHaveLength(0); expect(deepText(dom.node('modal'))).toContain('git push');
  expect(dialogButton(dom, '授权此版本').classList.contains('agent-call')).toBe(false);
  await dialogButton(dom, '授权此版本').onclick(); await authorizing;
  expect(calls[0]).toEqual({ method: 'hooks.command_authorize', params: { id: 'push-command', version: 1, authorized: true, expected_revision: 'commands-revision' } });
  expect(btn('手动执行').disabled).toBe(false); expect(btn('启用 Hook', mainExample()).disabled).toBe(false);
  const revoking = btn('撤销授权').onclick(); await dialogButton(dom, '确认撤权').onclick(); await revoking;
  expect(calls[1]).toEqual({ method: 'hooks.command_authorize', params: { id: 'push-command', version: 1, authorized: false, expected_revision: 'authorization-next' } });
  expect(btn('手动执行').disabled).toBe(true); expect(calls.some(item => item.method.startsWith('worker.'))).toBe(false);
});

test('cancelled authorization and navigation during confirmation never submit a command mutation', async () => {
  await openHooks(); let pending = btn('授权当前版本').onclick(); closeDialog(); await pending;
  expect(calls).toHaveLength(0); expect(btn('授权当前版本').disabled).toBe(false);
  pending = btn('授权当前版本').onclick(); dom.location.pathname = '/p/2222222222222222/';
  await dialogButton(dom, '授权此版本').onclick(); await pending; expect(calls).toHaveLength(0);
});

test('editing creates a new unauthorized version without upgrading existing Hook references', async () => {
  catalogue.commands.items[0].authorized = true; await openHooks(); await btn('编辑快捷指令').onclick();
  field('Shell 命令').value = 'git push --tags'; await btn('保存快捷指令').onclick();
  expect(calls[0].params.command).toEqual({ id: 'push-command', name: '推送', command: 'git push --tags', default_worker_id: null });
  expect(catalogue.commands.items[0]).toMatchObject({ version: 2, authorized: false });
  expect(catalogue.command_example.hooks.mounts[0].actions[0].command_version).toBe(1);
  expect(deepText(mainExample())).toContain('不会自动升级'); expect(btn('启用 Hook', mainExample()).disabled).toBe(true);
  const form = createHookForm(catalogue, { initial: { ...hook(), enabled: true } });
  expect(field('快捷指令版本', form.node).value).toBe('push-command:1'); expect(form.validate()).toContain('请选择当前已注册');
});

test('Hook form permits an unauthed stopped reference but blocks enabling; missing directory never accepts inline Shell', () => {
  const form = createHookForm(catalogue, { initial: hook() }); expect(form.validate()).toBe('');
  expect(form.collect().actions).toEqual(hook().actions); expect(field('Shell 命令', form.node)).toBeNull();
  field('启用此 Hook', form.node).checked = true; expect(form.validate()).toContain('未授权');
  delete catalogue.commands; expect(createHookForm(catalogue, { initial: hook() }).validate()).toContain('请选择当前已注册');
  const legacy = { ...hook(), actions: [{ type: 'command', command: 'git push' }] };
  expect(createHookForm(catalogue, { initial: legacy }).validate()).toContain('先显式导入');
});

test('save failures preserve name, multiline draft and original revision across unrelated catalogue mutations', async () => {
  await openHooks(); await btn('编辑快捷指令').onclick(); const input = field('Shell 命令'); input.value = 'echo draft\ngit push';
  await btn('编辑挂载', mainExample()).onclick(); await btn('保存挂载', mainExample()).onclick();
  expect(ui.hooksPage.catalogue.commands.revision).toBe('external-revision'); expect(field('Shell 命令')).toBe(input);
  intercept = (_path, body) => body?.method === 'hooks.command_save' ? failure('revision conflict') : null;
  await btn('保存快捷指令').onclick(); expect(calls.at(-1).params.expected_revision).toBe('commands-revision');
  expect(input.value).toBe('echo draft\ngit push'); expect(input.disabled).toBe(false); expect(deepText(section())).toContain('编辑已保留');
  const refreshing = btn('刷新目录').onclick(); closeDialog(); await refreshing; expect(field('Shell 命令')).toBe(input);
});

test('manual execution requires selecting a Worker and explicit confirmation, pins version and does not install Hook', async () => {
  catalogue.commands.items[0].authorized = true; await openHooks(); await openRun();
  const picker = field('执行目录 Worker'); expect(picker.children.map(option => option.textContent).join(' ')).toContain('W8');
  expect(picker.children.find(option => option.value === '43').disabled).toBe(true);
  expect(picker.children.find(option => option.value === '44').textContent).toContain('W8-1');
  await btn('确认执行一次').onclick(); expect(calls).toHaveLength(0); expect(deepText(section())).toContain('请选择未冻结');
  picker.value = '42'; const executing = btn('确认执行一次').onclick(); expect(calls).toHaveLength(0);
  expect(deepText(dom.node('modal'))).toContain('W8'); expect(dialogButton(dom, '执行一次').classList.contains('agent-call')).toBe(false);
  await dialogButton(dom, '执行一次').onclick(); await executing;
  expect(calls).toEqual([{ method: 'hooks.command_start', params: { id: 'push-command', version: 1, worker_id: 42, expected_revision: 'commands-revision' } }]);
  expect(deepText(section())).toContain('执行成功'); expect(deepText(section())).toContain('原始输出不公开');
});

test('manual safe gate refusal keeps Worker selection and does not retry or fall back to main', async () => {
  catalogue.commands.items[0].authorized = true; await openHooks(); await openRun(); field('执行目录 Worker').value = '42';
  intercept = (_path, body) => body?.method === 'hooks.command_start' ? failure('分支冻结') : null;
  const executing = btn('确认执行一次').onclick(); await dialogButton(dom, '执行一次').onclick(); await executing;
  expect(calls).toHaveLength(1); expect(calls[0].params.worker_id).toBe(42); expect(field('执行目录 Worker').value).toBe('42');
  expect(deepText(section())).toContain('不要盲目重试未知结果');
});

test('Worker picker read failure refuses manual execution instead of guessing an internal ID', async () => {
  catalogue.commands.items[0].authorized = true; await openHooks(); intercept = path => path.endsWith('/api/input-parents') ? failure('offline') : null;
  await openRun(); expect(deepText(section())).toContain('不会改投 main'); expect(btn('确认执行一次')).toBeUndefined(); expect(calls).toHaveLength(0);
});

test('late manual picker and save results never repaint another project or view', async () => {
  catalogue.commands.items[0].authorized = true; await openHooks(); let resolve;
  intercept = path => path.endsWith('/api/input-parents') ? new Promise(done => { resolve = done; }) : null;
  const reading = openRun(); await until(() => resolve);
  activateDetailView({ view: 'overview' }); const next = document.createElement('p'); next.textContent = 'next'; root().replaceChildren(next);
  resolve(json({ items: [] })); await reading; expect(root().children).toEqual([next]);
  ui.hooksPage = null; intercept = null; await openHooks(); await btn('编辑快捷指令').onclick(); field('Shell 命令').value = 'echo changed';
  resolve = null; intercept = (_path, body) => body?.method === 'hooks.command_save' ? new Promise(done => { resolve = done; }) : null;
  const saving = btn('保存快捷指令').onclick(); await until(() => resolve);
  activateDetailView({ view: 'overview' }); root().replaceChildren(next); resolve(json(catalogue)); await saving;
  expect(root().children).toEqual([next]);
});

test('deleting requires confirmation and removes future authorization, unknown execution remains visible and un-replayed', async () => {
  history = [execution({ status: 'unknown', command_result: null })];
  await openHooks(); await until(() => section().querySelector('.shortcut-execution'));
  expect(deepText(section())).toContain('结果未知'); expect(deepText(section())).toContain('W8'); expect(calls).toHaveLength(0);
  const removing = btn('删除快捷指令').onclick(); expect(deepText(dom.node('modal'))).toContain('引用它的 Hook 将不可执行');
  await dialogButton(dom, '删除指令').onclick(); await removing;
  expect(calls[0]).toEqual({ method: 'hooks.command_remove', params: { id: 'push-command', expected_revision: 'commands-revision' } });
  expect(deepText(section())).toContain('尚未注册'); expect(btn('启用 Hook', mainExample()).disabled).toBe(true);
});

test('old main inline command only supports explicit import, uses source revision and remains disabled and unauthed', async () => {
  const mount = catalogue.command_example.hooks.mounts[0]; mount.actions = [{ type: 'command', command: 'git push' }];
  mount.last_execution = { id: 8, status: 'unknown', created_at: '2026-10-09T00:00:00Z', error: '旧执行未知' };
  await openHooks(); expect(deepText(mainExample())).toContain('停止直接执行'); expect(deepText(mainExample())).toContain('旧执行未知');
  expect(btn('启用 Hook', mainExample()).disabled).toBe(true); expect(btn('编辑挂载', mainExample()).disabled).toBe(true);
  const importing = btn('导入为快捷指令', mainExample()).onclick(); expect(calls).toHaveLength(0);
  await dialogButton(dom, '确认导入').onclick(); await importing;
  expect(calls[0]).toEqual({ method: 'hooks.command_import', params: { source: { worker_id: 1, hook_id: 'main-push' }, expected_revision: 'main-revision' } });
  expect(btn('启用 Hook', mainExample()).disabled).toBe(true); expect(mount.last_execution.id).toBe(8); expect(calls).toHaveLength(1);
});

test('legacy template imports use template revision, cancellation never imports and stopped template cannot bypass import by attachment', async () => {
  catalogue.templates[0].actions = [{ type: 'command', command: 'git push' }]; await openHooks();
  const card = root().querySelector('.hook-template'); let importing = btn('导入为快捷指令', card).onclick(); closeDialog(); await importing; expect(calls).toHaveLength(0);
  importing = btn('导入为快捷指令', card).onclick(); await dialogButton(dom, '确认导入').onclick(); await importing;
  expect(calls[0]).toEqual({ method: 'hooks.command_import', params: { source: { template_id: 'push-template' }, expected_revision: 'templates-revision' } });
  expect(ui.hooksPage.catalogue.commands).toEqual(catalogue.commands);
  expect(ui.hooksPage.catalogue.templates).toEqual(catalogue.templates);
  catalogue.templates[0].actions = [{ type: 'command', command: 'git push' }];
  activateDetailView({ view: 'task', key: 'task-1' }); root().replaceChildren(workerHooks({ id: 1, task_kind: 'main', status: 'waiting', hooks: catalogue.command_example.hooks }, { refresh() {} }));
  await btn('挂载 Hook').onclick(); field('挂载模板').value = 'push-template'; field('挂载模板').onchange(); await btn('原样挂载模板').onclick();
  expect(calls).toHaveLength(1); expect(dom.node('error').textContent).toContain('先显式导入');
});

test('manual child selection retains real integer identity and ignores raw output fields', async () => {
  catalogue.commands.items[0].authorized = true; await openHooks(); await openRun(); field('执行目录 Worker').value = '44';
  intercept = (_path, body) => body?.method === 'hooks.command_start' ? json({ execution_id: executionId,
    execution: execution({ worker_id: 44, worker_number: 'W8-1', status: 'failed', command_result: { status: 'failed', exit_code: 5, reason: 'output_limit', stdout: 'SECRET-STDOUT', stderr: 'SECRET-STDERR' } }),
    commands: { ...catalogue.commands, items: [{ ...catalogue.commands.items[0], last_execution: { worker_id: 44, worker_number: 'W8-1', status: 'failed', created_at: '2026-10-09T00:00:00Z',
      command_result: { status: 'failed', exit_code: 5, reason: 'output_limit', stdout: 'SECRET-STDOUT' } } }] } }) : null;
  const executing = btn('确认执行一次').onclick(); await dialogButton(dom, '执行一次').onclick(); await executing;
  expect(calls[0].params.worker_id).toBe(44); expect(deepText(section())).toContain('W8-1');
  expect(deepText(section())).toContain('退出码 5'); expect(deepText(section())).toContain('输出超限');
  expect(deepText(root())).not.toContain('SECRET-STDOUT'); expect(dom.node('error').textContent).not.toContain('SECRET-STDERR');
});

test('failed authorization retains visible unauthed state and never retries automatically', async () => {
  await openHooks(); intercept = (_path, body) => body?.method === 'hooks.command_authorize' ? failure('revision conflict') : null;
  const authorizing = btn('授权当前版本').onclick(); await dialogButton(dom, '授权此版本').onclick(); await authorizing;
  expect(calls).toHaveLength(1); expect(btn('授权当前版本').disabled).toBe(false); expect(btn('手动执行').disabled).toBe(true);
  expect(dom.node('error').textContent).toContain('未假定授权已改变');
});

test('Worker legacy import forwards worker_hooks rather than the full project catalogue and never copies receipts into a definition', async () => {
  const model = catalogue.command_example.hooks; model.mounts[0].actions = [{ type: 'command', command: 'git push' }];
  activateDetailView({ view: 'task', key: 'task-1' }); let refreshed;
  root().replaceChildren(workerHooks({ id: 1, task_kind: 'main', status: 'waiting', hooks: model }, { refresh(result) { refreshed = result; } }));
  const importing = btn('导入为快捷指令').onclick(); await until(() => dialogButton(dom, '确认导入'));
  await dialogButton(dom, '确认导入').onclick(); await importing;
  expect(refreshed).toEqual(model); expect(refreshed).not.toHaveProperty('commands');
  expect(calls[0].params).toEqual({ source: { worker_id: 1, hook_id: 'main-push' }, expected_revision: 'main-revision' });
});

test('old services do not offer shortcut mutations or inline command import or execution', async () => {
  delete catalogue.commands; catalogue.command_example.hooks.mounts[0].actions = [{ type: 'command', command: 'git push' }]; await openHooks();
  expect(deepText(section())).toContain('请更新后台服务'); expect(btn('注册快捷指令')).toBeUndefined();
  const importing = btn('导入为快捷指令', mainExample()); expect(importing.disabled).toBe(true); expect(importing.parentNode.classList.contains('help-host')).toBe(true);
  await importing.onclick(); expect(calls).toHaveLength(0);
});

test('management saves an explicit default child Worker or null, directory-only editing creates an unauthorized version', async () => {
  catalogue.commands.items[0] = { ...push(), authorized: true, default_worker_id: 1 };
  await openHooks(); await btn('编辑快捷指令').onclick();
  const directory = field('默认执行目录 Worker'); expect(directory.value).toBe('1'); expect(directory.children.some(item => item.value === '44')).toBe(true);
  directory.value = '44'; await btn('保存快捷指令').onclick();
  expect(calls[0].params.command).toEqual({ id: 'push-command', name: '推送', command: 'git push', default_worker_id: 44 });
  expect(catalogue.commands.items[0]).toMatchObject({ version: 2, authorized: false });
  await btn('编辑快捷指令').onclick(); field('默认执行目录 Worker').value = ''; await btn('保存快捷指令').onclick();
  expect(calls[1].params.command.default_worker_id).toBeNull(); expect(catalogue.commands.items[0].version).toBe(3);
});

test('management retains missing default identity across repaint and failure; does not silently save null or main', async () => {
  catalogue.commands.items[0].default_worker_id = 999; await openHooks(); await btn('编辑快捷指令').onclick();
  const directory = field('默认执行目录 Worker'), draft = field('Shell 命令'); expect(directory.value).toBe('999');
  await btn('保存快捷指令').onclick(); expect(calls).toHaveLength(0); expect(deepText(section())).toContain('默认目录失效');
  directory.value = '44'; draft.value = 'printf preserved';
  await btn('编辑挂载', mainExample()).onclick(); await btn('保存挂载', mainExample()).onclick();
  expect(field('默认执行目录 Worker')).toBe(directory); expect(directory.value).toBe('44');
  intercept = (_path, body) => body?.method === 'hooks.command_save' ? failure('revision conflict') : null;
  await btn('保存快捷指令').onclick(); expect(directory.value).toBe('44'); expect(draft.value).toBe('printf preserved'); expect(calls.at(-1).params.expected_revision).toBe('commands-revision');
});

test('all automation modules fold independently and retain exceptional summaries and template search on unrelated saves', async () => {
  const mount = catalogue.command_example.hooks.mounts[0]; mount.state = 'unknown'; mount.last_execution = { status: 'unknown', error: '需要核对副作用' };
  history = [execution({ status: 'unknown' })]; await openHooks(); await until(() => root().querySelector('.shortcut-execution'));
  const modules = root().querySelectorAll('.automation-module'); expect(modules).toHaveLength(7);
  const search = field('查找 Hook 模板'); search.value = '推送'; search.oninput();
  for (const module of modules) await module.querySelector('.automation-module-toggle').onclick();
  expect(root().querySelector('[data-module="project-hooks"]').moduleSummary.textContent).toContain('需要核对副作用');
  expect(root().querySelector('[data-module="command-history"]').moduleSummary.textContent).toContain('结果未知');
  const authorizing = btn('授权当前版本').onclick(); await dialogButton(dom, '授权此版本').onclick(); await authorizing;
  for (const module of root().querySelectorAll('.automation-module')) expect(module.moduleOpen).toBe(false);
  expect(field('查找 Hook 模板')).toBe(search); expect(search.value).toBe('推送');
});

test('command authorization and command Hook switches have distinct enable/disable classes without Agent purple', async () => {
  catalogue.commands.items[0].authorized = true; await openHooks();
  expect(btn('撤销授权').classList.contains('command-revoke')).toBe(true); expect(btn('启用 Hook', mainExample()).classList.contains('hook-enable')).toBe(true);
  expect(btn('撤销授权').classList.contains('agent-call')).toBe(false); expect(btn('启用 Hook', mainExample()).classList.contains('agent-call')).toBe(false);
  catalogue.command_example.hooks.mounts[0].enabled = true; await btn('刷新目录').onclick();
  expect(btn('停用 Hook', mainExample()).classList.contains('hook-disable')).toBe(true);
});
