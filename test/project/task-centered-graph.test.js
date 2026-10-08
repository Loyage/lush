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

test('Task graph projects current Git diagnostics, compact progress, waiting and open decisions without writing facts', async () => {
  const hold = gate();
  const f = fixture({ run: async () => { await hold.promise; return 'done'; } }); await repo(f.root);
  try {
    const created = await f.project.order('实施功能\n验收条件');
    // Wait for the input boundary, not admission: startup may still write delivery facts.
    await until(() => f.store.all("SELECT id FROM events WHERE task_id=? AND type='invocation.inputs_delivered'", created.task.id).length > 0);
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

test('graph progress counts only planned work, including after all work finishes while waiting for signals', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.order('four work milestones');
    const now = Date.now(), at = offset => new Date(now + offset).toISOString();
    const run = f.store.startRun(task);
    f.store.run('UPDATE agent_runs SET started_at=?, ended_at=?, status=? WHERE id=?',
      at(-60000), at(-50000), 'completed', run.id);
    const resumed = f.store.startRun(task);
    f.store.run('UPDATE agent_runs SET started_at=?, ended_at=?, status=? WHERE id=?',
      at(-48000), at(-40000), 'completed', resumed.id);
    const stored = { version: 1, updated_at: at(-41000), items: ['inspect', 'implement', 'test', 'commit'].map((key, index) => ({
      key, label: key, status: 'completed', started_at: at(-59000 + index * 4000),
      completed_at: at(-55000 + index * 4000), duration_ms: 4000,
    })) };
    for (const allDone of [true, false]) {
      const plan = structuredClone(stored);
      if (!allDone) Object.assign(plan.items[3], { status: 'pending', completed_at: null, duration_ms: null });
      f.store.setProgressPlan(task.id, plan);
      for (const status of ['waiting', 'awaiting', 'queued', 'completed', 'failed', 'cancelled']) {
        f.store.update(task.id, { status });
        const events = f.store.get('SELECT count(*) AS n FROM events').n;
        const views = [await f.project.taskGraph(), await f.project.graph()];
        for (const view of views) {
          const progress = view.nodes.find(node => node.id === task.id).progress;
          expect(progress).toMatchObject({ completed: allDone ? 4 : 3, total: 4 });
          if (['waiting', 'awaiting', 'queued'].includes(status)) {
            expect(progress.current).toMatchObject({ kind: 'wait', wait_ms: 2000 });
            expect(progress.current.waiting_since).toBe(at(-40000));
            expect(progress.current.label).toBe({ waiting: '等待子Worker信号', awaiting: '等待你答复', queued: '排队等待调用槽' }[status]);
          } else if (allDone) expect(progress.current).toBeNull();
          else expect(progress.current).toMatchObject({ key: 'commit', kind: 'step', work_ms: 7000, active_since: null });
        }
        expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
        expect(JSON.parse(f.store.task(task.id).progress_plan)).toEqual(plan);
      }
    }
  } finally { await f.close(); }
});

test('Task graph projects branch-level merge orchestration state read-only', async () => {
  const f = fixture({ run: async () => 'done' }); await repo(f.root);
  try {
    const input = await f.project.order('work');
    const graph = await f.project.taskGraph();
    const main = graph.nodes.find(node => node.task_kind === 'main');
    const order = graph.nodes.find(node => node.id === input.task.id);
    // 主 Task 的分支下挂着 1 条 order 子分支；order 自己没有子分支，不冒充有。
    expect(main.branch_info.subtree_order).toBe(1);
    expect(order.branch_info.subtree_order).toBe(0);
    // 没有活动编排运行时不编造一个。
    expect(main.branch_info.merge_run).toBeNull();

    const before = f.store.all('SELECT count(*) AS n FROM events')[0].n;
    if (!f.store.branch('main')) f.store.recordBranch({ branch: 'main' });
    f.store.setBranchMergeRun('main', { version: 1, mode: 'orchestrate', task_id: 99, status: 'paused',
      order: ['a', 'b'], done: ['a'] });
    const after = (await f.project.taskGraph()).nodes.find(node => node.task_kind === 'main');
    expect(after.branch_info.merge_run).toEqual({ mode: 'orchestrate', status: 'paused', done: 1, total: 2, task_id: 99 });
    // 读面只投影，不写事件、不改运行态。
    expect(f.store.all('SELECT count(*) AS n FROM events')[0].n).toBe(before);
    expect(f.store.branchMergeRun('main')).toMatchObject({ status: 'paused', task_id: 99 });
  } finally { await f.close(); }
});

test('archiving a parent also archives its branchless merge queue without changing task facts', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task: parent } = await f.project.order('parent');
    f.store.update(parent.id, { status: 'completed' });
    const queue = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'merge', goal: 'internal queue' });
    f.store.update(queue.id, { status: 'completed', target_branch: parent.branch });
    const otherQueue = f.store.create({ parent_id: parent.parent_id, role: 'agent', task_kind: 'merge', goal: 'main queue' });
    // Even if a historical target points at this branch, ownership comes only from the direct parent.
    f.store.update(otherQueue.id, { status: 'completed', target_branch: parent.branch });
    const branchless = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'child', goal: 'not a queue' });
    f.store.update(branchless.id, { status: 'completed' });
    await git(f.root, 'branch', 'independent', 'main');
    f.store.recordBranch({ branch: 'independent', parent: 'main' });
    const independent = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'child', goal: 'independent work' });
    f.store.update(independent.id, { status: 'completed', branch: 'independent' });
    const before = (await f.project.taskGraph()).nodes.find(node => node.id === queue.id);
    expect(before).toMatchObject({ archived: false, branch: null, branch_info: null });
    const facts = f.store.task(queue.id);
    await f.project.archiveBranch(parent.branch);
    const eventCount = f.store.get('SELECT count(*) AS n FROM events').n;
    const graph = await f.project.taskGraph();
    expect(graph.nodes.find(node => node.id === parent.id)).toMatchObject({ archived: true, branch_info: { archived: true } });
    expect(graph.nodes.find(node => node.id === queue.id)).toMatchObject({ archived: true, parent_id: parent.id, branch: null, branch_info: null });
    for (const task of [otherQueue, branchless, independent]) {
      expect(graph.nodes.find(node => node.id === task.id).archived).toBe(false);
    }
    expect(graph.edges).toContainEqual({ from: parent.id, to: queue.id });
    expect(f.store.task(queue.id)).toEqual(facts);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(eventCount);
  } finally { await f.close(); }
});

