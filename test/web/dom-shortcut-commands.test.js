import { test, expect, beforeEach, afterAll } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { gate, until } from '../helpers.js';

const json = value => Response.json(value);
const failure = message => Response.json({ error: message }, { status: 409 });
const push = () => ({ id: 'push-command', name: '推送', command: 'git push', version: 1, default_worker_id: 999 });
const hook = () => ({ id: 'main-push', name: '合并后推送', trigger: 'worker.merge_received', enabled: false, mode: 'persistent', editable: true, removable: true, builtin: false, conditions: {}, state: 'idle', last_execution: null, actions: [{ type: 'command', command_id: 'push-command', command_version: 1 }] });
let catalogue, calls, reads, intercept;
const dom = installDom({ fetch: async (url, options = {}) => {
  const path = String(url), body = options.body ? JSON.parse(options.body) : null;
  if (body) calls.push(body); else reads.push(path);
  const custom = intercept?.(path, body); if (custom) return custom;
  if (path.endsWith('/api/hooks')) return json(catalogue);
  if (body?.method === 'hooks.command_import') {
    const target = catalogue.command_example.hooks.mounts[0]; target.actions = hook().actions; target.enabled = false;
    return json({ ...catalogue, imported_command_ids: ['push-command'], worker_hooks: catalogue.command_example.hooks });
  }
  throw new Error(`Unexpected request ${path} ${body?.method || ''}`);
} });
const { openHookTools, openHooks: openAutomation, workerHooks, mountCard } = await import('../../src/ui/web/assets/render-hooks.js');
const { createHookForm } = await import('../../src/ui/web/assets/hook-form.js');
const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { closeDialog } = await import('../../src/ui/web/assets/dialog.js');
const root = () => dom.node('detail');
const btn = (label, node = root()) => node.querySelectorAll('button').find(item => item.textContent === label);
const mainExample = () => root().querySelector('.command-hook-example');
const reference = () => root().querySelector('.push-command-reference');
const noDefinitionControls = () => {
  for (const label of ['注册快捷指令', '编辑快捷指令', '保存快捷指令', '删除快捷指令', '导出 Markdown', '新建模板', '管理来源模板', '指令与 Hook 工具']) expect(btn(label)).toBeUndefined();
  expect(root().querySelector('.shortcut-command-editor')).toBeNull();
  expect(root().querySelector('[aria-label="Shell 命令"]')).toBeNull();
  expect(root().querySelector('a[href="#hook-tools"]')).toBeNull();
};
function mainMount() {
  activateDetailView({ view: 'task', key: 'task-1' });
  const render = model => root().replaceChildren(mountCard({ id: 1, task_kind: 'main', status: 'waiting' }, model.mounts[0], model,
    render, () => ui.view?.id === 'task', { catalogue }));
  render(catalogue.command_example.hooks);
}
beforeEach(() => {
  closeDialog(); calls = []; reads = []; intercept = null; dom.location.pathname = '/'; ui.hooksPage = null;
  const mounted = hook(); catalogue = { version: 1, revision: 'templates-revision', triggers: [{ id: 'worker.merge_received', label: '收到合并' }],
    actions: [{ type: 'command', label: '快捷指令', modes: ['once', 'persistent'], triggers: ['worker.merge_received'], agent_call: false }],
    templates: [{ ...hook(), id: 'push-template' }], commands: { version: 1, revision: 'commands-revision', items: [push()] },
    command_example: { worker_id: 1, hook_id: mounted.id, template_id: 'push-template', hooks: { version: 1, worker_id: 1, can_attach: true, revision: 'main-revision', mounts: [mounted] } } };
  activateDetailView({ view: 'overview' });
});
afterAll(() => { closeDialog(); dom.restore(); });

