import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { mountCard, workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { ui } from '../../src/ui/web/assets/state.js';

test('real automation DOM saves project defaults through HTTP/RPC and applies them to future Workers', async () => {
  const f = await setup(); let dom;
  try {
    await repo(f.root); f.project.kick = () => {};
    const old = (await f.project.order('existing', 'main', [], null, false)).task;
    const writes = [];
    dom = installDom({ fetch: (url, options = {}) => {
      if (options.body) writes.push(JSON.parse(options.body));
      return fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
    } });
    await openProjectAutomation({ feature: 'completion' });
    const root = dom.node('detail'); await root.querySelector('[data-level="accept"]').onclick();
    const saving = root.querySelectorAll('button').find(item => item.textContent === '保存项目设置').onclick();
    await dialogButton(dom, '授权并保存').onclick(); await saving;
    expect(writes[0].method).toBe('hooks.automation_settings');
    expect(f.project.automationSettings().completion_defaults).toEqual({ enabled: true, level: 'accept' });
    expect(f.project.taskHooks(old.id).completion.level).toBe('off');
    const fresh = (await f.project.order('future', 'main', [], null, false)).task;
    expect(f.project.taskHooks(fresh.id).completion.level).toBe('accept');
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
});

const press = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label).onclick();
const set = (root, label, value) => { const input = root.querySelector(`[aria-label="${label}"]`); input.value = value; input.onchange?.(); return input; };

for (const registrationKind of ['rule', 'shell']) test(`real page DOM → HTTP/RPC ${registrationKind} registers separately, mounts fixed version, revises and explicitly upgrades`, async () => {
  const f = await setup(); let dom;
  try {
    await repo(f.root); f.project.kick = () => {}; const main = await f.project.bootstrapMain();
    const task = (await f.project.order('Registry target', 'main', [], null, false)).task;
    const writes = [];
    dom = installDom({ fetch: (url, options = {}) => {
      if (options.body) writes.push(JSON.parse(options.body));
      return fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
    } });
    await openProjectAutomation({ feature: 'register' }); const root = dom.node('detail');
    if (registrationKind === 'shell') {
      set(root, '登记方式', 'shell'); set(root, '功能名称', '独立登记通知'); set(root, '指令名称', '安全空命令'); set(root, 'Shell 指令正文', 'printf registry-no-run');
    } else {
      set(root, 'Hook 名称', '独立登记通知'); set(root, '触发节点', 'agent.returned'); set(root, '动作类型', 'notify'); set(root, '告知标题', 'registry'); set(root, '消息或告知正文', 'No execution during registration');
    }
    let saving = press(root, '确认登记功能'); await dialogButton(dom, '只登记功能').onclick(); await saving;
    let catalogue = f.project.hooksList(); const registered = catalogue.registry.items.find(item => item.name === '独立登记通知');
    if (!registered) throw Error(`Registration failed: ${root.querySelectorAll('[role="status"]').at(-1)?.textContent}; methods=${writes.map(write => write.method).join(',')}`);
    expect(registered.mount_count).toBe(0); expect(registered.version).toBe(1);
    expect(f.project.taskHooks(main.id).mounts.some(mount => mount.registry_id === registered.id)).toBe(false);
    expect(writes.map(write => write.method)).toEqual([registrationKind === 'shell' ? 'hooks.register' : 'hooks.save']);
    await openProjectAutomation(); expect(deepText(root)).toContain('独立登记通知');
    await openProjectAutomation({ feature: registered.id }); await press(root, '读取 Worker 列表');
    expect(root.querySelector('[aria-label="选择目标 Worker"]').value).toBe('');
    const target = root.querySelector('[aria-label="选择目标 Worker"]'); target.value = String(task.id); await target.onchange();
    expect(root.querySelector('[aria-label="授权版本"]').value).toBe('');
    set(root, '授权版本', '1'); saving = press(root, '确认挂载'); await dialogButton(dom, '授权挂载').onclick(); await saving;
    let model = f.project.taskHooks(task.id), mount = model.mounts.find(mount => mount.registry_id === registered.id);
    expect(mount.registry_version).toBe(1); expect(mount.enabled).toBe(false);
    expect(writes.at(-1).params.hook).toEqual({ template_id: registered.id, template_version: 1, enabled: false });
    const worker = workerHooks({ ...task, hooks: model }); expect(deepText(worker)).toContain(`自定义 · ${registered.id} · 固定 v1`);
    expect(deepText(worker)).not.toContain('新建自定义规则'); expect(deepText(worker)).not.toContain('编辑挂载');
    set(root, 'Hook 名称', '独立登记通知 v2'); saving = press(root, '登记新版本'); await dialogButton(dom, '只登记功能').onclick(); await saving;
    catalogue = f.project.hooksList(); expect(catalogue.registry.items.find(item => item.id === registered.id).versions).toEqual([1, 2]);
    model = f.project.taskHooks(task.id); expect(model.mounts.find(item => item.id === mount.id).registry_version).toBe(1);
    let refreshed;
    const card = mountCard(task, mount, model, next => { refreshed = next; }, () => true, { catalogue });
    await press(card, '选择登记版本升级'); set(card, '授权版本', '2'); saving = press(card, '确认升级挂载版本'); await dialogButton(dom, '授权升级版本').onclick(); await saving;
    expect(refreshed.mounts.find(item => item.id === mount.id).registry_version).toBe(2);
    expect(f.project.taskHooks(task.id).mounts.find(item => item.id === mount.id).name).toBe('独立登记通知 v2');
    expect(writes.map(write => write.method)).toEqual([registrationKind === 'shell' ? 'hooks.register' : 'hooks.save', 'worker.hook_attach', 'hooks.save', 'worker.hook_update']);
    if (registrationKind === 'shell') expect(f.project.hooksList().commands.items.find(item => item.name === '安全空命令').last_execution).toBeNull();
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
});
