import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo, until } from '../helpers.js';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { mountCard, workerHooks } from '../../src/ui/web/assets/render-hooks.js';
import { openProjectAutomation } from '../../src/ui/web/assets/render-project-automation.js';
import { ui } from '../../src/ui/web/assets/state.js';
import { deliveryControls } from '../../src/ui/web/assets/render-delivery.js';
import { registeredMountPicker } from '../../src/ui/web/assets/automation-registry.js';

test('real automation DOM saves project defaults through HTTP/RPC and applies them to future Workers', async () => {
  const f = await setup(); let dom;
  try {
    await repo(f.root); f.project.kick = () => {};
    const old = (await f.project.order('existing', 'main', [], null, false)).task;
    const writes = []; let releaseSave;
    dom = installDom({ fetch: (url, options = {}) => {
      const write = options.body ? JSON.parse(options.body) : null;
      if (write) writes.push(write);
      const response = fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
      if (write?.method === 'hooks.automation_settings') return new Promise(resolve => { releaseSave = () => resolve(response); });
      return response;
    } });
    await openProjectAutomation();
    const root = dom.node('detail'), tools = root.querySelector('.ui-list-tools');
    expect(tools.querySelector('[aria-label="查找自动化功能"]')).not.toBeNull();
    expect(tools.querySelector('[aria-label="包含已回收临时项"]')).not.toBeNull();
    expect(deepText(tools)).toContain('登记新功能');
    expect(deepText(root.querySelector('.ui-list-pagination'))).toContain('目录已完整读取');
    await openProjectAutomation({ feature: 'completion' });
    const settings = root.querySelector('.automation-settings-panel');
    expect(settings.classList.contains('ui-module')).toBe(true);
    expect(settings.querySelector('.module-body').hidden).toBe(false);
    expect(root.querySelector('.automation-principle').open).not.toBe(true);
    await root.querySelector('[data-level="accept"]').onclick();
    settings.querySelector('.module-toggle').onclick();
    expect(settings.querySelector('.module-body').hidden).toBe(true);
    expect(root.querySelector('[data-level="accept"]').getAttribute('aria-pressed')).toBe('true');
    expect(settings.querySelector('.automation-settings-feedback').parentNode).toBe(settings);
    await openProjectAutomation(); await openProjectAutomation({ feature: 'completion' });
    expect(root.querySelector('.automation-settings-panel')).toBe(settings);
    expect(settings.querySelector('.module-body').hidden).toBe(true);
    settings.querySelector('.module-toggle').onclick();
    const save = root.querySelectorAll('button').find(item => item.textContent === '保存项目设置');
    const saving = save.onclick();
    await dialogButton(dom, '授权并保存').onclick(); await until(() => releaseSave);
    expect(save.textContent).toBe('保存中…'); expect(save.disabled).toBe(true);
    expect(root.querySelector('.automation-settings-status').textContent).toBe('正在保存项目设置…');
    await save.onclick(); expect(writes).toHaveLength(1); releaseSave(); await saving;
    expect(save.textContent).toBe('保存项目设置'); expect(save.disabled).toBe(true); // clean draft remains gated
    expect(writes[0].method).toBe('hooks.automation_settings');
    expect(f.project.automationSettings().completion_defaults).toEqual({ enabled: true, level: 'accept' });
    expect(f.project.taskHooks(old.id).completion.level).toBe('off');
    const fresh = (await f.project.order('future', 'main', [], null, false)).task;
    expect(f.project.taskHooks(fresh.id).completion.level).toBe('accept');
    // Reuse the real settings flow for compact Worker controls and their existing save gates.
    ui.view = { id: 'task', key: String(old.id) };
    let worker;
    const refresh = () => { worker = workerHooks({ ...old, hooks: f.project.taskHooks(old.id) }, { refresh }); root.replaceChildren(worker); };
    refresh();
    expect(worker.classList.contains('ui-module')).toBe(true);
    expect(worker.querySelector('.module-body').hidden).toBe(true);
    expect(worker.querySelector('.module-body').querySelector('[data-level="merge"]')).toBeNull();
    expect(worker.querySelector('.hook-management-toggle')).toBeNull();
    expect(worker.querySelector('[data-level="merge"]').classList.contains('agent-call')).toBe(false);
    await worker.querySelector('[data-level="merge"]').onclick();
    expect(f.project.taskHooks(old.id).completion.level).toBe('merge');
    expect(worker.querySelector('.module-body').hidden).toBe(true);
    worker.querySelector('.module-toggle').onclick();
    const management = worker.querySelector('.hook-management');
    expect(management.open).toBe(true);
    refresh(); expect(worker.querySelector('.hook-management').open).toBe(true);
    const accepting = worker.querySelector('[data-level="accept"]').onclick();
    expect(dialogButton(dom, '授权自动验收').classList.contains('agent-call')).toBe(false);
    await dialogButton(dom, '授权自动验收').onclick(); await accepting;
    expect(f.project.taskHooks(old.id).completion.level).toBe('accept');
    expect(writes.slice(-2).map(write => write.method)).toEqual(['worker.completion', 'worker.completion']);
    worker.querySelector('.module-toggle').onclick();
    expect(worker.querySelector('.module-body').hidden).toBe(true);
    worker.querySelector('.hook-management').open = true;
    expect(worker.querySelector('.module-body').hidden).toBe(false);
    const delivery = deliveryControls({ ...old, status: 'waiting', merge_readiness: { ready: true } });
    root.append(delivery); const merge = delivery.querySelectorAll('button').find(node => node.textContent === '合并');
    expect(merge.classList.contains('agent-call')).toBe(false);
    const merging = merge.onclick();
    expect(dialogButton(dom, '合并').classList.contains('agent-call')).toBe(false);
    await dialogButton(dom, '取消').onclick(); await merging;
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
});

const press = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label).onclick();
const set = (root, label, value) => { const input = root.querySelector(`[aria-label="${label}"]`); input.value = value; input.onchange?.(); return input; };

