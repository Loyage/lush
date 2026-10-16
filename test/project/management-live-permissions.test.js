import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, temp, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';
import { readDeviceManagementPermissions, saveDeviceManagementPermissions } from '../../src/core/management-permissions.js';

const approve = { answers: [{ selected: [1], custom: '' }] };
async function prepared(invoke = async () => {}, extra = {}) {
  let f;
  f = fixture({ async run(args) { if (args.task.role === 'manager') await invoke({ ...args, rpc: f.rpc }); return 'done'; } }, extra);
  f.project.kick = () => {}; await repo(f.root);
  f.rpc = new Dispatcher(f.project, { isRequested: () => false }, {});
  f.target = (await f.project.order('target', 'main', [], null, false)).task;
  f.state = manager => JSON.parse(f.store.task(manager.id).management);
  f.set = patch => {
    const current = readDeviceManagementPermissions(f.config);
    const saved = saveDeviceManagementPermissions(f.config, { ...current.permissions, ...patch }, current.revision);
    f.project.refreshManagementPermissions(); return saved;
  };
  f.run = async () => {
    f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    for (const task of f.store.all("SELECT * FROM tasks WHERE task_kind='management'")) expect(task.error).toBeNull();
  };
  f.jobs = async () => { await Promise.all([...(f.project.managementControlJobs ?? [])]); };
  f.call = (token, method, params, request_id) => f.rpc.dispatch('manager.call', { method, params, request_id, _token: token });
  return f;
}

for (const access of ['unavailable','confirmation']) test(`queued automatic capability rechecks ${access} at write admission; failed requests never replay after relaxation`, async () => {
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
    if (access !== 'automatic') expect(reply.reason).toContain(access === 'confirmation' ? '最新管家权限要求重新精确确认' : '最新管家权限禁止');
    expect(f.state(manager).pending_signal).toBeNull(); expect(f.project.managementOccupant()).toBeNull();
    expect(f.store.task(manager.id).status).toBe('completed');
    expect(f.store.draftCount()).toBe(access === 'automatic' ? 1 : 0);
    expect(f.state(manager).control_calls).toHaveLength(1);
    const started = f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='management.capability_started'", manager.id).n;
    expect(started).toBe(access === 'automatic' ? 1 : 0);
  } finally { await f.close(); }
});

