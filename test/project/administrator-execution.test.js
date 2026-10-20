import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'bun:test';
import { fixture, repo, temp } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { createAdministratorExecutor } from '../../src/administrator/execution.js';
import { createAdministratorRunner } from '../../src/administrator/runner.js';
import { AdministratorService } from '../../src/administrator/service.js';
import { AdministratorClient, AdministratorInvocationClient } from '../../src/administrator/client.js';
import { ADMINISTRATOR_TOOL_NAMES } from '../../src/administrator/tool-protocol.js';
import { safeAdministratorValue, signAdministratorRequest } from '../../src/administrator/delegation.js';
import { startTestWeb, fetch } from '../web/auth-fixture.js';

// One real normal chain replaces the initial injected broker. No separate exception matrix.
test('authenticated user confirmation -> administrator runtime -> Provider/bridge -> signed cross-project business and unknown receipts', async () => {
  const device = temp(), home = path.join(device, 'shared', 'administrator');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const userEnv = { PATH: process.env.PATH, HOME: device, LUSH_GLOBAL_CONFIG: device, LUSH_PROVIDER: 'mock' };
  const a = fixture(undefined, { LUSH_GLOBAL_CONFIG: device }), b = fixture(undefined, { LUSH_GLOBAL_CONFIG: device });
  const servers = [];
  let executor, service, web;
  try {
    await repo(a.root); await repo(b.root); a.project.kick = b.project.kick = () => {};
    const first = (await a.project.order('admin first', 'main', [], null, false)).task;
    const second = (await b.project.order('admin second', 'main', [], null, false)).task;
    const da = new Dispatcher(a.project, createSignal(), {}), db = new Dispatcher(b.project, createSignal(), {});
    for (const [f, d] of [[a, da], [b, db]]) { const server = new RPCServer(f.config.socket, d); await server.start(); servers.push(server); }
    const permission = a.project.managementPermissionGet('worker.rename', 'device');
    a.project.managementPermissionSet('worker.rename', 'confirmation', permission.revision, 'device');
    const noticesBefore = a.store.get('SELECT count(*) AS n FROM notices').n;
    fs.mkdirSync(path.join(b.root, 'src')); fs.writeFileSync(path.join(b.root, 'src', 'app.js'), 'export const result = 42;\nconst api_key = "CANARY-CREDENTIAL";\n');
    fs.writeFileSync(path.join(b.root, '.env'), 'TOKEN=PRIVATE-CANARY');
    executor = createAdministratorExecutor({ env: a.config.env, home });
    const plan = [
      { operation: 'catalog', params: {} },
      { operation: 'project.call', params: { project: a.root, method: 'worker.rename', params: { id: first.id, title: 'admin renamed without another confirmation' } } },
      { operation: 'project.call', params: { project: b.root, method: 'worker.inspect', params: { id: second.id } } },
      { operation: 'source.read', params: { project: b.root, path: 'src/app.js' } },
    ];
    const provider = path.join(home, 'controlled-provider.mjs');
    fs.writeFileSync(provider, `#!/usr/bin/env node\nconst args=process.argv.slice(2); const tools=[],events=new Map(),active=[];
const extension=await import(${JSON.stringify(fileURLToPath(new URL('../../src/administrator/pi-tools.js', import.meta.url)))});
const pi={registerTool:t=>tools.push(t),setActiveTools:n=>active.push(n),on:(k,v)=>events.set(k,v)};extension.default(pi);
await events.get('session_start')();await events.get('before_agent_start')({});
const replies=[]; for(const [i,p] of ${JSON.stringify(plan)}.entries()) replies.push(await tools[0].execute('tool_'+i,p,new AbortController().signal));
console.log(JSON.stringify({registered:tools.map(t=>t.name),active,blocked:events.get('tool_call')({toolName:'bash'}).block,replies,args,credentialEnv:!!process.env.LUSH_AGENT_TOKEN}));\n`, { mode: 0o700 });
    const runner = createAdministratorRunner({ env: { ...userEnv, LUSH_PI_COMMAND: provider, LUSH_AGENT_TOKEN: 'DEVELOPER-TOKEN-CANARY' }, home,
      profile: { agent: 'pi', model: 'test/model', connection_id: 'test_connection' },
      prepareConnection: async () => ({ dir: fs.mkdtempSync(path.join(home, 'model-runtime-')) }), timeoutMs: 5000 });
    service = await new AdministratorService({ env: userEnv, home, runner, executor }).start();
    const client = new AdministratorClient({ env: userEnv, home });
    web = startTestWeb(null, 0, { env: userEnv, administratorOptions: { client } });
    const url = `http://127.0.0.1:${web.port}/api/host/administrator/`;
    const post = async (route, body, expected = 200, headers = {}) => {
      const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      expect(response.status).toBe(expected); return response.json();
    };
    expect((await fetch(url + 'status', { anonymous: true })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${web.port}/p/${'a'.repeat(16)}/api/host/administrator/status`)).status).toBe(404);
    const creation = { kind: 'create', mode: 'administrator', scope: 'device_user', client_request_id: 'create_test', name: '跨项目管理员' };
    await post('preview', { definition: creation }, 400, { 'x-lush-agent-token': 'dev-token' });
    const preview = await post('preview', { definition: creation });
    await post('commit', { confirmation_id: preview.confirmation_id, definition: { ...creation, name: 'changed' }, confirm: true }, 400);
    const made = await post('commit', { confirmation_id: preview.confirmation_id, definition: creation, confirm: true });
    expect(made.worker).toMatchObject({ status: 'ready', mode: 'administrator', scope: 'device_user', can_input: true });
    expect(service.store.all('SELECT * FROM agent_runs')).toHaveLength(0);
    const input = { kind: 'input', mode: 'administrator', scope: 'device_user', client_request_id: 'input_test', id: made.worker.id, instruction: '跨项目核对并修改目标名称\n 保留空白 ' };
    const approved = await post('preview', { definition: input });
    await post('commit', { confirmation_id: approved.confirmation_id, definition: { ...input, instruction: input.instruction + ' ' }, confirm: true }, 400);
    const submitted = await post('commit', { confirmation_id: approved.confirmation_id, definition: input, confirm: true });
    await service.idle();
    const receipt = await (await fetch(url + 'receipt?client_request_id=input_test')).json();
    expect(receipt).toMatchObject({ found: true, definition: input, instruction: { id: submitted.instruction.id, status: 'succeeded' } });
    expect(receipt.worker.status).toBe('ready');
    const output = receipt.worker.result, result = JSON.parse(output);
    expect(result.registered).toEqual(ADMINISTRATOR_TOOL_NAMES);
    expect(result.active.every(active => JSON.stringify(active) === JSON.stringify(ADMINISTRATOR_TOOL_NAMES))).toBe(true);
    expect(result.blocked).toBe(true); expect(result.credentialEnv).toBe(false);
    expect(result.replies[0].details.result.map(item => item.name)).toEqual(['catalog', 'project.call', 'source.list', 'source.read', 'device.call', 'service.project', 'service.host']);
    expect(result.args).toContain('--no-context-files'); expect(result.args).toContain('--no-mcp'); expect(result.args).toContain('--no-approve');
    expect(result.replies[1].details.result).toMatchObject({ status: 'succeeded', identity: { worker_id: made.worker.id } });
    expect(a.store.task(first.id).display_title).toBe('admin renamed without another confirmation');
    expect(a.store.get('SELECT count(*) AS n FROM notices').n).toBe(noticesBefore);
    expect(result.replies[2].details.result.result).toMatchObject({ id: second.id, goal: 'admin second' });
    expect(result.replies[2].details.result.result.coverage).not.toBe('worker_metadata_only');
    expect(result.replies[3].details.result.content).toContain('result = 42');
    expect(output).not.toContain('CANARY-CREDENTIAL'); expect(output).not.toContain('DEVELOPER-TOKEN-CANARY');
    expect(JSON.parse(a.store.get("SELECT data FROM events WHERE type='administrator.call_started'").data).identity.worker_id).toBe(made.worker.id);
    const identity = { service_id: 'service_test', worker_id: 'admin_1', instruction_id: 'instruction_1', call_id: 'initial' };
    await expect(executor.execute({ operation: 'source.read', params: { project: b.root, path: '.env' }, identity })).rejects.toThrow();
    const originalActor = a.project.actor.bind(a.project); a.project.actor = value => value === 'dev-token' ? first.id : originalActor(value);
    const signed = signAdministratorRequest(home, { project: a.root, method: 'worker.inspect', params: { id: first.id }, identity: { ...identity, call_id: 'direct_read' } });
    await expect(da.dispatch('administrator.dispatch', { ...signed, _token: 'dev-token' })).rejects.toThrow('user approval');
    await expect(da.dispatch('administrator.dispatch', { ...signed, signature: 'x'.repeat(86) })).rejects.toThrow();
    let effects = 0;
    const dispatch = da.dispatch.bind(da);
    da.dispatch = async (method, values) => { if (method === 'worker.rename' && values.title === 'unknown-write') { effects++; a.project.renameTask(first.id, values.title); throw new Error('original execution failure marker'); } return dispatch(method, values); };
    const unknownParams = { project: a.root, method: 'worker.rename', params: { id: first.id, title: 'unknown-write' } };
    // A second precisely confirmed input exercises the real broker's unknown propagation and stable dedupe.
    let unknownCalls;
    service.runner = async ({ socket, token, signal }) => {
      const invocation = new AdministratorInvocationClient(socket, token);
      const firstCall = await invocation.call('project.call', unknownParams, { signal });
      const secondCall = await invocation.call('project.call', unknownParams, { signal });
      unknownCalls = [firstCall, secondCall];
      return 'Observed unknown; no replay';
    };
    const next = { ...input, client_request_id: 'unknown_input', instruction: '执行并核对未知写入证据，不重放' };
    const nextPreview = await post('preview', { definition: next });
    await post('commit', { confirmation_id: nextPreview.confirmation_id, definition: next, confirm: true });
    await service.idle();
    const unknown = await (await fetch(url + 'receipt?client_request_id=unknown_input')).json();
    expect(unknownCalls[0].call.status).toBe('unknown'); expect(unknownCalls[1].result).toEqual(unknownCalls[0].result);
    expect(unknown.worker).toMatchObject({ status: 'unknown', can_input: false });
    expect(effects).toBe(1);
    expect(JSON.stringify(service.store.all('SELECT * FROM tool_calls WHERE status=\'unknown\''))).toContain('original execution failure marker');
    expect(safeAdministratorValue({ privatePrompt: 'PROMPT-CANARY', apiKey: 'KEY-CANARY', OPENAI_API_KEY: 'ENV-KEY-CANARY', result: 'useful' })).toEqual({ result: 'useful' });
    await post('stop', { id: made.worker.id });
    expect((await client.detail({ id: made.worker.id })).worker.status).toBe('stopped');
    await web.stop(true); web = null;
    expect((await client.readStatus()).online).toBe(true); // Host teardown is not the service lifecycle.
  } finally {
    await web?.stop(true); await service?.close(); await executor?.close();
    for (const server of servers.reverse()) await server.close();
    await a.close(); await b.close(); fs.rmSync(device, { recursive: true, force: true });
  }
});
