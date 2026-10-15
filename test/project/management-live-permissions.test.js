import { test, expect } from 'bun:test';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';

const approve = { answers: [{ selected: [1], custom: '' }] };
async function prepared(invoke = async () => {}) {
  let f;
  f = fixture({ async run(args) { if (args.task.role === 'manager') await invoke({ ...args, rpc: f.rpc }); return 'done'; } });
  f.project.kick = () => {}; await repo(f.root);
  f.rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
  f.target = (await f.project.order('target', 'main', [], null, false)).task;
  f.state = manager => JSON.parse(f.store.task(manager.id).management);
  f.set = patch => { const current = f.project.managementPermissions(); return f.project.setManagementPermissions({ ...current.permissions, ...patch }, current.revision); };
  f.run = async () => {
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    for (const task of f.store.all("SELECT * FROM tasks WHERE task_kind='management'")) expect(task.error).toBeNull();
  };
  f.jobs = async () => { await Promise.all([...(f.project.managementControlJobs ?? [])]); };
  f.call = (token, method, params, request_id) => f.rpc.dispatch('manager.call', { method, params, request_id, _token: token });
  return f;
}

for (const history of ['missing','empty','denied','allowed']) test(`live reads, discovery and writes ignore ${history} historical permissions throughout an existing invocation`, async () => {
  const f = await prepared(async ({ token, rpc }) => {
    f.set({ 'manager.query': 'unavailable', 'manager.history': 'unavailable', 'worker.lookup': 'unavailable', 'draft.add': 'unavailable' });
    for (const method of ['manager.query','manager.history','worker.lookup']) {
      const params = method === 'worker.lookup' ? { number: f.target.worker_number } : {};
      await expect(rpc.dispatch(method, { ...params, _token: token })).rejects.toThrow('最新项目权限禁止');
      await expect(f.call(token, method, params)).rejects.toThrow('最新项目权限禁止');
    }
    await expect(f.call(token, 'draft.add', { content: 'not authorized' })).rejects.toThrow('最新项目权限禁止');
    expect((await rpc.dispatch('manager.catalog', { _token: token })).methods.find(item => item.method === 'draft.add').access).toBe('unavailable');
    f.set({ 'manager.query': 'read', 'manager.history': 'read', 'worker.lookup': 'read', 'draft.add': 'automatic' });
    for (const method of ['manager.query','manager.history','worker.lookup']) {
      const params = method === 'worker.lookup' ? { number: f.target.worker_number } : {};
      expect(await rpc.dispatch(method, { ...params, _token: token })).toBeTruthy();
      expect((await f.call(token, method, params)).status).toBe('succeeded');
    }
    expect((await f.call(token, 'draft.add', { content: 'now authorized' })).status).toBe('succeeded');
  });
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'live project policy' }).task;
    const state = f.state(manager);
    if (history === 'missing') delete state.permissions_snapshot;
    if (history === 'empty') state.permissions_snapshot.permissions = {};
    if (history === 'denied') for (const method of Object.keys(state.permissions_snapshot.permissions)) state.permissions_snapshot.permissions[method] = 'unavailable';
    f.store.update(manager.id, { management: JSON.stringify(state) });
    const historyBefore = f.state(manager).permissions_snapshot;
    await f.run(); expect(f.store.draftCount()).toBe(1);
    expect(f.state(manager).permissions_snapshot).toEqual(historyBefore);
    expect(f.project.inspect(manager.id).management).not.toHaveProperty('execution_authorization');
  } finally { await f.close(); }
});

