import { test, expect } from 'bun:test';
import { fixture, until, gate } from './helpers.js';
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

/** planner 只写 spec 队列（spawn 会拒绝 planner 父任务）；测试里用它造一个能直接派活的非 planner 任务。 */
function host(f, { role = 'coordinator', goal = 'host', input_id = null, run = false } = {}) {
  const task = f.store.create({ input_id, role, goal });
  if (!run) f.store.update(task.id, { status: 'waiting' });
  return task;
}

test('raw input persists, creates a planner, and the mock queues a spec without Service', async () => {
  const f = fixture();
  try {
    const input = f.project.submit('  原话\n保留  ');
    expect(input.content).toBe('  原话\n保留  ');
    await until(() => f.store.task(input.task.id).status === 'completed');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    await until(() => f.store.get("SELECT count(*) AS n FROM task_specs WHERE status='dropped'").n === 1);
    // planner 不再有子任务：它只写队列，scheduler 是独立的根任务
    expect(f.store.children(input.task.id)).toEqual([]);
    expect(f.store.specs({ planner_task_id: input.task.id })).toHaveLength(1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    expect(scheduler.parent_id).toBeNull();
    expect(scheduler.status).toBe('completed');
    // planner / scheduler 属于意图层：不进任务树，只在意图视图里出现
    expect(f.project.tree()).toEqual([]);
    expect(f.store.task(input.task.id).layer).toBe('intent');
    expect(scheduler.layer).toBe('intent');
    expect(f.project.inputs()[0]).toMatchObject({ id: input.id, task_id: input.task.id, specs_dropped: 1, scheduler_id: scheduler.id, scheduler_status: 'completed' });
    expect(f.store.get("SELECT name FROM sqlite_master WHERE name='services'")).toBeNull();
  } finally { await f.close(); }
});

test('planners run in parallel and share the single concurrency pool', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY:'2' });
  try {
    const first = f.project.submit('first').task;
    const second = f.project.submit('second').task;
    await until(() => f.project.running.size === 2);
    expect(f.project.status().agents.map(agent => agent.role).sort()).toEqual(['planner','planner']);
    // 总并发受 LUSH_CONCURRENCY 限制，第三个 planner 只能排队
    const third = f.project.submit('third').task;
    await Bun.sleep(20);
    expect(f.project.running.has(third.id)).toBe(false);
    provider.calls.find(call => call.task.id === first.id).done.resolve('one');
    await until(() => f.project.running.has(third.id));
  } finally { await f.close(); }
});

test('multi-level fanout parks ancestors, respects limits, wakes with child results', async () => {
  const counts = new Map(); let peak = 0;
  const f = fixture({ async run({ task, api }) {
    counts.set(task.id, (counts.get(task.id) || 0) + 1);
    peak = Math.max(peak, api.running.size);
    if (task.calls === 1 && task.role === 'coordinator') for (let i=0;i<4;i++) api.spawn(task.id, `child ${i}`, 'research');
    await Bun.sleep(5); return `done ${task.id}`;
  } }, { LUSH_CONCURRENCY:'2' });
  try {
    const root = host(f, { goal: 'tree', run: true });
    f.project.kick();
    await until(() => f.store.task(root.id).status === 'completed');
    expect(f.store.tasks().length).toBe(5); expect(peak).toBeLessThanOrEqual(2);
    expect(counts.get(root.id)).toBeGreaterThan(1);
    expect(f.store.tasks().every(t => t.status === 'completed')).toBe(true);
    expect(f.store.children(root.id).length).toBe(4);
  } finally { await f.close(); }
});

test('messages arriving during an invocation are delivered exactly on the next invocation', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = f.project.submit('work').task;
    await until(() => provider.calls.length === 1);
    f.project.message(task.id, 'new requirement');
    expect(provider.calls[0].messages).toEqual([]);
    provider.calls[0].done.resolve('first');
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].messages.map(m => m.body)).toEqual(['new requirement']);
    provider.calls[1].done.resolve('second');
    await until(() => f.store.task(task.id).status === 'completed');
    expect(f.store.unread(task.id)).toEqual([]);
  } finally { await f.close(); }
});