test('historical merge queues inherit archive even when their parent is outside the bounded Task graph', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task: parent } = await f.project.order('old parent');
    f.store.update(parent.id, { status: 'completed' });
    await f.project.archiveBranch(parent.branch);
    f.store.transaction(() => {
      for (let i = 0; i < 201; i++) {
        const task = f.store.create({ role: 'agent', task_kind: 'child', goal: `history ${i}` });
        f.store.update(task.id, { status: 'completed' });
      }
    });
    const queue = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'merge', goal: 'historical queue' });
    f.store.update(queue.id, { status: 'completed', target_branch: parent.branch });
    const graph = await f.project.taskGraph();
    expect(graph.truncated).toBe(true);
    expect(graph.nodes).toHaveLength(200);
    expect(graph.nodes.some(node => node.id === parent.id)).toBe(false);
    const node = graph.nodes.find(node => node.id === queue.id);
    expect(node).toMatchObject({ archived: true, branch_info: null });
    expect(node).not.toHaveProperty('parent_branch');
  } finally { await f.close(); }
});

test('an active internal merge queue blocks parent archive rather than being hidden with unfinished work', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task: parent } = await f.project.order('parent');
    f.store.update(parent.id, { status: 'completed' });
    const queue = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'merge', goal: 'active queue' });
    f.store.update(queue.id, { status: 'waiting', target_branch: parent.branch });
    await expect(f.project.archiveBranch(parent.branch)).rejects.toThrow(`unfinished workers: #${queue.id}`);
    expect(f.store.branch(parent.branch).status).toBe('active');
    expect(fs.existsSync(parent.workspace)).toBe(true);
    expect((await f.project.taskGraph()).nodes.find(node => node.id === queue.id).archived).toBe(false);
  } finally { await f.close(); }
});

test('Task input rule is frozen from committed fork, chooses delivery, and falls back without losing input', async () => {
  const paused = gate();
  const f = fixture({ run: async () => { await paused.promise; return 'done'; } }); await repo(f.root);
  try {
    fs.mkdirSync(path.join(f.root, '.lush-task'));
    fs.writeFileSync(path.join(f.root, '.lush-task/input.mjs'), rule);
    await git(f.root, 'add', '.lush-task/input.mjs'); await git(f.root, 'commit', '-m', 'input rule');
    const order = await f.project.order('work');
    await until(() => f.project.running.has(order.task.id));
    expect(fs.readFileSync(snapshotPath(f.config.home, order.task.id), 'utf8').trim()).toBe(rule.trim());
    expect((await f.project.taskGraph()).nodes.find(node => node.id === order.task.id).has_rule).toBe(true);
    const child = await f.project.spawn(order.task.id, 'child');
    expect(fs.readFileSync(snapshotPath(f.config.home, child.id), 'utf8').trim()).toBe(rule.trim());
    // Changing the worktree after creation does not change the fixed rule.
    fs.writeFileSync(path.join(order.task.workspace, '.lush-task/input.mjs'), 'console.log(JSON.stringify({delivery:"interrupt"}))');
    f.project.message(order.task.id, 'later: wait');
    expect(f.store.all("SELECT id FROM events WHERE task_id=? AND type='preempt.requested'", order.task.id)).toHaveLength(0);
    f.project.message(order.task.id, 'urgent');
    expect(f.store.all("SELECT data FROM events WHERE task_id=? AND type='task.input_routed'", order.task.id)
      .map(row => JSON.parse(row.data).delivery)).toEqual(['message', 'interrupt']);
    // A broken rule cannot silently drop an input; failure and fallback are auditable.
    fs.writeFileSync(snapshotPath(f.config.home, order.task.id), 'process.exit(7)');
    f.project.message(order.task.id, 'still deliver');
    expect(f.store.unread(order.task.id).map(item => item.body)).toContain('still deliver');
    expect(JSON.parse(f.store.all("SELECT data FROM events WHERE task_id=? AND type='task.input_routed' ORDER BY id DESC LIMIT 1", order.task.id)[0].data))
      .toMatchObject({ delivery: 'interrupt', source: 'fallback' });
  } finally { paused.resolve(); await f.close(); }
});

test('Task forest shows truncated parents and tolerates corrupt cycles', () => {
  expect(taskForest({ nodes: [{ id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }] })[0].children[0].id).toBe(3);
  expect(taskForest({ nodes: [{ id: 1, parent_id: 2 }, { id: 2, parent_id: 1 }] })).toHaveLength(2);
});
