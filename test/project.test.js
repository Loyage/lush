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
    expect(f.project.tree().map(task => task.role).sort()).toEqual(['planner','scheduler']);
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
    // 两条 spec 必须在同一个 tick 写完，pump 才会把它们编进同一批
    const upstream = f.project.addSpec(planner.id, { goal: '上游', role: 'research', name: 'upstream-research' });
    const downstream = f.project.addSpec(planner.id, { goal: '下游', role: 'research', name: 'downstream-research', deps: [{ spec: upstream.id, kind: 'order' }] });
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
    await until(() => f.store.get("SELECT count(*) AS n FROM tasks WHERE role='scheduler'").n === 1);
    const scheduler = f.store.get("SELECT * FROM tasks WHERE role='scheduler'");
    expect(f.store.spec(spec.id)).toMatchObject({ status: 'pending', batch_id: scheduler.id });
    f.project.stopping = true;   // 不让下一批马上取走，先看清释放结果
    f.project.cancel(scheduler.id);
    expect(f.store.spec(spec.id)).toMatchObject({ status: 'pending', batch_id: null, note: 'scheduler 被取消，spec 回到 pending' });
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