test('retired command and history subpages only redirect, with no catalogue/history read or mutation', async () => {
  const before = structuredClone(catalogue);
  for (const subpage of ['settings', 'commands', 'history']) {
    await openHookTools({ subpage }); expect(dom.location.hash).toBe('#hooks'); expect(ui.view.id).toBe('hooks');
    expect(root().querySelectorAll('.automation-feature')).toHaveLength(4); noDefinitionControls();
    expect(root().querySelector('.shortcut-history-module')).toBeNull(); expect(dom.node('error').textContent).toContain('入口已移除');
  }
  expect(reads).toHaveLength(0); expect(calls).toHaveLength(0); expect(catalogue).toEqual(before);
});

for (const authorized of [undefined, false, true]) test(`push definition is read-only and ignores obsolete authorized=${authorized}`, async () => {
  if (authorized !== undefined) catalogue.commands.items[0].authorized = authorized;
  const before = structuredClone(catalogue); await openAutomation({ feature: 'push' });
  expect(reference().hidden).toBe(true); await btn('展开推送高级设置').onclick(); expect(reference().hidden).toBe(false);
  expect(deepText(reference())).toContain('git push'); expect(deepText(reference())).toContain('引用指令（只读）');
  noDefinitionControls(); expect(btn('授权当前版本')).toBeUndefined(); expect(btn('撤销授权')).toBeUndefined();
  expect(root().querySelector('[aria-label="默认执行目录 Worker"]')).toBeNull();
  expect(calls).toHaveLength(0); expect(catalogue).toEqual(before); expect(root().querySelector('.push-history')).toBeNull();
});

test('literal latest definition refresh is read-only and retains mount identity, authorization, version and historical default', async () => {
  catalogue.command_example.hooks.mounts[0].enabled = true; await openAutomation({ feature: 'push' });
  const beforeMount = structuredClone(catalogue.command_example.hooks), literal = 'echo "<script>literal</script>"\n# W8\ngit push --tags';
  catalogue.commands.items[0] = { ...push(), command: literal, version: 4 }; catalogue.commands.revision = 'external-revision';
  await btn('展开推送高级设置').onclick(); await btn('重新读取推送设置').onclick();
  expect(reference().hidden).toBe(false); expect(deepText(reference())).toContain(literal); expect(root().querySelector('script')).toBeNull();
  expect(deepText(reference())).toContain('v4'); noDefinitionControls();
  expect(catalogue.command_example.hooks).toEqual(beforeMount); expect(catalogue.commands.items[0].default_worker_id).toBe(999);
  expect(btn('停用 Hook', mainExample()).disabled).toBe(false); expect(calls).toHaveLength(0);
});

test('missing catalogue and failed explicit read remain visible; read-only recovery cannot invent authorization or replay', async () => {
  await openAutomation({ feature: 'push' }); await btn('展开推送高级设置').onclick();
  const before = structuredClone(catalogue);
  intercept = path => path.endsWith('/api/hooks') ? failure('initial offline') : null; await btn('重新读取推送设置').onclick();
  expect(deepText(root())).toContain('推送设置读取失败：initial offline');
  expect(deepText(reference())).toContain('git push'); expect(catalogue).toEqual(before); noDefinitionControls(); expect(calls).toHaveLength(0);
  intercept = null; catalogue.commands = null; await btn('重新读取推送设置').onclick();
  expect(deepText(reference())).toContain('快捷指令目录不可用'); expect(btn('启用 Hook', mainExample()).disabled).toBe(true); noDefinitionControls();
  intercept = path => path.endsWith('/api/hooks') ? failure('offline') : null; await btn('重新读取推送设置').onclick();
  expect(deepText(root())).toContain('推送设置读取失败：offline'); expect(calls).toHaveLength(0);
  intercept = null; catalogue.commands = { version: 1, revision: 'recovered', items: [{ ...push(), version: 7 }] };
  await btn('重新读取推送设置').onclick(); expect(deepText(reference())).toContain('git push'); expect(deepText(reference())).toContain('v7');
  expect(btn('启用 Hook', mainExample()).disabled).toBe(false); expect(catalogue.command_example.hooks.mounts[0].enabled).toBe(false); expect(calls).toHaveLength(0);
});

