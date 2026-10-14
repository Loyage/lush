import { test, expect } from 'bun:test';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { managementPolicy, effectiveManagementPolicy, managementCatalog } from '../../src/rpc/management-policy.js';
import { PARAMS } from '../../src/rpc/registry.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';

const approve = { answers: [{ selected: [1], custom: '' }] };
async function prepared(invoke = async () => {}) {
  let f;
  f = fixture({ async run(args) { if (args.task.role === 'manager') await invoke({ ...args, rpc: f.rpc }); return 'done'; } });
  f.project.kick = () => {};
  await repo(f.root);
  f.rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
  f.target = (await f.project.order('target', 'main', [], null, false)).task;
  f.run = async () => {
    f.project.pump();
    const runs = [...f.project.running.entries()];
    await Promise.all(runs.map(([, run]) => run.promise));
    for (const [taskId] of runs) {
      expect(f.store.task(taskId).error).toBeNull();
      expect(f.store.task(taskId).status).not.toBe('failed');
    }
  };
  f.state = manager => JSON.parse(f.store.task(manager.id).management);
  f.set = patch => { const view = f.project.managementPermissions(); return f.project.setManagementPermissions({ ...view.permissions, ...patch }, view.revision); };
  f.confirm = async notice => { f.project.answer(notice, approve); f.project.resolveManagementConfirmation(notice); await Promise.all([...(f.project.managementControlJobs ?? [])]); };
  return f;
}

test('project permission directory defaults, strict complete mapping, monotone policies and optimistic revision', async () => {
  const f = await prepared();
  try {
    const first = await f.rpc.dispatch('management.permissions');
    expect(first).toMatchObject({ version: 1, scope: 'project' });
    expect(Object.keys(first.permissions)).toEqual(Object.keys(PARAMS));
    expect(first.methods.map(item => item.method)).toEqual(managementCatalog().methods.map(item => item.method));
    for (const item of first.methods) {
      expect(item.access).toBe(managementPolicy(item.method).access);
      expect(first.groups.some(group => group.id === item.group && group.label && group.description)).toBe(true);
      expect(item.label.length > 0 && item.description.length > 0).toBe(true);
      for (const access of ['read','automatic','confirmation','unavailable','invalid',null]) {
        if (item.allowed_access.includes(access)) continue;
        expect(() => f.project.setManagementPermissions({ ...first.permissions, [item.method]: access }, first.revision)).toThrow('invalid or elevated');
      }
    }
    for (const permissions of [null, [], {}, { ...first.permissions, unknown: 'unavailable' }])
      await expect(f.rpc.dispatch('management.permissions_update', { permissions, expected_revision: first.revision })).rejects.toThrow();
    await expect(f.rpc.dispatch('management.permissions_update', { permissions: first.permissions, expected_revision: first.revision, scope: 'device' })).rejects.toThrow('unknown parameter');
    const next = await f.rpc.dispatch('management.permissions_update', { permissions: { ...first.permissions, 'draft.add': 'confirmation' }, expected_revision: first.revision });
    expect(next.permissions['draft.add']).toBe('confirmation'); expect(next.revision).not.toBe(first.revision);
    await expect(f.rpc.dispatch('management.permissions_update', { permissions: first.permissions, expected_revision: first.revision })).rejects.toThrow('revision changed');
    expect(f.project.managementPermissions()).toEqual(next);
    expect(f.project.managementPermissionsSnapshot()).toEqual({ version: 1, scope: 'project', revision: next.revision, permissions: next.permissions });
  } finally { await f.close(); }
});

