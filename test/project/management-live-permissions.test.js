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

for (const access of ['unavailable']) test(`queued automatic capability rechecks ${access} at write admission; failed requests never replay after relaxation`, async () => {
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

for (const access of ['automatic']) test(`pending confirmation rechecks latest ${access}, closes its Notice, and never wakes a model`, async () => {
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