for (const exit of ['view', 'project']) test(`late read-only definition refresh after leaving ${exit} cannot repaint the next page`, async () => {
  await openAutomation({ feature: 'push' }); const slow = gate(); let started = false;
  intercept = path => path.endsWith('/api/hooks') ? (started = true, slow.promise) : null;
  const loading = btn('重新读取推送设置').onclick(); await until(() => started);
  if (exit === 'project') dom.location.pathname = '/p/2222222222222222/';
  activateDetailView({ view: 'overview' }); const next = document.createElement('p'); next.textContent = 'next'; root().replaceChildren(next);
  slow.resolve(json({ ...catalogue, commands: { ...catalogue.commands, items: [{ ...push(), command: 'LATE' }] } })); await loading;
  expect(root().children).toEqual([next]); expect(deepText(root())).not.toContain('LATE'); expect(calls).toHaveLength(0);
});

test('legacy inline import is only in main detail and preserves stable mount, source revision and safe receipt', async () => {
  const mount = catalogue.command_example.hooks.mounts[0]; mount.actions = [{ type: 'command', command: 'git push' }]; mount.last_execution = { id: 8, status: 'unknown', error: '旧执行未知' };
  await openAutomation({ feature: 'push' }); const enable = btn('启用 Hook', mainExample());
  expect(enable.disabled).toBe(true); expect(enable.parentNode.getAttribute('data-help')).toContain('显式导入');
  await enable.onclick(); expect(calls).toHaveLength(0); expect(btn('编辑挂载', mainExample())).toBeUndefined(); expect(btn('导入为快捷指令', mainExample())).toBeUndefined();
  expect(btn('查看 main Worker 自动化')).toBeTruthy(); expect(root().querySelector('.push-history')).toBeNull(); noDefinitionControls();
  mainMount(); expect(btn('编辑挂载').disabled).toBe(true);
  let importing = btn('导入为快捷指令').onclick(); await dialogButton(dom, '取消').onclick(); await importing; expect(calls).toHaveLength(0);
  importing = btn('导入为快捷指令').onclick(); await dialogButton(dom, '确认导入').onclick(); await importing;
  expect(calls[0].params).toEqual({ source: { worker_id: 1, hook_id: 'main-push' }, expected_revision: 'main-revision' });
  expect(mount.last_execution).toEqual({ id: 8, status: 'unknown', error: '旧执行未知' }); expect(mount.id).toBe('main-push'); expect(mount.enabled).toBe(false);
  expect(btn('启用 Hook').disabled).toBe(false);
  await openAutomation({ feature: 'push' }); expect(btn('启用 Hook', mainExample()).disabled).toBe(false); expect(calls).toHaveLength(1); noDefinitionControls();
});

test('Worker inline import forwards only worker_hooks, not full catalogue', async () => {
  const model = catalogue.command_example.hooks; model.mounts[0].actions = [{ type: 'command', command: 'git push' }]; activateDetailView({ view: 'task', key: 'task-1' }); let refreshed;
  root().replaceChildren(workerHooks({ id: 1, task_kind: 'main', status: 'waiting', hooks: model }, { refresh(result) { refreshed = result; } }));
  noDefinitionControls();
  const importing = btn('导入为快捷指令').onclick(); await until(() => dialogButton(dom, '确认导入')); await dialogButton(dom, '确认导入').onclick(); await importing;
  expect(refreshed).toEqual(model); expect(refreshed).not.toHaveProperty('commands');
});

test('Hook form ignores legacy revocation and old version but still blocks inline Shell', () => {
  catalogue.commands.items[0].authorized = false; catalogue.commands.items[0].version = 7;
  const form = createHookForm(catalogue, { initial: hook() }); expect(form.validate()).toBe(''); expect(form.collect().actions).toEqual([{ type: 'command', command_id: 'push-command' }]);
  form.node.querySelector('[aria-label="启用此 Hook"]').checked = true; expect(form.validate()).toBe('');
  expect(createHookForm(catalogue, { initial: { ...hook(), actions: [{ type: 'command', command: 'git push' }] } }).validate()).toContain('先显式导入');
});