for (const access of ['unavailable','confirmation','automatic']) test(`queued automatic capability rechecks ${access} at write admission; failed requests never replay after relaxation`, async () => {
  let reply, duplicate;
  const f = await prepared(async ({ token }) => {
    const original = f.project.write.bind(f.project); let queued = false;
    f.project.write = async (action, fn) => {
      if (action === 'execute confirmed management capability' && !queued) {
        queued = true; await Promise.resolve(); f.set({ 'draft.add': access });
        const call = f.state(manager).control_calls[0];
        expect(call.status).toBe('approved'); expect(call.started_at).toBeUndefined();
      }
      return original(action, fn);
    };
    reply = await f.call(token, 'draft.add', { content: 'fixed queued request' }, 'same');
    f.set({ 'draft.add': 'automatic' });
    duplicate = await f.call(token, 'draft.add', { content: 'fixed queued request' }, 'same');
  });
  let manager;
  try {
    manager = f.project.submitManagementInstruction({ instruction: 'write admission' }).task;
    await f.run(); await f.jobs();
    expect(reply.status).toBe(access === 'automatic' ? 'succeeded' : 'failed'); expect(duplicate).toEqual(reply);
    if (access !== 'automatic') expect(reply.reason).toContain(access === 'confirmation' ? '最新项目权限要求重新精确确认' : '最新项目权限禁止');
    expect(f.state(manager).pending_signal).toBeNull(); expect(f.project.managementOccupant()).toBeNull();
    expect(f.store.task(manager.id).status).toBe('completed');
    expect(f.store.draftCount()).toBe(access === 'automatic' ? 1 : 0);
    expect(f.state(manager).control_calls).toHaveLength(1);
    const started = f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='management.capability_started'", manager.id).n;
    expect(started).toBe(access === 'automatic' ? 1 : 0);
  } finally { await f.close(); }
});

for (const access of ['unavailable','confirmation']) test(`already-started capability keeps fixed authorization after project changes to ${access}, including real dispatcher receipt validation`, async () => {
  let reply;
  const f = await prepared(async ({ token }) => {
    const original = f.project.managementDispatch;
    f.project.managementDispatch = async (...args) => {
      const call = f.state(manager).control_calls[0]; expect(call.status).toBe('running');
      expect(call.execution_authorization.permissions).toEqual({ 'draft.add': 'automatic' });
      f.set({ 'draft.add': access }); await Promise.resolve();
      return original(...args);
    };
    reply = await f.call(token, 'draft.add', { content: 'started effect' }, 'started');
  });
  let manager;
  try {
    manager = f.project.submitManagementInstruction({ instruction: 'fixed start authority' }).task;
    await f.run(); await f.jobs(); expect(reply.status).toBe('succeeded'); expect(f.store.draftCount()).toBe(1);
    f.set({ 'draft.add': 'unavailable' }); await f.jobs(); expect(f.store.draftCount()).toBe(1);
    expect(f.state(manager).control_calls[0].status).toBe('succeeded');
  } finally { await f.close(); }
});

for (const access of ['unavailable','automatic']) test(`pending confirmation rechecks latest ${access}, closes its Notice, and never wakes a model`, async () => {
  let reply;
  const f = await prepared(async ({ token }) => { reply = await f.call(token, 'draft.add', { content: 'pending effect' }); });
  try {
    f.set({ 'draft.add': 'confirmation' });
    const manager = f.project.submitManagementInstruction({ instruction: 'pending confirmation' }).task;
    await f.run(); expect(reply.status).toBe('pending_confirmation');
    let wakes = 0; f.project.wake = () => { wakes++; };
    // An already persisted delayed answer must not become a later model input.
    f.store.message(manager.id, JSON.stringify({ notice_id: reply.notice_id, answer: approve, answer_source: 'user' }));
    f.set({ 'draft.add': access }); await f.jobs();
    expect(f.state(manager).control_calls[0].status).toBe(access === 'automatic' ? 'succeeded' : 'rejected');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', reply.notice_id).status).toBe('dismissed');
    const messages = f.store.all("SELECT consumed FROM messages WHERE task_id=? AND json_valid(body) AND json_extract(body,'$.notice_id')=?", manager.id, reply.notice_id);
    expect(messages).toHaveLength(1); expect(messages[0].consumed).toBe(1);
    expect(() => f.project.answer(reply.notice_id, approve)).toThrow('notice is not open');
    expect(f.project.resolveManagementConfirmation(reply.notice_id)).toBe(true); await f.jobs();
    expect(f.state(manager).pending_signal).toBeNull(); expect(f.project.managementOccupant()).toBeNull();
    expect(f.store.draftCount()).toBe(access === 'automatic' ? 1 : 0); expect(wakes).toBe(0);
    f.set({ 'draft.add': 'automatic' }); f.project.drainManagementActions(); await f.jobs();
    expect(f.store.draftCount()).toBe(access === 'automatic' ? 1 : 0);
  } finally { await f.close(); }
});

