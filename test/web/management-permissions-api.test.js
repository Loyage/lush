import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { repo } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { MANAGEMENT_TOOL_NAMES } from '../../src/agent/pi-management.js';

const post = (f, method, params, headers = {}) => fetch(f.url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params }) });
const get = f => fetch(f.url + '/api/management/permissions');

test('HTTP settings -> registry -> frozen permissions -> real restricted Provider/tools/bridge -> confirmation -> persisted execution/result', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root);
    const target = (await f.project.order('paused target', 'main', [], null, false)).task;
    const initialResponse = await get(f); expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json();
    const permissions = { ...initial.permissions, 'draft.add': 'confirmation', 'manager.query': 'unavailable',
      'manager.history': 'unavailable', 'worker.lookup': 'unavailable', 'worker.resume': 'unavailable', 'worker.retry': 'unavailable' };
    const savedResponse = await post(f, 'management.permissions_update', { permissions, expected_revision: initial.revision });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json(); expect(saved.permissions).toEqual(permissions);
    expect(await (await get(f)).json()).toEqual(saved);
    const cli = managementToolCLI(f.root, 'node'); f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    cli.plan([
      { name: 'manager_catalog', params: {} },
      { name: 'manager_call', params: { method: 'system.summary', params: {} }, callId: 'safe-read' },
      { name: 'manager_call', params: { method: 'draft.add', params: { content: 'confirmed through real tools', branch: 'main' } }, callId: 'exact-draft' },
      { name: 'manager_query', params: { worker: target.id } },
      { name: 'manager_query', params: { worker: target.worker_number } },
      { name: 'manager_history', params: { id: target.id } },
      { name: 'manager_start', params: { worker: target.id } },
      { name: 'manager_retry', params: { worker: target.id } },
      { name: 'manager_call', params: { method: 'manager.query', params: { id: target.id } }, callId: 'no-query-bypass' },
    ]);
    const submitted = await post(f, 'management.submit', { instruction: 'bounded permission probe', profile: { agent: 'pi', config_mode: 'pi' } });
    expect(submitted.status).toBe(200);
    const manager = (await submitted.json()).task;
    // New defaults after submission do not replace the frozen confirmation/read denial.
    expect((await post(f, 'management.permissions_update', { permissions: initial.permissions, expected_revision: saved.revision })).status).toBe(200);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    const stored = f.store.task(manager.id), result = JSON.parse(stored.result);
    expect(result.modelActive).toEqual([...MANAGEMENT_TOOL_NAMES]);
    expect(result.blocked).toEqual([true,true,true,true,true]);
    expect(result.replies[0].response.details.methods.find(item => item.method === 'draft.add')).toMatchObject({ base_access: 'automatic', access: 'confirmation' });
    expect(result.replies[1].response.details.status).toBe('succeeded');
    const receipt = result.replies[2].response.details;
    expect(receipt).toMatchObject({ method: 'draft.add', status: 'pending_confirmation' });
    for (const reply of result.replies.slice(3)) expect(reply.error).toContain('管理请求被拒绝或未确认完成');
    expect(f.store.draftCount()).toBe(0); expect(f.store.task(target.id).status).toBe('paused');
    const answer = await post(f, 'notice.answer', { id: receipt.notice_id, answer: { answers: [{ selected: [1], custom: '' }] } });
    expect(answer.status).toBe(200);
    await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.store.draftCount()).toBe(1);
    expect(f.store.get('SELECT content FROM drafts').content).toBe('confirmed through real tools');
    const state = JSON.parse(f.store.task(manager.id).management);
    expect(state.control_calls[0]).toMatchObject({ status: 'succeeded', result: { submitted: true } });
    const inspected = await (await fetch(f.url + `/api/worker/${manager.id}`)).json();
    expect(inspected.management).not.toHaveProperty('permissions_snapshot');
    expect(JSON.stringify(inspected)).not.toContain('permissions_snapshot');
  } finally { await f.close(); }
});

test('HTTP permissions enforce strict parameters/revision and same-Origin authenticated user boundary', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'permissions-password' } });
  try {
    expect((await get(f)).status).toBe(401);
    expect((await post(f, 'management.permissions_update', {})).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=permissions-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const value = await (await fetch(f.url + '/api/management/permissions', { headers: { Cookie } })).json();
    const params = { permissions: value.permissions, expected_revision: value.revision };
    expect((await post(f, 'management.permissions_update', params, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    for (const extra of [{ _token: 'forged' }, { scope: 'device' }, { extra: true }])
      expect((await post(f, 'management.permissions_update', { ...params, ...extra }, { Cookie })).status).toBe(400);
    expect(value.permissions['worker.transcript']).toBe('read');
    expect(value.permissions['worker.accept']).toBe('confirmation');
    for (const permissions of [{}, { ...value.permissions, unknown: 'read' },
      { ...value.permissions, 'worker.transcript': 'automatic' }, { ...value.permissions, 'worker.accept': 'automatic' }])
      expect((await post(f, 'management.permissions_update', { ...params, permissions }, { Cookie })).status).toBe(400);
    expect((await post(f, 'management.permissions_update', { permissions: value.permissions }, { Cookie })).status).toBe(400);
    for (const path of ['/api/management/permissions?scope=project','/api/management/permissions?x=1','/api/management/permissions?_token=bad'])
      expect((await fetch(f.url + path, { headers: { Cookie } })).status).toBe(400);
    expect((await post(f, 'management.permissions_update', params, { Cookie, Origin: f.url })).status).toBe(200);
    expect((await post(f, 'management.permissions_update', params, { Cookie })).status).toBe(400);
    expect((await post(f, 'management.permissions', {}, { Cookie })).status).toBe(400);
  } finally { await f.close(); }
});