test('one task keeps one agent identity while its credential rotates every wake', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const task = f.project.submit('identity').task;
    await until(() => provider.calls.length === 1);
    const first = f.project.running.get(task.id).token;
    expect(f.project.inspect(task.id).agent).toMatchObject({ id: 'planner#1', task_id: task.id, role: 'planner', wakes: 1, active: true });
    expect(f.store.task(task.id).agent_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.store.task(task.id).agent_token_hash).not.toBe(first);
    expect(f.project.status().agents.map(agent => agent.id)).toEqual(['planner#1']);
    expect(f.project.status()).toMatchObject({ agents_total: 1, agents_idle: 0 });

    f.project.message(task.id, 'more');
    provider.calls[0].done.resolve('first');
    await until(() => provider.calls.length === 2);
    const second = f.project.running.get(task.id).token;
    expect(second).not.toBe(first);
    expect(f.project.inspect(task.id).agent).toMatchObject({ id: 'planner#1', wakes: 2, active: true });

    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('task.list', { _token: first })).rejects.toThrow('token');
    const seen = f.store.task(task.id).agent_last_seen_at;
    await Bun.sleep(10);
    await rpc.dispatch('task.inspect', { id: task.id, _token: second });
    expect(f.store.task(task.id).agent_last_seen_at).not.toBe(seen);

    provider.calls[1].done.resolve('second');
    await until(() => f.project.running.size === 0 && f.store.task(task.id).status === 'completed');
    await expect(rpc.dispatch('task.list', { _token: second })).rejects.toThrow('token');
    expect(f.store.task(task.id).agent_token_hash).toBeNull();
    expect(f.project.inspect(task.id).agent).toMatchObject({ id: 'planner#1', wakes: 2, active: false, pid: null });
  } finally { await f.close(); }
});

test('every live task owns exactly one agent, parked ancestors included', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY:'2' });
  try {
    const parent = host(f, { goal: 'parent', run: true });
    f.project.kick();
    await until(() => provider.calls.length === 1);
    const child = f.project.spawn(parent.id, 'child', 'research');
    provider.calls[0].done.resolve('delegated');
    await until(() => provider.calls.some(call => call.task.id === child.id));
    await until(() => f.store.task(parent.id).status === 'waiting' && f.project.running.size === 1);
    expect(f.project.status()).toMatchObject({ agents_total: 2, agents_idle: 1 });
    expect(f.project.status().agents.map(agent => agent.id)).toEqual([`research#${child.id}`]);
    expect(f.project.inspect(parent.id).agent).toMatchObject({ id: `coordinator#${parent.id}`, active: false, pid: null });
    expect(f.project.inspect(child.id).agent).toMatchObject({ id: `research#${child.id}`, active: true });
  } finally { await f.close(); }
});

test('a notice parks only its task, answer wakes it, duplicate answers fail', async () => {
  const f = fixture({ async run({ task, api }) { if (task.calls === 1) api.notice(task.id, 'Which design?', 'A or B'); return 'waiting'; } });
  try {
    const task = f.project.submit('work').task;
    await until(() => f.store.task(task.id).status === 'awaiting');
    expect(f.project.running.size).toBe(0);
    const notice = f.store.get('SELECT * FROM notices');
    f.project.answer(notice.id, 'A');
    expect(() => f.project.answer(notice.id, 'B')).toThrow('not open');
    await until(() => f.store.task(task.id).status === 'completed');
    expect(f.store.task(task.id).calls).toBe(2);
  } finally { await f.close(); }
});

test('cancel cascades and terminal tasks cannot have active descendants', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const root = host(f, { goal: 'root', run: true });
    f.project.kick();
    const child = f.project.spawn(root.id, 'child', 'coordinator');
    const leaf = f.project.spawn(child.id, 'leaf', 'research');
    await until(() => f.project.running.size === 3);
    f.project.notice(leaf.id,'question');
    f.project.cancel(root.id);
    await until(() => f.project.running.size === 0);
    expect(f.store.tasks().map(t => t.status)).toEqual(['cancelled','cancelled','cancelled']);
    expect(f.store.get('SELECT status FROM notices').status).toBe('dismissed');
    expect(() => f.project.spawn(root.id,'no')).toThrow('terminal');
    expect(() => f.project.message(root.id,'no')).toThrow('ended');
    expect(() => f.project.retry(leaf.id)).toThrow('parent has ended');
  } finally { await f.close(); }
});

test('failure cancels descendants; child failure wakes parent with explicit error', async () => {
  let message;
  const f = fixture({ async run({ task, api, messages }) {
    if (task.role === 'coordinator' && task.calls === 1) { api.spawn(task.id,'fail','research'); return 'delegated'; }
    if (task.role === 'research') throw new Error('backend failed');
    message = messages[0].body; return 'reported failure';
  } });
  try {
    const root = host(f, { goal: 'root', run: true });
    f.project.kick();
    await until(() => f.store.task(root.id).status === 'completed');
    expect(message).toContain('backend failed');
    expect(f.store.children(root.id)[0].status).toBe('failed');
  } finally { await f.close(); }
});

