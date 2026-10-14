import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { Store } from '../../src/persistence/store.js';
import { Project } from '../../src/core/project.js';

async function setup(provider = () => 'done') {
  let f;
  f = fixture({ run: args => provider(args, f) });
  f.project.kick = () => {}; await repo(f.root);
  f.rpc = new Dispatcher(f.project, { isRequested: () => false, request() {} }, {});
  let clock = Date.parse('2030-01-01T00:00:00Z');
  f.project.scheduledHookOptions = { now: () => clock, setTimeout: () => 1, clearTimeout() {} };
  f.advance = ms => { clock += ms; f.project.observeScheduledTaskHooks(); };
  f.signal = () => f.project.saveHookSignal({ name: 'future', schedule: { kind: 'daily', time: '00:01', timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items.at(-1);
  f.bind = (signal, mode = 'once') => f.project.createManagementWorker({ name: 'bound', instruction: 'manage', signal_id: signal.id, mode });
  f.submit = (key = 'immediate') => f.project.submitManagementInstruction({ instruction: 'manage', client_request_id: key }).task;
  f.state = task => JSON.parse(f.store.task(task.id).management);
  f.disable = task => f.project.updateManagementBinding(task.id, false, f.project.managementView(task.id).revision);
  f.run = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
  return f;
}
const approve = { answers: [{ selected: [1], custom: '' }] };

test('project-local serial admission rejects concurrent new identities while exact duplicates return their original queued Worker', async () => {
  const f = await setup(), isolated = await setup();
  try {
    const signal = f.signal();
    const replies = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => f.rpc.dispatch('management.submit', {
      instruction: 'manage', client_request_id: i < 6 ? 'same' : `distinct-${i}`,
    })));
    expect(replies.filter(reply => reply.status === 'fulfilled')).toHaveLength(6);
    expect(new Set(replies.filter(reply => reply.status === 'fulfilled').map(reply => reply.value.task.id)).size).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n).toBe(1);
    expect(() => f.bind(signal)).toThrow('当前项目已有管家');
    expect(() => f.project.submitManagementInstruction({ instruction: 'changed', client_request_id: 'same' })).toThrow('different management definition');
    expect(isolated.submit().status).toBe('queued'); // Not a device/cross-project lock.
    const first = replies[0].value.task;
    f.disable(first); expect(f.project.managementOccupant()).toBeNull();
    expect(f.submit('after-stop').worker_number).toBe('V2');
  } finally { await isolated.close(); await f.close(); }
});

test('existing future bindings wait without occupancy, then run fairly by occurrence age across freeze and daily triggers', async () => {
  const order = [], entered = gate(), release = gate();
  const f = await setup(async ({ task }) => {
    order.push(task.id); if (order.length === 1) { entered.resolve(); await release.promise; } return 'done';
  });
  try {
    const signal = f.signal(), old = f.bind(signal, 'persistent'), younger = f.bind(signal, 'persistent');
    expect(f.project.managementOccupant()).toBeNull();
    const immediate = f.submit(); // Its occurrence predates the signal, despite a newer Worker ID.
    f.advance(60000); f.project.pump(); await entered.promise;
    expect(order).toEqual([immediate.id]);
    expect(f.project.running.size).toBe(1);
    const freeze = f.project.branchFreeze.bind(f.project);
    f.project.branchFreeze = () => [{ branch: 'main', reason: 'freeze' }];
    f.project.pump(); expect(order).toEqual([immediate.id]);
    f.disable(immediate); f.advance(86400000); f.project.pump();
    expect(() => f.submit('cannot-bypass-disable')).toThrow('当前项目已有管家');
    expect(f.state(old).pending_signal.id).toBe(f.state(younger).pending_signal.id);
    f.project.branchFreeze = freeze;
    release.resolve(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    await f.run(); await f.run();
    expect(order).toEqual([immediate.id, old.id, younger.id]);
    expect(f.project.managementOccupant()).toBeNull();
    f.advance(86400000); await f.run(); await f.run();
    expect(order).toEqual([immediate.id, old.id, younger.id, old.id, younger.id]);
  } finally { release.resolve(); await f.close(); }
});

for (const stop of ['disable','cancel']) test(`${stop} revokes dangerous confirmation but cannot release model ownership before actual exit`, async () => {
  const entered = gate(), release = gate(); let confirmation;
  const f = await setup(async ({ task, token }, f) => {
    confirmation = await f.rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token });
    entered.resolve(); await release.promise; return 'physically exited';
  });
  try {
    f.target = (await f.project.order('target is not a child of its manager', 'main', [], null, false)).task;
    const manager = f.submit(); f.project.pump(); await entered.promise;
    expect(confirmation.status).toBe('pending_confirmation');
    const blocked = await f.project.deleteTaskPreview(manager.id);
    expect(blocked.can_delete).toBe(false); expect(blocked.blockers.join(' ')).toContain('enabled');
    if (stop === 'disable') f.disable(manager); else await f.rpc.dispatch('worker.cancel', { id: manager.id });
    expect(f.state(manager).control_calls[0].status).toBe('rejected');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', confirmation.notice_id).status).toBe('dismissed');
    expect(f.project.running.get(manager.id).controller.signal.aborted).toBe(stop === 'cancel');
    expect(() => f.submit('still-exiting')).toThrow('当前项目已有管家');
    expect((await f.project.deleteTaskPreview(manager.id)).blockers.join(' ')).toContain('exiting');
    await f.project.resolveManagementConfirmationUnsafe(confirmation.notice_id);
    expect(f.store.task(f.target.id).status).toBe('paused');
    release.resolve(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.project.managementOccupant()).toBeNull();
    const preview = await f.project.deleteTaskPreview(manager.id);
    expect(preview.can_delete).toBe(true);
    expect(preview.workers.map(task => task.id)).toEqual([manager.id]);
    await f.project.deleteTask(manager.id, { revision: preview.revision, confirm: true });
    expect(f.store.task(f.target.id).status).toBe('paused');
  } finally { release.resolve(); await f.close(); }
});

