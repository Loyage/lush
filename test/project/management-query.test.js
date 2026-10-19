import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { managementLegacyRPCProvider as managementToolCLI } from '../agent/management-legacy-rpc-fixture.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { RPCServer } from '../../src/rpc/server.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { PARAMS } from '../../src/rpc/registry.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { managementPolicy, managementCatalog, validateManagementCall } from '../../src/rpc/management-policy.js';
import { WORKER_QUERY_CAPABILITIES, validateWorkerQuery, safeWorkerQueryError, INVALID_WORKER_QUERY_CODE } from '../../src/core/worker-query.js';
import { graphOptions } from '../../src/core/project/graph-pages.js';
import { createSignal } from '../../src/signal.js';
import { LushError } from '../../src/core/types.js';

const snapshot = () => ({ permissions: Object.fromEntries(Object.keys(PARAMS).map(method => [method, managementPolicy(method).access])) });
const instruction = '查询当前开发任务，完成后再安排草稿。';
const call = (method, params) => ({ name: 'manager_call', params: { method, params } });

test('query schemas, enum validation and both CLI/manager catalogues agree without device authorization', () => {
  const policy = snapshot(), catalog = managementCatalog(policy), cli = cliCatalog();
  for (const [method, capability] of Object.entries(WORKER_QUERY_CAPABILITIES)) {
    expect(Object.keys(capability.schema.properties)).toEqual(PARAMS[method]);
    expect(catalog.methods.find(item => item.method === method)).toMatchObject(capability);
    for (const entry of cli.commands.flatMap(item => item.rpc).filter(item => item.method === method)) expect(entry).toMatchObject(capability);
    for (const example of capability.examples) {
      expect(() => validateWorkerQuery(method, example)).not.toThrow();
      expect(() => validateManagementCall(method, example, instruction, policy)).not.toThrow();
    }
    const schema = capability.schema.properties.scope;
    if (schema) {
      for (const scope of schema.enum) expect(() => validateManagementCall(method, { scope }, instruction, policy)).not.toThrow();
      for (const scope of ['device', 'development', 'private-input']) {
        try { validateManagementCall(method, { scope }, instruction, policy); throw Error('expected invalid query'); }
        catch (error) {
          expect(error.code).toBe(INVALID_WORKER_QUERY_CODE);
          expect(error.message).not.toContain('private-input');
          expect(safeWorkerQueryError(error)).toMatchObject({ kind: 'invalid_parameters', execution: 'not_started' });
        }
      }
    }
  }
  expect(() => graphOptions({ scope: 'tree', details: false })).not.toThrow();
  expect(() => graphOptions({ scope: 'development' })).toThrow('all | tree');
  expect(() => validateManagementCall('management.permission_get', { method: 'worker.cancel', scope: 'device' }, instruction, policy)).toThrow('explicitly requested');
  expect(() => validateManagementCall('management.permission_get', { method: 'worker.cancel' }, '查看设备权限', policy)).toThrow('explicit scope');
  expect(() => validateManagementCall('agent.connections.list', { scope: 'all' }, instruction, policy)).toThrow('device scope');
  const denied = { permissions: { ...policy.permissions, 'worker.graph': 'unavailable' } };
  expect(() => validateManagementCall('worker.graph', { scope: 'tree' }, instruction, denied)).toThrow('禁止');
  // Force-acceptance CLI methods remain user-only. Catalogue visibility and
  // the query error path must not grant them to the management actor.
  for (const method of ['worker.accept_preview', 'worker.accept_force']) {
    expect(catalog.methods.find(item => item.method === method).access).toBe('unavailable');
    expect(() => validateManagementCall(method, { id: 1 }, instruction, policy)).toThrow('仅由用户');
  }
  expect(safeWorkerQueryError(new LushError('PRIVATE', INVALID_WORKER_QUERY_CODE))).toBeNull();
  expect(safeWorkerQueryError(new LushError('PRIVATE', -32602))).toBeNull();
});

