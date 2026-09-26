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
    const input = await f.project.say('work');
    const graph = await f.project.taskGraph();
    const say = graph.nodes.find(node => node.id === input.task.id);
    const main = graph.nodes.find(node => node.task_kind === 'main');
    expect(say.parent_id).toBe(main.id);
    expect(say.branch).toBe(input.task.branch);
    expect(say.workspace).toBe(input.task.workspace);
    expect(graph.edges).toContainEqual({ from: main.id, to: say.id });
    expect(graph.nodes.every(node => node.kind === 'task')).toBe(true);
    expect(taskForest(graph)[0].children[0].id).toBe(say.id);
  } finally { await f.close(); }
});

test('Task graph projects current Git diagnostics, compact progress, waiting and open decisions without writing facts', async () => {
  const hold = gate();
  const f = fixture({ run: async () => { await hold.promise; return 'done'; } }); await repo(f.root);
  try {
    const created = await f.project.say('实施功能\n验收条件');
    await until(() => f.store.all("SELECT id FROM events WHERE task_id=? AND type='invocation.started'", created.task.id).length > 0);
    f.store.setProgressPlan(created.task.id, { version: 1, items: [
      { key: 'inspect', label: '现状', status: 'completed' },
      { key: 'build', label: '实现', status: 'pending', started_at: new Date().toISOString() },
    ] });
    const notice = f.project.notice(created.task.id, '决定方案', '请先确认');
    fs.writeFileSync(path.join(created.task.workspace, 'file.txt'), 'base\nnew\n');
    const before = f.store.all('SELECT count(*) AS n FROM events')[0].n;
    const graph = await f.project.taskGraph();
    const node = graph.nodes.find(item => item.id === created.task.id);
    expect(node.goal_preview).toContain('验收条件');
    expect(node.progress).toMatchObject({ total: 2, completed: 1, current: { label: '实现' } });
    expect(node.notice).toMatchObject({ id: notice.id, title: '决定方案' });
    expect(node.notice_count).toBe(1);
    expect(node.branch_info.diagnostics.working_tree.status).toBe('dirty');
    expect(node.branch_info.diagnostics.working_tree.files_total).toBe(1);
    expect(node.branch_info.diagnostics.changes.status).toBe('ok');
    expect(f.store.all('SELECT count(*) AS n FROM events')[0].n).toBe(before);
  } finally { hold.resolve(); await f.close(); }
});

test('Task input rule is frozen from committed fork, chooses delivery, and falls back without losing input', async () => {
  const paused = gate();
  const f = fixture({ run: async () => { await paused.promise; return 'done'; } }); await repo(f.root);
  try {
    fs.mkdirSync(path.join(f.root, '.lush-task'));
    fs.writeFileSync(path.join(f.root, '.lush-task/input.mjs'), rule);
    await git(f.root, 'add', '.lush-task/input.mjs'); await git(f.root, 'commit', '-m', 'input rule');
    const say = await f.project.say('work');
    await until(() => f.project.running.has(say.task.id));
    expect(fs.readFileSync(snapshotPath(f.config.home, say.task.id), 'utf8').trim()).toBe(rule.trim());
    expect((await f.project.taskGraph()).nodes.find(node => node.id === say.task.id).has_rule).toBe(true);
    const child = f.project.spawn(say.task.id, 'child');
    expect(fs.readFileSync(snapshotPath(f.config.home, child.id), 'utf8').trim()).toBe(rule.trim());
    // Changing the worktree after creation does not change the fixed rule.
    fs.writeFileSync(path.join(say.task.workspace, '.lush-task/input.mjs'), 'console.log(JSON.stringify({delivery:"interrupt"}))');
    f.project.message(say.task.id, 'later: wait');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='preempt.requested'", say.task.id)).toHaveLength(0);
    f.project.message(say.task.id, 'urgent');
    expect(f.store.all("SELECT data FROM events WHERE task_id=? AND type='task.input_routed'", say.task.id)
      .map(row => JSON.parse(row.data).delivery)).toEqual(['message', 'interrupt']);
    // A broken rule cannot silently drop an input; failure and fallback are auditable.
    fs.writeFileSync(snapshotPath(f.config.home, say.task.id), 'process.exit(7)');
    f.project.message(say.task.id, 'still deliver');
    expect(f.store.unread(say.task.id).map(item => item.body)).toContain('still deliver');
    expect(JSON.parse(f.store.all("SELECT data FROM events WHERE task_id=? AND type='task.input_routed' ORDER BY id DESC LIMIT 1", say.task.id)[0].data))
      .toMatchObject({ delivery: 'interrupt', source: 'fallback' });
  } finally { paused.resolve(); await f.close(); }
});

test('Task forest shows truncated parents and tolerates corrupt cycles', () => {
  expect(taskForest({ nodes: [{ id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }] })[0].children[0].id).toBe(3);
  expect(taskForest({ nodes: [{ id: 1, parent_id: 2 }, { id: 2, parent_id: 1 }] })).toHaveLength(2);
});
