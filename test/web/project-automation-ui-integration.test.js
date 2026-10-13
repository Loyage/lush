import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { installDom, dialogButton } from '../dom-stub.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { ui } from '../../src/ui/web/assets/state.js';

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
    const root = dom.node('detail'), choice = root.querySelector('[aria-label="用户新建 Worker 默认开启到"]');
    choice.value = 'accept'; choice.onchange();
    const saving = root.querySelectorAll('button').find(item => item.textContent === '保存项目设置').onclick();
    await dialogButton(dom, '授权并保存').onclick(); await saving;
    expect(writes[0].method).toBe('hooks.automation_settings');
    expect(f.project.automationSettings().completion_defaults).toEqual({ enabled: true, level: 'accept' });
    expect(f.project.taskHooks(old.id).completion.level).toBe('off');
    const fresh = (await f.project.order('future', 'main', [], null, false)).task;
    expect(f.project.taskHooks(fresh.id).completion.level).toBe('accept');
    await openProjectAutomation({ feature: 'acceptance_notice' });
    const notice = root.querySelector('[aria-label="用户新建 Worker 默认待验收告知"]'); notice.value = 'off'; notice.onchange();
    await root.querySelectorAll('button').find(item => item.textContent === '保存项目设置').onclick();
    expect(f.project.automationSettings().acceptance_notice_defaults.enabled).toBe(false);
    expect(f.project.taskHooks(fresh.id).acceptance_notice.enabled).toBe(true);
    expect(writes.every(item => item.method === 'hooks.automation_settings')).toBe(true);
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
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
    const btn = label => dom.node('detail').querySelectorAll('button').find(item => item.textContent === label);
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
