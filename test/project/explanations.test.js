import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';

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

test('selection explanation snapshots page context without task, branch, worktree or history entry', async () => {
  let received;
  const held = gate();
  const f = fixture({ resolve: () => ({ agent: 'mock' }), async run(options) { received = options; await held.promise; return '这段文字说明了……'; } });
  try {
    const rpc = new Dispatcher(f.project);
    const explanation = await rpc.dispatch('explanation.selection', { quote: 'bun run test 失败', location: { view: 'tasks', section: 'result', task_id: 7 } });
    await until(() => received);
    expect(received.task.role).toBe('explainer');
    expect(received.context.explanation).toMatchObject({ version: 1, kind: 'selection', quote: 'bun run test 失败', location: { view: 'tasks', section: 'result', task_id: 7 } });
    expect(typeof received.context.explanation.captured_at).toBe('string');
    expect(() => f.project.actor(received.token)).toThrow('no RPC capability');
    expect(() => f.project.spawn(explanation.id, 'do work', 'worker')).toThrow('cannot delegate');
    held.resolve();
    await until(() => f.store.task(explanation.id).status === 'completed' && !f.project.running.has(explanation.id));
    const row = f.store.task(explanation.id);
    expect(row.parent_id).toBeNull(); expect(row.input_id).toBeNull(); expect(row.branch).toBeNull(); expect(row.workspace).toBeNull(); expect(row.integration).toBe('none');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    const saved = await rpc.dispatch('explanation.get', { id: explanation.id });
    expect(saved.source.kind).toBe('selection'); expect(saved.source.location.task_id).toBe(7); expect(saved.result).toContain('说明了');
    // Generic records have no transcript task_id, so they never enter a task's explanation history.
    expect((await rpc.dispatch('explanation.list', { id: 7 })).explanations).toHaveLength(0);
  } finally { held.resolve(); await f.close(); }
});

test('selection explanation validates quote and location before creating a task', async () => {
  const f = fixture({ resolve: () => ({ agent: 'mock' }) });
  try {
    await expect(f.project.startSelectionExplanation('', {})).rejects.toThrow('1–8192');
    await expect(f.project.startSelectionExplanation('x'.repeat(8193), {})).rejects.toThrow('1–8192');
    await expect(f.project.startSelectionExplanation('text', { unknown: 'x' })).rejects.toThrow('unknown location field');
    await expect(f.project.startSelectionExplanation('text', { task_id: 0 })).rejects.toThrow('id must be');
    expect(f.store.tasks()).toHaveLength(0);
  } finally { await f.close(); }
});

test('explanation.selection is a user-only RPC with bounded params', () => {
  expect(PARAMS['explanation.selection']).toEqual(['quote', 'location']);
  expect(USER_ONLY.has('explanation.selection')).toBe(true);
  expect(assertAllowed('explanation.selection', { quote: 'x', location: {} }, null)).toBe(null);
  expect(() => assertAllowed('explanation.selection', { quote: 'x', location: {} }, 3)).toThrow('user approval');
  expect(() => assertAllowed('explanation.selection', { quote: 'x', location: {}, id: 1 }, null)).toThrow('unknown parameter');
});
