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

const flowOf = (f, inputId) => f.store.get('SELECT flow FROM inputs WHERE id=?', inputId).flow;

test('a develop prefix short-circuits the planner and creates the routed worker', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const result = await f.project.submit('开发 做一个登录页');
    expect(result.route).toEqual({ prefix: '开发', target: 'worker' });
    expect(flowOf(f, result.id)).toBe('develop');
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
    expect(route.data).toMatchObject({ prefix: '开发', target: 'worker', flow: 'develop', task: result.worker.id });
    expect(events.some(event => event.type === 'completed' && event.data.route === true)).toBe(true);
    // 走的是 route，不是旧的 direct 占位。
    expect(events.some(event => event.type === 'input.direct')).toBe(false);
    expect(f.project.inputs().find(input => input.id === result.id).route).toBe(1);
  } finally { await f.close(); }
});

test('an explain prefix creates a read-only research root and never a worktree or branch', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const result = await f.project.submit('解释：调度器怎么工作');
    expect(result.route).toEqual({ prefix: '解释', target: 'research' });
    expect(flowOf(f, result.id)).toBe('explain');
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

test('a non-prefix input still goes to the planner, and direct follows the prefix when both apply', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const plain = await f.project.submit('做一个登录页');
    expect(plain.route).toBeUndefined();
    expect(plain.worker).toBeUndefined();
    expect(flowOf(f, plain.id)).toBeNull();
    expect(plain.task.role).toBe('planner');
    expect(plain.task.status).toBe('queued');
    expect(provider.calls).toHaveLength(0);

    // direct=true 且前缀命中：按前缀目标（解释→research），而不是 direct 的 worker。
    const routed = await f.project.submit('解释：直接解释一下', null, [], true);
    expect(routed.route).toEqual({ prefix: '解释', target: 'research' });
    expect(routed.research.role).toBe('research');
    expect(routed.worker).toBeUndefined();
    expect(routed.direct).toBeUndefined();
    expect(f.store.history(routed.task.id).some(event => event.type === 'input.direct')).toBe(false);

    // direct=true 且没有前缀：仍是旧的直接 worker 行为。
    const direct = await f.project.submit('直接做一个页面', null, [], true);
    expect(direct.route).toBeUndefined();
    expect(direct.direct).toBe(true);
    expect(direct.worker.goal).toBe('直接做一个页面');
  } finally { await f.close(); }
});

test('a single buffered draft can short-circuit, while a multi-draft batch still plans', async () => {
  const provider = controlled(), f = fixture(provider); f.project.stopping = true; await repo(f.root);
  try {
    const draftId = f.project.draft('开发 会话里的登录页');
    const batch = await f.project.commitDrafts();
    expect(batch.drafts).toEqual([draftId.id]);
    expect(batch.route).toEqual({ prefix: '开发', target: 'worker' });
    expect(batch.worker.goal).toBe('会话里的登录页');
    expect(flowOf(f, batch.id)).toBe('develop');

    // 多草稿批次以固定引导语开头，不会被前缀命中，仍交给 planner。
    f.project.draft('开发 第一条');
    f.project.draft('解释 第二条');
    const multi = await f.project.commitDrafts();
    expect(multi.route).toBeUndefined();
    expect(flowOf(f, multi.id)).toBeNull();
    expect(multi.task.status).toBe('queued');
    expect(provider.calls).toHaveLength(0);
  } finally { await f.close(); }
});
