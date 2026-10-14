import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { installDom, dialogButton } from '../dom-stub.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { renderConvergenceAutomation } from '../../src/ui/web/assets/automation-completion.js';

test('real DOM settings → HTTP action → registered user RPC → SQLite policy → response updates only future orders', async () => {
  const f = await setup(); let dom;
  try {
    await repo(f.root); f.project.kick = () => {};
    const old = (await f.project.order('existing', 'main', [], null, false)).task;
    const writes = [];
    dom = installDom({ fetch: async (url, options = {}) => {
      if (options.body) writes.push(JSON.parse(options.body));
      return fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
    } });
    await openProjectAutomation({ feature: 'completion' });
    const root = dom.node('detail'), choice = root.querySelector('[data-level="accept"]');
    await choice.onclick();
    const saving = root.querySelectorAll('button').find(item => item.textContent === '保存项目设置').onclick();
    await dialogButton(dom, '授权并保存').onclick(); await saving;
    expect(writes[0].method).toBe('hooks.automation_settings');
    expect(f.project.automationSettings().completion_defaults).toEqual({ enabled: true, level: 'accept' });
    expect(f.project.taskHooks(old.id).completion.level).toBe('off');
    const fresh = (await f.project.order('future', 'main', [], null, false)).task;
    expect(f.project.taskHooks(fresh.id).completion.level).toBe('accept');
    await openProjectAutomation({ feature: 'acceptance_notice' });
    const notice = root.querySelector('[data-level="off"]'); await notice.onclick();
    await root.querySelectorAll('button').find(item => item.textContent === '保存项目设置').onclick();
    expect(f.project.automationSettings().acceptance_notice_defaults.enabled).toBe(false);
    expect(f.project.taskHooks(fresh.id).acceptance_notice.enabled).toBe(true);
    expect(writes.every(item => item.method === 'hooks.automation_settings')).toBe(true);
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
});

test('real scope defaults → HTTP-created orders/children → mounted projection → detail controls → persisted ACK', async () => {
  const f = await setup(); let dom, convergence;
  try {
    await repo(f.root); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
    const main = await f.project.bootstrapMain(), beforeMain = await f.project.branchConvergence('main');
    const writes = [];
    dom = installDom({ fetch: async (url, options = {}) => {
      if (options.body) writes.push(JSON.parse(options.body));
      return fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
    } });
    const root = dom.node('detail'), btn = label => root.querySelectorAll('button').find(item => item.textContent === label);
    const selectScope = value => { const select = root.querySelector('[aria-label="挂载范围"]'); select.value = value; select.onchange(); };
    const create = async content => {
      const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
        body: JSON.stringify({ method: 'order.submit', params: { content, start: false } }) });
      expect(response.ok).toBe(true); return (await response.json()).task;
    };
    await openProjectAutomation({ feature: 'completion' }); selectScope('none'); await root.querySelector('[data-level="merge"]').onclick();
    await btn('保存项目设置').onclick();
    expect(writes.at(-1).params.patch).toEqual({ mount_scopes: { completion: 'none' }, completion_defaults: { enabled: true, level: 'merge' } });
    const excluded = await create('scope excludes completion');
    expect(f.project.taskHooks(excluded.id)).toMatchObject({ mounted_features: { completion: false, push: false, convergence: true }, completion: { level: 'off' } });
    activateDetailView({ view: 'task', key: `task-${excluded.id}` }); root.replaceChildren(workerHooks(f.project.inspect(excluded.id)));
    expect(root.querySelector('[data-feature="completion"]')).toBeNull(); expect(root.querySelector('[data-feature="push"]')).toBeNull();
    await openProjectAutomation({ feature: 'completion' }); selectScope('user'); await btn('保存项目设置').onclick();
    await openProjectAutomation({ feature: 'acceptance_notice' }); selectScope('user'); await btn('保存项目设置').onclick();
    convergence = renderConvergenceAutomation({ ownsPage: () => true }); root.replaceChildren(convergence); await convergence.ready;
    selectScope('all'); await btn('保存新 Worker 归并默认').onclick();
    expect(writes.at(-1).method).toBe('branch.convergence_defaults_set');
    expect(writes.at(-1).params).toMatchObject({ mounted: true, scope: 'all', enabled: false });
    expect(await f.project.branchConvergence('main')).toEqual(beforeMain);
    const included = await create('scope includes completion');
    f.project.stopping = true; const child = await f.project.spawn(included.id, 'scoped child'); f.project.stopping = false;
    const childHooks = f.project.taskHooks(child.id);
    expect(childHooks.mounted_features).toEqual({ completion: true, acceptance_notice: false, convergence: true, push: false });
    expect(childHooks.completion).toMatchObject({ level: 'merge', locked: true });
    activateDetailView({ view: 'task', key: `task-${child.id}` }); root.replaceChildren(workerHooks(f.project.inspect(child.id)));
    expect(root.querySelector('[data-feature="acceptance_notice"]')).toBeNull();
    expect(root.querySelector('[data-feature="completion"]').querySelectorAll('button').every(item => item.disabled)).toBe(true);
    let refreshes = 0;
    const draw = () => root.replaceChildren(workerHooks(f.project.inspect(included.id), { refresh() { refreshes++; draw(); } }));
    activateDetailView({ view: 'task', key: `task-${included.id}` }); draw();
    const before = f.project.taskHooks(included.id);
    expect(before.mounted_features).toEqual({ completion: true, acceptance_notice: true, convergence: true, push: false });
    expect(root.querySelectorAll('.worker-automation-feature')).toHaveLength(3);
    await root.querySelector('[data-feature="completion"]').querySelector('[data-level="off"]').onclick();
    expect(writes.at(-1)).toEqual({ method: 'worker.completion', params: { id: included.id, level: 'off', expected_revision: before.revision } });
    expect(f.project.taskHooks(included.id).completion.level).toBe('off'); expect(refreshes).toBe(1);
    expect(root.querySelector('[data-level="off"]').getAttribute('aria-pressed')).toBe('true');
    expect(f.project.taskHooks(excluded.id).mounted_features.completion).toBe(false);
    expect(f.project.taskHooks(main.id).mounted_features.push).toBe(true);
  } finally { convergence?.dispose(); ui.disposeProjectAutomation?.(); dom?.restore(); f.project.stopping = false; await f.close(); }
});

