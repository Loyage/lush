import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';

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

test('drafts buffer, drop and commit as one numbered batch to a single planner', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    expect(() => f.project.draft('   ')).toThrow('draft must be non-empty');
    const first = f.project.draft('第一条 想法');
    const second = f.project.draft('第二条');
    const third = f.project.draft('第三条');
    expect(f.project.drafts().map(draft => draft.content)).toEqual(['第一条 想法', '第二条', '第三条']);
    expect(f.project.dropDraft(second.id)).toEqual({ id: second.id });
    expect(f.project.drafts()).toHaveLength(2);

    const batch = f.project.commitDrafts();
    expect(batch.drafts).toEqual([first.id, third.id]);
    expect(batch.task.role).toBe('planner');
    expect(batch.task.goal).toBe(batch.content);
    expect(f.project.inspect(batch.task.id).goal).toContain('用户在一次提交中给了 2 条');
    expect(batch.content).toContain('1) 第一条 想法');
    expect(batch.content).toContain('2) 第三条');
    // 每条原话逐字留在 drafts 行上，提交过的回写 input_id 作为审计链；被移除的草稿不留行
    expect(f.store.all('SELECT content,input_id FROM drafts ORDER BY id').map(row => [row.content, row.input_id]))
      .toEqual([['第一条 想法', batch.id], ['第三条', batch.id]]);
    expect(f.store.draftCount()).toBe(0);
    expect(f.project.inputs()[0].draft_count).toBe(2);
    expect(() => f.project.dropDraft(first.id)).toThrow('already submitted');
    expect(() => f.project.commitDrafts()).toThrow('no buffered drafts');
  } finally { await f.close(); }
});

test('a single buffered draft reaches the planner verbatim', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    f.project.draft('  原话\n保留  ');
    const batch = f.project.commitDrafts();
    expect(batch.content).toBe('  原话\n保留  ');
    expect(batch.task.goal).toBe('  原话\n保留  ');
  } finally { await f.close(); }
});

test('drafts can be edited in place and submitted as a chosen subset', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const first = f.project.draft('第一条');
    const second = f.project.draft('第二条');
    const third = f.project.draft('第三条');

    // 编辑就地生效，草稿 id 不变，输入顺序因此稳定
    const edited = f.project.editDraft(second.id, '第二条（改过）');
    expect(edited).toMatchObject({ id: second.id, content: '第二条（改过）', input_id: null });
    expect(f.project.drafts().map(draft => draft.content)).toEqual(['第一条', '第二条（改过）', '第三条']);
    expect(() => f.project.editDraft(second.id, '   ')).toThrow('draft must be non-empty');
    expect(() => f.project.editDraft(999, 'x')).toThrow('draft 999 not found');

    // 只提交选中的子集，且按草稿 id 升序拼接；未选中的继续留在缓存
    const batch = f.project.commitDrafts([second.id, first.id]);
    expect(batch.drafts).toEqual([first.id, second.id]);
    expect(batch.content).toContain('1) 第一条');
    expect(batch.content).toContain('2) 第二条（改过）');
    expect(batch.content).not.toContain('第三条');
    expect(f.store.draft(first.id).input_id).toBe(batch.id);
    expect(f.store.draft(second.id).input_id).toBe(batch.id);
    expect(f.store.draft(third.id).input_id).toBeNull();
    expect(f.project.drafts().map(draft => draft.id)).toEqual([third.id]);

    // 已提交的草稿既不能改也不能再提交；未知 / 重复 / 空数组都在提交前拒绝
    expect(() => f.project.editDraft(first.id, 'x')).toThrow(`draft ${first.id} was already submitted as input ${batch.id}`);
    expect(() => f.project.commitDrafts([first.id])).toThrow('already submitted');
    expect(() => f.project.commitDrafts([999])).toThrow('draft 999 not found');
    expect(() => f.project.commitDrafts([third.id, third.id])).toThrow(`draft ${third.id} listed twice`);
    expect(() => f.project.commitDrafts([])).toThrow('select at least one draft');
    expect(() => f.project.commitDrafts('nope')).toThrow('must be an array');

    // 省略 ids 时行为不变：提交全部 open drafts
    const rest = f.project.commitDrafts();
    expect(rest.drafts).toEqual([third.id]);
    expect(rest.content).toBe('第三条');
    expect(f.store.draftCount()).toBe(0);
  } finally { await f.close(); }
});

test('the draft cache is bounded', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    for (let index = 0; index < 500; index += 1) f.store.addDraft(`draft ${index}`);
    expect(() => f.project.draft('one too many')).toThrow('too many buffered drafts');
  } finally { await f.close(); }
});

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

test('agent tokens cannot touch the user input buffer', async () => {
  const f = fixture({ run({ signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  try {
    const root = f.project.submit('root').task;
    await until(() => f.project.running.has(root.id));
    const token = f.project.running.get(root.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    expect(await rpc.dispatch('draft.list', { _token: token })).toEqual([]);
    for (const [method, params] of [['draft.add', { content: 'sneak' }], ['draft.update', { id: 1, content: 'sneak' }], ['draft.remove', { id: 1 }], ['draft.commit', {}]]) {
      await expect(rpc.dispatch(method, { ...params, _token: token })).rejects.toThrow('user approval');
    }
    expect(f.store.draftCount()).toBe(0);
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
