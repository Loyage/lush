import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

/** planner 只写 spec 队列；测试里用它造一个能直接派活的非 planner 任务。 */
function host(f, { role = 'coordinator', goal = 'host', input_id = null } = {}) {
  const task = f.store.create({ input_id, role, goal });
  f.store.update(task.id, { status: 'waiting' });
  return task;
}

/** A git project with one finished worker whose branch holds an unmerged change. */
async function upstreamOnly() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'staged work' });
  const worker = f.project.spawn(parent.id, 'upstream change', 'worker');
  const cwd = await f.project.workspaces.ensure(f.store.task(worker.id));
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'upstream\n');
  await git(cwd, 'add', 'file.txt'); await git(cwd, 'commit', '-m', 'upstream work');
  await f.project.workspaces.finish(f.store.task(worker.id));
  f.store.update(worker.id, { status: 'completed' });
  return { ...f, parent, upstream: f.store.task(worker.id) };
}

test('a queued task waits for its dependencies and is released when they settle', async () => {
  const gates = new Map(); let a = null, b = null, upstreamStatusWhenDownstreamRan = null;
  const f = fixture({ run({ task, api, signal }) {
    if (task.role === 'coordinator') {
      if (task.calls === 1) {
        a = api.spawn(task.id, '上游工作', 'research');
        b = api.spawn(task.id, '下游工作', 'research', [{ id: a.id, kind: 'order' }]);
      }
      return Promise.resolve('delegated');
    }
    if (task.id === b.id) upstreamStatusWhenDownstreamRan = api.store.task(a.id).status;
    const done = gate(); gates.set(task.id, done);
    signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } }, { LUSH_CONCURRENCY: '4' });
  try {
    const root = f.store.create({ input_id: null, role: 'coordinator', goal: '两件有先后的事' });
    f.project.kick();
    await until(() => a && gates.has(a.id));
    expect(f.project.running.has(b.id)).toBe(false);
    expect(gates.has(b.id)).toBe(false);
    expect(f.project.blockedBy(b.id)).toEqual([a.id]);
    expect(f.project.decorate([f.store.task(b.id)])[0].blocked).toBe(true);
    gates.get(a.id).resolve('上游完成');
    await until(() => gates.has(b.id));
    expect(upstreamStatusWhenDownstreamRan).toBe('completed');
    expect(f.project.blockedBy(b.id)).toEqual([]);
    gates.get(b.id).resolve('下游完成');
    await until(() => f.store.task(root.id).status === 'completed');
    expect(f.store.task(b.id).status).toBe('completed');
  } finally { await f.close(); }
});

test('dependency declaration rejects deadlocks and dependencies that cannot work', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const first = host(f, { goal: 'first' });
    const second = host(f, { goal: 'second' });
    const research = f.project.spawn(first.id, 'a', 'research');
    const worker = f.project.spawn(first.id, 'w', 'worker');
    expect(() => f.project.spawn(first.id, 'x', 'research', [{ id: 999 }])).toThrow('task 999 not found');
    expect(() => f.project.spawn(first.id, 'x', 'research', [{ id: research.id }, { id: research.id }])).toThrow('duplicate dependency');
    expect(() => f.project.spawn(first.id, 'x', 'research', [{ id: research.id, kind: 'eventually' }])).toThrow('kind must be code or order');
    expect(() => f.project.spawn(first.id, 'x', 'research', new Array(33).fill({ id: research.id }))).toThrow('at most 32');
    // 祖先在等子孙结算，依赖它就会互等；父任务同理
    expect(() => f.project.spawn(research.id, 'x', 'research', [{ id: first.id, kind: 'order' }])).toThrow('ancestor');
    expect(() => f.project.spawn(research.id, 'x', 'research', [{ id: research.id, kind: 'order' }])).toThrow('ancestor');
    // code 依赖需要一条能叠上去的分支
    expect(() => f.project.spawn(first.id, 'x', 'research', [{ id: second.id }])).toThrow('coordinator task');
    expect(() => f.project.spawn(first.id, 'x', 'research', [{ id: worker.id }, { id: research.id }])).toThrow('at most one code dependency');
    f.store.update(worker.id, { status: 'failed' });
    expect(() => f.project.spawn(first.id, 'x', 'research', [{ id: worker.id }])).toThrow('cannot serve as a code base');
    // 失败的那次调用没有留下半个任务
    expect(f.store.children(first.id).map(child => child.goal)).toEqual(['a', 'w']);
  } finally { await f.close(); }
});

test('a planner cannot delegate directly; the queue is its only path', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const planner = f.project.submit('plan').task;
    expect(() => f.project.spawn(planner.id, 'no direct spawn', 'research')).toThrow('planner 不再直接派活');
    const first = f.project.addSpec(planner.id, { goal: '第一次调研', role: 'research', name: 'first-research' });
    const second = f.project.addSpec(planner.id, { goal: '第二次调研', role: 'research', name: 'second-research', deps: [{ spec: first.id, kind: 'order' }] });
    expect(f.store.specsByPlanner(planner.id).map(spec => [spec.seq, spec.status, spec.name])).toEqual([[1, 'pending', 'first-research'], [2, 'pending', 'second-research']]);
    expect(second.deps).toEqual([{ spec: first.id, kind: 'order' }]);
  } finally { await f.close(); }
});

