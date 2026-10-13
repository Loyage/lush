import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { until } from '../helpers.js';

const json = value => Response.json(value);
const failure = message => Response.json({ error: message }, { status: 409 });
const push = () => ({ id: 'push-command', name: '推送', command: 'git push', version: 1, default_worker_id: 999 });
const hook = () => ({ id: 'main-push', name: '合并后推送', trigger: 'worker.merge_received', enabled: false, mode: 'persistent', editable: true, removable: true, builtin: false, conditions: {}, state: 'idle', last_execution: null, actions: [{ type: 'command', command_id: 'push-command', command_version: 1 }] });
let catalogue, calls, reads, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) calls.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.includes('/api/hooks/commands/executions')) return json({ version: 1, items: [], has_more: false, next_before: null });
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (body?.method === 'hooks.command_save') {
    const definition = body.params.command, old = catalogue.commands.items.find(item => item.id === definition.id);
    const { authorized, ...previous } = old || {};
    const item = { ...previous, ...definition, id: old?.id || 'new-command', version: old ? old.version + 1 : 1 };
    catalogue.commands = { ...catalogue.commands, revision: 'commands-next', items: old ? catalogue.commands.items.map(entry => entry.id === item.id ? item : entry) : [...catalogue.commands.items, item] }; return json(catalogue);
  }
  if (body?.method === 'hooks.command_remove') { catalogue.commands.items = []; catalogue.commands.revision = 'removed'; return json(catalogue); }
  if (body?.method === 'hooks.command_import') {
    const target = body.params.source.template_id ? catalogue.templates[0] : catalogue.command_example.hooks.mounts[0]; target.actions = hook().actions; target.enabled = false;
    return json({ ...catalogue, imported_command_ids: ['push-command'], worker_hooks: catalogue.command_example.hooks });
  }
  if (body?.method === 'worker.hook_update') { catalogue.commands.revision = 'external-revision'; return json(catalogue.command_example.hooks); }
  throw new Error(`Unexpected request ${path} ${body?.method || ''}`);
} });
const { openHookTools: openHooks, openHooks: openAutomation, workerHooks } = await import('../../src/ui/web/assets/render-hooks.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const section = () => root().querySelector('.shortcut-commands');
const manager = () => root().querySelector('.shortcut-command-management');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const field = label => root().querySelector(`[aria-label="${label}"]`);
const mainExample = () => root().querySelector('.command-hook-example');
const pick = () => manager().querySelector('.shortcut-directory-pick').onclick();
async function ready() { await openHooks({ subpage: 'commands' }); await pick(); }
beforeEach(() => {
  closeDialog(); ui.hooksPage?.shortcutNode?.dispose?.(); calls = []; reads = []; intercept = null; dom.location.pathname = '/'; ui.hooksPage = null;
  const mounted = hook(); catalogue = { version: 1, revision: 'templates-revision', triggers: [{ id: 'worker.merge_received', label: '收到合并' }],
    actions: [{ type: 'command', label: '快捷指令', modes: ['once', 'persistent'], triggers: ['worker.merge_received'], agent_call: false }],
    templates: [{ ...hook(), id: 'push-template' }], commands: { version: 1, revision: 'commands-revision', items: [push()] },
    command_example: { worker_id: 1, hook_id: mounted.id, template_id: 'push-template', hooks: { version: 1, worker_id: 1, can_attach: true, revision: 'main-revision', mounts: [mounted] } } };
  activateDetailView({ view: 'overview' });
});
afterAll(() => { ui.hooksPage?.shortcutNode?.dispose?.(); closeDialog(); dom.restore(); });

test('three independent subpages: settings contains no manager or history, commands begins with list only', async () => {
  await openHooks(); expect(root().querySelector('h1').textContent).toBe('指令与 Hook 工具');
  expect(section().hidden).toBe(true); expect(root().querySelector('.project-hooks')).toBeNull();
  expect(root().querySelector('.page-subnav').children.map(link => link.textContent)).toEqual(['Hook 模板', '指令管理', '指令运行记录']);
  expect(reads.some(path => path.includes('executions'))).toBe(false);
  await openHooks({ subpage: 'commands' }); expect(dom.location.hash).toBe('#hooks-commands'); expect(section().hidden).toBe(false);
  expect(manager().querySelector('.shortcut-command')).toBeNull(); expect(manager().querySelector('.shortcut-command-detail-page').hidden).toBe(true);
  expect(manager().querySelector('.ui-list-page')).toBeTruthy(); expect(manager().querySelector('.ui-list-entry')).toBeTruthy();
  expect(root().querySelector('.project-hooks')).toBeNull(); expect(root().querySelector('[data-module="tools"]').hidden).toBe(true);
  expect(root().querySelector('.shortcut-run-module')).toBeNull(); expect(root().querySelector('.shortcut-command-runs')).toBeNull(); expect(calls).toHaveLength(0);
});

test('single detail/back preserves filter, selection, scroll position and focus without writes', async () => {
  await openHooks({ subpage: 'commands' }); const input = field('查找管理指令'); input.value = '推送'; input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
  root().scrollTop = 375; await pick(); expect(manager().querySelector('.shortcut-directory').parentNode.hidden).toBe(true); expect(manager().querySelector('.shortcut-command-detail-page').hidden).toBe(false);
  root().scrollTop = 10; await btn('返回指令列表').onclick(); expect(root().scrollTop).toBe(375); expect(input.value).toBe('推送'); expect(document.activeElement.dataset.commandId).toBe('push-command');
  expect(manager().querySelector('.ui-list-entry').classList.contains('selected')).toBe(true); expect(calls).toHaveLength(0);
});

test('draft nodes and original revision survive subpages, returning to list, explicit refresh and unrelated Hook mutation', async () => {
  await ready(); await btn('编辑快捷指令').onclick(); const draft = field('Shell 命令'); draft.value = 'echo preserved\ngit push';
  catalogue.commands.revision = 'external-revision'; await openHooks(); await btn('刷新目录').onclick();
  expect(ui.hooksPage.catalogue.commands.revision).toBe('external-revision');
  await openHooks({ subpage: 'commands' }); expect(field('Shell 命令')).toBe(draft);
  await btn('返回指令列表').onclick(); await openHooks({ subpage: 'history' }); await openHooks({ subpage: 'commands' }); await btn('继续指令编辑').onclick();
  await openHooks(); await btn('刷新目录').onclick(); await openHooks({ subpage: 'commands' });
  intercept = (_path, body) => body?.method === 'hooks.command_save' ? failure('revision conflict') : null;
  await btn('保存快捷指令').onclick(); expect(calls.at(-1).params.expected_revision).toBe('commands-revision'); expect(draft.value).toBe('echo preserved\ngit push'); expect(draft.disabled).toBe(false); expect(deepText(section())).toContain('编辑已保留');
});

test('adding literal multiline Shell is safe and never submits a retired directory or Agent call', async () => {
  await openHooks({ subpage: 'commands' }); await btn('注册快捷指令').onclick(); const text = 'echo "<script>literal</script>"\n# W8\ngit push';
  field('快捷指令名称').value = '新指令'; field('Shell 命令').value = text; expect(btn('保存快捷指令').classList.contains('agent-call')).toBe(false); await btn('保存快捷指令').onclick();
  expect(calls).toEqual([{ method: 'hooks.command_save', params: { command: { name: '新指令', command: text }, expected_revision: 'commands-revision' } }]);
  expect(deepText(section())).toContain(text); expect(root().querySelector('script')).toBeNull(); expect(catalogue.commands.items.at(-1)).not.toHaveProperty('authorized');
  expect(field('默认执行目录 Worker')).toBeNull(); expect(reads.some(path => path.includes('input-parents') || path.includes('snapshot'))).toBe(false);
});

test('editing preserves retired default and Hook identity while references resolve the latest definition', async () => {
  catalogue.commands.items[0].authorized = true; await ready(); await btn('编辑快捷指令').onclick(); field('Shell 命令').value = 'git push --tags'; await btn('保存快捷指令').onclick();
  expect(calls[0].params.command).toEqual({ id: 'push-command', name: '推送', command: 'git push --tags' });
  expect(catalogue.commands.items[0]).toMatchObject({ version: 2, default_worker_id: 999 }); expect(catalogue.command_example.hooks.mounts[0].actions[0].command_version).toBe(1);
  const form = createHookForm(catalogue, { initial: { ...hook(), enabled: true } });
  expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual([{ type: 'command', command_id: 'push-command' }]);
  expect(root().querySelector('.command-hook-example')).toBeNull(); expect(field('默认父 Worker')).toBeNull();
});

for (const authorized of [undefined, false, true]) test(`no authorization controls or badges for legacy authorized=${authorized}`, async () => {
  if (authorized !== undefined) catalogue.commands.items[0].authorized = authorized;
  await ready();
  for (const label of ['授权当前版本', '撤销授权']) expect(btn(label)).toBeUndefined();
  expect(field('查找管理指令授权')).toBeNull(); expect(deepText(section())).not.toContain('已授权'); expect(deepText(section())).not.toContain('撤权');
  expect(calls).toHaveLength(0);
});

for (const exit of ['cancel', 'subpage', 'project']) test(`deletion confirmation ${exit} never submits mutation`, async () => {
  await ready(); const pending = btn('删除快捷指令').onclick();
  if (exit === 'cancel') closeDialog(); else { if (exit === 'subpage') await openHooks({ subpage: 'history' }); else dom.location.pathname = '/p/2222222222222222/'; await dialogButton(dom, '删除指令').onclick(); }
  await pending; expect(calls).toHaveLength(0);
});

for (const exit of ['view', 'project', 'subpage']) test(`late save after leaving ${exit} preserves next page and does not publish a catalogue`, async () => {
  await ready(); await btn('编辑快捷指令').onclick(); const draft = field('Shell 命令'); draft.value = 'echo changed'; let resolve;
  intercept = (_path, body) => body?.method === 'hooks.command_save' ? new Promise(done => { resolve = done; }) : null;
  const saving = btn('保存快捷指令').onclick(); await until(() => resolve); const before = ui.hooksPage.catalogue;
  const next = document.createElement('p'); next.textContent = 'next';
  if (exit === 'subpage') await openHooks({ subpage: 'history' }); else { if (exit === 'project') dom.location.pathname = '/p/2222222222222222/'; else activateDetailView({ view: 'overview' }); root().replaceChildren(next); }
  resolve(json({ ...catalogue, commands: { ...catalogue.commands, revision: 'LATE' } })); await saving;
  expect(ui.hooksPage.catalogue).toBe(before); if (exit !== 'subpage') expect(root().children).toEqual([next]);
  else { await openHooks({ subpage: 'commands' }); expect(field('Shell 命令')).toBe(draft); expect(draft.disabled).toBe(false); }
});

test('delete confirms future reference scope, retains history and returns to an empty list', async () => {
  await ready(); const removing = btn('删除快捷指令').onclick(); expect(deepText(dom.node('modal'))).toContain('引用它的 Hook 将不可执行'); expect(calls).toHaveLength(0);
  await dialogButton(dom, '删除指令').onclick(); await removing;
  expect(calls[0]).toEqual({ method: 'hooks.command_remove', params: { id: 'push-command', expected_revision: 'commands-revision' } }); expect(deepText(section())).toContain('尚未注册'); expect(manager().querySelector('.shortcut-command-detail-page').hidden).toBe(true);
});

test('failed deletion preserves definition and never retries', async () => {
  await ready(); intercept = (_path, body) => body?.method === 'hooks.command_remove' ? failure('revision conflict') : null;
  const removing = btn('删除快捷指令').onclick(); await dialogButton(dom, '删除指令').onclick(); await removing;
  expect(calls).toHaveLength(1); expect(btn('删除快捷指令').disabled).toBe(false); expect(dom.node('error').textContent).toContain('未假定配置已改变');
  expect(catalogue.commands.items).toHaveLength(1);
});

test('legacy inline imports keep original source revisions, safe receipts and disabled mounts', async () => {
  const mount = catalogue.command_example.hooks.mounts[0]; mount.actions = [{ type: 'command', command: 'git push' }]; mount.last_execution = { id: 8, status: 'unknown', error: '旧执行未知' };
  await openAutomation({ feature: 'push' }); expect(btn('启用 Hook', mainExample()).disabled).toBe(true); expect(btn('编辑挂载', mainExample()).disabled).toBe(true);
  const importing = btn('导入为快捷指令', mainExample()).onclick(); await dialogButton(dom, '确认导入').onclick(); await importing;
  expect(calls[0].params).toEqual({ source: { worker_id: 1, hook_id: 'main-push' }, expected_revision: 'main-revision' }); expect(mount.last_execution.id).toBe(8); expect(btn('启用 Hook', mainExample()).disabled).toBe(false); expect(mount.enabled).toBe(false);
  catalogue.templates[0].actions = [{ type: 'command', command: 'git push' }]; await openHooks();
  const templateImport = btn('导入为快捷指令', root().querySelector('.hook-template')).onclick(); await dialogButton(dom, '确认导入').onclick(); await templateImport;
  expect(calls[1].params).toEqual({ source: { template_id: 'push-template' }, expected_revision: 'templates-revision' });
});

test('Worker inline import forwards only worker_hooks, not full catalogue', async () => {
  const model = catalogue.command_example.hooks; model.mounts[0].actions = [{ type: 'command', command: 'git push' }]; activateDetailView({ view: 'task', key: 'task-1' }); let refreshed;
  root().replaceChildren(workerHooks({ id: 1, task_kind: 'main', status: 'waiting', hooks: model }, { refresh(result) { refreshed = result; } }));
  const importing = btn('导入为快捷指令').onclick(); await until(() => dialogButton(dom, '确认导入')); await dialogButton(dom, '确认导入').onclick(); await importing;
  expect(refreshed).toEqual(model); expect(refreshed).not.toHaveProperty('commands');
});

test('Hook form ignores legacy revocation and old version but still blocks inline Shell', () => {
  catalogue.commands.items[0].authorized = false; catalogue.commands.items[0].version = 7;
  const form = createHookForm(catalogue, { initial: hook() }); expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual([{ type: 'command', command_id: 'push-command' }]);
  form.node.querySelector('[aria-label="启用此 Hook"]').checked = true; expect(form.validate()).toBe('');
  expect(createHookForm(catalogue, { initial: { ...hook(), actions: [{ type: 'command', command: 'git push' }] } }).validate()).toContain('先显式导入');
});

test('push reference editing updates future definition without changing the mounted ID, enable state or old version', async () => {
  catalogue.commands.items[0].authorized = false; catalogue.command_example.hooks.mounts[0].enabled = true;
  await openAutomation({ feature: 'push' }); const management = root().querySelector('.push-command-editor').children.at(-1);
  expect(deepText(root())).toContain('引用指令编辑'); expect(deepText(root())).toContain('编辑影响所有引用的未来执行');
  expect(root().querySelector('.push-command-authorization')).toBeNull();
  await management.querySelector('.shortcut-directory-pick').onclick(); await btn('编辑快捷指令', management).onclick();
  field('Shell 命令').value = 'git push --tags'; await btn('保存快捷指令', management).onclick();
  expect(calls.map(call => call.method)).toEqual(['hooks.command_save']);
  expect(catalogue.command_example.hooks.mounts[0]).toMatchObject({ enabled: true, actions: [{ type: 'command', command_id: 'push-command', command_version: 1 }] });
  expect(deepText(mainExample())).toContain('当前 v2'); expect(deepText(mainExample())).toContain('git push --tags');
  expect(btn('停用 Hook', mainExample()).disabled).toBe(false); expect(catalogue.commands.items[0]).not.toHaveProperty('authorized');
});

test('push directory refresh preserves draft and original revision, becoming read-only on incompatible catalogue', async () => {
  await openAutomation({ feature: 'push' }); const management = root().querySelector('.push-command-editor').children.at(-1);
  await management.querySelector('.shortcut-directory-pick').onclick(); await btn('编辑快捷指令', management).onclick();
  const draft = field('Shell 命令'); draft.value = 'preserved push draft';
  catalogue.commands = null; await btn('刷新推送设置').onclick();
  expect(field('Shell 命令')).toBe(draft); await btn('保存快捷指令', management).onclick(); expect(calls).toHaveLength(0);
  expect(deepText(management)).toContain('已加载记录只读');
  catalogue.commands = { version: 1, revision: 'concurrent', items: [{ ...push(), version: 4 }] }; await btn('刷新推送设置').onclick();
  expect(field('Shell 命令')).toBe(draft); expect(draft.value).toBe('preserved push draft');
  await btn('保存快捷指令', management).onclick(); expect(calls[0].params.expected_revision).toBe('commands-revision');
});

test('malformed refreshed command catalogue retains drafts read-only and can recover without silently changing draft revision', async () => {
  await ready(); await btn('编辑快捷指令').onclick(); const draft = field('Shell 命令'); draft.value = 'retained';
  catalogue.commands = null; await openHooks(); await btn('刷新目录').onclick(); await openHooks({ subpage: 'commands' });
  await btn('保存快捷指令').onclick(); expect(calls).toHaveLength(0); expect(draft.value).toBe('retained'); expect(deepText(manager())).toContain('已加载记录只读');
  catalogue.commands = { version: 1, revision: 'recovered', items: [push()] }; await openHooks(); await btn('刷新目录').onclick(); await openHooks({ subpage: 'commands' });
  await btn('保存快捷指令').onclick(); expect(calls[0].params.expected_revision).toBe('commands-revision');
});

test('missing directory can recover on explicit reread, while initial history remains independent', async () => {
  delete catalogue.commands; await openHooks({ subpage: 'commands' }); expect(btn('注册快捷指令')).toBeUndefined();
  catalogue.commands = { version: 1, revision: 'recovered', items: [push()] }; await openHooks(); await btn('刷新目录').onclick(); await openHooks({ subpage: 'commands' });
  expect(btn('注册快捷指令')).toBeTruthy(); await pick(); expect(btn('编辑快捷指令').disabled).toBe(false); expect(calls).toHaveLength(0);
});

test('missing old-service command catalogue disables management/import but does not prevent independent history reads', async () => {
  delete catalogue.commands; catalogue.templates[0].actions = [{ type: 'command', command: 'git push' }]; await openHooks({ subpage: 'commands' });
  expect(deepText(section())).toContain('请更新后台服务'); expect(btn('注册快捷指令')).toBeUndefined();
  await openHooks(); const importing = btn('导入为快捷指令', root().querySelector('.hook-template')); expect(importing.disabled).toBe(true); await importing.onclick();
  await openHooks({ subpage: 'history' }); await until(() => reads.some(path => path.includes('executions'))); expect(calls).toHaveLength(0);
});
