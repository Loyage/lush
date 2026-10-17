import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { managementState, managementInstruction } from '../../src/core/project/management-data.js';

test('full-size Unicode appends use immutable Message bodies instead of duplicating history in bounded management state', async () => {
  const instructions = [];
  const f = fixture({ async run({ context }) { instructions.push(context.management.instruction); return 'done'; } });
  try {
    f.project.kick = () => {};
    const manager = f.project.submitManagementInstruction({ instruction: '原始指令' }).task;
    const pump = async () => {
      f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise));
    };
    await pump();
    for (const character of ['甲', '乙']) {
      const body = character.repeat(32000);
      f.project.message(manager.id, body);
      expect(managementInstruction(f.project, f.store.task(manager.id))).toBe(body);
      expect(f.store.task(manager.id).management).not.toContain(body);
      expect(f.store.task(manager.id).management.length).toBeLessThan(body.length);
      await pump();
      expect(f.store.task(manager.id).status).toBe('completed');
    }
    expect(instructions).toEqual(['原始指令', '甲'.repeat(32000), '乙'.repeat(32000)]);
    f.project.message(manager.id, '消息缺失不应恢复最初指令');
    const state = managementState(f.store.task(manager.id));
    f.store.run('DELETE FROM messages WHERE id=?', state.pending_signal.message_id);
    expect(() => managementInstruction(f.project, f.store.task(manager.id))).toThrow('do not replay');
  } finally { await f.close(); }
});
