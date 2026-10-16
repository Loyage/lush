import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { fixture, repo } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { readDeviceManagementPermissions, saveDeviceManagementPermissions } from '../../src/core/management-permissions.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  f.target = (await f.project.order('delivered target', 'main', [], null, false)).task;
  f.cli = managementToolCLI(f.root, 'node');
  f.config.env.LUSH_PI_COMMAND = f.cli.command;
  const provider = new AgentProvider(f.config, f.project.agentSettings);
  f.invocations = [];
  const run = provider.run.bind(provider);
  provider.run = options => { f.invocations.push(options); return run(options); };
  f.project.provider = provider;
  f.rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await f.rpc.start();
  f.run = async () => {
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
  };
  f.state = task => JSON.parse(f.store.task(task.id).management);
  return f;
}

for (const history of ['missing']) test(`real Provider -> registered tools -> Bun bridge -> latest project permissions -> result for ${history} historical authorization`, async () => {
  const f = await setup();
  const set = patch => { const current = readDeviceManagementPermissions(f.config); return saveDeviceManagementPermissions(f.config, { ...current.permissions, ...patch }, current.revision); };
  try {
    f.cli.plan([
      { name: 'manager_catalog', params: {} },
      { name: 'manager_query', params: {} },
      { name: 'manager_call', params: { method: 'draft.add', params: { content: 'bridge must deny' } } },
      { name: 'manager_call', params: { method: 'worker.auto_title', params: { title: '最新权限真实链路' } } },
      { name: 'manager_call', params: { method: 'management.permissions', params: {} } },
      { name: 'manager_call', params: { method: 'management.permissions_update', params: {} } },
    ]);
    const manager = f.project.submitManagementInstruction({ instruction: 'check live permission through bridge',
      profile: { agent: 'pi', config_mode: 'pi' } }).task;
    const state = f.state(manager);
    if (history === 'missing') delete state.permissions_snapshot;
    else state.permissions_snapshot.permissions = {};
    f.store.update(manager.id, { management: JSON.stringify(state) });
    set({ 'draft.add': 'unavailable', 'manager.query': 'unavailable' });
    await f.run();
    expect(f.store.task(manager.id)).toMatchObject({ status: 'completed', error: null, auto_title: '最新权限真实链路' });
    const result = JSON.parse(f.store.task(manager.id).result);
    expect(result.blocked).toEqual([true,true,true,true,true]);
    expect(result.replies[0].response.details.methods.find(item => item.method === 'draft.add').access).toBe('unavailable');
    expect(result.replies[1].error).toBeTruthy(); expect(result.replies[2].error).toBeTruthy();
    expect(result.replies[3].response.details).toMatchObject({ status: 'succeeded', method: 'worker.auto_title' });
    expect(result.replies[4].error).toBeTruthy(); expect(result.replies[5].error).toBeTruthy();
    expect(f.store.draftCount()).toBe(0); expect(f.state(manager).permissions_snapshot).toEqual(state.permissions_snapshot);
  } finally { await f.rpc.close(); await f.close(); }
});

test('real Provider -> registered manager_call -> Bun bridge -> fixed acceptance confirmation -> original Git resource reclamation', async () => {
  const f = await setup();
  try {
    await f.project.workspaces.finish(f.target);
    f.store.update(f.target.id, { status: 'awaiting_acceptance', reservation: null });
    f.cli.plan([{ name: 'manager_call', callId: 'confirmed-bridge-accept', params: {
      method: 'worker.accept', params: { id: f.target.id } } }]);
    const manager = f.project.submitManagementInstruction({ instruction: 'accept delivered project work',
      profile: { agent: 'pi', config_mode: 'pi' } }).task;
    await f.run();
    const reply = JSON.parse(f.store.task(manager.id).result).replies[0].response.details;
    expect(reply).toMatchObject({ status: 'pending_confirmation', method: 'worker.accept' });
    expect(fs.existsSync(f.target.workspace)).toBe(true);
    expect(f.invocations).toHaveLength(1);
    f.project.answer(reply.notice_id, { answers: [{ selected: [1], custom: '' }] });
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.invocations).toHaveLength(1); // User approval is executed by the engine, not another model invocation.
    expect(f.state(manager).last_execution.control_calls[0]).toMatchObject({ status: 'succeeded', method: 'worker.accept' });
    expect(f.store.task(f.target.id).status).toBe('completed');
    expect(fs.existsSync(f.target.workspace)).toBe(false);
    expect(f.store.get("SELECT id FROM events WHERE task_id=? AND type='task.accepted'", f.target.id)).toBeTruthy();
  } finally { await f.rpc.close(); await f.close(); }
});

test('real Provider -> registered manager_call -> bridge -> own decision suspension -> user answer in same-occurrence isolated continuation', async () => {
  const f = await setup();
  try {
    f.cli.plan([{ name: 'manager_call', callId: 'bridge-own-question', params: { method: 'notice.post', params: {
      title: '选择协调方案', body: '只询问当前项目', questions: [{ header: '方案', question: '选择哪个方案？', options: [
        { label: '方案一', description: '第一种方式' }, { label: '方案二', description: '第二种方式' }] }] } } }]);
    const manager = f.project.submitManagementInstruction({ instruction: 'ask user before coordinating',
      profile: { agent: 'pi', config_mode: 'pi' } }).task;
    await f.run();
    expect(f.store.task(manager.id)).toMatchObject({ status: 'awaiting', error: null });
    const state = f.state(manager), occurrence = state.pending_signal.id;
    expect(state.pending_signal.phase).toBe('question');
    expect(state.control_calls[0]).toMatchObject({ status: 'succeeded', method: 'notice.post' });
    const noticeId = state.control_calls[0].result.id;
    f.cli.plan([{ name: 'manager_call', callId: 'bridge-after-question', params: { method: 'progress.plan',
      params: { steps: [{ key: 'continue', label: '继续协调' }] } } }]);
    f.project.answer(noticeId, { answers: [{ selected: [0], custom: '' }] });
    await f.run();
    expect(f.invocations).toHaveLength(2);
    expect(f.invocations[1].context.management).toMatchObject({ signal: { id: occurrence }, decisions: [
      { notice_id: noticeId, status: 'answered', answer_source: 'user', text_truncated: false }] });
    expect(f.invocations[1].token).not.toBe(f.invocations[0].token);
    expect(f.store.task(manager.id)).toMatchObject({ status: 'completed', error: null });
    const result = JSON.parse(f.store.task(manager.id).result);
    expect(result.blocked).toEqual([true,true,true,true,true]);
    expect(result.replies[0].response.details).toMatchObject({ method: 'progress.plan', status: 'succeeded' });
    expect(f.state(manager).last_execution.id).toBe(occurrence);
  } finally { await f.rpc.close(); await f.close(); }
});
