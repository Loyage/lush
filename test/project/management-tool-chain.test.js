import { fileURLToPath } from 'node:url';
import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { MANAGEMENT_TOOL_NAMES, registerManagementTools } from '../../src/agent/pi-management.js';
import { MANAGEMENT_RPC_METHODS } from '../../src/agent/management-rpc.js';
import { Dispatcher, HANDLERS } from '../../src/rpc/dispatcher.js';
import { LUSHW_METHODS } from '../../src/cli/catalog.js';
import { MANAGEMENT_CODE_METHODS } from '../../src/rpc/management-code-methods.js';
import { managementPolicy } from '../../src/rpc/management-policy.js';
import { PARAMS, MANAGER_METHODS, AGENT_ONLY } from '../../src/rpc/registry.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';

const extensions = ['pi-runtime.js', 'pi-management.js'].map(name => fileURLToPath(new URL(`../../src/agent/${name}`, import.meta.url)));
const sorted = values => [...values].sort();
const toolMethods = MANAGEMENT_TOOL_NAMES.map(name => name.replace('_', '.'));

// No copied production catalogue: compare independently wired boundaries against
// the shared tool names and the actual registered RPC handlers/manager allowlist.
test('management tools, trusted bridge, RPC registrations and invocation allowlist agree', () => {
  expect(sorted(MANAGEMENT_RPC_METHODS)).toEqual(sorted(MANAGER_METHODS));
  expect(sorted([...toolMethods, 'worker.lookup'])).toEqual(sorted(MANAGER_METHODS));
  expect(sorted([...AGENT_ONLY].filter(method => method.startsWith('manager.')))).toEqual(sorted(toolMethods));
  for (const method of MANAGER_METHODS) {
    expect(Object.hasOwn(PARAMS, method)).toBe(true);
    expect(typeof HANDLERS[method]).toBe('function');
  }
  const tools = [];
  registerManagementTools({ registerTool: tool => tools.push(tool), on() {} });
  const description = tools.find(tool => tool.name === 'manager_call').description;
  expect(description).toContain('lush/lushw');
  expect(description).not.toContain('lushc');
  expect(description).toContain('默认自动执行');
  expect(description).toContain('修改接口权限始终须真实用户审核');
});

test('completed Valet user append -> registered RPC -> real Provider/bridge uses fresh occurrence, instruction and latest permissions', async () => {
  const f = fixture(); let rpc;
  try {
    f.project.kick = () => {};
    await repo(f.root);
    const cli = managementToolCLI(f.root, 'node');
    f.config.env.LUSH_PI_COMMAND = cli.command;
    const provider = new AgentProvider(f.config, f.project.agentSettings);
    const contexts = [], run = provider.run.bind(provider);
    provider.run = options => { contexts.push(options); return run(options); };
    f.project.provider = provider;
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
    const manager = f.project.submitManagementInstruction({ instruction: '检查设备全局配置并记录原始事项',
      profile: { agent: 'pi', config_mode: 'pi' } }).task;
    const execute = async plan => {
      cli.plan(plan); f.project.pump();
      await Promise.all([...f.project.running.values()].map(run => run.promise));
      expect(f.store.task(manager.id).status).toBe('completed');
      return JSON.parse(f.store.task(manager.id).result).replies;
    };
    const draft = content => ({ name: 'manager_call', callId: 'same-model-call-id',
      params: { method: 'draft.add', params: { content, branch: 'main' } } });
    await execute([draft('原始事项')]);
    const initialRun = f.store.task(manager.id).calls;
    await dispatcher.dispatch('worker.message', { id: manager.id, body: '只记录本轮事项，不涉及设置' });
    const second = await execute([
      draft('本轮事项'),
      { name: 'manager_call', params: { method: 'management.permission_get', params: { method: 'draft.add', scope: 'device' } } },
      { name: 'manager_call', params: { method: 'worker.message', params: { id: manager.id, body: '不允许管家自行追加' } } },
      { name: 'manager_query', params: {} },
    ]);
    expect(second[0].response.details).toMatchObject({ method: 'draft.add', status: 'succeeded' });
    expect(JSON.parse(second[1].error)).toMatchObject({ kind: 'authorization_required', execution: 'not_started', recovery: 'ask_user' });
    expect(second[1].error).toContain('本轮用户');
    expect(second[2].error).toContain('管理请求被拒绝');
    expect(second[3].response.details.workers).toEqual([]);
    expect(f.store.draftCount()).toBe(2);
    const permission = f.project.managementPermissionGet('draft.add', 'device');
    f.project.managementPermissionSet('draft.add', 'unavailable', permission.revision, 'device');
    await dispatcher.dispatch('worker.message', { id: manager.id, body: '查询设备全局权限，再尝试记录第三轮' });
    const third = await execute([
      { name: 'manager_call', params: { method: 'management.permission_get', params: { method: 'draft.add', scope: 'device' } } },
      draft('禁止写入的第三轮'),
    ]);
    expect(third[0].response.details).toMatchObject({ status: 'succeeded', result: { method: 'draft.add', access: 'unavailable' } });
    expect(third[1].error).toContain('管理请求被拒绝');
    expect(f.store.draftCount()).toBe(2);
    expect(f.store.task(manager.id)).toMatchObject({ goal: manager.goal, calls: initialRun + 2 });
    expect(contexts.map(options => options.context.management.instruction)).toEqual([
      manager.goal, '只记录本轮事项，不涉及设置', '查询设备全局权限，再尝试记录第三轮',
    ]);
    expect(contexts[1].messages).toMatchObject([{ body: '只记录本轮事项，不涉及设置', append_number: null }]);
    expect(f.store.unread(manager.id)).toEqual([]);
    const audit = await dispatcher.dispatch('worker.management_calls', { id: manager.id, after: 0 });
    const finished = audit.items.filter(item => item.phase === 'finished');
    expect(new Set(finished.map(item => item.run_id)).size).toBe(3);
    expect(new Set(finished.map(item => item.occurrence_id)).size).toBe(3);
    expect(finished.filter(item => item.method === 'draft.add').map(item => item.status)).toEqual(['succeeded','succeeded','failed']);
  } finally { await rpc?.close(); await f.close(); }
});

