import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { openValetSettings as openEditor } from '../../src/ui/web/assets/render-valet-settings.js';
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
    const old = await (await post('management.submit', { instruction: 'old permission snapshot' })).json();
    const select = dom.node('detail').querySelectorAll('.valet-permission-method').find(node => node.dataset.method === 'draft.add').querySelector('select');
    select.value = 'confirmation'; select.onchange();
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '保存管家默认权限').onclick();
    expect(deepText(dom.node('detail'))).toContain('已保存');
    const stored = f.project.managementPermissions(); expect(stored.permissions['draft.add']).toBe('confirmation');
    expect(stored.revision).not.toBe(before.revision); expect(Object.keys(stored.permissions)).toEqual(Object.keys(before.permissions));
    expect(JSON.parse(f.store.task(old.task.id).management).permissions_snapshot.permissions['draft.add']).toBe('automatic');
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([{ name: 'manager_catalog', params: {} }, { name: 'manager_call', params: { method: 'draft.add', params: { content: 'page controlled write', branch: 'main' } }, callId: 'page-draft' }]);
    const submitted = await (await post('management.submit', { instruction: 'page policy probe', profile: { agent: 'pi', config_mode: 'pi' } })).json();
    const manager = submitted.task;
    expect(JSON.parse(f.store.task(manager.id).management).permissions_snapshot).toMatchObject({ scope: 'project', revision: stored.revision, permissions: stored.permissions });
    // Keep the unused old fixture from being pumped; this is not a user Worker.
    f.store.run('UPDATE tasks SET status=? WHERE id=?', 'paused', old.task.id);
    expect((await post('management.permissions_update', { permissions: before.permissions, expected_revision: stored.revision })).status).toBe(200);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const result = JSON.parse(f.store.task(manager.id).result);
    expect(result.replies[0].response.details.methods.find(item => item.method === 'draft.add').access).toBe('confirmation');
    const receipt = result.replies[1].response.details; expect(receipt.status).toBe('pending_confirmation'); expect(f.store.draftCount()).toBe(0);
    expect((await post('notice.answer', { id: receipt.notice_id, answer: { answers: [{ selected: [1], custom: '' }] } })).status).toBe(200);
    await Promise.all([...(f.project.managementControlJobs ?? [])]); expect(f.store.draftCount()).toBe(1);
  } finally { ui.disposeValetSettings?.(); dom?.restore(); await f.close(); }
});
