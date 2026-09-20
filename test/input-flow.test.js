import { test, expect } from 'bun:test';
import { fixture, repo, git, until, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

/** planner 只写 spec 队列；测试里用它造一个继承某条 input 的非 planner 任务。 */
function host(f, input_id) {
  const task = f.store.create({ input_id, role: 'coordinator', goal: 'host' });
  f.store.update(task.id, { status: 'waiting' });
  return task;
}

test('a root planner records the flow of its input and can reclassify it', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const input = await f.project.submit('解释一下调度器怎么工作');
    expect(f.project.inputs()[0]).toMatchObject({ id: input.id, flow: null });
    expect(f.project.setInputFlow(input.task.id, 'explain')).toEqual({ input_id: input.id, task_id: input.task.id, flow: 'explain' });
    expect(f.store.get('SELECT flow FROM inputs WHERE id=?', input.id).flow).toBe('explain');
    expect(f.project.inputs()[0]).toMatchObject({ id: input.id, flow: 'explain' });
    expect(f.store.history(input.task.id).some(event => event.type === 'input.flow' && event.data.flow === 'explain')).toBe(true);
    // 用户随时可以改判；改判只影响之后的 spawn
    f.project.setInputFlow(input.task.id, 'develop');
    expect(f.project.inputs()[0].flow).toBe('develop');
  } finally { await f.close(); }
});

test('an explain input still anchors its code but never gets task worktrees', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.submit('了解调度器怎么工作');
    f.project.setInputFlow(task.id, 'explain');
    const root = host(f, task.input_id);
    expect(() => f.project.spawn(root.id, 'implement it', 'worker')).toThrow('explain');
    expect(() => f.project.spawn(root.id, 'implement it', 'worker')).toThrow('了解');
    expect(() => f.project.spawn(root.id, 'split it', 'coordinator')).toThrow('explain');
    const research = f.project.spawn(root.id, 'read the scheduler', 'research');
    expect(research.role).toBe('research');
    // 后代沿用同一个 input_id，所以约束覆盖整棵子树
    expect(() => f.project.spawn(research.id, 'deep worker', 'worker')).toThrow('explain');
    // research 不创建 worktree，所以了解类输入不会留下待合并改动；它带的仍是 submit 那一刻的输入锚点。
    await f.project.workspaces.ensure(f.store.task(research.id));
    expect(f.store.task(research.id).workspace).toBeNull();
    expect(f.store.task(research.id).branch).toBeNull();
    const view = f.project.inputs()[0];
    expect(view.flow).toBe('explain');
    expect(view.anchor_commit).toBe(await git(f.root, 'rev-parse', 'HEAD'));
    expect(view.anchor_workspace).toContain('input-');
  } finally { await f.close(); }
});

test('develop and undecided inputs keep spawning workers unchanged', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const developed = (await f.project.submit('开发新功能')).task;
    const undecided = (await f.project.submit('还没判定')).task;
    f.project.setInputFlow(developed.id, 'develop');
    const developedHost = host(f, developed.input_id), undecidedHost = host(f, undecided.input_id);
    expect(f.project.spawn(developedHost.id, 'implement', 'worker').role).toBe('worker');
    expect(f.project.spawn(undecidedHost.id, 'implement', 'worker').role).toBe('worker');
  } finally { await f.close(); }
});

test('only a root task can classify an input; unknown flows are rejected', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const root = (await f.project.submit('root')).task;
    const child = f.project.spawn(host(f, root.input_id).id, 'child', 'research');
    expect(() => f.project.setInputFlow(child.id, 'explain')).toThrow('only a root task');
    expect(() => f.project.setInputFlow(root.id, 'maybe')).toThrow('flow must be develop or explain');
    expect(f.store.get('SELECT flow FROM inputs WHERE id=?', root.input_id).flow).toBeNull();
  } finally { await f.close(); }
});

test('users classify and reclassify any root input over RPC without a token', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const first = await f.project.submit('first');
    const second = await f.project.submit('second');
    const rpc = new Dispatcher(f.project, createSignal(), {});
    expect(await rpc.dispatch('input.flow', { id: first.task.id, flow: 'explain' })).toMatchObject({ input_id: first.id, flow: 'explain' });
    expect(await rpc.dispatch('input.flow', { id: second.task.id, flow: 'develop' })).toMatchObject({ flow: 'develop' });
    expect(await rpc.dispatch('input.flow', { id: first.task.id, flow: 'develop' })).toMatchObject({ flow: 'develop' });
    expect(f.project.inputs().map(input => input.flow)).toEqual(['develop', 'develop']);
    // 没有 id、也没有 agent token 时报明确错误；缺 flow 也报错
    await expect(rpc.dispatch('input.flow', { flow: 'explain' })).rejects.toThrow('requires a root task id');
    await expect(rpc.dispatch('input.flow', { id: first.task.id })).rejects.toThrow('flow must be develop or explain');
    await expect(rpc.dispatch('input.flow', { id: first.task.id, flow: 'develop', sid: 1 })).rejects.toThrow('unknown parameter');
  } finally { await f.close(); }
});

test('an agent classifies only its own root input', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const root = (await f.project.submit('root')).task;
    await until(() => f.project.running.has(root.id));
    const other = (await f.project.submit('other')).task;
    const token = f.project.running.get(root.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    // 省略 id 时判定自己这条输入
    expect(await rpc.dispatch('input.flow', { flow: 'explain', _token: token })).toMatchObject({ task_id: root.id, flow: 'explain' });
    // 指定别的根 task 被拒
    await expect(rpc.dispatch('input.flow', { id: other.id, flow: 'develop', _token: token })).rejects.toThrow('own input');
    // planner 不再直接派活，只能写 spec 队列
    await expect(rpc.dispatch('task.spawn', { parent: root.id, goal: 'no', role: 'worker', _token: token })).rejects.toThrow('planner 不再直接派活');
    // explain 输入下只能写 research 的 spec
    await expect(rpc.dispatch('spec.add', { goal: 'no worker', role: 'worker', _token: token })).rejects.toThrow('explain');
    expect((await rpc.dispatch('spec.add', { goal: 'read the scheduler', role: 'research', _token: token })).role).toBe('research');
    f.project.cancel(root.id);
    await until(() => !f.project.running.has(root.id));
  } finally { await f.close(); }
});