test('real Node tools -> Bun bridge -> current permissions -> query execution/results and safe preflight rejection', async () => {
  const f = fixture(); let rpc;
  try {
    f.project.kick = () => {};
    await repo(f.root);
    const target = (await f.project.order('development query target', 'main', [], null, false)).task;
    f.store.update(target.id, { result: 'PRIVATE-PROVIDER-RESULT', error: 'PRIVATE-PROVIDER-ERROR' });
    f.project.notify(target.id, 'notice', 'PRIVATE-NOTICE-BODY');
    // The safe query projection must retain retirement metadata without restoring execution.
    f.store.run('CREATE TABLE runner_bindings(worker_id INTEGER PRIMARY KEY)');
    f.store.run('INSERT INTO runner_bindings VALUES (?)', target.id);
    const retainedTarget = f.store.task(target.id);
    const cli = managementToolCLI(f.root, 'node');
    f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
    await rpc.start();
    const dispatched = [];
    const dispatch = f.project.managementDispatch.bind(f.project);
    f.project.managementDispatch = async (method, params, ...rest) => {
      dispatched.push({ method, params });
      if (method === 'worker.list' && params.limit === 97) throw new LushError('PRIVATE-ERROR-SENTINEL', -32602);
      if (method === 'worker.list' && params.limit === 98) throw new Error('PRIVATE-INTERNAL-SENTINEL');
      return dispatch(method, params, ...rest);
    };
    const plan = [
      call('worker.graph', { details: false, scope: 'tree', hidden_statuses: ['completed', 'cancelled', 'awaiting_acceptance'] }),
      call('worker.graph', { details: false, scope: 'all' }),
      call('worker.graph', { details: false }),
      call('worker.activity', { scope: 'work', limit: 10 }),
      call('worker.activity', { scope: 'all' }),
      call('worker.page', { scope: 'work', before: null, limit: 10 }),
      call('worker.page', { scope: 'all' }),
      call('worker.list', { after: 0, limit: 10 }),
      call('worker.graph', { scope: 'development' }),
      call('worker.graph', { details: 'false' }),
      call('worker.graph', { hidden_statuses: ['running', 'running'] }),
      call('worker.list', { limit: 0 }),
      call('worker.page', { scope: 'device' }),
      call('worker.list', { 'PRIVATE-PARAM-SENTINEL': 'PRIVATE-VALUE-SENTINEL' }),
      call('worker.list', { limit: 97 }),
      call('worker.list', { limit: 98 }),
      call('worker.accept_preview', { id: target.id }),
      call('worker.accept_force', { id: target.id, revision: '0'.repeat(64), confirm: true }),
    ];
    cli.plan(plan);
    const manager = f.project.submitManagementInstruction({ instruction, profile: { agent: 'pi', config_mode: 'pi' } }).task;
    f.project.pump();
    await Promise.all([...f.project.running.values()].map(run => run.promise));
    const task = f.store.task(manager.id);
    if (task.status !== 'completed') throw new Error(`query fixture failed: ${task.error}`);
    expect(task.status).toBe('completed');
    const { replies } = JSON.parse(task.result);
    expect(replies).toHaveLength(plan.length);
    for (let i = 0; i <= 7; i++) {
      expect(replies[i].error).toBeUndefined();
      expect(replies[i].response.details.status).toBe('succeeded');
    }
    for (let i = 0; i <= 2; i++) {
      const result = replies[i].response.details.result;
      expect(result.nodes.find(node => node.id === target.id)?.execution_retired).toBe(true);
      expect(result.coverage).toBe('worker_metadata_only');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(result.nodes.find(node => node.id === target.id)).not.toHaveProperty('result_preview');
      expect(result.nodes.find(node => node.id === target.id)).not.toHaveProperty('notice');
    }
    for (let i = 8; i <= 13; i++) {
      expect(replies[i].error).toContain('本次查询未执行');
      expect(replies[i].error).not.toContain('副作用');
      expect(replies[i].error).not.toContain('PRIVATE');
    }
    expect(replies[8].error).toContain('all | tree');
    expect(replies[9].error).toContain('boolean');
    expect(replies[11].error).toContain('integer');
    for (let i = 14; i <= 17; i++) {
      expect(replies[i].error).toContain('管理请求被拒绝或未确认完成');
      expect(replies[i].error).not.toContain('PRIVATE');
      expect(replies[i].error).not.toContain('未执行');
    }
    expect(dispatched).toHaveLength(10); // eight valid reads + two deliberately failing downstream reads
    expect(dispatched.filter(item => item.method === 'worker.graph')).toHaveLength(3);
    expect(f.store.task(target.id)).toEqual(retainedTarget);
    expect(f.store.draftCount()).toBe(0);
  } finally { await rpc?.close(); await f.close(); }
});