test('new immediate, waiting and persistent Valets freeze defaults; dedup and restart never replace snapshots; project isolation', async () => {
  const f = await prepared(), isolated = fixture(); let other, store;
  try {
    const first = f.project.createManagementWorker({ name: 'immediate', instruction: 'a', signal_id: null, client_request_id: 'same' });
    const signals = f.project.saveHookSignal({ name: 'future', schedule: { kind: 'daily', time: '01:00', timezone: 'UTC' } }, f.project.hookSignals().revision).signals;
    const waiting = f.project.createManagementWorker({ name: 'waiting', instruction: 'b', signal_id: signals.items[0].id });
    const persistent = f.project.createManagementWorker({ name: 'persistent', instruction: 'c', signal_id: signals.items[0].id, mode: 'persistent' });
    const snapshots = [first, waiting, persistent].map(item => f.state(item).permissions_snapshot);
    const next = f.set({ 'draft.add': 'unavailable', 'worker.resume': 'confirmation' });
    expect(isolated.project.managementPermissions().permissions['draft.add']).toBe('automatic');
    for (const [index, item] of [first, waiting, persistent].entries()) expect(f.state(item).permissions_snapshot).toEqual(snapshots[index]);
    expect(f.project.createManagementWorker({ name: 'immediate', instruction: 'a', signal_id: null, client_request_id: 'same' }).id).toBe(first.id);
    const later = f.project.submitManagementInstruction({ instruction: 'later' }).task;
    expect(f.state(later).permissions_snapshot.permissions).toEqual(next.permissions);
    expect(f.project.inspect(later.id).management).not.toHaveProperty('permissions_snapshot');
    await f.project.shutdown();
    store = new Store(path.join(f.config.home, 'project.db'), f.root);
    other = new Project(f.config, store, { run: () => 'done' }); other.kick = () => {};
    other.recover();
    expect(other.managementPermissions()).toEqual(next);
    expect(JSON.parse(store.task(first.id).management).permissions_snapshot).toEqual(snapshots[0]);
    expect(JSON.parse(store.task(later.id).management).permissions_snapshot.permissions).toEqual(next.permissions);
  } finally { await other?.shutdown(); store?.close(); await isolated.close(); await f.close(); }
});

test('all dedicated reads and manager.call obey the same frozen policy; user settings are unavailable to any Agent', async () => {
  const f = await prepared(async ({ token, rpc, task }) => {
    for (const [method, params] of [['manager.query',{}], ['manager.history',{}], ['worker.lookup',{ number: f.target.worker_number }],
      ['manager.start',{ id: f.target.id }], ['manager.retry',{ id: f.target.id }],
      ['manager.call',{ method: 'draft.add', params: { content: 'no' } }],
      ...['manager.query','manager.history','worker.lookup','worker.resume','worker.retry'].map(method => ['manager.call', { method, params: method === 'worker.lookup' ? { number: f.target.worker_number } : { id: f.target.id } }])])
      await expect(rpc.dispatch(method, { ...params, _token: token })).rejects.toThrow('权限快照禁止');
    for (const method of ['management.permissions','management.permissions_update']) {
      await expect(rpc.dispatch(method, { ...(method.endsWith('_update') ? { permissions: {}, expected_revision: 'x' } : {}), _token: token })).rejects.toThrow('requires user approval');
      await expect(rpc.dispatch('manager.call', { method, params: {}, _token: token })).rejects.toThrow();
    }
    const catalog = await rpc.dispatch('manager.catalog', { _token: token });
    expect(catalog.methods.find(item => item.method === 'worker.resume').access).toBe('unavailable');
    expect(f.state(task).control_calls).toEqual([]);
  });
  try {
    f.set(Object.fromEntries(['manager.query','manager.history','worker.lookup','worker.resume','worker.retry','draft.add'].map(method => [method, 'unavailable'])));
    f.project.submitManagementInstruction({ instruction: 'restricted' }); await f.run();
    expect(f.store.draftCount()).toBe(0); expect(f.store.task(f.target.id).status).toBe('paused');
  } finally { await f.close(); }
});

test('reviewed query/history/catalog through manager.call match dedicated safe reads; query actions reflect execution restrictions', async () => {
  const f = await prepared(async ({ token, rpc }) => {
    for (const method of ['manager.query','manager.history','manager.catalog']) {
      const params = method === 'manager.query' ? { id: f.target.id } : {};
      const direct = await rpc.dispatch(method, { ...params, _token: token });
      const proxied = await rpc.dispatch('manager.call', { method, params, _token: token });
      expect(proxied.status).toBe('succeeded');
      // The ordinary safety exit deliberately bounds large arrays in proxied catalogues.
      if (method !== 'manager.catalog') expect(proxied.result).toEqual(direct);
      if (method === 'manager.query') expect(direct.available_actions).toEqual([]);
    }
  });
  try {
    f.set({ 'worker.resume': 'unavailable' });
    f.project.submitManagementInstruction({ instruction: 'safe read aliases' }); await f.run();
  } finally { await f.close(); }
});

