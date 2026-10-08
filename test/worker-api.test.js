import { test, expect } from 'bun:test';
import { PARAMS, USER_ONLY, AGENT_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { Dispatcher, HANDLERS } from '../src/rpc/dispatcher.js';

// Strict public namespace; authority stays unchanged when optional profile selection is added.
const reads = {
  lookup: ['number'], graph: [], list: ['after','limit'], activity: ['limit','scope'], page: ['before','limit','scope'],
  tree: ['id'], inspect: ['id'], run_settings: ['id'], hooks: ['id'], history: ['id','after'], history_page: ['id','before','limit'],
  delete_preview: ['id'], diff: ['id'], usage: ['id'], code_state: ['id','scope','after','limit'],
  code_tree: ['id','scope','path','query','changed','after','limit','revision'],
  code_file: ['id','scope','path','view','side','offset','limit','context','revision'],
  transcript: ['id','after','limit'], transcript_latest: ['id','after','before','limit'],
  transcript_page: ['id','seq','offset'], transcript_step: ['id','seq','offset'],
  transcript_search: ['id','query','kind','tool','errors','after','limit'],
  runs_page: ['id','before','limit'], artifacts_page: ['id','before','limit'], artifact: ['id'],
};
const writes = {
  spawn: ['parent','goal','name'], integrate: ['id','commit'], reserve: ['id','kind'], reserve_all: ['branch'],
  auto_merge: ['id','enabled'], completion: ['id','level','expected_revision'], hook_attach: ['id','hook','expected_revision'],
  hook_update: ['id','hook_id','enabled','hook','expected_revision'], hook_remove: ['id','hook_id','expected_revision'],
  resolve: ['id'], resolve_divergence: ['id'], accept: ['id'],
  reopen: ['id'], sync_parent: ['id'], resolve_sync: ['id'], resolve_child_divergence: ['id'],
  unreserve: ['id'], approve_merge: ['id','commit','baseline'], message: ['id','body'],
  cancel: ['id'], retry: ['id','profile'], clear_override: ['id'], cleanup: ['id','keep_branch'], interrupt: ['id'],
  resume: ['id','profile'], configure: ['id','profile','model_selection'], delete: ['id','revision','confirm'],
};
const userOnly = new Set(['run_settings','code_state','code_tree','code_file','transcript_latest','transcript_page','transcript_step',
  'transcript_search','runs_page','artifacts_page','artifact','hooks','hook_attach','hook_update','hook_remove',
  'reserve','reserve_all','auto_merge','completion','resolve','resolve_divergence','unreserve','approve_merge',
  'cancel','retry','clear_override','cleanup','interrupt','resume','configure','reopen','sync_parent','resolve_sync','delete_preview','delete']);
const agentOnly = new Set(['integrate','resolve_child_divergence']);
const contract = { ...reads, ...writes };

test('worker RPC is the complete strict public namespace with unchanged authority', () => {
  expect(Object.keys(HANDLERS).sort()).toEqual(Object.keys(PARAMS).sort());
  expect(Object.keys(PARAMS).filter(name => name.startsWith('worker.')).sort())
    .toEqual(Object.keys(contract).map(name => `worker.${name}`).sort());
  expect(Object.keys(PARAMS).some(name => name.startsWith('task.'))).toBe(false);
  for (const [verb, keys] of Object.entries(contract)) {
    const method = `worker.${verb}`;
    expect(PARAMS[method]).toEqual(keys);
    expect(typeof HANDLERS[method]).toBe('function');
    expect(USER_ONLY.has(method)).toBe(userOnly.has(verb));
    expect(AGENT_ONLY.has(method)).toBe(agentOnly.has(verb));
    if (agentOnly.has(verb)) expect(() => assertAllowed(method, {}, null)).toThrow('agent only');
    else expect(assertAllowed(method, {}, null)).toBeNull();
    if (userOnly.has(verb)) expect(() => assertAllowed(method, {}, 42)).toThrow('requires user approval');
    else expect(assertAllowed(method, {}, 42)).toBe(42);
    expect(() => assertAllowed(method, { force: true }, null)).toThrow('unknown parameter');
    expect(HANDLERS[`task.${verb}`]).toBeUndefined();
  }
  // Renaming never re-enables retired services.
  for (const verb of ['verify','merge','merge_many','clear','ladder','analyze'])
    expect(() => assertAllowed(`worker.${verb}`, {}, null)).toThrow('unknown method');
});

test('every legacy task RPC is rejected before token lookup or side effects', async () => {
  let lookups = 0;
  const rpc = new Dispatcher({ actor() { lookups++; throw new Error('must not look up token'); } });
  for (const verb of [...Object.keys(contract), 'verify','merge','delete','clear']) {
    try {
      await rpc.dispatch(`task.${verb}`, { _token: 'expired', arbitrary: true });
      throw new Error('legacy RPC accepted');
    } catch (error) {
      expect(error.code).toBe(-32601);
      expect(error.message).toBe(`unknown method: task.${verb}`);
    }
  }
  await expect(rpc.dispatch('worker.inspect', { id: 1, arbitrary: true })).rejects.toThrow('unknown parameter');
  expect(lookups).toBe(0);
});

test('worker lifecycle RPC forwards existing internal methods, actors and persistent fields', async () => {
  const calls = [], result = { task_id: 7, task_kind: 'child', status: 'awaiting_acceptance', integration: 'none' };
  let actor = null;
  const project = { actor() { return actor; } };
  const cases = [
    ['accept', 'acceptTask', { id: 7 }, [7, null]],
    ['reopen', 'reopenTask', { id: 7 }, [7]],
    ['sync_parent', 'syncTaskParent', { id: 7 }, [7]],
    ['resolve_sync', 'resolveTaskSync', { id: 7 }, [7]],
    ['run_settings', 'taskRunSettings', { id: 7 }, [7]],
    ['clear_override', 'clearTaskProfile', { id: 7 }, [7]],
    ['auto_merge', 'setTaskAutoMerge', { id: 7, enabled: true }, [7, true]],
    ['completion', 'setTaskCompletion', { id: 7, level: 'accept', expected_revision: 'hooks-revision' }, [7, 'accept', 'hooks-revision']],
    ['retry', 'retry', { id: 7, profile: { agent: 'pi', model: 'deepseek/chat' } }, [7, { agent: 'pi', model: 'deepseek/chat' }]],
    ['configure', 'configureTask', { id: 7, profile: { agent: 'pi', model: 'deepseek/chat' } }, [7, { agent: 'pi', model: 'deepseek/chat' }]],
    ['configure', 'configureTaskModelSelection', { id: 7, model_selection: { connection_id: '11111111-1111-4111-8111-111111111111', model: 'deepseek/chat' } },
      [7, { connection_id: '11111111-1111-4111-8111-111111111111', model: 'deepseek/chat' }]],
    ['message', 'message', { id: 7, body: 'follow up' }, [7, 'follow up', null]],
    ['reserve', 'reserveTask', { id: 7, kind: 'merge' }, [7, 'merge']],
  ];
  for (const [, internal] of cases) project[internal] = (...args) => { calls.push({ internal, args }); return result; };
  const rpc = new Dispatcher(project);
  for (const [verb, internal, params, args] of cases) {
    expect(await rpc.dispatch(`worker.${verb}`, params)).toBe(result);
    expect(calls.at(-1)).toEqual({ internal, args });
  }
  actor = 42;
  expect(await rpc.dispatch('worker.accept', { id: 7, _token: 'live' })).toBe(result);
  expect(calls.at(-1)).toEqual({ internal: 'acceptTask', args: [7, 42] });
  for (const verb of userOnly) await expect(rpc.dispatch(`worker.${verb}`, { _token: 'live' })).rejects.toThrow('requires user approval');
  expect(calls).toHaveLength(cases.length + 1);
});

test('worker spawn preserves own-parent delegation and rejects retired creation arguments', async () => {
  const calls = [], result = { id: 8, parent_id: 42, task_kind: 'child' };
  let kind = 'order';
  const project = { actor: () => 42, store: { task: () => ({ task_kind: kind }) },
    spawn(...args) { calls.push(args); return result; } };
  const rpc = new Dispatcher(project);
  expect(await rpc.dispatch('worker.spawn', { goal: 'child goal', name: 'child', _token: 'live' })).toBe(result);
  expect(calls).toEqual([[42, 'child goal', 'agent', [], 'child']]);
  await expect(rpc.dispatch('worker.spawn', { parent: 43, goal: 'other', _token: 'live' })).rejects.toThrow('own worker');
  for (const key of ['role','deps','spec'])
    await expect(rpc.dispatch('worker.spawn', { goal: 'child', [key]: 'legacy', _token: 'live' })).rejects.toThrow('unknown parameter');
  kind = 'main';
  await expect(rpc.dispatch('worker.spawn', { goal: 'child', _token: 'live' })).rejects.toThrow('only order/child Workers');
  expect(calls).toHaveLength(1);
});

test('worker.auto_merge forwards the strict hook setting and rejects malformed authority', async () => {
  expect(PARAMS['worker.auto_merge']).toEqual(['id','enabled']);
  expect(USER_ONLY.has('worker.auto_merge')).toBe(true);
  expect(assertAllowed('worker.auto_merge', { id: 7, enabled: true }, null)).toBeNull();
  expect(() => assertAllowed('worker.auto_merge', { id: 7, enabled: true }, 42)).toThrow('requires user approval');
  expect(() => assertAllowed('worker.auto_merge', { id: 7, enabled: true, force: true }, null)).toThrow('unknown parameter');
  const result = { task_id: 7, changed: true, auto_merge: { enabled: true, locked: false, editable: true, reason: null } };
  const calls = [], project = { setTaskAutoMerge(...args) { calls.push(args); return result; } };
  expect(await HANDLERS['worker.auto_merge'](project, { id: 7, enabled: true }, null)).toBe(result);
  expect(calls).toEqual([[7, true]]);
});

test('worker iteration handlers are id-only with accept parent confirmation and conflict envelopes', async () => {
  for (const [verb, method] of [['accept','acceptTask'],['reopen','reopenTask'],
    ['sync_parent','syncTaskParent'],['resolve_sync','resolveTaskSync']]) {
    const rpc = `worker.${verb}`, task = { id: 7, status: 'awaiting_acceptance' };
    const result = verb === 'sync_parent' ? { task, synced: false, conflict: true,
      source_commit: 'source', parent_commit: 'parent', reason: 'conflict' } : task;
    expect(PARAMS[rpc]).toEqual(['id']); expect(USER_ONLY.has(rpc)).toBe(verb !== 'accept');
    expect(assertAllowed(rpc, { id: 7 }, null)).toBeNull();
    if (verb === 'accept') expect(assertAllowed(rpc, { id: 7 }, 42)).toBe(42);
    else expect(() => assertAllowed(rpc, { id: 7 }, 42)).toThrow('requires user approval');
    expect(() => assertAllowed(rpc, { id: 7, force: true }, null)).toThrow('unknown parameter');
    const calls = [], project = { [method](...args) { calls.push(args); return result; } };
    expect(await HANDLERS[rpc](project, { id: 7 }, null)).toBe(result);
    expect(calls).toEqual([verb === 'accept' ? [7, null] : [7]]);
    if (verb === 'accept') {
      expect(await HANDLERS[rpc](project, { id: 7 }, 42)).toBe(result);
      expect(calls.at(-1)).toEqual([7, 42]);
    }
  }
});