test('management graph and history cursors advance only past the actual 100 returned rows', async () => {
  const f = fixture(); let rpc;
  try {
    f.project.kick = () => {};
    await repo(f.root);
    const first = (await f.project.order('first page target', 'main', [], null, false)).task;
    const historical = new Set();
    for (let i = 0; i < 104; i++) {
      const row = f.store.create({ parent_id: first.parent_id, role: 'agent', task_kind: 'order', goal: `page target ${i}` });
      f.store.update(row.id, { status: 'completed', result: 'PRIVATE-RESULT' });
      historical.add(row.id);
    }
    const expected = new Set(f.store.all("SELECT id FROM tasks WHERE task_kind IN ('main','owner','order','child')").map(row => row.id));
    expect(expected.size).toBe(106);
    const cli = managementToolCLI(f.root, 'node');
    f.config.env.LUSH_PI_COMMAND = cli.command;
    f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
    await rpc.start();
    const query = async (method, params) => {
      // A new model-free occurrence reads the next opaque cursor; no polling or
      // lifecycle retry, and management identities never alter graph membership.
      cli.plan([call(method, params)]);
      const manager = f.project.submitManagementInstruction({ instruction, profile: { agent: 'pi', config_mode: 'pi' } }).task;
      f.project.pump();
      await Promise.all([...f.project.running.values()].map(run => run.promise));
      const task = f.store.task(manager.id);
      if (task.status !== 'completed') throw new Error(`paging fixture failed: ${task.error}`);
      const reply = JSON.parse(task.result).replies[0];
      expect(reply.error).toBeUndefined();
      expect(reply.response.details.status).toBe('succeeded');
      expect(JSON.stringify(reply)).not.toContain('PRIVATE');
      return reply.response.details.result;
    };
    const historyOne = await query('worker.page', { scope: 'work', limit: 200 });
    expect(historyOne.tasks).toHaveLength(100);
    expect(historyOne.limit).toBe(100);
    expect(historyOne.has_more).toBe(true);
    const historyTwo = await query('worker.page', { scope: 'work', limit: 200, before: historyOne.cursor });
    expect(historyTwo.tasks).toHaveLength(4);
    expect(historyTwo.has_more).toBe(false);
    expect(new Set([...historyOne.tasks, ...historyTwo.tasks].map(row => row.id))).toEqual(historical);
    const one = await query('worker.graph', { details: false, scope: 'tree' });
    expect(one.nodes).toHaveLength(100);
    expect(one.has_more).toBe(true);
    const two = await query('worker.graph', { details: false, scope: 'tree', cursor: one.cursor });
    expect(two.nodes).toHaveLength(6);
    expect(two.has_more).toBe(false);
    expect(two.cursor).toBeNull();
    const ids = [...one.nodes, ...two.nodes].map(row => row.id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(new Set(ids)).toEqual(expected);
  } finally { await rpc?.close(); await f.close(); }
});
