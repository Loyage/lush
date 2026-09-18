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

test('raw input persists, creates a planner, and mock delegates without Service', async () => {
  const f = fixture();
  try {
    const input = f.project.submit('  原话\n保留  ');
    expect(input.content).toBe('  原话\n保留  ');
    await until(() => f.store.task(input.task.id).status === 'completed');
    expect(f.store.children(input.task.id)[0].role).toBe('research');
    expect(f.project.tree()[0].children.length).toBe(1);
    expect(f.store.get("SELECT name FROM sqlite_master WHERE name='services'")).toBeNull();
  } finally { await f.close(); }
});

test('saturated worker pool cannot prevent planning the next input', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY:'1' });
  try {
    const first = f.project.submit('first').task;
    await until(() => provider.calls.length === 1);
    const worker = f.project.spawn(first.id, 'long research', 'research');
    provider.calls[0].done.resolve('delegated');
    await until(() => f.store.task(first.id).status === 'waiting' && f.store.task(worker.id).status === 'running');
    const second = f.project.submit('second').task;
    await until(() => provider.calls.some(call => call.task.id === second.id));
    expect(f.store.task(worker.id).status).toBe('running');
    expect(f.project.running.size).toBe(2);
  } finally { await f.close(); }
});

test('multi-level fanout parks ancestors, respects limits, wakes with child results', async () => {
  const counts = new Map(); let peak = 0;
  const f = fixture({ async run({ task, api }) {
    counts.set(task.id, (counts.get(task.id) || 0) + 1);
    peak = Math.max(peak, [...api.running.values()].filter(r => r.role !== 'planner').length);
    if (task.calls === 1 && task.role === 'planner') api.spawn(task.id, 'coordinate', 'coordinator');
    if (task.calls === 1 && task.role === 'coordinator') for (let i=0;i<4;i++) api.spawn(task.id, `child ${i}`, 'research');
    await Bun.sleep(5); return `done ${task.id}`;
  } }, { LUSH_CONCURRENCY:'2' });
  try {
    const task = f.project.submit('tree').task;
    await until(() => f.store.task(task.id).status === 'completed');
    expect(f.store.tasks().length).toBe(6); expect(peak).toBeLessThanOrEqual(2);
    expect(counts.get(task.id)).toBeGreaterThan(1);
    expect(f.store.tasks().every(t => t.status === 'completed')).toBe(true);
    expect(f.project.tree()[0].children[0].children.length).toBe(4);
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
    const root = f.project.submit('root').task;
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
    if (task.role === 'planner' && task.calls === 1) { api.spawn(task.id,'fail','research'); return 'delegated'; }
    if (task.role === 'research') throw new Error('backend failed');
    message = messages[0].body; return 'reported failure';
  } });
  try {
    const root = f.project.submit('root').task;
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
    const root = f.project.submit('root').task;
    const child = f.project.spawn(root.id,'child','research');
    f.store.update(root.id,{status:'running',integration:'merging'});
    f.project.recover();
    expect(f.store.task(root.id).status).toBe('failed');
    expect(f.store.task(child.id).status).toBe('cancelled');
    expect(f.store.task(root.id).integration).toBe('review');
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
    const root = f.project.submit('root').task;
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
    const root = f.project.submit('root').task;
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