test('ordinary development invocation cannot read or change management defaults', async () => {
  let rpc, checked = 0;
  const f = fixture({ async run({ token }) {
    for (const method of ['management.permissions','management.permissions_update']) {
      await expect(rpc.dispatch(method, { ...(method.endsWith('_update') ? { permissions: {}, expected_revision: 'x' } : {}), _token: token })).rejects.toThrow('requires user approval');
      checked++;
    }
    return 'done';
  } });
  f.project.kick = () => {};
  try {
    await repo(f.root); rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
    await f.project.order('ordinary invocation', 'main', [], null, true);
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(checked).toBe(2);
  } finally { await f.close(); }
});

test('legacy no-snapshot Valets retain original authorization, but missing snapshot methods fail closed', async () => {
  let reply;
  const f = await prepared(async ({ token, rpc }) => {
    reply = await rpc.dispatch('manager.call', { method: 'draft.add', params: { content: 'legacy works' }, _token: token });
  });
  try {
    f.set({ 'draft.add': 'unavailable' });
    const manager = f.project.submitManagementInstruction({ instruction: 'legacy' }).task;
    const state = f.state(manager); delete state.permissions_snapshot;
    f.store.update(manager.id, { management: JSON.stringify(state) });
    await f.run(); expect(reply.status).toBe('succeeded'); expect(f.store.draftCount()).toBe(1);
    expect(effectiveManagementPolicy('draft.add', { version: 1, permissions: {} }).access).toBe('unavailable');
    expect(effectiveManagementPolicy('worker.transcript', { permissions: { 'worker.transcript': 'read' } }).access).toBe('unavailable');
    expect(effectiveManagementPolicy('future.unknown', { permissions: { 'future.unknown': 'automatic' } }).access).toBe('unavailable');
  } finally { await f.close(); }
});

for (const action of ['start','retry']) for (const entry of ['dedicated','call']) test(`${entry} ${action}: tightened confirmation uses exact user approval then original waiting/config/dedup gates`, async () => {
  let receipt, duplicate;
  const method = action === 'start' ? 'worker.resume' : 'worker.retry';
  const f = await prepared(async ({ token, rpc }) => {
    const request = entry === 'dedicated' ? () => rpc.dispatch(`manager.${action}`, { id: f.target.id, _token: token })
      : () => rpc.dispatch('manager.call', { method, params: { id: f.target.id }, _token: token });
    receipt = await request(); duplicate = await request();
  });
  try {
    if (action === 'retry') f.store.update(f.target.id, { status: 'failed' });
    const oldProfile = f.store.task(f.target.id).retry_profile;
    f.set({ [method]: 'confirmation' });
    const manager = f.project.submitManagementInstruction({ instruction: 'confirm exact action' }).task;
    await f.run();
    expect(receipt).toMatchObject({ method, status: 'pending_confirmation' }); expect(duplicate).toEqual(receipt);
    expect(f.store.task(f.target.id).status).toBe(action === 'start' ? 'paused' : 'failed');
    // Changing defaults cannot revoke or raise this already-submitted exact operation.
    f.set({ [method]: 'unavailable' });
    f.project.workspaces.busy.add(f.target.id);
    await f.confirm(receipt.notice_id);
    expect(f.state(manager).control_calls[0].status).toBe('succeeded');
    expect(f.state(manager).receipts[0].status).toBe('waiting');
    f.project.workspaces.busy.delete(f.target.id);
    f.project.drainManagementActions();
    expect(f.state(manager).receipts[0].status).toBe('succeeded');
    expect(f.store.task(f.target.id).status).toBe('queued');
    expect(f.store.task(f.target.id).retry_profile).toBe(oldProfile);
    expect(f.state(manager).receipts).toHaveLength(1);
  } finally { await f.close(); }
});

test('manager.call lifecycle alias cannot change profile or resume a non-development identity', async () => {
  let result;
  const f = await prepared(async ({ token, rpc, task }) => {
    await expect(rpc.dispatch('manager.call', { method: 'worker.resume', params: { id: f.target.id, profile: {} }, _token: token })).rejects.toThrow('preserves saved configuration');
    result = await rpc.dispatch('manager.call', { method: 'worker.resume', params: { id: task.id }, _token: token });
  });
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'no bypass' }).task; await f.run();
    expect(result.status).toBe('failed'); // Its own authorization state changed; no target effect.
    expect(f.state(manager).receipts).toEqual([]);
    expect(f.store.task(f.target.id).status).toBe('paused');
  } finally { await f.close(); }
});
