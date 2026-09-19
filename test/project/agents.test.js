import { test, expect } from 'bun:test';
import { fixture, until, gate } from '../helpers.js';
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

/** planner 只写 spec 队列（spawn 会拒绝 planner 父任务）；测试里用它造一个能直接派活的非 planner 任务。 */
function host(f, { role = 'coordinator', goal = 'host', input_id = null, run = false } = {}) {
  const task = f.store.create({ input_id, role, goal });
  if (!run) f.store.update(task.id, { status: 'waiting' });
  return task;
}

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
