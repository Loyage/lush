import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

test('specs are written, read back through the queue read models, and users cannot write them', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    await until(() => f.project.running.has(planner.id));
    const token = f.project.running.get(planner.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    expect(await rpc.dispatch('spec.list')).toEqual([]);
    // 用户只能看队列，不能写：spec.add / spec.drop 是 planner/agent 专属
    await expect(rpc.dispatch('spec.add', { goal: 'nope', role: 'worker' })).rejects.toThrow('planner/agent only');
    await expect(rpc.dispatch('spec.drop', { id: 1, note: 'x' })).rejects.toThrow('planner/agent only');
    const first = await rpc.dispatch('spec.add', { goal: '调研 A', role: 'research', name: 'research-a', _token: token });
    const second = await rpc.dispatch('spec.add', { goal: '实现 B', role: 'worker', name: 'implement-b', deps: [{ spec: first.id, kind: 'code' }], _token: token });
    expect(first).toMatchObject({ planner_task_id: planner.id, seq: 1, status: 'pending', name: 'research-a', input_id: planner.input_id });
    expect(second.deps).toEqual([{ spec: first.id, kind: 'code' }]);
    const list = await rpc.dispatch('spec.list');
    expect(list.map(row => [row.id, row.seq, row.status])).toEqual([[first.id, 1, 'pending'], [second.id, 2, 'pending']]);
    // 队列对用户与 agent 都可读
    expect((await rpc.dispatch('spec.list', { _token: token })).map(row => row.id)).toEqual([first.id, second.id]);
    expect(f.project.inspect(planner.id).specs.map(row => row.id)).toEqual([first.id, second.id]);
    expect(f.project.status().specs).toMatchObject({ pending: 2, planned: 0, dropped: 0 });
    expect(await rpc.dispatch('spec.drop', { id: first.id, note: '不再需要', _token: token })).toMatchObject({ status: 'dropped', note: '不再需要' });
    expect(f.store.history(planner.id).some(event => event.type === 'spec.dropped')).toBe(true);
    provider.calls[0].done.resolve('done');
  } finally { await f.close(); }
});

test('one scheduler owns a batch of specs and spawns them with explicit spec links', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    // 两次写入之间专门让 pump 跑一轮：批次边界是「谁写的」，不是「哪一刻写的」
    const upstream = f.project.addSpec(planner.id, { goal: '上游', role: 'research', name: 'upstream-research' });
    await until(() => !f.project.scheduled);
    const downstream = f.project.addSpec(planner.id, { goal: '下游', role: 'research', name: 'downstream-research', deps: [{ spec: upstream.id, kind: 'order' }] });
    // planner 还在跑：这一轮拆解一条都不许被取走，也就不可能出现半成品批次
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(0);
    provider.calls[0].done.resolve('planned');
    await until(() => f.store.task(planner.id).status === 'completed');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    f.project.kick();
    // 同一项目同时最多一个未终态 scheduler：串行由结构保证
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(1);
    expect(f.store.specsForBatch(scheduler.id).map(spec => spec.id)).toEqual([upstream.id, downstream.id]);
    expect(f.store.specsForBatch(scheduler.id).map(spec => spec.batch_id)).toEqual([scheduler.id, scheduler.id]);
    const other = f.store.create({ input_id: null, role: 'scheduler', goal: 'rogue' });
    expect(() => f.project.spawn(other.id, 'x', 'research')).toThrow('--spec');
    expect(() => f.project.spawn(other.id, 'x', 'research', [], null, upstream.id)).toThrow('not in scheduler');
    // 依赖目标还没 spawn 时必须先 spawn 它
    expect(() => f.project.spawn(scheduler.id, downstream.goal, 'research', [], downstream.name, downstream.id)).toThrow('spawn the dependency');
    const first = f.project.spawn(scheduler.id, upstream.goal, 'research', [], upstream.name, upstream.id);
    expect(f.store.spec(upstream.id)).toMatchObject({ status: 'planned', task_id: first.id });
    const second = f.project.spawn(scheduler.id, downstream.goal, 'research', [], downstream.name, downstream.id);
    expect(f.project.inspect(second.id).deps).toEqual([{ id: first.id, kind: 'order', role: 'research', status: 'queued', integration: 'none', goal: '上游' }]);
    expect(f.project.inspect(scheduler.id).specs.map(spec => spec.status)).toEqual(['planned', 'planned']);
  } finally { await f.close(); }
});

test('a completed scheduler drops every spec it did not cover but keeps planned ones', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    const first = f.project.addSpec(planner.id, { goal: '一', role: 'research', name: 'first-research' });
    const second = f.project.addSpec(planner.id, { goal: '二', role: 'research', name: 'second-research' });
    const scheduler = f.store.create({ input_id: null, role: 'scheduler', goal: 'batch' });
    f.store.takeSpecs(scheduler.id, 50);
    const covered = f.project.spawn(scheduler.id, first.goal, 'research', [], first.name, first.id);
    f.store.update(covered.id, { status: 'completed' });
    f.project.finish(scheduler.id, 'completed', 'done');
    expect(f.store.spec(first.id)).toMatchObject({ status: 'planned', task_id: covered.id });
    expect(f.store.spec(second.id)).toMatchObject({ status: 'dropped', note: 'scheduler 未覆盖该 spec（completed）' });
    expect(f.store.specStats()).toMatchObject({ pending: 0, planned: 1, dropped: 1 });
  } finally { await f.close(); }
});