test('retry is explicit, preserves unconsumed messages and prior audit', async () => {
  let fail = true;
  const f = fixture({ async run() { if (fail) throw new Error('bad'); return 'ok'; } });
  try {
    const root = f.project.submit('root').task; f.project.message(root.id,'keep');
    await until(() => f.store.task(root.id).status === 'failed');
    expect(f.store.unread(root.id)).toHaveLength(1);
    fail = false; f.project.retry(root.id);
    await until(() => f.store.task(root.id).status === 'completed');
    expect(f.store.unread(root.id)).toHaveLength(0);
    expect(f.store.history(root.id).some(e => e.type === 'failed')).toBe(true);
  } finally { await f.close(); }
});

test('recovery does not replay running tasks or interrupted merges', async () => {
  const f = fixture();
  try {
    f.project.stopping = true;
    const root = host(f, { goal: 'root' });
    const child = f.project.spawn(root.id,'child','research');
    f.store.update(root.id,{status:'running',integration:'merging'});
    f.store.armAgent(root.id, 'deadbeef');
    f.project.recover();
    expect(f.store.task(root.id).status).toBe('failed');
    expect(f.store.task(child.id).status).toBe('cancelled');
    expect(f.store.task(root.id).integration).toBe('review');
    expect(f.store.task(root.id).agent_token_hash).toBeNull();
  } finally { await f.close(); }
});

test('recovery repairs a committed inbox message whose wake-up was interrupted', async () => {
  const f = fixture();
  try {
    f.project.stopping = true;
    const root = f.project.submit('waiting root').task;
    f.store.update(root.id,{status:'waiting'});
    f.store.message(root.id,'child result committed before daemon died');
    f.project.recover();
    expect(f.store.task(root.id).status).toBe('queued');
    expect(f.store.unread(root.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test('agent capabilities cannot approve merges, spoof parents or message siblings', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const root = host(f, { goal: 'root', run: true });
    f.project.kick();
    const a = f.project.spawn(root.id,'a','research'), b = f.project.spawn(root.id,'b','research');
    await until(() => provider.calls.length === 3);
    const token = f.project.running.get(a.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('task.merge', {id:a.id,_token:token})).rejects.toThrow('user approval');
    await expect(rpc.dispatch('task.spawn', {parent:root.id,goal:'spoof',_token:token})).rejects.toThrow('own task');
    await expect(rpc.dispatch('task.message', {id:b.id,body:'no',_token:token})).rejects.toThrow('direct');
    await rpc.dispatch('task.message', {id:root.id,body:'yes',_token:token});
    await expect(rpc.dispatch('service.list', {})).rejects.toThrow('unknown method');
    await expect(rpc.dispatch('task.list', {_token:'other-project'})).rejects.toThrow('token');
    f.project.cancel(a.id);
    await expect(rpc.dispatch('task.list', {_token:token})).rejects.toThrow();
  } finally { await f.close(); }
});

test('intent 层：planner 与 scheduler 不进任务树/任务列表/时间轴，只在意图视图里', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' });
  try {
    const planner = f.project.submit('做两件事').task;
    const spec = f.project.addSpec(planner.id, { goal: '写点东西', role: 'worker', name: 'write-something' });
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    provider.calls.find(call => call.task.id === planner.id).done.resolve('planned');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    const worker = f.project.spawn(scheduler.id, '写点东西', 'worker', [], 'write-something', spec.id);
    // 任务树只有 work 层：worker 的父是 intent 层的 scheduler，所以它自己就是根
    expect(f.project.tree().map(task => task.id)).toEqual([worker.id]);
    expect(f.store.summaries('intent').map(task => task.id).sort((a, b) => a - b)).toEqual([planner.id, scheduler.id]);
    expect(f.store.summaries('work').map(task => task.id)).toEqual([worker.id]);
    // 按 id 仍能看具体 planner / scheduler（意图面板就是从这跳的）
    expect(f.project.tree(scheduler.id).id).toBe(scheduler.id);
    expect(f.project.inspect(planner.id).layer).toBe('intent');
    // 时间轴也只画 work 层
    expect(f.project.timeline().tasks.map(task => task.role)).not.toContain('scheduler');
    // 意图行把 planner 的闸门与 scheduler 的 id / 状态一起带出来（worker 已经被编走，所以 pending 0 / planned 1）
    expect(f.project.inputs()[0]).toMatchObject({ task_id: planner.id, plan_gate: null, specs_pending: 0, specs_planned: 1,
      scheduler_id: scheduler.id, scheduler_status: 'running', plan_notice_id: null, work_tasks: 1 });
  } finally { await f.close(); }
});

test('plan 闸门：planner 申请批准前 spec 不会被编排，批准后才交给 scheduler', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' });
  try {
    const planner = f.project.submit('大改动').task;
    const spec = f.project.addSpec(planner.id, { goal: '动架构', role: 'worker', name: 'big-change' });
    await until(() => provider.calls.some(call => call.task.id === planner.id));
    const plan = f.project.proposePlan(planner.id, '这轮要动架构', '我打算先拆核心再改调用方……');
    expect(plan).toMatchObject({ kind: 'plan', task_id: planner.id });
    expect(f.store.task(planner.id).plan_gate).toBe('proposed');
    provider.calls.find(call => call.task.id === planner.id).done.resolve('等你批准');
    await until(() => f.store.task(planner.id).status === 'awaiting');
    await Bun.sleep(20);
    // 闸门没开：一条 spec 都不会被取走，也不会建 scheduler
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n).toBe(0);
    expect(f.store.spec(spec.id)).toMatchObject({ status: 'pending', batch_id: null });
    expect(f.project.inputs()[0]).toMatchObject({ plan_gate: 'proposed', plan_notice_id: plan.id });
    // 审批工具不能用来回答普通问题；反过来普通 notice 回答也不能撞开闸门
    expect(() => f.project.answer(plan.id, '好')).toThrow('plan approve|reject');
    const approved = f.project.approvePlan(planner.id);
    expect(approved).toMatchObject({ planner: planner.id, plan_gate: 'approved', specs: [spec.id] });
    // 计划被接受 = 这一轮的结论定了：planner 本轮结束，编排交给 scheduler
    expect(f.store.task(planner.id).status).toBe('completed');
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    expect(f.store.specsForBatch(scheduler.id).map(row => row.id)).toEqual([spec.id]);
  } finally { await f.close(); }
});

