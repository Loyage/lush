import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { openCliInterfaces as openEditor } from '../../src/ui/web/assets/render-valet-settings.js';
import { registerPageLeaveGuard } from '../../src/ui/web/assets/page-leave-guard.js';
const openValetSettings = () => openEditor({ registerPageLeaveGuard });
import { ui } from '../../src/ui/web/assets/state.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';

// Real page -> HTTP -> RPC registry/user authorization -> SQLite defaults -> new
// Valet snapshot -> restricted Provider/tool bridge. No paid model or user daemon.
test('page edits real directory and persists defaults used by new Valet and real bridge, existing snapshot stays frozen', async () => {
  const f = await setup(); f.project.kick = () => {};
  let dom;
  const post = (method, params) => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  try {
    await repo(f.root);
    const host = await (await fetch(f.url + '/api/host/projects')).json();
    const projectId = host.projects.find(item => item.project === f.root).id;
    dom = installDom({ fetch: (path, options) => fetch(f.url + String(path), options) }); dom.location.pathname = `/p/${projectId}/`;
    await openValetSettings();
    const before = f.project.managementPermissions();
    const oldResponse = await post('management.submit', { instruction: 'old permission snapshot' });
    expect(oldResponse.status).toBe(200);
    const old = await oldResponse.json();
    const input = dom.node('detail').querySelector('input'); input.value = 'order'; input.oninput({});
    dom.node('detail').querySelector('.cli-command-link').onclick();
    const select = dom.node('detail').querySelectorAll('.cli-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select');
    select.value = 'confirmation'; select.onchange();
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '保存管家默认权限').onclick();
    expect(deepText(dom.node('detail'))).toContain('已保存');
    const stored = f.project.managementPermissions(); expect(stored.permissions['draft.add']).toBe('confirmation');
    expect(stored.revision).not.toBe(before.revision); expect(Object.keys(stored.permissions)).toEqual(Object.keys(before.permissions));
    expect(JSON.parse(f.store.task(old.task.id).management).permissions_snapshot.permissions['draft.add']).toBe('automatic');
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([{ name: 'manager_catalog', params: {} }, { name: 'manager_call', params: { method: 'draft.add', params: { content: 'page controlled write', branch: 'main' } }, callId: 'page-draft' },
      { name: 'manager_call', params: { method: 'cli.catalog', params: {} } }]);
    const definition = { instruction: 'page policy probe', profile: { agent: 'pi', config_mode: 'pi' } };
    // Defaults remain editable while a queued occurrence owns the project lane,
    // but a new Valet identity requires safe settlement, not a database status hack.
    const blocked = await post('management.submit', definition); expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain('已有管家');
    expect((await post('worker.cancel', { id: old.task.id })).status).toBe(200);
    expect(f.project.managementOccupant()).toBeNull();
    const submitted = await post('management.submit', definition); expect(submitted.status).toBe(200);
    const manager = (await submitted.json()).task;
    expect(JSON.parse(f.store.task(manager.id).management).permissions_snapshot).toMatchObject({ scope: 'project', revision: stored.revision, permissions: stored.permissions });
    expect(JSON.parse(f.store.task(old.task.id).management).permissions_snapshot.permissions['draft.add']).toBe('automatic');
    expect((await post('management.permissions_update', { permissions: before.permissions, expected_revision: stored.revision })).status).toBe(200);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const result = JSON.parse(f.store.task(manager.id).result);
    expect(result.replies[0].response.details.methods.find(item => item.method === 'draft.add').access).toBe('confirmation');
    expect(result.replies[2].response).toBeUndefined(); expect(result.replies[2].error).toContain('管理请求被拒绝');
    const receipt = result.replies[1].response.details; expect(receipt.status).toBe('pending_confirmation'); expect(f.store.draftCount()).toBe(0);
    expect((await post('notice.answer', { id: receipt.notice_id, answer: { answers: [{ selected: [1], custom: '' }] } })).status).toBe(200);
    await Promise.all([...(f.project.managementControlJobs ?? [])]); expect(f.store.draftCount()).toBe(1);
  } finally { ui.disposeValetSettings?.(); dom?.restore(); await f.close(); }
});
