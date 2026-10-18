import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { managementToolCLI } from '../agent/management-tool-cli-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { PARAMS } from '../../src/rpc/registry.js';
import { managementCatalog, managementAuthorization, managementPolicy, validateManagementCall } from '../../src/rpc/management-policy.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { MANAGEMENT_PREFLIGHT_CODE, managementScopeError, safeManagementPreflightError } from '../../src/core/management-guidance.js';
import { LushError } from '../../src/core/types.js';
import { createSignal } from '../../src/signal.js';

const snapshot = () => ({ permissions: Object.fromEntries(Object.keys(PARAMS).map(method => [method, managementPolicy(method).access])) });
const call = params => ({ name: 'manager_call', params: { method: 'agent.selection.resources', params } });

test('scope prerequisites share CLI/manager discovery, without changing method access or query scope', () => {
  const policy = snapshot(), catalog = managementCatalog(policy), cli = cliCatalog();
  expect(catalog.help).toContain('manager_catalog');
  for (const method of ['agent.selection.resources', 'agent.connections.list', 'management.permission_get', 'hooks.auto_select']) {
    const authorization = managementAuthorization(method);
    expect(authorization).toMatchObject({ scope: 'device', explicit_scope_required: true, explicit_user_instruction_required: true });
    expect(catalog.methods.find(item => item.method === method).authorization).toEqual(authorization);
    for (const entry of cli.commands.flatMap(item => item.rpc).filter(item => item.method === method)) expect(entry.authorization).toEqual(authorization);
  }
  for (const method of ['worker.graph', 'worker.page', 'worker.activity', 'agent.status', 'branch.convergence_defaults_set']) expect(managementAuthorization(method)).toBeNull();
  expect(() => validateManagementCall('worker.graph', { scope: 'tree' }, '查询工作', policy)).not.toThrow();
  const denied = { permissions: { ...policy.permissions, 'agent.selection.resources': 'unavailable' } };
  expect(() => validateManagementCall('agent.selection.resources', { scope: 'device' }, '读取设备资源', denied)).toThrow('禁止');
});

test('only fixed scope preflight diagnostics cross the bridge and distinguish parameter repair from user authorization', () => {
  for (const [reason, kind, recovery] of [['scope_required', 'invalid_parameters', 'read_catalog'], ['invalid_scope', 'invalid_parameters', 'read_catalog'], ['user_authorization_required', 'authorization_required', 'ask_user']]) {
    const safe = safeManagementPreflightError(managementScopeError(reason));
    expect(safe).toMatchObject({ code: MANAGEMENT_PREFLIGHT_CODE, kind, recovery, execution: 'not_started' });
    expect(safe.error).toContain('manager_catalog');
    expect(safeManagementPreflightError(safe)).toEqual(safe); // Bun and Node independently verify the envelope.
    expect(safeManagementPreflightError(new LushError(safe.error, -32602))).toBeNull();
  }
  expect(safeManagementPreflightError(new LushError('PRIVATE-HANDLER-PAYLOAD', MANAGEMENT_PREFLIGHT_CODE))).toBeNull();
  expect(safeManagementPreflightError(new Error('PRIVATE-AUTH-ERROR'))).toBeNull();
});

test('real Node tools -> Bun bridge -> scope preflight -> resource handler preserves useful errors and unknown-result safety', async () => {
  const f = fixture(); let rpc;
  try {
    f.project.kick = () => {}; await repo(f.root);
    const cli = managementToolCLI(f.root, 'node');
    f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const dispatched = [], managers = [];
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = async (method, ...args) => {
      dispatched.push(method);
      if (dispatched.length === 2) throw new Error('PRIVATE-HANDLER-PAYLOAD');
      if (dispatched.length === 3) throw new LushError('PRIVATE-SPOOFED-DIAGNOSTIC', MANAGEMENT_PREFLIGHT_CODE);
      return dispatch(method, ...args);
    };
    const invoke = async (instruction, plan) => {
      cli.plan(plan);
      const manager = f.project.submitManagementInstruction({ instruction, profile: { agent: 'pi', config_mode: 'pi' } }).task;
      managers.push(manager.id);
      f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
      const task = f.store.task(manager.id); expect(task.status).toBe('completed');
      return JSON.parse(task.result).replies;
    };
    const original = await invoke('用账号来源为my的gpt-6-astra模型改进页面。PRIVATE-INSTRUCTION', [call({}), call({ scope: 'all' }), call({ scope: 'device' })]);
    expect(original[0].error).toContain('缺少设备范围参数');
    expect(original[1].error).toContain('scope 必须为');
    expect(original[2].error).toContain('缺少本轮用户的设备范围授权');
    expect(original[2].error).toContain('询问');
    expect(JSON.parse(original[0].error)).toMatchObject({ kind: 'invalid_parameters', execution: 'not_started', recovery: 'read_catalog' });
    expect(JSON.parse(original[2].error)).toMatchObject({ kind: 'authorization_required', execution: 'not_started', recovery: 'ask_user' });
    for (const reply of original) {
      expect(reply.error).toContain('本次请求未执行'); expect(reply.error).toContain('manager_catalog');
      expect(reply.error).not.toContain('PRIVATE'); expect(reply.error).not.toContain('副作用可能');
    }
    expect(dispatched).toHaveLength(0);
    const authorized = await invoke('请读取设备全局模型来源缓存。', [
      call({}), call({ scope: 'device' }), call({ scope: 'device' }), call({ scope: 'device' }),
    ]);
    expect(authorized[0].error).toContain('缺少设备范围参数');
    expect(authorized[1].error).toBeUndefined(); expect(authorized[1].response.details.status).toBe('succeeded');
    expect(authorized[1].response.details.result).toHaveProperty('connections');
    for (const reply of authorized.slice(2)) {
      expect(reply.error).toContain('管理请求被拒绝或未确认完成'); expect(reply.error).toContain('manager_catalog');
      expect(reply.error).not.toContain('PRIVATE'); expect(reply.error).not.toContain('未执行');
    }
    expect(dispatched).toEqual(Array(3).fill('agent.selection.resources'));
    // Combined Dispatcher keeps trusted call auditing without persisting the
    // richer bridge diagnostics, private instruction or arbitrary handler errors.
    const audit = await f.project.rpcDispatcher.dispatch('worker.management_calls', { id: managers[0], after: 0 });
    expect(audit.items.filter(item => item.phase === 'finished').map(item => item.status)).toEqual(['failed', 'failed', 'failed']);
    expect(audit.items.filter(item => item.phase === 'started')).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE');
    expect(JSON.stringify(audit)).not.toContain('authorization_required');
    expect(f.store.draftCount()).toBe(0);
    expect(f.store.all("SELECT id FROM tasks WHERE task_kind IN ('order','child')")).toHaveLength(0);
  } finally { await rpc?.close(); await f.close(); }
});
