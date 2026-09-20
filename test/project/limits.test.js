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

test('depth and invocation limits bound runaway agents', async () => {
  const f = fixture({ async run({task, api}) { api.message(task.id, 'again'); return 'loop'; } }, {LUSH_TASK_CALLS:'2', LUSH_MAX_DEPTH:'2'}); await repo(f.root);
  try {
    const root = host(f, { goal: 'root', run: true });
    f.project.kick();
    const child = f.project.spawn(root.id,'child','research');
    expect(() => f.project.spawn(child.id,'too deep','research')).toThrow('nesting');
    await until(() => f.store.task(root.id).status === 'failed');
    expect(f.store.task(root.id).error).toContain('invocation limit');
  } finally { await f.close(); }
});

test('timeout aborts invocation and frees the agent slot', async () => {
  const provider = controlled(), f = fixture(provider, {LUSH_CALL_TIMEOUT:'1'}); await repo(f.root);
  try {
    const task = (await f.project.submit('timeout')).task;
    await until(() => f.store.task(task.id).status === 'failed');
    expect(provider.calls[0].signal.aborted).toBe(true);
    expect(f.project.running.size).toBe(0);
  } finally { await f.close(); }
});