test('cancelling a scheduler returns its untouched specs to the queue', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    const spec = f.project.addSpec(planner.id, { goal: '工作', role: 'research', name: 'some-research' });
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    provider.calls.find(call => call.task.id === planner.id).done.resolve('planned');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    expect(f.store.spec(spec.id)).toMatchObject({ status: 'pending', batch_id: scheduler.id });
    f.project.stopping = true;   // 不让下一批马上取走，先看清释放结果
    f.project.cancel(scheduler.id);
    expect(f.store.spec(spec.id)).toMatchObject({ status: 'pending', batch_id: null, note: 'scheduler 被取消，spec 回到 pending' });
  } finally { await f.close(); }
});

test('a planner round is one batch, and a later round waits for the live scheduler', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' }); await repo(f.root);
  try {
    const first = (await f.project.submit('first')).task, second = (await f.project.submit('second')).task;
    // 同一轮里隔了几拍才写下的 spec 仍然是一批：边界是「谁写的」，不是「哪一刻写的」
    const a1 = f.project.addSpec(first.id, { goal: 'a1', role: 'research', name: 'a1-research' });
    await until(() => !f.project.scheduled);
    const a2 = f.project.addSpec(first.id, { goal: 'a2', role: 'research', name: 'a2-research' });
    await until(() => !f.project.scheduled);
    await until(() => provider.calls.some(call => call.task.id === first.id));
    provider.calls.find(call => call.task.id === first.id).done.resolve('planned');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    expect(f.store.specsForBatch(scheduler.id).map(spec => spec.id)).toEqual([a1.id, a2.id]);
    // 另一个 planner 写的条目不会混进这一批，也不会在 scheduler 活着时另开一批
    const b1 = f.project.addSpec(second.id, { goal: 'b1', role: 'research', name: 'b1-research' });
    expect(f.store.spec(b1.id)).toMatchObject({ status: 'pending', batch_id: null });
    await until(() => provider.calls.some(call => call.task.id === second.id));
    provider.calls.find(call => call.task.id === second.id).done.resolve('planned');
    await until(() => f.store.task(second.id).status === 'completed');
    await Bun.sleep(20);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(1);
    // 这一批收尾后，下一批才出生，且只含第二个 planner 的条目
    await until(() => provider.calls.some(call => call.task.id === scheduler.id));
    provider.calls.find(call => call.task.id === scheduler.id).done.resolve('done');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 2);
    const next = f.store.get('SELECT * FROM tasks WHERE role=\'scheduler\' ORDER BY id DESC LIMIT 1');
    expect(f.store.specsForBatch(next.id).map(spec => spec.id)).toEqual([b1.id]);
  } finally { await f.close(); }
});

test('a planner parked on a notice still hands its written specs to a scheduler', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    const spec = f.project.addSpec(planner.id, { goal: '其余条目', role: 'research', name: 'clear-research' });
    f.project.notice(planner.id, '这条读不懂', '两种可能理解……');
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    provider.calls.find(call => call.task.id === planner.id).done.resolve('其余的先写进队列');
    await until(() => f.store.task(planner.id).status === 'awaiting');
    // 停在 awaiting 也算这一轮结束：已写好的条目不该被别人的答复卡住
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    expect(f.store.specsForBatch(scheduler.id).map(row => row.id)).toEqual([spec.id]);
    // 用户答复后 planner 醒来补写的那一条是下一批，不会挤进这一批
    const late = f.project.addSpec(planner.id, { goal: '答复后补写', role: 'research', name: 'late-research' });
    expect(f.store.spec(late.id)).toMatchObject({ status: 'pending', batch_id: null });
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(1);
  } finally { await f.close(); }
});

test('spawning a spec whose dependency was dropped is refused', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const planner = (await f.project.submit('plan')).task;
    const dep = f.project.addSpec(planner.id, { goal: '依赖', role: 'research', name: 'dep-research' });
    const consumer = f.project.addSpec(planner.id, { goal: '消费者', role: 'research', name: 'consumer-research', deps: [{ spec: dep.id, kind: 'order' }] });
    const scheduler = f.store.create({ input_id: null, role: 'scheduler', goal: 'batch' });
    f.store.takeSpecs(scheduler.id, 50);
    f.project.dropSpec(dep.id, '不需要了', scheduler.id);
    expect(() => f.project.spawn(scheduler.id, consumer.goal, 'research', [], consumer.name, consumer.id)).toThrow('was dropped');
  } finally { await f.close(); }
});

test('spec dependencies may only point at specs from the same planner', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const first = (await f.project.submit('first')).task;
    const second = (await f.project.submit('second')).task;
    const spec = f.project.addSpec(first.id, { goal: '调研', role: 'research', name: 'research' });
    expect(() => f.project.addSpec(second.id, { goal: '接入', role: 'worker', name: 'wire', deps: [{ spec: spec.id, kind: 'order' }] })).toThrow('another planner');
    expect(() => f.project.addSpec(first.id, { goal: '未知', role: 'research', deps: [{ spec: 999 }] })).toThrow('spec 999 not found');
    expect(() => f.project.addSpec(first.id, { goal: '坏角色', role: 'scheduler' })).toThrow('spec role');
    expect(f.project.addSpec(first.id, { goal: '好', role: 'worker' })).toMatchObject({ name: null, role: 'worker' });
  } finally { await f.close(); }
});
