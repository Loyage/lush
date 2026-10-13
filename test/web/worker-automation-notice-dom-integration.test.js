import { test, expect, setDefaultTimeout } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { repo, until } from '../helpers.js';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';
import { ui } from '../../src/ui/web/assets/state.js';
setDefaultTimeout(20000);

test('Worker DOM → authenticated HTTP → registered user RPC → persisted notice switch returns exact fresh hooks, without unlocking child completion', async () => {
  const f = await setup(); let dom;
  f.project.kick = () => {};
  try {
    await repo(f.root);
    const parent = (await f.project.order('parent', 'main', [], null, false)).task;
    f.project.stopping = true;
    const child = await f.project.spawn(parent.id, 'child');
    f.project.stopping = false;
    const requests = [];
    dom = installDom({ fetch: async (url, options) => {
      const route = String(url), body = options?.body ? JSON.parse(options.body) : null;
      requests.push({ route, body });
      return httpFetch(f.url + route, { ...options, headers: { ...options?.headers, Origin: f.url } });
    } });
    activateDetailView({ view: 'task', key: `task-${child.id}` });
    const panel = dom.node('detail'); let refreshed = 0;
    const draw = () => panel.replaceChildren(workerHooks(f.project.inspect(child.id), { refresh: () => { refreshed++; draw(); } }));
    draw();
    const feature = () => panel.querySelector('[data-feature="acceptance_notice"]');
    const button = enabled => feature().querySelector(`[data-notice-enabled="${enabled}"]`);
    const before = f.project.taskHooks(child.id), notices = f.store.all('SELECT * FROM notices');
    expect(before.acceptance_notice.enabled).toBe(false); expect(before.completion.locked).toBe(true);
    expect(button(true).disabled).toBe(false);
    await button(true).onclick();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ route: '/api/action', body: { method: 'worker.acceptance_notice', params: { id: child.id, enabled: true, expected_revision: before.revision } } });
    const saved = f.project.taskHooks(child.id);
    expect(saved.acceptance_notice.enabled).toBe(true); expect(saved.revision).not.toBe(before.revision);
    expect(saved.completion).toMatchObject({ level: 'merge', locked: true, editable: false });
    expect(button(true).getAttribute('aria-pressed')).toBe('true'); expect(refreshed).toBe(1);
    expect(f.store.all('SELECT * FROM notices')).toEqual(notices); // Settings do not generate/backfill success.
    expect(f.store.history(child.id).filter(event => event.type === 'task.acceptance_notice_changed')).toHaveLength(1);
    await button(false).onclick(); expect(requests[1].body.params.expected_revision).toBe(saved.revision);
    expect(f.project.taskHooks(child.id).acceptance_notice.enabled).toBe(false); expect(refreshed).toBe(2);
    expect(deepText(panel.querySelector('[data-feature="completion"]'))).toContain('成果自动合并与验收');
  } finally { closeDialog(); dom?.restore(); f.project.stopping = false; await f.close(); }
});

test('real main push identity → Worker DOM → HTTP user mutation → persisted exact Hook; deletion never selects a same-name replacement', async () => {
  const f = await setup(); let dom;
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    f.store.create({ role: 'agent', task_kind: 'order', goal: 'not main despite its ID' });
    await repo(f.root); const main = await f.project.bootstrapMain();
    expect(main.id).not.toBe(1);
    const before = f.project.taskHooks(main.id), savedId = before.push.hook_id;
    const original = before.mounts.find(item => item.id === savedId), requests = [];
    expect(before.push.worker_id).toBe(main.id); expect(original.enabled).toBe(false);
    dom = installDom({ fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null; requests.push({ route: String(url), body });
      return httpFetch(f.url + url, { ...options, headers: { ...options?.headers, Origin: f.url } });
    } });
    ui.hookCatalogue = null; activateDetailView({ view: 'task', key: `task-${main.id}` });
    const panel = dom.node('detail'); let refreshed = 0;
    const draw = () => panel.replaceChildren(workerHooks(f.project.inspect(main.id), { refresh() { refreshed++; draw(); } }));
    const control = label => panel.querySelector('[data-feature="push"]').querySelectorAll('button').find(item => item.textContent === label);
    draw(); expect(requests).toEqual([]); expect(control('开启推送').disabled).toBe(false);
    const notices = f.store.all('SELECT * FROM notices'), executions = f.store.history(main.id).filter(item => item.type.startsWith('hook.execution'));
    const enabling = control('开启推送').onclick(); await until(() => dialogButton(dom, '启用指令 Hook'));
    expect(dialogButton(dom, '启用指令 Hook').classList.contains('agent-call')).toBe(false);
    await dialogButton(dom, '启用指令 Hook').onclick(); await enabling;
    expect(requests.filter(item => item.body)).toEqual([{ route: '/api/action', body: { method: 'worker.hook_update',
      params: { id: main.id, hook_id: savedId, enabled: true, expected_revision: before.revision } } }]);
    const saved = f.project.taskHooks(main.id); expect(saved.mounts.find(item => item.id === savedId).enabled).toBe(true);
    expect(saved.revision).not.toBe(before.revision); expect(refreshed).toBe(1); expect(control('关闭推送')).toBeTruthy();
    expect(f.store.all('SELECT * FROM notices')).toEqual(notices);
    expect(f.store.history(main.id).filter(item => item.type.startsWith('hook.execution'))).toEqual(executions);
    f.project.removeTaskHook(main.id, savedId, saved.revision);
    const next = f.project.attachTaskHook(main.id, { name: original.name, trigger: original.trigger, mode: original.mode, enabled: false, actions: original.actions }, f.project.taskHooks(main.id).revision);
    const replacement = next.mounts.find(item => item.name === original.name); expect(replacement.id).not.toBe(savedId);
    draw(); expect(control('开启推送')).toBeUndefined(); expect(deepText(panel)).toContain('不会自动重装');
    expect(f.project.taskHooks(main.id).push.hook_id).toBe(savedId);
    expect(f.project.taskHooks(main.id).mounts.find(item => item.id === replacement.id).enabled).toBe(false);
    expect(requests.filter(item => item.body)).toHaveLength(1);
  } finally { closeDialog(); dom?.restore(); await f.close(); }
});
