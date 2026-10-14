import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { setup, fetch } from '../web/harness.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';

// Real HTTP -> RPC -> lifecycle -> restricted Provider -> Pi tools -> Bun bridge ->
// invocation-authorized RPC, with a model-free CLI in an isolated project/device.
test('HTTP/RPC restricted Provider chain retains the serial slot through user confirmation, then stops and deletes only the Valet', async () => {
  const f = await setup();
  const post = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    f.project.kick = () => {}; await repo(f.root);
    const target = (await f.project.order('must survive manager deletion', 'main', [], null, false)).task;
    const cli = managementToolCLI(f.root, 'node');
    f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([
      { name: 'manager_catalog', params: {} },
      { name: 'manager_call', callId: 'create-development', params: { method: 'order.submit', params: { content: 'created by Valet', branch: 'main', start: false } } },
      { name: 'manager_call', callId: 'dangerous-confirmation', params: { method: 'worker.cancel', params: { id: target.id } } },
    ]);
    const definition = { instruction: 'manage current project', profile: { agent: 'pi', config_mode: 'pi' }, client_request_id: 'http-serial-valet' };
    const created = await post('management.submit', definition); expect(created.status).toBe(200);
    const manager = created.body.task;
    expect((await post('management.submit', { instruction: 'cannot create another' })).status).toBe(400);
    expect((await post('management.submit', definition)).body.task.id).toBe(manager.id);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const completedModel = f.project.inspect(manager.id);
    const replies = JSON.parse(completedModel.result).replies;
    expect(replies.map(reply => reply.error ?? null)).toEqual([null, null, null]);
    expect(completedModel.status).toBe('awaiting'); expect(f.project.running.size).toBe(0);
    expect(replies[1].response.details.status).toBe('succeeded');
    expect(replies[2].response.details.status).toBe('pending_confirmation');
    const childByOperation = f.store.get("SELECT * FROM tasks WHERE goal='created by Valet'");
    expect(childByOperation.task_kind).toBe('order'); expect(childByOperation.parent_id).not.toBe(manager.id);
    const blocked = await (await fetch(f.url + `/api/worker/${manager.id}/delete-preview`)).json();
    expect(blocked.can_delete).toBe(false);
    expect((await post('management.submit', { instruction: 'still blocked after model exits' })).status).toBe(400);
    const disabled = await post('management.binding_update', { id: manager.id, enabled: false, expected_revision: completedModel.management.revision });
    expect(disabled.status).toBe(200); expect(disabled.body.management.enabled).toBe(false);
    expect(disabled.body.management.last_execution.control_calls.at(-1).status).toBe('rejected');
    const preview = await (await fetch(f.url + `/api/worker/${manager.id}/delete-preview`)).json();
    expect(preview.can_delete).toBe(true); expect(preview.workers.map(task => task.id)).toEqual([manager.id]);
    const files = preview.resources.files;
    expect(files.some(file => file.endsWith(`task-${manager.id}-input.md`))).toBe(true);
    expect(preview.resources.worktrees).toEqual([path.join(f.config.home, 'management', String(manager.id))]);
    const deleted = await post('worker.delete', { id: manager.id, revision: preview.revision, confirm: true });
    expect(deleted.status).toBe(200);
    for (const file of [...files, ...preview.resources.worktrees]) expect(fs.existsSync(file)).toBe(false);
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', manager.id)).toBeNull();
    expect(f.store.task(target.id).status).toBe('paused'); expect(f.store.task(childByOperation.id).status).toBe('paused');
    expect((await post('management.submit', { instruction: 'lane released' })).status).toBe(200);
  } finally { await f.close(); }
});