test('returned dangerous confirmation owns the lane until user rejects or stops it without another model call', async () => {
  let confirmation, calls = 0;
  const f = await setup(async ({ token }, f) => {
    calls++; confirmation = await f.rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token }); return 'waiting for user';
  });
  try {
    f.target = (await f.project.order('paused target', 'main', [], null, false)).task;
    const signal = f.signal(), next = f.bind(signal);
    const manager = f.submit(); await f.run(); f.advance(60000);
    expect(f.store.task(manager.id).status).toBe('awaiting');
    f.project.pump(); expect(calls).toBe(1);
    expect(() => f.submit('blocked-by-confirmation')).toThrow('当前项目已有管家');
    f.disable(manager); await f.run();
    expect(calls).toBe(2); expect(f.store.task(next.id).status).toBe('awaiting');
    f.disable(next); expect(f.project.managementOccupant()).toBeNull();
    expect(f.store.task(f.target.id).status).toBe('paused');
  } finally { await f.close(); }
});

test('stop cannot revoke an already executing dangerous side effect; deletion and serial lane wait for its actual receipt', async () => {
  const entered = gate(), release = gate(); let confirmation;
  const f = await setup(async ({ token }, f) => {
    confirmation = await f.rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token }); return 'submitted';
  });
  try {
    f.target = (await f.project.order('target', 'main', [], null, false)).task;
    const manager = f.submit(); await f.run();
    // Park inside the real side effect, after the trusted dispatch has checked
    // actor/receipt/confirmation. Stopping cannot revoke an already entered handler.
    const cancel = f.project.cancel.bind(f.project);
    f.project.cancel = async (...args) => {
      entered.resolve(); await release.promise;
      return cancel(...args);
    };
    f.project.answer(confirmation.notice_id, approve); await entered.promise;
    f.disable(manager); expect(f.state(manager).control_calls[0].status).toBe('running');
    expect(() => f.submit('running-effect')).toThrow('当前项目已有管家');
    expect((await f.project.deleteTaskPreview(manager.id)).can_delete).toBe(false);
    release.resolve(); await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.state(manager).control_calls[0].status).toBe('succeeded');
    expect(f.store.task(f.target.id).status).toBe('cancelled');
    expect(f.project.managementOccupant()).toBeNull();
    expect((await f.project.deleteTaskPreview(manager.id)).can_delete).toBe(true);
  } finally { release.resolve(); await f.close(); }
});