for (const stopped of ['rejected','cancelled']) test(`relaxing confirmation cannot replay a previously ${stopped} request or retain its serial lane`, async () => {
  let reply;
  const f = await prepared(async ({ token }) => { reply = await f.call(token, 'draft.add', { content: 'never replay' }); });
  try {
    f.set({ 'draft.add': 'confirmation' });
    const manager = f.project.submitManagementInstruction({ instruction: 'stopped confirmation' }).task;
    await f.run(); expect(reply.status).toBe('pending_confirmation');
    if (stopped === 'rejected') f.project.answer(reply.notice_id, { answers: [{ selected: [0], custom: '' }] });
    else f.project.cancelManagementWorker(manager.id, 'test cancellation');
    await f.jobs();
    f.set({ 'draft.add': 'automatic' }); f.project.drainManagementActions(); await f.jobs();
    expect(f.state(manager).control_calls[0].status).toBe('rejected');
    expect(f.state(manager).pending_signal).toBeNull(); expect(f.project.managementOccupant()).toBeNull();
    expect(() => f.project.answer(reply.notice_id, approve)).toThrow('notice is not open');
    expect(f.store.draftCount()).toBe(0);
  } finally { await f.close(); }
});

for (const phase of ['submission','execution']) test(`permission change during asynchronous ${phase} preflight cannot submit or start a stale authorization`, async () => {
  let receipt, changed = false;
  const f = await prepared(async ({ token }) => {
    if (phase === 'submission') await expect(f.call(token, 'worker.cancel', { id: f.target.id })).rejects.toThrow('最新项目权限禁止');
    else receipt = await f.call(token, 'worker.cancel', { id: f.target.id });
  });
  try {
    const git = f.project.workspaces.git.bind(f.project.workspaces);
    let armed = phase === 'submission';
    f.project.workspaces.git = async (...args) => {
      const result = await git(...args);
      if (armed && !changed && args.includes('--porcelain')) { changed = true; f.set({ 'worker.cancel': 'unavailable' }); }
      return result;
    };
    const manager = f.project.submitManagementInstruction({ instruction: 'preflight recheck' }).task;
    await f.run();
    if (phase === 'execution') { armed = true; f.project.answer(receipt.notice_id, approve); await f.jobs(); }
    expect(changed).toBe(true); expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='management.capability_started'", manager.id).n).toBe(0);
    expect(f.state(manager).control_calls).toHaveLength(phase === 'submission' ? 0 : 1);
    if (phase === 'execution') expect(f.state(manager).control_calls[0].status).toBe('failed');
  } finally { await f.close(); }
});

for (const action of ['start','retry']) for (const access of ['unavailable','confirmation']) test(`waiting ${action} action rechecks ${access} at its actual start and relaxation never replays a skipped effect`, async () => {
  let reply;
  const method = action === 'start' ? 'worker.resume' : 'worker.retry';
  const f = await prepared(async ({ token, rpc }) => { reply = await rpc.dispatch(`manager.${action}`, { id: f.target.id, _token: token }); });
  try {
    if (action === 'retry') f.store.update(f.target.id, { status: 'failed' });
    f.project.workspaces.busy.add(f.target.id);
    const manager = f.project.submitManagementInstruction({ instruction: 'waiting action' }).task;
    await f.run(); expect(reply.status).toBe('waiting');
    f.set({ [method]: access }); f.project.workspaces.busy.delete(f.target.id); f.project.drainManagementActions();
    expect(f.state(manager).receipts[0].status).toBe('skipped');
    expect(f.state(manager).receipts[0].reason).toContain(access === 'confirmation' ? '最新项目权限要求重新精确确认' : '最新项目权限禁止');
    expect(f.state(manager).pending_signal).toBeNull(); expect(f.project.managementOccupant()).toBeNull();
    expect(f.store.task(f.target.id).status).toBe(action === 'start' ? 'paused' : 'failed');
    f.set({ [method]: 'automatic' }); f.project.drainManagementActions();
    expect(f.state(manager).receipts[0].status).toBe('skipped');
  } finally { f.project.workspaces.busy.delete(f.target.id); await f.close(); }
});

