import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from './helpers.js';
import { readWorkerResources } from '../src/core/usage-statistics.js';
const message = id => ({ type: 'message', lush: { task_id: id }, message: { role: 'assistant',
  usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5, cost: { total: .2 } } } });
function save(config, id, rows) {
  const dir = path.join(config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `resources_lush-task-${id}.jsonl`);
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return file;
}
test('lifetime own/subtree totals include all 205 descendants and all sessions, exclude inherited fork context', async () => {
  const f = fixture();
  try {
    const tasks = [{ id: 1, parent_id: null, status: 'waiting' }];
    for (let id = 2; id <= 206; id++) {
      tasks.push({ id, parent_id: id === 206 ? 2 : 1, status: id === 206 ? 'running' : 'completed' });
      save(f.config, id, [message(1), message(id)]);
    }
    const file = save(f.config, 1, [message(1)]);
    fs.writeFileSync(file.replace('resources_', 'second_'), JSON.stringify(message(1)) + '\n');
    const totals = await readWorkerResources(f.config, tasks);
    expect(totals.get(1).own).toMatchObject({ input: 70, output: 6, cost: .4, running: false });
    expect(totals.get(1).subtree.input).toBe(207 * 35);
    expect(totals.get(1).subtree.cost).toBeCloseTo(207 * .2);
    expect(totals.get(1).subtree.running).toBe(true);
    expect(totals.get(2).subtree).toMatchObject({ input: 70, output: 6, running: true });
    fs.appendFileSync(file, JSON.stringify(message(1)) + '\n');
    tasks.at(-1).status = 'waiting';
    const updated = await readWorkerResources(f.config, tasks);
    expect(updated.get(1).own.input).toBe(105);
    expect(updated.get(1).subtree.running).toBe(false);
  } finally { await f.close(); }
});
test('worker.graph exposes complete subtree usage even when the spending child is off-page, without writes', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const main = await f.project.ensureMainTask();
    const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'spending' });
    f.store.update(child.id, { status: 'completed' });
    save(f.config, child.id, [message(child.id)]);
    f.store.transaction(() => {
      for (let i = 0; i < 205; i++) {
        const row = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'recent' });
        f.store.update(row.id, { status: 'completed' });
      }
    });
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    const graph = await f.project.taskGraph();
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.some(row => row.id === child.id)).toBe(false);
    expect(graph.nodes.find(row => row.id === main.id).resources).toMatchObject({
      own: { input: 0, cost: 0 }, subtree: { input: 35, output: 3, cost: .2 },
    });
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
  } finally { await f.close(); }
}, 15000);

test('unknown cost/tokens, malformed or partial records and Codex metadata do not masquerade as complete zero totals; cycles terminate', async () => {
  const f = fixture();
  try {
    const file = save(f.config, 2, [{ type: 'message', message: { role: 'assistant' } }]);
    fs.appendFileSync(file, 'bad json\n{"type":');
    fs.writeFileSync(path.join(f.config.home, 'sessions', 'codex-task-3.json'), '{}');
    fs.writeFileSync(path.join(f.config.home, 'sessions', 'codex-task-5.json'), '{}');
    const codex = message(5); delete codex.message.usage.cost;
    save(f.config, 5, [codex]);
    const totals = await readWorkerResources(f.config, [
      { id: 1, parent_id: 2, status: 'waiting' }, { id: 2, parent_id: 1, status: 'waiting' },
      { id: 3, parent_id: null, status: 'waiting' }, { id: 4, status: 'queued' }, { id: 5, status: 'waiting' },
    ]);
    expect(totals.get(2).own).toMatchObject({ unknown_tokens: 1, unknown_cost: 1, incomplete: true });
    expect(totals.get(1).subtree.incomplete).toBe(true);
    expect(totals.get(3).own.incomplete).toBe(true);
    expect(totals.get(5).own).toMatchObject({ input: 35, output: 3, unknown_tokens: 0, unknown_cost: 1, incomplete: false });
    expect(totals.get(4).own).toMatchObject({ input: 0, output: 0, cost: 0, incomplete: false, running: false });
  } finally { await f.close(); }
});
