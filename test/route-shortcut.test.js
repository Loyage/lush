import { test, expect } from 'bun:test';
import { fixture, repo, gate } from './helpers.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

test('a develop prefix short-circuits the planner and creates the routed worker', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const result = await f.project.submit('开发 做一个登录页');
    expect(result.route).toEqual({ prefix: '开发', target: 'worker' });
    // 规划模型一次都没被调用，planner 直接结算为 completed。
    expect(provider.calls).toHaveLength(0);
    expect(f.project.running.size).toBe(0);
    expect(result.task.status).toBe('completed');
    expect(result.task.calls).toBe(0);
    expect(result.task.result).toContain('前缀 开发 命中');
    expect(result.worker.role).toBe('worker');
    expect(result.worker.goal).toBe('做一个登录页');
    expect(f.store.task(result.worker.id).parent_id).toBeNull();

    const events = f.store.history(result.task.id);
    const route = events.find(event => event.type === 'input.route');
    expect(route.data).toMatchObject({ prefix: '开发', target: 'worker', task: result.worker.id });
    expect(events.some(event => event.type === 'completed' && event.data.route === true)).toBe(true);
    // 走的是 route，不是任何直接执行占位。
    expect(f.project.inputs().find(input => input.id === result.id).route).toBe(1);
  } finally { await f.close(); }
});

test('an explain prefix creates a read-only research root and never a worktree or branch', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const result = await f.project.submit('解释：调度器怎么工作');
    expect(result.route).toEqual({ prefix: '解释', target: 'research' });
    expect(provider.calls).toHaveLength(0);
    expect(result.research.role).toBe('research');
    expect(result.research.goal).toBe('调度器怎么工作');

    // research 沿用主项目目录且只读：ensure 后工作区仍是项目目录，任务上没有分支 / worktree。
    const workspace = await f.project.workspaces.ensure(result.research);
    expect(workspace).toBe(f.config.project);
    expect(f.store.task(result.research.id).branch).toBeNull();
    expect(f.store.task(result.research.id).workspace).toBeNull();
  } finally { await f.close(); }
});

test('a non-prefix input still goes to the planner', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const plain = await f.project.submit('做一个登录页');
    expect(plain.route).toBeUndefined();
    expect(plain.worker).toBeUndefined();
    expect(plain.task.role).toBe('planner');
    expect(plain.task.status).toBe('queued');
    expect(provider.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test('task read models and the branch graph flag a fast-routed input', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const routed = await f.project.submit('开发 路由出来的任务');
    const plain = await f.project.submit('交给规划器的普通任务');

    // 任务树 / 概览共用的 activity 读模型：派生的 worker 与它的 planner 都带上 route。
    const activity = new Map(f.project.activity(50, 'all').tasks.map(task => [task.id, task]));
    expect(activity.get(routed.worker.id).route).toBe(true);
    expect(activity.get(routed.task.id).route).toBe(true);
    expect(activity.get(plain.task.id).route).toBe(false);

    // 任务详情单读模型同一口径。
    expect(f.project.inspect(routed.worker.id).route).toBe(true);
    expect(f.project.inspect(plain.task.id).route).toBe(false);

    // 分支图：快速路由的 planner 挂在输入锚点分支上，节点同样标 route。
    const graph = await f.project.graph();
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    expect(byId.get(routed.task.id).route).toBe(true);
    expect(byId.get(plain.task.id).route).toBe(false);
  } finally { await f.close(); }
});

test('a single buffered draft can short-circuit, while multiple drafts each plan', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const draftId = f.project.draft('开发 会话里的登录页');
    const committed = await f.project.commitDrafts();
    expect(committed.drafts).toEqual([draftId.id]);
    expect(committed.inputs).toHaveLength(1);
    const single = committed.inputs[0];
    expect(single.draft).toBe(draftId.id);
    expect(single.route).toEqual({ prefix: '开发', target: 'worker' });
    expect(single.worker.goal).toBe('会话里的登录页');

    // 多条草稿逐条提交：每条各自成为一个输入，不再拼批次引导语。
    f.project.draft('开发 第一条');
    f.project.draft('解释 第二条');
    const multi = await f.project.commitDrafts();
    expect(multi.drafts).toHaveLength(2);
    expect(multi.inputs).toHaveLength(2);
    expect(multi.inputs[0].worker.goal).toBe('第一条');
    expect(multi.inputs[1].research.goal).toBe('第二条');
    expect(provider.calls).toHaveLength(0);
  } finally { await f.close(); }
});