for (const action of ['start','retry']) for (const history of [false,true]) test(`confirmed waiting ${action} retains exact approval when automatic permission is tightened back to confirmation (historical receipt: ${history})`, async () => {
  let receipt;
  const method = action === 'start' ? 'worker.resume' : 'worker.retry';
  const f = await prepared(async ({ token }) => { receipt = await f.call(token, method, { id: f.target.id }); });
  try {
    if (action === 'retry') f.store.update(f.target.id, { status: 'failed' });
    f.set({ [method]: 'confirmation' }); f.project.workspaces.busy.add(f.target.id);
    const manager = f.project.submitManagementInstruction({ instruction: 'approved waiting action' }).task;
    await f.run(); f.project.answer(receipt.notice_id, approve); await f.jobs();
    expect(f.state(manager).receipts[0].status).toBe('waiting');
    if (history) {
      const state = f.state(manager); delete state.receipts[0].capability_receipt_id;
      f.store.update(manager.id, { management: JSON.stringify(state) });
    }
    f.set({ [method]: 'automatic' }); f.set({ [method]: 'confirmation' });
    f.project.workspaces.busy.delete(f.target.id); f.project.drainManagementActions();
    expect(f.state(manager).receipts[0].status).toBe('succeeded'); expect(f.store.task(f.target.id).status).toBe('queued');
  } finally { f.project.workspaces.busy.delete(f.target.id); await f.close(); }
});

test('waiting and persistent signal bindings use current policy on every occurrence without rewriting historical snapshots', async () => {
  const observed = [];
  const f = await prepared(async ({ token, rpc }) => {
    const catalog = await rpc.dispatch('manager.catalog', { _token: token });
    observed.push(catalog.methods.find(item => item.method === 'draft.add').access);
    if (observed.at(-1) === 'unavailable') await expect(f.call(token, 'draft.add', { content: 'blocked' })).rejects.toThrow();
    else expect((await f.call(token, 'draft.add', { content: 'allowed' })).status).toBe('succeeded');
  });
  try {
    const signal = f.project.saveHookSignal({ name: 'daily', schedule: { kind: 'daily', time: '01:00', timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items[0];
    const waiting = f.project.createManagementWorker({ name: 'once', instruction: 'waiting', signal_id: signal.id });
    const persistent = f.project.createManagementWorker({ name: 'persistent', instruction: 'persistent', signal_id: signal.id, mode: 'persistent' });
    const snapshots = [waiting,persistent].map(manager => f.state(manager).permissions_snapshot);
    const submit = manager => f.project.submitManagementSignal(manager.id, { id: f.store.event(null, 'test.signal', {}), signal_id: signal.id, due_at: new Date().toISOString() });
    f.set({ 'draft.add': 'unavailable' }); submit(waiting); await f.run(); submit(persistent); await f.run();
    f.set({ 'draft.add': 'automatic' }); submit(persistent); await f.run();
    expect(observed).toEqual(['unavailable','unavailable','automatic']); expect(f.store.draftCount()).toBe(1);
    expect([waiting,persistent].map(manager => f.state(manager).permissions_snapshot)).toEqual(snapshots);
  } finally { await f.close(); }
});

test('restart rechecks an unstarted durable approval against persisted current project permissions, not the old snapshot', async () => {
  let receipt;
  const f = await prepared(async ({ token }) => {
    f.project.stopping = true;
    receipt = await f.call(token, 'draft.add', { content: 'not started before restart' }, 'durable');
  });
  let restarted, store;
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'restart durable request' }).task;
    const snapshot = f.state(manager).permissions_snapshot;
    await f.run(); expect(receipt.status).toBe('approved');
    f.set({ 'draft.add': 'confirmation' }); await f.project.shutdown();
    store = new Store(path.join(f.config.home, 'project.db'), f.root);
    restarted = new Project(f.config, store, { run: () => 'done' }); restarted.kick = () => {};
    new Dispatcher(restarted, { isRequested: () => false }, {});
    restarted.recover(); await Promise.all([...(restarted.managementControlJobs ?? [])]);
    await restarted.executeManagementCapability(manager.id, receipt.receipt_id);
    const state = JSON.parse(store.task(manager.id).management);
    expect(state.permissions_snapshot).toEqual(snapshot); expect(state.control_calls[0].status).toBe('failed');
    expect(state.control_calls[0].started_at).toBeUndefined(); expect(store.draftCount()).toBe(0);
    const current = restarted.managementPermissions();
    restarted.setManagementPermissions({ ...current.permissions, 'draft.add': 'automatic' }, current.revision);
    await Promise.all([...(restarted.managementControlJobs ?? [])]); expect(store.draftCount()).toBe(0);
  } finally { await restarted?.shutdown(); store?.close(); await f.close(); }
});