test('real project push UI authorizes exact main mount only after confirmation, refuses deleted references and still permits stopping', async () => {
  const f = await setup(); let dom;
  try {
    await repo(f.root); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
    await f.project.bootstrapMain(); const example = f.project.commandHookExample();
    const writes = []; let incompatibleRead = false;
    dom = installDom({ fetch: async (url, options = {}) => {
      if (options.body) writes.push(JSON.parse(options.body));
      const response = await fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
      // Simulate an old/incomplete read projection, but mutations still traverse real HTTP/RPC/SQLite.
      if (incompatibleRead && String(url).endsWith('/api/hooks')) return Response.json({ ...await response.json(), commands: null });
      return response;
    } });
    await openProjectAutomation({ feature: 'push' });
    const btn = label => dom.node('detail').querySelectorAll('button').find(item => item.textContent === ({ '启用 Hook': '开启', '停用 Hook': '关闭' }[label] || label));
    const sourceRevision = f.project.taskHooks(example.worker_id).revision;
    expect(btn('启用 Hook').disabled).toBe(false);
    let saving = btn('启用 Hook').onclick(); await dialogButton(dom, '取消').onclick(); await saving; expect(writes).toHaveLength(0);
    saving = btn('启用 Hook').onclick(); await dialogButton(dom, '确认启用推送').onclick(); await saving;
    expect(writes).toEqual([{ method: 'worker.hook_update', params: { id: example.worker_id, hook_id: example.hook_id, enabled: true, expected_revision: sourceRevision } }]);
    expect(f.project.taskHooks(example.worker_id).mounts.find(item => item.id === example.hook_id).enabled).toBe(true);
    incompatibleRead = true; await btn('重新读取推送设置').onclick(); expect(btn('停用 Hook').disabled).toBe(false); await btn('停用 Hook').onclick();
    expect(writes).toHaveLength(2); expect(writes[1].params).toMatchObject({ id: example.worker_id, hook_id: example.hook_id, enabled: false });
    expect(btn('启用 Hook').disabled).toBe(true); expect(btn('启用 Hook').parentNode.getAttribute('data-help')).toContain('目录不可用');
    incompatibleRead = false;
    const commandId = example.hooks.mounts.find(item => item.id === example.hook_id).actions[0].command_id;
    f.project.removeShortcutCommand(commandId, f.project.shortcutCommands().revision);
    await btn('重新读取推送设置').onclick(); expect(btn('启用 Hook').disabled).toBe(true); expect(btn('启用 Hook').parentNode.getAttribute('data-help')).toContain('已删除');
    await btn('启用 Hook').onclick(); expect(writes).toHaveLength(2);
    expect(f.project.taskHooks(example.worker_id).mounts.find(item => item.id === example.hook_id).enabled).toBe(false);
    expect(f.store.history(example.worker_id).some(event => event.type === 'hook.command_submitted')).toBe(false);
    expect(dom.node('detail').querySelector('.push-history')).toBeNull();
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
});
