import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from './helpers.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { assertAllowed } from '../src/rpc/registry.js';
import { createSignal } from '../src/signal.js';

/** 造一棵可删的树：host（无分支）+ worker（有 worktree 与已提交改动）+ 一条消息。 */
async function settled(f) {
  const host = f.store.create({ input_id: null, role: 'coordinator', goal: 'host' });
  const worker = f.project.spawn(host.id, 'implement', 'worker', [], 'implement-feature');
  const cwd = await f.project.workspaces.ensure(worker);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'changed\n');
  await git(cwd, 'add', 'file.txt'); await git(cwd, 'commit', '-m', 'implementation');
  await f.project.workspaces.finish(f.store.task(worker.id));
  f.project.message(host.id, 'note');
  f.store.update(host.id, { status: 'completed' });
  f.store.update(worker.id, { status: 'completed' });
  return { host, worker, cwd };
}

test('task delete refuses active tasks, is user-only, and refuses tasks other rows still reference', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const host = f.store.create({ input_id: null, role: 'coordinator', goal: 'host' });
    const child = f.project.spawn(host.id, 'work', 'worker', [], 'work');
    f.store.update(child.id, { status: 'completed' });

    // 子树里还有活动任务（host 还在排队）：整体拒绝，不做隐式取消。
    expect(() => f.project.deleteTask(host.id)).toThrow(`#${host.id} still active`);
    f.store.update(host.id, { status: 'completed' });

    // 只有用户能删：agent 拿着自己的 token 也不行。
    expect(() => assertAllowed('task.delete', { id: host.id }, 7)).toThrow('user approval');

    // verifier 是独立记录，不跟被删任务一起走：外键会拦住，所以先点名拒绝。
    const verifier = f.store.create({ input_id: null, role: 'verifier', goal: 'verify', verifies_task_id: child.id });
    f.store.update(verifier.id, { status: 'completed' });
    expect(() => f.project.deleteTask(child.id)).toThrow(`still referenced by verifier #${verifier.id}`);
    expect(() => f.project.deleteTask(host.id)).toThrow(`still referenced by verifier #${verifier.id}`);

    // 删掉引用方之后，同一棵树就能删。
    const rpc = new Dispatcher(f.project, createSignal(), {});
    expect((await rpc.dispatch('task.delete', { id: verifier.id })).deleted.tasks).toBe(1);
    const result = await rpc.dispatch('task.delete', { id: host.id });
    expect(result.deleted.ids).toEqual([host.id, child.id]);
    expect(f.store.tasks()).toEqual([]);
  } finally { await f.close(); }
});

test('task delete drops the subtree rows and keeps branch lineage, inputs and task ids', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { host, worker, cwd } = await settled(f);
    await f.project.workspaces.merge(worker.id);
    const branch = f.store.task(worker.id).branch;
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(1);

    const result = await f.project.deleteTask(host.id);
    expect(result.deleted).toMatchObject({ root: host.id, ids: [host.id, worker.id], tasks: 2, messages: 1 });
    expect(result.reclaimed).toEqual({ worktrees: 1, branches: 1 });
    expect(result.next_task_id).toBe(worker.id + 1);
    expect(f.store.tasks()).toEqual([]);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(1);
    expect(fs.existsSync(cwd)).toBe(false);
    expect(await git(f.root, 'branch', '--list', branch)).toBe('');

    // 谱系记录留着：task_id 刻意没有外键，历史指针继续指着已经不在的任务行（读模型按「已清空」处理）。
    const record = f.store.branches().find(row => row.branch === branch);
    expect(record).toMatchObject({ task_id: worker.id, status: 'deleted' });

    // 删除是唯一会丢任务历史的路径，所以留一条项目级事件当审计：它没有任务可挂，内容在 data 里。
    const audit = f.store.get("SELECT * FROM events WHERE type='task.deleted'");
    expect(audit.task_id).toBe(null);
    expect(JSON.parse(audit.data)).toMatchObject({ task_id: host.id, counts: { tasks: 2 } });

    // id 不复用。
    expect(f.store.create({ input_id: null, role: 'coordinator', goal: 'next' }).id).toBe(worker.id + 1);
  } finally { await f.close(); }
});

test('task delete refuses a subtree it cannot reclaim, and then leaves every row in place', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { host, worker, cwd } = await settled(f);
    const branch = f.store.task(worker.id).branch;
    await expect(f.project.deleteTask(host.id)).rejects.toThrow('cannot be reclaimed');
    // 一条都不删：任务、消息、分支与磁盘上的 worktree 全留着，用户先自己收尾（task cleanup）。
    expect(f.store.tasks().map(task => task.id)).toEqual([host.id, worker.id]);
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(1);
    expect(fs.existsSync(cwd)).toBe(true);
    expect(await git(f.root, 'branch', '--list', branch)).toContain(branch);
  } finally { await f.close(); }
});

test('task delete refuses a planner that still has unhandled specs', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const planner = f.store.create({ input_id: null, role: 'planner', goal: 'plan' });
    const spec = f.store.addSpec({ planner_task_id: planner.id, goal: 'do a thing' });
    f.store.update(planner.id, { status: 'completed' });
    expect(() => f.project.deleteTask(planner.id)).toThrow('still has pending specs');
    // 用户明确丢掉这条拆解之后，planner 连同它的 spec 行一起删。
    f.store.dropSpec(spec.id, 'test');
    const result = await f.project.deleteTask(planner.id);
    expect(result.deleted).toMatchObject({ tasks: 1, task_specs: 1 });
    expect(f.store.get('SELECT count(*) AS n FROM task_specs').n).toBe(0);
  } finally { await f.close(); }
});

test('task delete removes dependency edges and the messages a deleted task sent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'parent' });
    const child = f.project.spawn(parent.id, 'child', 'worker', [], 'child');
    // 子把结果报给父：这条消息讲的就是将要被删的那条任务。
    f.project.message(parent.id, 'child note', child.id);
    // 依赖边：另一条终态任务指着将被删的任务（任务行活下来，边随上游一起走）。
    const upstream = f.store.create({ input_id: null, role: 'coordinator', goal: 'upstream' });
    const downstream = f.store.create({ input_id: null, role: 'coordinator', goal: 'downstream' });
    f.store.addDep(downstream.id, upstream.id, 'order');
    for (const task of [parent, child, upstream, downstream]) f.store.update(task.id, { status: 'completed' });
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(1);
    expect(f.store.get('SELECT count(*) AS n FROM task_deps').n).toBe(1);

    expect((await f.project.deleteTask(upstream.id)).deleted).toMatchObject({ tasks: 1, task_deps: 1 });
    expect((await f.project.deleteTask(child.id)).deleted).toMatchObject({ tasks: 1, messages: 1 });
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(0);
    expect(f.store.get('SELECT count(*) AS n FROM task_deps').n).toBe(0);
    expect(f.store.task(parent.id).status).toBe('completed');
    expect(f.store.task(downstream.id).status).toBe('completed');
  } finally { await f.close(); }
});