test('dependency reachability walks the chain so a future edit-DAG cannot loop', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = host(f, { goal: 'chain' });
    const a = f.project.spawn(root.id, 'a', 'research');
    const b = f.project.spawn(root.id, 'b', 'research', [{ id: a.id, kind: 'order' }]);
    const c = f.project.spawn(root.id, 'c', 'research', [{ id: b.id, kind: 'order' }]);
    expect(f.store.reaches(c.id, a.id)).toBe(true);
    expect(f.store.reaches(b.id, a.id)).toBe(true);
    expect(f.store.reaches(a.id, c.id)).toBe(false);
    expect(f.store.reaches(a.id, a.id)).toBe(true);
  } finally { await f.close(); }
});

test('read models expose dependency edges and blocked state', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = host(f, { goal: 'plan' });
    const a = f.project.spawn(root.id, 'a', 'research');
    const b = f.project.spawn(root.id, 'b', 'research', [{ id: a.id, kind: 'order' }]);
    expect(f.project.inspect(b.id).deps).toEqual([{ id: a.id, kind: 'order', role: 'research', status: 'queued', integration: 'none', goal: 'a' }]);
    expect(f.project.inspect(a.id).dependents.map(row => [row.id, row.kind])).toEqual([[b.id, 'order']]);
    const tree = f.project.tree()[0].children;
    expect(tree.find(row => row.id === b.id).blocked).toBe(true);
    expect(tree.find(row => row.id === a.id).blocked).toBe(false);
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const list = await rpc.dispatch('task.list', {});
    expect(list.find(row => row.id === b.id).deps).toEqual([{ id: a.id, kind: 'order', status: 'queued' }]);
    const inspected = await rpc.dispatch('task.inspect', { id: a.id });
    expect(inspected.dependents.map(row => row.id)).toEqual([b.id]);
  } finally { await f.close(); }
});

test('a code dependency stacks the worktree on the upstream branch', async () => {
  const f = await upstreamOnly();
  try {
    const downstream = f.project.spawn(f.parent.id, 'downstream change', 'worker', [{ id: f.upstream.id, kind: 'code' }]);
    const cwd = await f.project.workspaces.ensure(f.store.task(downstream.id));
    // 上游还没合并进主工作树，但下游看得到它
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('base\n');
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toBe('upstream\n');
    expect(f.store.task(downstream.id).base_commit).toBe(f.upstream.head_commit);
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(f.upstream.head_commit);
    // 审阅范围只含下游自己的提交，不把上游的算进来
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'downstream\n');
    await git(cwd, 'add', 'other.txt'); await git(cwd, 'commit', '-m', 'downstream work');
    await f.project.workspaces.finish(f.store.task(downstream.id));
    expect(f.store.task(downstream.id).integration).toBe('pending');
    expect(await git(cwd, 'rev-list', '--count', `${f.upstream.head_commit}..HEAD`)).toBe('1');
    expect(f.store.history(downstream.id).some(event => event.type === 'workspace.created' && event.data.stacked_on === f.upstream.id)).toBe(true);
  } finally { await f.close(); }
});

test('an order dependency only waits; the worktree still starts from project HEAD', async () => {
  const f = await upstreamOnly();
  try {
    const downstream = f.project.spawn(f.parent.id, 'downstream change', 'worker', [{ id: f.upstream.id, kind: 'order' }]);
    const cwd = await f.project.workspaces.ensure(f.store.task(downstream.id));
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toBe('base\n');
    expect(f.store.task(downstream.id).base_commit).toBe(await git(f.root, 'rev-parse', 'HEAD'));
  } finally { await f.close(); }
});

test('a cancelled upstream unblocks an order dependency but fails a code dependency loudly', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'staged work' });
    const upstream = f.project.spawn(parent.id, 'upstream', 'worker');
    const ordered = f.project.spawn(parent.id, 'ordered', 'worker', [{ id: upstream.id, kind: 'order' }]);
    const stacked = f.project.spawn(parent.id, 'stacked', 'worker', [{ id: upstream.id, kind: 'code' }]);
    f.store.update(upstream.id, { status: 'cancelled' });
    // order 只等结束：上游取消了也算结束，下游自己从 HEAD 开工
    expect(f.project.blockedBy(ordered.id)).toEqual([]);
    const orderedCwd = await f.project.workspaces.ensure(f.store.task(ordered.id));
    expect(fs.readFileSync(path.join(orderedCwd, 'file.txt'), 'utf8')).toBe('base\n');
    // code 需要一条真的分支：不能默默从 HEAD 开工，否则下游会在缺上游改动的树上工作
    await expect(f.project.workspaces.ensure(f.store.task(stacked.id))).rejects.toThrow('only a completed upstream can be a worktree base');
    expect(f.store.task(stacked.id).workspace).toBeNull();
  } finally { await f.close(); }
});

test('a stacked task cannot merge before its upstream', async () => {
  const f = await upstreamOnly();
  try {
    const downstream = f.project.spawn(f.parent.id, 'downstream change', 'worker', [{ id: f.upstream.id, kind: 'code' }]);
    const cwd = await f.project.workspaces.ensure(f.store.task(downstream.id));
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'downstream\n');
    await git(cwd, 'add', 'other.txt'); await git(cwd, 'commit', '-m', 'downstream work');
    await f.project.workspaces.finish(f.store.task(downstream.id));
    f.store.update(downstream.id, { status: 'completed' });
    await expect(f.project.workspaces.merge(downstream.id)).rejects.toThrow(`code dependency #${f.upstream.id} is not merged`);
    expect(f.store.task(downstream.id).integration).toBe('pending');
    await f.project.workspaces.merge(f.upstream.id);
    await f.project.workspaces.merge(downstream.id);
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('upstream\n');
    expect(fs.readFileSync(path.join(f.root, 'other.txt'), 'utf8')).toBe('downstream\n');
    expect(f.store.task(downstream.id).integration).toBe('merged');
  } finally { await f.close(); }
});
