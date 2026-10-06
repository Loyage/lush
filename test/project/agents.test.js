import { test, expect } from 'bun:test';
import { fixture, repo, git, until, gate } from '../helpers.js';
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

test('one task keeps one agent identity while its credential rotates every wake', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.order('identity')).task;
    await until(() => provider.calls.length === 1);
    const first = f.project.running.get(task.id).token;
    expect(f.project.inspect(task.id).agent).toMatchObject({ id: `agent#${task.id}`, task_id: task.id, role: 'agent', wakes: 1, active: true });
    expect(f.store.task(task.id).agent_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.store.task(task.id).agent_token_hash).not.toBe(first);
    expect(f.project.status().agents.map(agent => agent.id)).toEqual([`agent#${task.id}`]);
    expect(f.project.status()).toMatchObject({ agents_total: 2, agents_idle: 1 });

    f.project.message(task.id, 'more');
    provider.calls[0].done.resolve('first');
    await until(() => provider.calls.length === 2);
    const second = f.project.running.get(task.id).token;
    expect(second).not.toBe(first);
    expect(f.project.inspect(task.id).agent).toMatchObject({ id: `agent#${task.id}`, wakes: 2, active: true });

    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('worker.list', { _token: first })).rejects.toThrow('token');
    const seen = f.store.task(task.id).agent_last_seen_at;
    await Bun.sleep(10);
    await rpc.dispatch('worker.inspect', { id: task.id, _token: second });
    expect(f.store.task(task.id).agent_last_seen_at).not.toBe(seen);

    provider.calls[1].done.resolve('second');
    // A order Task stays idle between invocations rather than completing on an ordinary return.
    await until(() => f.project.running.size === 0 && f.store.task(task.id).status === 'waiting');
    await expect(rpc.dispatch('worker.list', { _token: second })).rejects.toThrow('token');
    expect(f.store.task(task.id).agent_token_hash).toBeNull();
    expect(f.project.inspect(task.id).agent).toMatchObject({ id: `agent#${task.id}`, wakes: 2, active: false, pid: null });
  } finally { await f.close(); }
});

test('every live task owns exactly one agent, parked ancestors included', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY:'2' }); await repo(f.root);
  try {
    const parent = (await f.project.order('parent')).task;
    await until(() => provider.calls.length === 1);
    const child = await f.project.spawn(parent.id, 'child', undefined, [], 'child');
    provider.calls[0].done.resolve('delegated');
    await until(() => provider.calls.some(call => call.task.id === child.id));
    await until(() => f.store.task(parent.id).status === 'waiting' && f.project.running.size === 1);
    expect(f.project.status()).toMatchObject({ agents_total: 3, agents_idle: 2 });
    expect(f.project.status().agents.map(agent => agent.id)).toEqual([`agent#${child.id}`]);
    expect(f.project.inspect(parent.id).agent).toMatchObject({ id: `agent#${parent.id}`, active: false, pid: null });
    expect(f.project.inspect(child.id).agent).toMatchObject({ id: `agent#${child.id}`, active: true });
  } finally { await f.close(); }
});

test('a notice parks only its task, answer wakes it, duplicate answers fail', async () => {
  const f = fixture({ async run({ task, api }) { if (task.calls === 1) api.notice(task.id, 'Which design?', 'A or B'); return 'waiting'; } }); await repo(f.root);
  try {
    const task = (await f.project.order('work')).task;
    await until(() => f.store.task(task.id).status === 'awaiting');
    expect(f.project.running.size).toBe(0);
    const notice = f.store.get('SELECT * FROM notices');
    f.project.answer(notice.id, 'A');
    expect(() => f.project.answer(notice.id, 'B')).toThrow('not open');
    await until(() => f.store.task(task.id).status === 'waiting');
    expect(f.store.task(task.id).calls).toBe(2);
  } finally { await f.close(); }
});

test('message admission rejects frozen deliveries and owners without enqueueing or changing delivery', async () => {
  const f = fixture({ async run() { throw new Error('diagnosis must not invoke an Agent'); } });
  f.project.stopping = true;
  try {
    await repo(f.root);
    const { task: parent } = await f.project.order('message admission');
    f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'message target', undefined, [], 'message-target');
    f.store.update(child.id, { status: 'waiting' });
    for (const status of ['requested', 'executing', 'blocked']) {
      const reservation = JSON.stringify({ version: 2, kind: 'merge', status, parent_id: parent.id });
      f.store.update(child.id, { reservation });
      const inbox = f.store.unread(child.id), history = f.store.history(child.id);
      for (const sender of [null, parent.id]) {
        expect(() => f.project.message(child.id, 'must remain unsent', sender)).toThrow('Worker is frozen for merge');
        expect(f.store.unread(child.id)).toEqual(inbox);
        expect(f.store.history(child.id)).toEqual(history);
        expect(f.store.task(child.id).reservation).toBe(reservation);
      }
    }
    f.store.update(child.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'pending' }) });
    const before = f.store.unread(child.id).length;
    f.project.message(child.id, 'pending is not frozen', parent.id);
    expect(f.store.unread(child.id)).toHaveLength(before + 1);
    expect(f.store.unread(child.id).at(-1)).toMatchObject({ body: 'pending is not frozen', sender_id: parent.id });
    await git(f.root, 'branch', 'message-owner');
    const boundOwner = await f.project.bindBranch('message-owner', await git(f.root, 'rev-parse', 'message-owner'));
    const { task: ownedOrder } = await f.project.order('bound owner child', 'message-owner');
    for (const [owner, directChild] of [[f.store.task(parent.parent_id), parent], [boundOwner, ownedOrder]]) {
      const inbox = f.store.unread(owner.id);
      expect(directChild.parent_id).toBe(owner.id);
      for (const sender of [null, directChild.id]) {
        expect(() => f.project.message(owner.id, 'ordinary completion report', sender)).toThrow('branch owner Worker is not an unrestricted Agent inbox');
        expect(f.store.unread(owner.id)).toEqual(inbox);
      }
    }
  } finally { await f.close(); }
});

test('agent capabilities cannot approve merges, spoof parents or message siblings', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const root = (await f.project.order('root')).task;
    await until(() => provider.calls.length === 1);
    const a = await f.project.spawn(root.id,'alpha work', undefined, [], 'alpha');
    const b = await f.project.spawn(root.id,'beta work', undefined, [], 'beta');
    await until(() => provider.calls.length === 3);
    const token = f.project.running.get(a.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('worker.approve_merge', {id:a.id,commit:'deadbeef',baseline:'deadbeef',_token:token})).rejects.toThrow('user approval');
    await expect(rpc.dispatch('worker.spawn', {parent:root.id,goal:'spoof',_token:token})).rejects.toThrow('own worker');
    await expect(rpc.dispatch('worker.message', {id:b.id,body:'no',_token:token})).rejects.toThrow('direct');
    await rpc.dispatch('worker.message', {id:root.id,body:'yes',_token:token});
    await expect(rpc.dispatch('service.list', {})).rejects.toThrow('unknown method');
    await expect(rpc.dispatch('worker.list', {_token:'other-project'})).rejects.toThrow('token');
    f.project.cancel(a.id);
    await expect(rpc.dispatch('worker.list', {_token:token})).rejects.toThrow();
  } finally { await f.close(); }
});
