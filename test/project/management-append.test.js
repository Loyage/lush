import { test, expect } from 'bun:test';
import { fixture, gate } from '../helpers.js';
import { managementState, managementInstruction } from '../../src/core/project/management-data.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';

async function pump(f) {
  f.project.pump();
  await Promise.all([...f.project.running.values()].map(run => run.promise));
}
const create = f => f.project.submitManagementInstruction({ instruction: '最初管理指令' }).task;

test('user RPC appends a fresh occurrence to the same settled Valet, retaining original input, history and serial ownership', async () => {
  const invocations = [];
  const f = fixture({ async run(options) { invocations.push(options); return '正常结束'; } });
  try {
    f.project.kick = () => {};
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    const original = create(f);
    expect(f.project.inspect(original.id).management.can_append).toBe(false);
    await pump(f);
    const before = f.store.task(original.id), old = managementState(before);
    expect(f.project.inspect(original.id).management.can_append).toBe(true);
    const queued = await dispatcher.dispatch('worker.message', { id: original.id, body: '本轮新增需求' });
    expect(queued).toMatchObject({ id: original.id, worker_number: original.worker_number, status: 'queued', goal: original.goal });
    expect(f.project.managementOccupant().id).toBe(original.id);
    expect(() => create(f)).toThrow('已有管家');
    expect(() => f.project.message(original.id, '不可重复排队')).toThrow('安全收口');
    expect(f.store.all('SELECT * FROM tasks WHERE task_kind=\'management\'')).toHaveLength(1);
    const pending = managementState(f.store.task(original.id));
    expect(pending.pending_signal.id).not.toBe(old.last_execution.id);
    expect(pending.last_execution).toEqual(old.last_execution);
    expect(managementInstruction(f.project, f.store.task(original.id))).toBe('本轮新增需求');
    await pump(f);
    const after = f.store.task(original.id);
    expect(after).toMatchObject({ id: original.id, goal: original.goal, workspace: before.workspace, calls: 2, status: 'completed', branch: null });
    expect(invocations.map(call => call.context.management.instruction)).toEqual(['最初管理指令', '本轮新增需求']);
    expect(invocations[1].messages).toMatchObject([{ body: '本轮新增需求', sender_id: null, append_number: null }]);
    expect(f.store.unread(original.id)).toEqual([]);
    expect(f.store.all('SELECT * FROM agent_runs WHERE task_id=?', original.id)).toHaveLength(2);
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.project.inspect(original.id).management.can_append).toBe(true);
    const history = f.project.inputHistory({ modes: ['append'] });
    expect(history.items).toMatchObject([{ kind: 'message', content: '本轮新增需求', task_id: original.id }]);
  } finally { await f.close(); }
});

test('another queued or live Valet rejects append without saving it; provider return retains the lane through actual cleanup', async () => {
  const entered = gate(), returned = gate();
  let live = false;
  const f = fixture({ async run() { if (live) { entered.resolve(); await returned.promise; } return '正常结束'; } });
  try {
    f.project.kick = () => {};
    const original = create(f); await pump(f);
    live = true;
    const other = create(f);
    expect(f.project.inspect(original.id).management).toMatchObject({ can_append: false });
    expect(() => f.project.message(original.id, '保留在客户端')).toThrow('已有管家');
    expect(f.store.unread(original.id)).toEqual([]);
    f.project.pump(); await entered.promise;
    expect(f.project.running.has(other.id)).toBe(true);
    expect(() => f.project.message(original.id, '仍不可提交')).toThrow('已有管家');
    // A returned Provider is not a safely settled Worker while runtime cleanup still owns it.
    const state = managementState(f.store.task(other.id));
    f.project.completeManagementInvocation(other.id, state.pending_signal.run_id);
    expect(f.project.managementOccupant().id).toBe(other.id);
    expect(() => f.project.message(original.id, '收尾仍阻塞')).toThrow('已有管家');
    returned.resolve(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    expect(f.project.inspect(original.id).management.can_append).toBe(true);
  } finally { returned.resolve(); await f.close(); }
});

test('failed, cancelled, unknown, pending confirmation and non-user paths cannot revive a management occurrence', async () => {
  const f = fixture({ async run() { return '正常结束'; } });
  try {
    f.project.kick = () => {};
    const original = create(f); await pump(f);
    const before = f.store.task(original.id), settled = managementState(before);
    const rejects = () => {
      expect(f.project.inspect(original.id).management.can_append).toBe(false);
      expect(() => f.project.message(original.id, '不应落库')).toThrow('安全收口');
      expect(f.store.unread(original.id)).toEqual([]);
    };
    for (const status of ['failed', 'cancelled']) { f.store.update(original.id, { status }); rejects(); }
    f.store.update(original.id, { status: 'completed' });
    for (const status of ['pending_confirmation', 'approved', 'running', 'unknown']) {
      f.store.update(original.id, { management: JSON.stringify({ ...settled, control_calls: [{ receipt_id: 999, status }] }) });
      rejects();
    }
    f.store.update(original.id, { management: JSON.stringify({ ...settled, state: 'skipped', last_execution: { ...settled.last_execution, status: 'skipped' } }) });
    // A safely skipped/rejected operation is not a failed Provider invocation.
    expect(f.project.inspect(original.id).management.can_append).toBe(true);
    f.store.update(original.id, { management: before.management });
    expect(() => f.project.message(original.id, '系统不允许', null, false)).toThrow('only the user');
    expect(() => f.project.message(original.id, 'Agent 不允许', 1)).toThrow('only the user');
    expect(f.store.unread(original.id)).toEqual([]);
  } finally { await f.close(); }
});

test('an unstarted append survives recovery without replaying its predecessor or enabling an old stopped persistent binding', async () => {
  const f = fixture({ async run() { return '正常结束'; } });
  try {
    f.project.kick = () => {};
    const original = create(f); await pump(f);
    const state = managementState(f.store.task(original.id));
    // Simulate a safely stopped persistent binding with its proved successful history.
    f.store.update(original.id, { status: 'waiting', management: JSON.stringify({ ...state, mode: 'persistent', consumed: false }) });
    f.project.message(original.id, '独立的一轮追加');
    const occurrence = managementState(f.store.task(original.id)).pending_signal;
    f.project.recoverManagementWorkers();
    expect(managementState(f.store.task(original.id)).pending_signal).toEqual(occurrence);
    expect(f.project.managementReady(f.store.task(original.id))).toBe(true);
    await pump(f);
    expect(managementState(f.store.task(original.id))).toMatchObject({ enabled: false, consumed: false, pending_signal: null,
      last_execution: { id: occurrence.id, status: 'succeeded' } });
    expect(f.store.task(original.id)).toMatchObject({ status: 'waiting', calls: 2 });
  } finally { await f.close(); }
});
