import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

/** planner 只写 spec 队列（spawn 会拒绝 planner 父任务）；测试里用它造一个能直接派活的非 planner 任务。 */
function host(f, { role = 'coordinator', goal = 'host', input_id = null, run = false } = {}) {
  const task = f.store.create({ input_id, role, goal });
  if (!run) f.store.update(task.id, { status: 'waiting' });
  return task;
}

test('planners run in parallel and share the single concurrency pool', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY:'2' }); await repo(f.root);
  try {
    const first = (await f.project.submit('first')).task;
    const second = (await f.project.submit('second')).task;
    await until(() => f.project.running.size === 2);
    expect(f.project.status().agents.map(agent => agent.role).sort()).toEqual(['planner','planner']);
    // 总并发受 LUSH_CONCURRENCY 限制，第三个 planner 只能排队
    const third = (await f.project.submit('third')).task;
    await Bun.sleep(20);
    expect(f.project.running.has(third.id)).toBe(false);
    provider.calls.find(call => call.task.id === first.id).done.resolve('one');
    await until(() => f.project.running.has(third.id));
  } finally { await f.close(); }
});

test('multi-level fanout parks ancestors, respects limits, wakes with child results', async () => {
  const counts = new Map(); let peak = 0;
  const f = fixture({ async run({ task, api }) {
    counts.set(task.id, (counts.get(task.id) || 0) + 1);
    peak = Math.max(peak, api.running.size);
    if (task.calls === 1 && task.role === 'coordinator') for (let i=0;i<4;i++) api.spawn(task.id, `child ${i}`, 'research');
    await Bun.sleep(5); return `done ${task.id}`;
  } }, { LUSH_CONCURRENCY:'2' });
  try {
    const root = host(f, { goal: 'tree', run: true });
    f.project.kick();
    await until(() => f.store.task(root.id).status === 'completed');
    expect(f.store.tasks().length).toBe(5); expect(peak).toBeLessThanOrEqual(2);
    expect(counts.get(root.id)).toBeGreaterThan(1);
    expect(f.store.tasks().every(t => t.status === 'completed')).toBe(true);
    expect(f.store.children(root.id).length).toBe(4);
  } finally { await f.close(); }
});
