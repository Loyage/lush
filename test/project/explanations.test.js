import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';


function source(f) {
  const task = f.store.create({ role: 'research', input_id: null, goal: '理解测试结果' });
  f.store.update(task.id, { status: 'completed' });
  const file = path.join(f.config.home, 'sessions', `001_lush-task-${task.id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call1', name: 'bash', arguments: { command: 'bun run test' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call1', toolName: 'bash', content: [{ type: 'text', text: '1 pass, 0 fail' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  return { task, file };
}

test('explainer snapshots source, pairs output, retains history and result without any branch or worktree', async () => {
  let received;
  const held = gate();
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run(options) { received = options; await held.promise; return '目的：运行测试。结果：记录显示 1 项通过。'; } });
  try {
    const { task, file } = source(f), rpc = new Dispatcher(f.project);
    const explanation = await rpc.dispatch('explanation.start', { id: task.id, seq: 2, quote: '1 pass' });
    await until(() => received);
    expect(received.task.role).toBe('explainer'); expect(received.context.explanation.related[0].body).toContain('bun run test');
    expect(() => f.project.actor(received.token)).toThrow('no RPC capability');
    expect(() => f.project.spawn(explanation.id, 'do work', 'worker')).toThrow('cannot delegate');
    held.resolve();
    await until(() => f.store.task(explanation.id).status === 'completed' && !f.project.running.has(explanation.id));
    const row = f.store.task(explanation.id);
    expect(row.parent_id).toBeNull(); expect(row.input_id).toBeNull(); expect(row.branch).toBeNull(); expect(row.workspace).toBeNull(); expect(row.integration).toBe('none');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    fs.unlinkSync(file);
    const saved = await rpc.dispatch('explanation.get', { id: explanation.id });
    expect(saved.source.quote).toBe('1 pass'); expect(saved.result).toContain('1 项通过');
    const history = await rpc.dispatch('explanation.list', { id: task.id });
    expect(history.explanations[0].id).toBe(explanation.id);
    expect((await rpc.dispatch('explanation.list', { id: task.id, before: explanation.id })).explanations).toHaveLength(0);
  } finally { held.resolve(); await f.close(); }
});

test('explanation validates before creation and refuses backends without tool isolation', async () => {
  const f = fixture({ resolve: () => ({ agent: 'codex' }) });
  try {
    const { task } = source(f);
    await expect(f.project.startExplanation(task.id, 1, '')).rejects.toThrow('1–8192');
    await expect(f.project.startExplanation(task.id, 1, 'test')).rejects.toThrow('Pi');
    expect(f.store.tasks()).toHaveLength(1);
  } finally { await f.close(); }
});