test('stopping between durable start and actual legacy dispatch prevents the effect and retains unknown protection', async () => {
  const entered = gate(), release = gate(); let confirmation;
  const f = await setup(async ({ token }, f) => {
    confirmation = await f.rpc.dispatch('manager.call', { method: 'worker.cancel', params: { id: f.target.id }, _token: token });
    return 'submitted';
  });
  try {
    f.target = (await f.project.order('target', 'main', [], null, false)).task;
    const manager = f.submit(); await f.run();
    const dispatch = f.project.managementDispatch;
    f.project.managementDispatch = async (...args) => { entered.resolve(); await release.promise; return dispatch(...args); };
    f.project.answer(confirmation.notice_id, approve); await entered.promise;
    f.disable(manager);
    release.resolve(); await Promise.all([...(f.project.managementControlJobs ?? [])]);
    expect(f.state(manager).control_calls[0].status).toBe('unknown');
    expect(f.store.task(f.target.id).status).not.toBe('cancelled');
    expect((await f.project.deleteTaskPreview(manager.id)).can_delete).toBe(false);
    expect(() => f.submit('cannot-replay-unknown')).toThrow('当前项目已有管家');
  } finally { release.resolve(); await f.close(); }
});

test('unknown effects survive disable, cancel and restart without replay or unsafe deletion; queued bindings retain their place', async () => {
  const f = await setup(); let other, store;
  try {
    const signal = f.signal(), queued = f.bind(signal);
    const manager = f.submit();
    const state = f.state(manager); state.pending_signal.phase = 'returned'; state.state = 'waiting_actions';
    state.control_calls = [{ receipt_id: 10001, method: 'draft.add', status: 'running', occurrence_id: state.pending_signal.id }];
    f.store.update(manager.id, { status: 'waiting', management: JSON.stringify(state) });
    f.advance(60000); await f.project.shutdown();
    store = new Store(path.join(f.config.home, 'project.db'), f.root);
    let calls = 0; other = new Project(f.config, store, { run() { calls++; return 'must not run'; } });
    other.kick = () => {}; other.scheduledHookOptions = f.project.scheduledHookOptions; other.recover();
    expect(other.managementView(queued.id).state).toBe('queued');
    expect(other.managementView(manager.id).state).toBe('unknown');
    other.updateManagementBinding(manager.id, false, other.managementView(manager.id).revision);
    other.cancel(manager.id); other.pump(); expect(calls).toBe(0);
    expect((await other.deleteTaskPreview(manager.id)).can_delete).toBe(false);
    expect(() => other.submitManagementInstruction({ instruction: 'cannot bypass unknown' })).toThrow('当前项目已有管家');
  } finally { await other?.shutdown(); store?.close(); await f.close(); }
});

test('disabled safe Valet deletion pins history and non-Git directory/session fingerprints and preserves signal/development resources', async () => {
  const f = await setup();
  try {
    const signal = f.signal(), manager = f.bind(signal, 'persistent');
    const target = (await f.project.order('independent managed development', 'main', [], null, false)).task;
    await f.project.workspaces.ensure(f.store.task(manager.id));
    const workspace = f.store.task(manager.id).workspace;
    fs.writeFileSync(path.join(workspace, 'controlled.log'), 'retained output');
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
    const session = path.join(sessions, `fixture_lush-manager-${manager.id}-pi.jsonl`);
    fs.writeFileSync(session, 'execution history');
    f.disable(manager); const preview = await f.project.deleteTaskPreview(manager.id);
    expect(preview.can_delete).toBe(true); expect(preview.resources.worktrees).toEqual([workspace]);
    expect(preview.resources.files).toContain(session); expect(preview.resources.branches).toEqual([]);
    fs.appendFileSync(session, '\nchanged');
    await expect(f.project.deleteTask(manager.id, { revision: preview.revision, confirm: true })).rejects.toThrow('changed');
    expect(f.store.task(manager.id).id).toBe(manager.id); expect(fs.existsSync(workspace)).toBe(true);
    const fresh = await f.project.deleteTaskPreview(manager.id);
    f.store.event(manager.id, 'test.history_changed', {});
    await expect(f.project.deleteTask(manager.id, { revision: fresh.revision, confirm: true })).rejects.toThrow('changed');
    const final = await f.project.deleteTaskPreview(manager.id);
    await expect(f.project.deleteTask(manager.id, { revision: final.revision, confirm: false })).rejects.toThrow('confirm=true');
    await f.project.deleteTask(manager.id, { revision: final.revision, confirm: true });
    expect(fs.existsSync(workspace)).toBe(false); expect(fs.existsSync(session)).toBe(false);
    expect(f.store.task(target.id).id).toBe(target.id); expect(f.project.hookSignals().items[0].id).toBe(signal.id);
    expect(f.bind(signal).worker_number).toBe('V2'); // Deletion does not recycle public identity.
  } finally { await f.close(); }
});
