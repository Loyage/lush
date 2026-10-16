import { test, expect } from 'bun:test';
import { installDom, deepText, dialogButton } from '../dom-stub.js';
import { setup, fetch } from './harness.js';
import { repo, until, env, temp } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { startTestWeb } from './auth-fixture.js';
import { openCliInterfaces as openEditor } from '../../src/ui/web/assets/render-valet-settings.js';
import { registerPageLeaveGuard } from '../../src/ui/web/assets/page-leave-guard.js';
const openValetSettings = () => openEditor({ registerPageLeaveGuard });
import { ui } from '../../src/ui/web/assets/state.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';

for (const bound of [false, true]) test(`global page first default save works with ${bound ? 'all daemons offline' : 'no registered projects'} without project attachment`, async () => {
  const root = temp(), home = path.join(root, 'device'), environment = env({ LUSH_GLOBAL_CONFIG: home });
  const calls = [], writes = [], reads = [];
  const projectHost = { launcher: !bound,
    require() { calls.push('require'); throw Error('offline'); },
    openRoute() { calls.push('openRoute'); throw Error('offline'); } };
  const config = bound ? { project: path.join(root, 'offline'), home: path.join(root, 'offline', '.lush'), env: environment } : null;
  const web = startTestWeb(config, 0, { env: environment, projectHost }), url = `http://127.0.0.1:${web.port}`;
  let dom;
  try {
    const html = await (await fetch(url + '/')).text();
    const asset = /<meta id="cli-catalog-asset" content="([^\"]+)"/.exec(html)[1];
    dom = installDom({ fetch: (route, options) => {
      (options?.method === 'POST' ? writes : reads).push(String(route));
      return fetch(url + route, options);
    } });
    dom.node('cli-catalog-asset').setAttribute('content', asset);
    await openValetSettings(); expect(reads).toEqual([asset]);
    const button = text => dom.node('detail').querySelectorAll('button').find(node => node.textContent === text);
    await button('读取全局权限').onclick();
    expect(deepText(dom.node('detail'))).toContain('不代表任何项目实际授权');
    expect(button('保存全局管家权限').disabled).toBe(false);
    const cancelled = button('保存全局管家权限').onclick(); await dialogButton(dom, '取消').onclick(); await cancelled;
    expect(writes).toEqual([]); expect(fs.existsSync(path.join(home, 'shared', 'management-permissions.json'))).toBe(false);
    const saving = button('保存全局管家权限').onclick(); await dialogButton(dom, '确认全局生效').onclick(); await saving;
    expect(writes).toEqual(['/api/host/management/permissions']);
    expect(deepText(dom.node('detail'))).toContain('已保存设备全局管家权限');
    expect(dom.node('detail').querySelector('.cli-permissions-unconfigured').hidden).toBe(true);
    const saved = await (await fetch(url + '/api/host/management/permissions')).json();
    expect(saved.configured).toBe(true); expect(saved.scope).toBe('device');
    expect(saved.permissions).toEqual(Object.fromEntries(saved.methods.map(item => [item.method, item.base_access])));
    expect(calls).toEqual([]); expect(reads).toEqual([asset, '/api/host/management/permissions']);
  } finally { ui.disposeValetSettings?.(); dom?.restore(); await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

// Real global page -> Host HTTP/user authorization -> device policy
// -> restricted Provider/tool bridge. Historical snapshots are receipts, not proof
// of effective authorization. Both a queued Valet and its pending request observe
// changes saved by the actual page. No paid model or user daemon.
for (const outcome of ['approved', 'revoked']) test(`page policy applies to an existing queued Valet through the real bridge, pending request ${outcome}`, async () => {
  const f = await setup(); f.project.kick = () => {}; f.project.startManagementPermissionsMonitor();
  let dom;
  const post = (method, params) => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  try {
    await repo(f.root);
    const host = await (await fetch(f.url + '/api/host/projects')).json();
    const projectId = host.projects.find(item => item.project === f.root).id;
    const html = await (await fetch(`${f.url}/p/${projectId}/`)).text();
    const asset = /<meta id="cli-catalog-asset" content="([^\"]+)"/.exec(html)[1];
    const reads = [];
    dom = installDom({ fetch: (path, options) => { if (!options?.method) reads.push(String(path)); return fetch(f.url + String(path), options); } }); dom.location.pathname = '/';
    dom.node('cli-catalog-asset').setAttribute('content', asset);
    await openValetSettings(); expect(reads).toEqual([asset]);
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '读取全局权限').onclick();
    const before = f.project.managementPermissions();
    const oldResponse = await post('management.submit', { instruction: 'existing queued Valet', profile: { agent: 'pi', config_mode: 'pi' } });
    expect(oldResponse.status).toBe(200);
    const old = await oldResponse.json();
    const historicalSnapshot = JSON.parse(f.store.task(old.task.id).management).permissions_snapshot;
    const input = dom.node('detail').querySelector('input'); input.value = 'order'; input.oninput({});
    dom.node('detail').querySelector('.cli-command-link').onclick();
    const select = dom.node('detail').querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select');
    select.value = 'confirmation'; select.onchange();
    const firstSave = dom.node('detail').querySelectorAll('button').find(node => node.textContent === '保存全局管家权限').onclick();
    await dialogButton(dom, '确认全局生效').onclick(); await firstSave;
    expect(deepText(dom.node('detail'))).toContain('已保存设备全局管家权限，此设备用户所有项目的新旧管家均生效');
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '重新读取全局权限').onclick();
    expect(deepText(dom.node('detail'))).toContain('已读取设备全局管家权限；适用于此设备用户所有项目的新旧管家。');
    expect(dom.node('detail').querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select').value).toBe('confirmation');
    expect(reads).toEqual([asset, '/api/host/management/permissions', '/api/host/management/permissions']);
    const stored = f.project.managementPermissions(); expect(stored.permissions['draft.add']).toBe('confirmation');
    expect(stored.revision).not.toBe(before.revision); expect(Object.keys(stored.permissions)).toEqual(Object.keys(before.permissions));
    expect(JSON.parse(f.store.task(old.task.id).management).permissions_snapshot).toEqual(historicalSnapshot);
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([{ name: 'manager_catalog', params: {} }, { name: 'manager_call', params: { method: 'draft.add', params: { content: 'page controlled write', branch: 'main' } }, callId: 'page-draft' },
      { name: 'manager_call', params: { method: 'cli.catalog', params: {} } }]);
    const definition = { instruction: 'page policy probe', profile: { agent: 'pi', config_mode: 'pi' } };
    // Global permissions remain editable while a queued occurrence owns the lane,
    // but a new Valet identity requires safe settlement, not a database status hack.
    const blocked = await post('management.submit', definition); expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain('已有管家');
    const manager = old.task;
    expect(f.project.managementOccupant().id).toBe(manager.id);
    // This same identity predates the page save; its historical automatic policy
    // must not bypass the newly configured confirmation requirement.
    expect(JSON.parse(f.store.task(old.task.id).management).permissions_snapshot.permissions['draft.add']).toBe('automatic');
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const result = JSON.parse(f.store.task(manager.id).result);
    expect(result.replies[0].response.details.methods.find(item => item.method === 'draft.add').access).toBe('confirmation');
    expect(result.replies[2].response).toBeUndefined(); expect(result.replies[2].error).toContain('管理请求被拒绝');
    const receipt = result.replies[1].response.details; expect(receipt.status).toBe('pending_confirmation'); expect(f.store.draftCount()).toBe(0);
    if (outcome === 'revoked') {
      const currentSelect = dom.node('detail').querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select');
      currentSelect.value = 'unavailable'; currentSelect.onchange();
      await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '保存全局管家权限').onclick();
      await until(() => JSON.parse(f.store.task(manager.id).management).control_calls[0].status === 'rejected');
      await Promise.all([...(f.project.managementControlJobs ?? [])]);
      expect(JSON.parse(f.store.task(manager.id).management).control_calls[0].status).toBe('rejected');
      expect(f.store.get('SELECT status FROM notices WHERE id=?', receipt.notice_id).status).toBe('dismissed');
    }
    expect((await post('notice.answer', { id: receipt.notice_id, answer: { answers: [{ selected: [1], custom: '' }] } })).status).toBe(outcome === 'approved' ? 200 : 400);
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.store.draftCount()).toBe(outcome === 'approved' ? 1 : 0);
    expect(f.project.managementOccupant()).toBeNull();
    expect(JSON.parse(f.store.task(manager.id).management).permissions_snapshot).toEqual(historicalSnapshot);
  } finally { ui.disposeValetSettings?.(); dom?.restore(); await f.close(); }
});