test('plan 驳回：本轮 spec 作废、理由送到 planner 并唤醒它重拆', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' });
  try {
    const planner = f.project.submit('大改动').task;
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
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' });
  try {
    const planner = f.project.submit('大改动').task;
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

test('depth and invocation limits bound runaway agents', async () => {
  const f = fixture({ async run({task, api}) { api.message(task.id, 'again'); return 'loop'; } }, {LUSH_TASK_CALLS:'2', LUSH_MAX_DEPTH:'2'});
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
  const provider = controlled(), f = fixture(provider, {LUSH_CALL_TIMEOUT:'1'});
  try {
    const task = f.project.submit('timeout').task;
    await until(() => f.store.task(task.id).status === 'failed');
    expect(provider.calls[0].signal.aborted).toBe(true);
    expect(f.project.running.size).toBe(0);
  } finally { await f.close(); }
});

test('specs are written, read back through the queue read models, and users cannot write them', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const planner = f.project.submit('plan').task;
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
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' });
  try {
    const planner = f.project.submit('plan').task;
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
  const f = fixture(); f.project.stopping = true;
  try {
    const planner = f.project.submit('plan').task;
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
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' });
  try {
    const planner = f.project.submit('plan').task;
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
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' });
  try {
    const first = f.project.submit('first').task, second = f.project.submit('second').task;
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
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '2' });
  try {
    const planner = f.project.submit('plan').task;
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
  const f = fixture(); f.project.stopping = true;
  try {
    const planner = f.project.submit('plan').task;
    const dep = f.project.addSpec(planner.id, { goal: '依赖', role: 'research', name: 'dep-research' });
    const consumer = f.project.addSpec(planner.id, { goal: '消费者', role: 'research', name: 'consumer-research', deps: [{ spec: dep.id, kind: 'order' }] });
    const scheduler = f.store.create({ input_id: null, role: 'scheduler', goal: 'batch' });
    f.store.takeSpecs(scheduler.id, 50);
    f.project.dropSpec(dep.id, '不需要了', scheduler.id);
    expect(() => f.project.spawn(scheduler.id, consumer.goal, 'research', [], consumer.name, consumer.id)).toThrow('was dropped');
  } finally { await f.close(); }
});

test('spec dependencies may only point at specs from the same planner', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const first = f.project.submit('first').task;
    const second = f.project.submit('second').task;
    const spec = f.project.addSpec(first.id, { goal: '调研', role: 'research', name: 'research' });
    expect(() => f.project.addSpec(second.id, { goal: '接入', role: 'worker', name: 'wire', deps: [{ spec: spec.id, kind: 'order' }] })).toThrow('another planner');
    expect(() => f.project.addSpec(first.id, { goal: '未知', role: 'research', deps: [{ spec: 999 }] })).toThrow('spec 999 not found');
    expect(() => f.project.addSpec(first.id, { goal: '坏角色', role: 'scheduler' })).toThrow('spec role');
    expect(f.project.addSpec(first.id, { goal: '好', role: 'worker' })).toMatchObject({ name: null, role: 'worker' });
  } finally { await f.close(); }
});