for (const registrationKind of ['rule', 'shell']) test(`real page DOM → HTTP/RPC ${registrationKind} registers separately, mounts fixed version, revises and explicitly upgrades`, async () => {
  const f = await setup(); let dom;
  try {
    await repo(f.root); f.project.kick = () => {}; const main = await f.project.bootstrapMain();
    const task = (await f.project.order('Registry target', 'main', [], null, false)).task;
    const writes = [], reads = []; let smallPages = false, failNextDirectory = false, holdNextHistory = false, releaseHistory;
    dom = installDom({ fetch: (url, options = {}) => {
      if (options.body) { const write = JSON.parse(options.body); writes.push(write); if (write.method === 'hooks.temporary_reclaim') failNextDirectory = true; }
      if (failNextDirectory && url.startsWith('/api/hooks?')) { failNextDirectory = false; throw Error('injected read failure after committed reclaim'); }
      if (smallPages && url.startsWith('/api/hooks?')) url += '&limit=2';
      if (smallPages && url.startsWith('/api/hooks/temporary/history?')) url += '&limit=2';
      reads.push(url);
      const response = fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
      if (holdNextHistory && url.startsWith('/api/hooks/temporary/history?')) { holdNextHistory = false; return new Promise(resolve => { releaseHistory = async () => resolve(await response); }); }
      return response;
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
    await openProjectAutomation({ feature: registered.id });
    expect(root.querySelector('.registry-mount').classList.contains('ui-module')).toBe(true);
    expect(root.querySelector('.registry-mount').querySelector('.module-body').hidden).toBe(false);
    expect(root.querySelector('.registry-advanced').open).not.toBe(true);
    await press(root, '读取 Worker 列表');
    expect(root.querySelector('[aria-label="选择目标 Worker"]').value).toBe('');
    const target = root.querySelector('[aria-label="选择目标 Worker"]'); target.value = String(task.id); await target.onchange();
    expect(root.querySelector('[aria-label="授权版本"]').value).toBe('');
    const version = set(root, '授权版本', '1'), mountPanel = root.querySelector('.registry-mount');
    mountPanel.querySelector('.module-toggle').onclick();
    expect(mountPanel.querySelector('.module-body').hidden).toBe(true);
    expect(mountPanel.querySelector('[role="status"]').parentNode).toBe(mountPanel);
    mountPanel.querySelector('.module-toggle').onclick();
    expect(root.querySelector('[aria-label="授权版本"]')).toBe(version);
    expect(version.value).toBe('1');
    saving = press(root, '确认挂载'); await dialogButton(dom, '授权挂载').onclick(); await saving;
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
    if (registrationKind === 'rule') {
      smallPages = true;
      // A user/Valet-created temporary definition enters the same real UI/HTTP chain.
      const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'hooks.temporary_create', params: {
        hook: { name: '本次临时告知', trigger: 'agent.returned', actions: [{ type: 'notify', title: 'temporary-ui', body: '本次使用' }] },
        expected_revisions: { registry: f.project.hooksList().registry.revision }, client_request_id: 'ui-temporary',
      } }) });
      expect(response.status).toBe(200); const temporary = await response.json();
      await press(root, '← 返回自动化功能列表'); await press(root, '刷新目录');
      expect(deepText(root)).toContain('目录未列全');
      while (!root.querySelectorAll('button').find(item => item.textContent === '继续读取功能').hidden) await press(root, '继续读取功能');
      const row = root.querySelector(`[data-feature="${temporary.template_id}"]`); expect(deepText(row)).toContain('临时'); expect(deepText(row)).toContain('0 个挂载');
      catalogue = f.project.hooksList();
      const firstPage = await (await fetch(f.url + '/api/hooks?limit=2')).json();
      const picker = registeredMountPicker({ catalogue: firstPage, workerId: task.id, model: f.project.taskHooks(task.id) });
      expect(deepText(picker)).toContain('可选目录未列全');
      while (!picker.querySelectorAll('button').find(item => item.textContent === '继续读取可挂载功能').hidden) await press(picker, '继续读取可挂载功能');
      expect(deepText(picker.querySelector('[aria-label="已登记功能"]'))).toContain('本次临时告知 · 临时');
      await openProjectAutomation({ feature: temporary.template_id });
      expect(deepText(root)).toContain('实际挂载 0'); expect(deepText(root)).not.toContain('系统登记只读');
      holdNextHistory = true; const reading = press(root, '只读刷新使用状态');
      await openProjectAutomation(); await openProjectAutomation({ feature: temporary.template_id });
      await releaseHistory(); await reading;
      expect(deepText(root)).toContain('旧响应不作为新核验');
      expect(root.querySelectorAll('button').find(item => item.textContent === '安全回收临时功能').disabled).toBe(true);
      await press(root, '只读刷新使用状态');
      await press(root, '读取 Worker 列表'); const target = root.querySelector('[aria-label="选择目标 Worker"]'); target.value = String(task.id); await target.onchange(); set(root, '授权版本', '1');
      saving = press(root, '确认挂载'); await dialogButton(dom, '授权挂载').onclick(); await saving;
      expect(root.querySelectorAll('button').find(item => item.textContent === '安全回收临时功能').disabled).toBe(true);
      expect(deepText(root)).toContain('残留挂载（含停用）');
      let tempModel = f.project.taskHooks(task.id), tempMount = tempModel.mounts.find(item => item.registry_id === temporary.template_id);
      // The existing Worker UI enables the mount, then a real lifecycle event runs it once.
      const tempCard = mountCard(task, tempMount, tempModel, () => {}, () => true, { catalogue });
      await press(tempCard, '启用 Hook');
      f.project.emitTaskHook(task.id, 'agent.returned'); await f.project.hookQueue;
      await press(root, '只读刷新使用状态'); expect(deepText(root)).toContain('累计挂载 1 · 成功 1');
      expect(deepText(root)).toContain('仍有更早记录'); await press(root, '读取更早使用审计');
      expect(reads.some(url => url.includes('/temporary/history?') && url.includes('&before='))).toBe(true);
      expect(f.project.taskHooks(task.id).mounts.some(item => item.registry_id === temporary.template_id)).toBe(false);
      saving = press(root, '安全回收临时功能'); await dialogButton(dom, '确认安全回收').onclick(); await saving;
      expect(deepText(root)).toContain('安全回收成功'); expect(deepText(root)).toContain('刷新失败'); expect(root.querySelector('.registry-mount').hidden).toBe(true);
      await press(root, '安全回收临时功能'); expect(writes.filter(write => write.method === 'hooks.temporary_reclaim')).toHaveLength(1);
      await openProjectAutomation(); await press(root, '刷新目录'); expect(root.querySelector(`[data-feature="${temporary.template_id}"]`)).toBeNull();
      const include = root.querySelector('[aria-label="包含已回收临时项"]'); include.checked = true; await include.onchange();
      while (!root.querySelectorAll('button').find(item => item.textContent === '继续读取功能').hidden) await press(root, '继续读取功能');
      expect(deepText(root.querySelector(`[data-feature="${temporary.template_id}"]`))).toContain('已回收 · 只读');
      await openProjectAutomation({ feature: temporary.template_id }); await press(root, '只读刷新使用状态');
      await press(root, '读取更早使用审计');
      expect(deepText(root)).toContain('hook.execution_succeeded'); expect(root.querySelector('.registry-mount')?.hidden ?? true).toBe(true);
      expect(f.project.hooksList().registry.items.find(item => item.id === registered.id).temporary).toBe(false);
    }
  } finally { ui.disposeProjectAutomation?.(); dom?.restore(); await f.close(); }
});
