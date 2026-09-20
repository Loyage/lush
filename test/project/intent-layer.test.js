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

test('raw input persists, creates a planner, and the mock queues a spec without Service', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const input = (await f.project.submit('  原话\n保留  '));
    expect(input.content).toBe('  原话\n保留  ');
    await until(() => f.store.task(input.task.id).status === 'completed');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    await until(() => f.store.get("SELECT count(*) AS n FROM task_specs WHERE status='dropped'").n === 1);
    // planner 不再有子任务：它只写队列，scheduler 是独立的根任务
    expect(f.store.children(input.task.id)).toEqual([]);
    expect(f.store.specs({ planner_task_id: input.task.id })).toHaveLength(1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    expect(scheduler.parent_id).toBeNull();
    expect(scheduler.status).toBe('completed');
    // planner / scheduler 属于意图层：不进任务树，只在意图视图里出现
    expect(f.project.tree()).toEqual([]);
    expect(f.store.task(input.task.id).layer).toBe('intent');
    expect(scheduler.layer).toBe('intent');
    expect(f.project.inputs()[0]).toMatchObject({ id: input.id, task_id: input.task.id, specs_dropped: 1, scheduler_id: scheduler.id, scheduler_status: 'completed' });
    expect(f.store.get("SELECT name FROM sqlite_master WHERE name='services'")).toBeNull();
  } finally { await f.close(); }
});

test('intent 层：planner 与 scheduler 不进任务树/任务列表/时间轴，只在意图视图里', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('做两件事')).task;
    const spec = f.project.addSpec(planner.id, { goal: '写点东西', role: 'worker', name: 'write-something' });
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    provider.calls.find(call => call.task.id === planner.id).done.resolve('planned');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    const worker = f.project.spawn(scheduler.id, '写点东西', 'worker', [], 'write-something', spec.id);
    // 任务树只有 work 层：worker 的父是 intent 层的 scheduler，所以它自己就是根
    expect(f.project.tree().map(task => task.id)).toEqual([worker.id]);
    expect(f.store.summaries('intent').map(task => task.id).sort((a, b) => a - b)).toEqual([planner.id, scheduler.id]);
    expect(f.store.summaries('work').map(task => task.id)).toEqual([worker.id]);
    // 按 id 仍能看具体 planner / scheduler（意图面板就是从这跳的）
    expect(f.project.tree(scheduler.id).id).toBe(scheduler.id);
    expect(f.project.inspect(planner.id).layer).toBe('intent');
    // 时间轴也只画 work 层
    expect(f.project.timeline().tasks.map(task => task.role)).not.toContain('scheduler');
    // 意图行把 planner 的闸门与 scheduler 的 id / 状态一起带出来（worker 已经被编走，所以 pending 0 / planned 1）
    expect(f.project.inputs()[0]).toMatchObject({ task_id: planner.id, plan_gate: null, specs_pending: 0, specs_planned: 1,
      scheduler_id: scheduler.id, scheduler_status: 'running', plan_notice_id: null, work_tasks: 1 });
  } finally { await f.close(); }
});
