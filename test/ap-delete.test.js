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
  await f.project.workspaces.finish(f.store.ap(worker.id));
  f.project.message(host.id, 'note');
  f.store.update(host.id, { status: 'completed' });
  f.store.update(worker.id, { status: 'completed' });
  return { host, worker, cwd };
}

test('ap delete refuses active aps, is user-only, and refuses aps other rows still reference', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const host = f.store.create({ input_id: null, role: 'coordinator', goal: 'host' });
    const child = f.project.spawn(host.id, 'work', 'worker', [], 'work');
    f.store.update(child.id, { status: 'completed' });

    // 子树里还有活动 AP（host 还在排队）：整体拒绝，不做隐式取消。
    expect(() => f.project.deleteAP(host.id)).toThrow(`#${host.id} still active`);
    f.store.update(host.id, { status: 'completed' });

    // 只有用户能删：agent 拿着自己的 token 也不行。
    expect(() => assertAllowed('ap.delete', { id: host.id }, 7)).toThrow('user approval');

    // verifier 是独立记录，不跟被删 AP 一起走：外键会拦住，所以先点名拒绝。
    const verifier = f.store.create({ input_id: null, role: 'verifier', goal: 'verify', verifies_ap_id: child.id });
    f.store.update(verifier.id, { status: 'completed' });
    expect(() => f.project.deleteAP(child.id)).toThrow(`still referenced by verifier #${verifier.id}`);
    expect(() => f.project.deleteAP(host.id)).toThrow(`still referenced by verifier #${verifier.id}`);

    // 删掉引用方之后，同一棵树就能删。
    const rpc = new Dispatcher(f.project, createSignal(), {});
    expect((await rpc.dispatch('ap.delete', { id: verifier.id })).deleted.aps).toBe(1);
    const result = await rpc.dispatch('ap.delete', { id: host.id });
    expect(result.deleted.ids).toEqual([host.id, child.id]);
    expect(f.store.aps()).toEqual([]);
  } finally { await f.close(); }
});

test('ap delete drops the subtree rows and keeps branch lineage, inputs and AP ids', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { host, worker, cwd } = await settled(f);
    await f.project.workspaces.merge(worker.id);
    const branch = f.store.ap(worker.id).branch;
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(1);

    const result = await f.project.deleteAP(host.id);
    expect(result.deleted).toMatchObject({ root: host.id, ids: [host.id, worker.id], aps: 2, messages: 1 });
    expect(result.reclaimed).toEqual({ worktrees: 1, branches: 1 });
    expect(result.next_ap_id).toBe(worker.id + 1);
    expect(f.store.aps()).toEqual([]);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(1);
    expect(fs.existsSync(cwd)).toBe(false);
    expect(await git(f.root, 'branch', '--list', branch)).toBe('');

    // 谱系记录留着：ap_id 刻意没有外键，历史指针继续指着已经不在的 AP 行（读模型按「已清空」处理）。
    const record = f.store.branches().find(row => row.branch === branch);
    expect(record).toMatchObject({ ap_id: worker.id, status: 'deleted' });

    // 删除是唯一会丢 AP 历史的路径，所以留一条项目级事件当审计：它没有 AP 可挂，内容在 data 里。
    const audit = f.store.get("SELECT * FROM events WHERE type='ap.deleted'");
    expect(audit.ap_id).toBe(null);
    expect(JSON.parse(audit.data)).toMatchObject({ ap_id: host.id, counts: { aps: 2 } });

    // id 不复用。
    expect(f.store.create({ input_id: null, role: 'coordinator', goal: 'next' }).id).toBe(worker.id + 1);
  } finally { await f.close(); }
});

test('ap delete refuses a subtree it cannot reclaim, and then leaves every row in place', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const { host, worker, cwd } = await settled(f);
    const branch = f.store.ap(worker.id).branch;
    await expect(f.project.deleteAP(host.id)).rejects.toThrow('cannot be reclaimed');
    // 一条都不删：AP、消息、分支与磁盘上的 worktree 全留着，用户先自己收尾（ap cleanup）。
    expect(f.store.aps().map(ap => ap.id)).toEqual([host.id, worker.id]);
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(1);
    expect(fs.existsSync(cwd)).toBe(true);
    expect(await git(f.root, 'branch', '--list', branch)).toContain(branch);
  } finally { await f.close(); }
});

test('ap delete refuses a planner that still has unhandled specs', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const planner = f.store.create({ input_id: null, role: 'planner', goal: 'plan' });
    const spec = f.store.addSpec({ planner_ap_id: planner.id, goal: 'do a thing' });
    f.store.update(planner.id, { status: 'completed' });
    expect(() => f.project.deleteAP(planner.id)).toThrow('still has pending specs');
    // 用户明确丢掉这条拆解之后，planner 连同它的 spec 行一起删。
    f.store.dropSpec(spec.id, 'test');
    const result = await f.project.deleteAP(planner.id);
    expect(result.deleted).toMatchObject({ aps: 1, ap_specs: 1 });
    expect(f.store.get('SELECT count(*) AS n FROM ap_specs').n).toBe(0);
  } finally { await f.close(); }
});

test('ap delete removes dependency edges and the messages a deleted AP sent', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = f.store.create({ input_id: null, role: 'coordinator', goal: 'parent' });
    const child = f.project.spawn(parent.id, 'child', 'worker', [], 'child');
    // 子把结果报给父：这条消息讲的就是将要被删的那条 AP。
    f.project.message(parent.id, 'child note', child.id);
    // 依赖边：另一条终态 AP 指着将被删的 AP（AP 行活下来，边随上游一起走）。
    const upstream = f.store.create({ input_id: null, role: 'coordinator', goal: 'upstream' });
    const downstream = f.store.create({ input_id: null, role: 'coordinator', goal: 'downstream' });
    f.store.addDep(downstream.id, upstream.id, 'order');
    for (const ap of [parent, child, upstream, downstream]) f.store.update(ap.id, { status: 'completed' });
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(1);
    expect(f.store.get('SELECT count(*) AS n FROM ap_deps').n).toBe(1);

    expect((await f.project.deleteAP(upstream.id)).deleted).toMatchObject({ aps: 1, ap_deps: 1 });
    expect((await f.project.deleteAP(child.id)).deleted).toMatchObject({ aps: 1, messages: 1 });
    expect(f.store.get('SELECT count(*) AS n FROM messages').n).toBe(0);
    expect(f.store.get('SELECT count(*) AS n FROM ap_deps').n).toBe(0);
    expect(f.store.ap(parent.id).status).toBe('completed');
    expect(f.store.ap(downstream.id).status).toBe('completed');
  } finally { await f.close(); }
});