// Node/Lush covers the production Pi extension import graph; Bun/Pi preserves the other config path.
for (const [runtime, mode] of [['bun', 'pi'], ['node', 'lush']]) {
  test(`${runtime}/${mode}: Provider -> active real tools -> Bun bridge -> invocation-authorized RPC -> persisted effects/public results`, async () => {
    const f = fixture(); let rpc;
    try {
      f.project.kick = () => {}; // Only the explicit pump below may launch a model-free CLI.
      await repo(f.root);
      const target = (await f.project.order('paused target', 'main', [], null, false)).task;
      const failed = (await f.project.order('failed target', 'main', [], null, false)).task;
      f.store.update(failed.id, { status: 'failed' });
      // History must reach real persisted runs without exposing their raw material.
      const historyRuns = [];
      for (let i = 0; i < 2; i++) {
        const run = f.store.startRun({ ...target, calls: i + 1 }, { agent: 'mock', model: 'fixture-model' });
        f.store.finishRun(run.id, 'completed', { result: 'PRIVATE_PROVIDER_OUTPUT', error: 'PRIVATE_PROVIDER_ERROR' });
        historyRuns.push(run.id);
      }
      const cli = managementToolCLI(f.root, runtime, { compactCatalog: true });
      f.config.env.LUSH_PI_COMMAND = cli.command;
      const provider = new AgentProvider(f.config, f.project.agentSettings);
      // Observe real runtime-issued options only; never substitute a Provider result
      // or mint a test credential. Reuse these options later to probe the expired token.
      let invocation;
      const runProvider = provider.run.bind(provider);
      provider.run = options => { invocation = options; return runProvider(options); };
      f.project.provider = provider;
      const calls = [];
      class ObservedDispatcher extends Dispatcher {
        async dispatch(method, params) {
          calls.push({ method, authenticated: typeof params._token === 'string' && !!params._token });
          return super.dispatch(method, params);
        }
      }
      rpc = new RPCServer(f.config.socket, new ObservedDispatcher(f.project, createSignal(), {}));
      await rpc.start();
      const draft = { method: 'draft.add', params: { content: 'real-tool-chain draft', branch: 'main' } };
      const plan = [
        { name: 'manager_catalog', params: {} },
        { name: 'manager_history', params: { id: target.id, limit: 1 } },
        { name: 'manager_call', params: draft, callId: 'same-draft-operation' },
        { name: 'manager_call', params: draft, callId: 'same-draft-operation' },
        { name: 'manager_call', params: { method: 'worker.inspect', params: { id: target.id } } },
        // Directory visibility is not permission: real policy must deny this call.
        { name: 'manager_call', params: { method: 'worker.transcript_page', params: { id: target.id } } },
        { name: 'manager_query', params: { worker: target.worker_number } },
        { name: 'manager_start', params: { worker: target.worker_number } },
        { name: 'manager_retry', params: { worker: failed.id } },
        { name: 'manager_call', params: { method: 'worker.transcript', params: { id: target.id } } },
        { name: 'manager_call', params: { method: 'worker.history', params: { id: target.id } } },
        { name: 'manager_call', callId: 'bridge-spawn', params: { method: 'worker.spawn', params: { parent: target.id, goal: 'delegated via real bridge', name: 'bridge-child' } } },
        { name: 'manager_call', callId: 'bridge-message', params: { method: 'worker.message', params: { id: failed.id, body: 'cross-tree bridge message' } } },
        { name: 'manager_call', callId: 'bridge-plan', params: { method: 'progress.plan', params: { steps: [{ key: 'inspect', label: '核验' }] } } },
        { name: 'manager_call', callId: 'bridge-complete', params: { method: 'progress.complete', params: { step: 'inspect' } } },
        { name: 'manager_call', callId: 'bridge-title', params: { method: 'worker.auto_title', params: { title: '可信管家协作' } } },
      ];
      // A temporary-device API key is enough to exercise real Lush connection
      // preparation. The CLI never sends a model or account-observation request.
      const connection = mode === 'lush' ? await f.project.agentConnections.forScope('device').save({
        label: 'model-free fixture', provider: 'deepseek', auth_type: 'api_key', models: ['deepseek-chat'],
      }, { api_key: 'FIXTURE-MANAGED-API-KEY' }) : null;
      const manager = f.project.submitManagementInstruction({ instruction: '检查当前项目并保存草稿、开始及重试目标',
        profile: { agent: 'pi', config_mode: mode,
          ...(connection ? { connection_id: connection.id, model: 'deepseek/deepseek-chat' } : {}) } }).task;
      expect(manager.worker_number).toBe('V1');
      cli.plan([...plan, { name: 'manager_query', params: { worker: manager.worker_number } },
        { name: 'manager_call', params: { method: 'context.inspect', params: {} } }]);
      f.project.pump();
      await Promise.all([...f.project.running.values()].map(run => run.promise));
      const task = f.store.task(manager.id);
      expect(task.status, task.error ?? 'management Provider did not complete').toBe('completed');
      expect(invocation.context.management.authorization).toMatchObject({
        dangerous_operations: 'latest_device_permissions', permission_changes: 'exact_user_confirmation',
      });
      const result = JSON.parse(task.result);
      expect(result.runtime).toBe(runtime);
      expect(result.extensions).toEqual(extensions);
      for (const key of ['registered', 'cliActive', 'sessionActive', 'modelActive']) expect(result[key]).toEqual([...MANAGEMENT_TOOL_NAMES]);
      expect(result.blocked).toEqual([true, true, true, true, true]);
      expect(result.entries).toContainEqual({ type: 'lush.invocation', data: {
        task_id: manager.id, run_id: invocation.context.invocation.run_id, role: 'manager' } });
      const replies = result.replies;
      expect(replies).toHaveLength(18);
      for (const [index, reply] of replies.entries()) {
        if (index === 5 || index === 17) {
          expect(reply.response).toBeUndefined();
          expect(reply.error).toContain('管理请求被拒绝或未确认完成');
        } else {
          if (reply.error) throw new Error(`unexpected tool error at plan ${index}: ${plan[index]?.params?.method ?? plan[index]?.name}`);
          expect(reply.error).toBeUndefined();
          if (index === 0) {
            expect(reply.catalogContentVerified).toBe(true);
            expect(reply.response.content).toEqual([]);
          } else expect(reply.response.content).toEqual([{ type: 'text', text: JSON.stringify(reply.response.details) }]);
        }
      }
      const catalog = replies[0].response.details;
      expect(sorted(catalog.methods.map(item => item.method))).toEqual(sorted(Object.keys(PARAMS)));
      expect(sorted(catalog.methods.map(item => item.method))).toEqual(sorted(Object.keys(HANDLERS)));
      // Relation-bound Worker APIs never become target-based Valet proxies.
      // The independently reviewed management set retains cross-tree authority.
      for (const method of LUSHW_METHODS) {
        expect(catalog.methods.find(item => item.method === method).access).toBe('unavailable');
      }
      for (const method of MANAGEMENT_CODE_METHODS) {
        expect(catalog.methods.find(item => item.method === method).access).toBe(managementPolicy(method).access);
      }
      expect(catalog.methods.find(item => item.method === 'draft.add').access).toBe('automatic');
      expect(catalog.methods.find(item => item.method === 'worker.graph').schema.properties.scope.enum).toEqual(['all', 'tree']);
      expect(catalog.methods.find(item => item.method === 'worker.list').schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000 });
      expect(catalog.methods.find(item => item.method === 'worker.transcript').access).toBe('read');
      expect(catalog.methods.find(item => item.method === 'worker.transcript_page').access).toBe('unavailable');
      const history = replies[1].response.details;
      expect(history.items).toMatchObject([{ id: historyRuns[1], task_id: target.id, status: 'completed', model: 'fixture-model' }]);
      expect(history.next_cursor).toBe(historyRuns[1]);
      expect(JSON.stringify(history)).not.toContain('PRIVATE_PROVIDER');
      expect(replies[2].response.details).toMatchObject({ method: 'draft.add', status: 'succeeded' });
      expect(replies[3].response).toEqual(replies[2].response);
      expect(f.store.draftCount()).toBe(1);
      expect(f.store.get('SELECT content FROM drafts').content).toBe('real-tool-chain draft');
      expect(replies[4].response.details).toMatchObject({ method: 'worker.inspect', status: 'succeeded', result: { id: target.id } });
      expect(replies[6].response.details).toMatchObject({ id: target.id, status: 'paused' });
      for (const [index, id] of [[7, target.id], [8, failed.id]]) {
        expect(replies[index].response.details).toMatchObject({ target_id: id, status: 'succeeded' });
        expect(f.store.task(id).status).toBe('queued');
      }
      expect(replies[9].response.details).toMatchObject({ status: 'succeeded', result: { coverage: 'step_metadata_only' } });
      expect(replies[10].response.details).toMatchObject({ status: 'succeeded', result: { coverage: 'event_metadata_only' } });
      const child = f.store.task(replies[11].response.details.result.id);
      expect(child).toMatchObject({ parent_id: target.id, task_kind: 'child' });
      expect(child.parent_id).not.toBe(manager.id);
      const message = f.store.get('SELECT sender_id,body,append_number FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 1', failed.id);
      expect(message).toMatchObject({ sender_id: manager.id, body: 'cross-tree bridge message', append_number: null });
      expect(JSON.parse(task.progress_plan).items[0].status).toBe('completed');
      expect(task.auto_title).toBe('可信管家协作');
      expect(replies[16].response.details).toMatchObject({ id: manager.id, worker_number: manager.worker_number,
        task_kind: 'management', status: 'running', available_actions: [] });
      expect(calls.every(call => call.authenticated)).toBe(true);
      expect(sorted(new Set(calls.map(call => call.method)))).toEqual(sorted(MANAGER_METHODS));
      expect(calls.filter(call => call.method === 'worker.lookup')).toHaveLength(3);
      for (const secret of ['FIXTURE-MANAGED-API-KEY', invocation.token, 'agent_token_hash', 'retry_profile', 'control_calls', 'creation_fingerprint'])
        expect(task.result).not.toContain(secret);
      expect(task.agent_token_hash).toBeNull();
      expect(f.project.running.has(manager.id)).toBe(false);

      // Start the same real Provider/CLI/extension stack with the now-stale runtime
      // token. No user RPC fallback or new credential: every tool must fail closed,
      // including the already-committed draft operation's exact replay key.
      cli.plan([
        { name: 'manager_catalog', params: {} },
        { name: 'manager_history', params: { limit: 1 } },
        { name: 'manager_call', params: draft, callId: 'same-draft-operation' },
        { name: 'manager_query', params: { worker: target.worker_number } },
        { name: 'manager_start', params: { worker: target.id } },
        { name: 'manager_retry', params: { worker: failed.id } },
      ]);
      const before = { drafts: f.store.draftCount(), events: f.store.get('SELECT count(*) AS n FROM events').n };
      const stale = JSON.parse(await runProvider({ ...invocation, signal: new AbortController().signal, onSpawn() {} }));
      expect(stale.replies).toHaveLength(MANAGEMENT_TOOL_NAMES.length);
      for (const reply of stale.replies) {
        expect(reply.response).toBeUndefined();
        expect(reply.error).toContain('管理请求被拒绝或未确认完成');
        expect(reply.error).not.toContain(invocation.token);
      }
      expect(f.store.draftCount()).toBe(before.drafts);
      expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before.events);
      expect(f.store.task(target.id).status).toBe('queued');
      expect(f.store.task(failed.id).status).toBe('queued');
      expect(stale.modelActive).toEqual([...MANAGEMENT_TOOL_NAMES]);
    } finally { await rpc?.close(); await f.close(); }
  });
}
