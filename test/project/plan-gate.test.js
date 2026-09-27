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

test('plan 闸门：批准前不编译，批准后 runtime 直接生成 Work DAG', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('大改动')).task;
    const spec = f.project.addSpec(planner.id, { goal: '动架构', role: 'worker', name: 'big-change' });
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    const plan = f.project.proposePlan(planner.id, '这轮要动架构', '我打算先拆核心再改调用方……');
    expect(plan).toMatchObject({ kind: 'plan', task_id: planner.id });
    expect(f.store.task(planner.id).plan_gate).toBe('proposed');
    provider.calls.find(call => call.task.id === planner.id).done.resolve('等你批准');
    await until(() => f.store.task(planner.id).status === 'awaiting');
    await Bun.sleep(20);
    // 闸门没开：一条 spec 都不会被编译。
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(0);
    expect(f.store.spec(spec.id)).toMatchObject({ status: 'pending', batch_id: null });
    expect(f.project.inputs()[0]).toMatchObject({ plan_gate: 'proposed', plan_notice_id: plan.id });
    // 审批工具不能用来回答普通问题；反过来普通 notice 回答也不能撞开闸门
    expect(() => f.project.answer(plan.id, '好')).toThrow('plan approve|reject');
    const approved = f.project.approvePlan(planner.id);
    expect(approved).toMatchObject({ planner: planner.id, plan_gate: 'approved', specs: [spec.id] });
    // 计划被接受 = planner 结束；deterministic compiler 直接建立 root work item。
    expect(f.store.task(planner.id).status).toBe('completed');
    await until(() => f.store.spec(spec.id).status === 'planned');
    const work = f.store.task(f.store.spec(spec.id).task_id);
    expect(work).toMatchObject({ role: 'worker', parent_id: null, input_id: planner.input_id });
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(0);
  } finally { await f.close(); }
});

test('plan 驳回：本轮 spec 作废、理由送到 planner 并唤醒它重拆', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('大改动')).task;
    const spec = f.project.addSpec(planner.id, { goal: '动架构', role: 'worker', name: 'big-change' });
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    const plan = f.project.proposePlan(planner.id, '这轮要动架构');
    provider.calls.find(call => call.task.id === planner.id).done.resolve('等你批准');
    await until(() => f.store.task(planner.id).status === 'awaiting');
    const rejected = f.project.rejectPlan(planner.id, '别动架构，先加个开关');
    expect(rejected).toMatchObject({ planner: planner.id, plan_gate: 'rejected', dropped_specs: [spec.id] });
    expect(f.store.spec(spec.id)).toMatchObject({ status: 'dropped', note: '计划被驳回：别动架构，先加个开关' });
    expect(f.store.get("SELECT * FROM notices WHERE id=?", plan.id)).toMatchObject({ status: 'dismissed', answer: '别动架构，先加个开关' });
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(0);
    // 理由进了收件箱，planner 被唤醒；新一轮开头把闸门清掉，它自己决定要不要再请你批准
    expect(f.store.unread(planner.id).map(message => message.body).join('\n')).toContain('别动架构，先加个开关');
    await until(() => f.store.task(planner.id).plan_gate === null && f.store.task(planner.id).status === 'running');
  } finally { await f.close(); }
});

test('计划审查权限：agent 只能提，批准/驳回是用户专属', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('大改动')).task;
    f.project.addSpec(planner.id, { goal: '动架构', role: 'worker', name: 'big-change' });
    await until(() => f.store.task(planner.id).status === 'running');
    const token = f.project.running.get(planner.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('plan.approve', { id: planner.id, _token: token })).rejects.toThrow('user approval');
    await expect(rpc.dispatch('plan.reject', { id: planner.id, reason: '不', _token: token })).rejects.toThrow('user approval');
    await expect(rpc.dispatch('plan.propose', { title: '没 token' })).rejects.toThrow('agent only');
    const plan = await rpc.dispatch('plan.propose', { title: '这轮要动架构', _token: token });
    expect(plan.kind).toBe('plan');
    await expect(rpc.dispatch('notice.answer', { id: plan.id, answer: '好' })).rejects.toThrow('plan approve|reject');
  } finally { await f.close(); }
});
