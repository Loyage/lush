import { fileURLToPath } from 'node:url';
import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { MANAGEMENT_TOOL_NAMES, registerManagementTools } from '../../src/agent/pi-management.js';
import { MANAGEMENT_RPC_METHODS } from '../../src/agent/management-rpc.js';
import { Dispatcher, HANDLERS } from '../../src/rpc/dispatcher.js';
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
  expect(description).toContain('默认自动执行');
  expect(description).toContain('修改接口权限始终须真实用户审核');
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
      const cli = managementToolCLI(f.root, runtime);
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
      cli.plan([...plan, { name: 'manager_query', params: { worker: manager.worker_number } }]);
      f.project.pump();
      await Promise.all([...f.project.running.values()].map(run => run.promise));
      const task = f.store.task(manager.id);
      expect(task.status).toBe('completed');
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
      expect(replies).toHaveLength(17);
      for (const [index, reply] of replies.entries()) {
        if (index === 5) {
          expect(reply.response).toBeUndefined();
          expect(reply.error).toContain('管理请求被拒绝或未确认完成');
        } else {
          if (reply.error) throw new Error(`unexpected tool error at plan ${index}: ${plan[index]?.params?.method ?? plan[index]?.name}`);
          expect(reply.error).toBeUndefined();
          expect(reply.response.content).toEqual([{ type: 'text', text: JSON.stringify(reply.response.details) }]);
        }
      }
      const catalog = replies[0].response.details;
      expect(sorted(catalog.methods.map(item => item.method))).toEqual(sorted(Object.keys(PARAMS)));
      expect(sorted(catalog.methods.map(item => item.method))).toEqual(sorted(Object.keys(HANDLERS)));
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