for (const access of ['automatic','unavailable']) test(`pending confirmation rechecks latest ${access}, closes its Notice, and never wakes a model`, async () => {
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

test('two online project monitors recheck shared pending confirmations within one tick, without replay or model wake', async () => {
  const root = temp(), replies = [];
  const a = await prepared(async ({ token }) => { replies[0] = await a.call(token, 'draft.add', { content: 'A' }); }, { LUSH_GLOBAL_CONFIG: root });
  const b = await prepared(async ({ token }) => { replies[1] = await b.call(token, 'draft.add', { content: 'B' }); }, { LUSH_GLOBAL_CONFIG: root });
  try {
    a.set({ 'draft.add': 'confirmation' });
    const managers = [a,b].map(f => f.project.submitManagementInstruction({ instruction: 'shared pending confirmation' }).task);
    const history = [a,b].map((f, i) => f.state(managers[i]).permissions_snapshot);
    await a.run(); await b.run(); expect(replies.map(reply => reply.status)).toEqual(['pending_confirmation','pending_confirmation']);
    let wakes = 0; for (const f of [a,b]) { f.project.wake = () => { wakes++; }; f.project.startManagementPermissionsMonitor(); }
    const current = readDeviceManagementPermissions(a.config);
    saveDeviceManagementPermissions(a.config, { ...current.permissions, 'draft.add': 'unavailable' }, current.revision);
    await until(() => [a,b].every((f, i) => f.state(managers[i]).control_calls[0].status === 'rejected'));
    for (const [i, f] of [a,b].entries()) {
      expect(f.store.get('SELECT status FROM notices WHERE id=?', replies[i].notice_id).status).toBe('dismissed');
      expect(f.state(managers[i]).permissions_snapshot).toEqual(history[i]); expect(f.store.draftCount()).toBe(0);
    }
    const restrictive = readDeviceManagementPermissions(a.config);
    const relaxed = saveDeviceManagementPermissions(a.config, { ...restrictive.permissions, 'draft.add': 'automatic' }, restrictive.revision);
    await until(() => [a,b].every(f => f.project.managementPermissionsObservedRevision === `device:${relaxed.revision}`));
    expect(wakes).toBe(0); expect([a,b].map(f => f.store.draftCount())).toEqual([0,0]);
    for (const f of [a,b]) { f.project.stopManagementPermissionsMonitor(); expect(f.project.managementPermissionsMonitor).toBeNull(); }
  } finally { await a.close(); await b.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const access of ['unavailable','confirmation']) test(`shared tightening to ${access} skips an unstarted blocked lifecycle action; later relaxation does not replay`, async () => {
  let reply;
  const f = await prepared(async ({ token, rpc }) => {
    f.project.workspaces.busy.add(f.target.id);
    reply = await rpc.dispatch('manager.start', { id: f.target.id, _token: token });
  });
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'blocked start' }).task;
    await f.run(); expect(reply.status).toBe('waiting'); expect(f.store.task(f.target.id).status).toBe('paused');
    f.set({ 'worker.resume': access }); await f.jobs();
    expect(f.state(manager).receipts[0].status).toBe('skipped');
    f.project.workspaces.busy.delete(f.target.id);
    f.set({ 'worker.resume': 'automatic' }); f.project.drainManagementActions(); await f.jobs();
    expect(f.state(manager).receipts[0].status).toBe('skipped'); expect(f.store.task(f.target.id).status).toBe('paused');
  } finally { f.project.workspaces.busy.delete(f.target.id); await f.close(); }
});

test('confirmed device-setting effects acquire their own settings-write lock after policy start admission releases it', async () => {
  let reply;
  const f = await prepared(async ({ token }) => { reply = await f.call(token, 'hooks.auto_select', {
    enabled: true, scope: 'device', expected_revision: f.project.deviceAutomation.get().revision,
  }); });
  try {
    f.set({});
    const manager = f.project.submitManagementInstruction({ instruction: 'enable global device automatic selection' }).task;
    await f.run(); expect(reply.status).toBe('pending_confirmation');
    f.project.answer(reply.notice_id, approve); await f.jobs();
    expect(f.state(manager).control_calls[0].status).toBe('succeeded');
    expect(f.project.deviceAutomation.get().auto_select.enabled).toBe(true);
  } finally { await f.close(); }
});

test('another process holding settings-write cannot be bypassed by final capability admission; failed calls do not replay', async () => {
  let result;
  const f = await prepared(async ({ token }) => { result = await f.call(token, 'draft.add', { content: 'must not start under foreign writer' }); });
  const module = new URL('../../src/core/device-config.js', import.meta.url).pathname;
  let child;
  try {
    f.set({});
    child = Bun.spawn([Bun.which('bun'), '--eval', `import { acquireConfigurationLock } from ${JSON.stringify(module)};
      const lock = acquireConfigurationLock(${JSON.stringify({ deviceHome: f.config.deviceHome })}, 'device');
      console.log('locked'); await new Response(Bun.stdin).text(); lock.release();`], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader(), ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain('locked');
    const manager = f.project.submitManagementInstruction({ instruction: 'cross-process admission' }).task;
    await f.run(); await f.jobs();
    expect(result.status).toBe('failed'); expect(f.state(manager).control_calls[0].started_at).toBeUndefined(); expect(f.store.draftCount()).toBe(0);
    child.stdin.end(); expect(await child.exited).toBe(0); child = null;
    f.project.drainManagementActions(); expect(f.store.draftCount()).toBe(0);
  } finally {
    if (child) { child.stdin.end(); await child.exited; }
    await f.close();
  }
});

test('shared permission save orders after durable start but does not stop or reauthorize an already-started effect', async () => {
  const entered = gate(), finish = gate(); let result;
  const f = await prepared(async ({ token }) => { result = await f.call(token, 'draft.add', { content: 'already started' }); });
  const dispatch = f.project.managementDispatch;
  f.project.managementDispatch = async (...args) => {
    if (args[0] === 'draft.add') { entered.resolve(); await finish.promise; }
    return dispatch(...args);
  };
  try {
    const manager = f.project.submitManagementInstruction({ instruction: 'running boundary' }).task;
    const run = f.run(); await entered.promise;
    const started = f.state(manager).control_calls[0];
    expect(started.status).toBe('running'); expect(started.execution_authorization.permissions['draft.add']).toBe('automatic');
    f.set({ 'draft.add': 'unavailable' }); expect(f.state(manager).control_calls[0].status).toBe('running');
    finish.resolve(); await run; await f.jobs();
    expect(result.status).toBe('succeeded'); expect(f.store.draftCount()).toBe(1);
    expect(f.state(manager).control_calls[0].execution_authorization).toEqual(started.execution_authorization);
  } finally { finish.resolve(); await f.close(); }
});
