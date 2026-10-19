import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';

test('user RPC appends a fresh occurrence to the same settled Valet while preserving original input and history', async () => {
  const invocations = [];
  const f = fixture({ async run(options) { invocations.push(options); return '正常结束'; } });
  try {
    f.project.kick = () => {};
    const dispatcher = new Dispatcher(f.project, createSignal(), {});
    const original = f.project.submitManagementInstruction({ instruction: '最初管理指令' }).task;
    const pump = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
    await pump();
    expect(f.project.inspect(original.id).management.can_append).toBe(true);
    const queued = await dispatcher.dispatch('worker.message', { id: original.id, body: '本轮新增需求' });
    expect(queued).toMatchObject({ id: original.id, status: 'queued', goal: original.goal });
    expect(f.project.managementOccupant().id).toBe(original.id);
    await pump();
    expect(f.store.task(original.id)).toMatchObject({ id: original.id, goal: original.goal, calls: 2, status: 'completed', branch: null });
    expect(invocations.map(call => call.context.management.instruction)).toEqual(['最初管理指令', '本轮新增需求']);
    expect(f.store.unread(original.id)).toEqual([]);
    expect(f.store.all('SELECT * FROM agent_runs WHERE task_id=?', original.id)).toHaveLength(2);
    expect(f.project.managementOccupant()).toBeNull();
    expect(f.project.inputHistory({ modes: ['append'] }).items).toMatchObject([{ kind: 'message', content: '本轮新增需求', task_id: original.id }]);
  } finally { await f.close(); }
});
