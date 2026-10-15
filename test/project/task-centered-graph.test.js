import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, gate, git, repo, until } from '../helpers.js';
import { taskForest } from '../../src/ui/web/assets/task-graph-layout.js';
import { snapshotPath } from '../../src/core/task-input-rule.js';

const rule = `const data = await Bun.stdin.json();
console.log(JSON.stringify({ delivery: data.input.startsWith('later:') ? 'message' : 'interrupt' }));\n`;

test('Task graph keeps owner, child and old tasks with branches as attributes', async () => {
  const f = fixture({ run: async () => 'done' }); await repo(f.root);
  try {
    const input = await f.project.order('work');
    const graph = await f.project.taskGraph();
    const order = graph.nodes.find(node => node.id === input.task.id);
    const main = graph.nodes.find(node => node.task_kind === 'main');
    expect(order.parent_id).toBe(main.id);
    expect(order.branch).toBe(input.task.branch);
    expect(order.workspace).toBe(input.task.workspace);
    expect(order.created_at).toBe(input.task.created_at);
    expect(graph.edges).toContainEqual({ from: main.id, to: order.id });
    expect(graph.nodes.every(node => node.kind === 'task')).toBe(true);
    expect(taskForest(graph)[0].children[0].id).toBe(order.id);
  } finally { await f.close(); }
});
