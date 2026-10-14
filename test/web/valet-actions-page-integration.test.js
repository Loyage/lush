import fs from 'node:fs';
import { test, expect } from 'bun:test';
import { installDom, answerDialog, dialogText } from '../dom-stub.js';
import { repo, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { loadDetail } from '../../src/ui/web/assets/detail.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { openResource } from '../../src/ui/web/assets/sidebar-ui.js';
import { closeDialog } from '../../src/ui/web/assets/dialog.js';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const button = (dom, label) => dom.node('detail').querySelectorAll('button').find(node => node.textContent === label);

// Actual detail -> HTTP -> registered user RPC -> SQLite authorization/revision ->
// resource deletion, after an isolated real restricted Provider/CLI tool invocation.
test('real Valet detail revokes a pending confirmation and deletes only its settled resources', async () => {
  const f = await setup(); let dom, restore;
  const mutations = [], readPaths = [];
  const post = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    f.project.kick = () => {}; await repo(f.root);
    const target = (await f.project.order('must survive Valet UI deletion', 'main', [], null, false)).task;
    const signal = f.project.saveHookSignal({ name: 'must survive deletion', schedule: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString(), timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items[0];
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([{ name: 'manager_call', params: { method: 'worker.cancel', params: { id: target.id } }, callId: 'ui-delete-confirmation' }]);
    const created = await post('management.submit', { instruction: 'controlled pending confirmation', profile: { agent: 'pi', config_mode: 'pi' } });
    expect(created.status).toBe(200); const manager = created.body.task;
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const inspected = f.project.inspect(manager.id);
    expect(inspected.status).toBe('awaiting'); expect(f.project.running.size).toBe(0);
    const noticeId = JSON.parse(inspected.result).replies[0].response.details.notice_id;
    expect((await post('management.submit', { instruction: 'must be blocked until revoked' })).status).toBe(400);
    const projects = await (await fetch(f.url + '/api/host/projects')).json();
    const projectId = projects.projects.find(item => item.project === f.root).id;
    resetUiState();
    dom = installDom({ fetch: (path, options) => {
      readPaths.push(String(path));
      if (options?.body) mutations.push(JSON.parse(options.body));
      return fetch(f.url + String(path), options);
    } });
    dom.location.pathname = `/p/${projectId}/`; dom.node('modal').hidden = true;
    restore = registerNavigation({ detail: loadDetail, resource: openResource, refresh: async () => {} });
    expect(await loadDetail(manager.id)).toBe(true);
    const blocked = button(dom, '删除'); await blocked.onclick();
    expect(dom.node('modal').hidden).toBe(true); expect(dom.node('error').textContent).toContain('unfinished/unknown');
    expect(mutations).toEqual([]);
    const disabling = button(dom, '停用授权').onclick(); await flush();
    expect(dialogText(dom)).toContain('尚未执行');
    await answerDialog(dom, '停用授权'); await disabling;
    expect(mutations).toEqual([{ method: 'management.binding_update', params: { id: manager.id, enabled: false, expected_revision: inspected.management.revision } }]);
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.store.get('SELECT status FROM notices WHERE id=?', noticeId).status).toBe('dismissed');
    const preview = await f.project.deleteTaskPreview(manager.id); expect(preview.can_delete).toBe(true);
    const deleting = button(dom, '删除').onclick(); await flush();
    await until(() => !dom.node('modal').hidden);
    expect(dialogText(dom)).toContain('彻底删除管家');
    await answerDialog(dom, '彻底删除'); await deleting;
    expect(mutations.at(-1)).toEqual({ method: 'worker.delete', params: { id: manager.id, revision: preview.revision, confirm: true } });
    expect(mutations.filter(row => row.method === 'worker.delete')).toHaveLength(1);
    expect(ui.view.id).toBe('valets'); expect(ui.deletedWorkerIds.has(manager.id)).toBe(true);
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', manager.id)).toBeNull();
    for (const file of [...preview.resources.files, ...preview.resources.worktrees]) expect(fs.existsSync(file)).toBe(false);
    expect(f.store.task(target.id).status).toBe('paused'); expect(f.project.hookSignals().items.some(item => item.id === signal.id)).toBe(true);
    expect(readPaths.some(path => path.includes('/delete-preview'))).toBe(true);
    expect((await post('management.submit', { instruction: 'new UI-verified lane' })).status).toBe(200);
  } finally { closeDialog(); ui.disposeDetailRequests?.(); restore?.(); dom?.restore(); await f.close(); }
});
