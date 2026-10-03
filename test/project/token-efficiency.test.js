import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, gate, repo, until, temp, env } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { PiProvider } from '../../src/agent/provider.js';
import { Config } from '../../src/config.js';

test('idle pump and leaf inspect do not load unrelated historical dependencies or task summaries', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'research', goal: 'parent' });
    const child = f.store.create({ role: 'research', parent_id: parent.id, goal: 'x'.repeat(300) });
    f.store.transaction(() => {
      let previous = parent.id;
      for (let i = 0; i < 1500; i++) {
        const task = f.store.create({ role: 'research', goal: 'history' });
        f.store.addDep(task.id, previous, 'order');
        f.store.update(task.id, { status: 'completed' });
        previous = task.id;
      }
      f.store.update(parent.id, { status: 'completed' });
      f.store.update(child.id, { status: 'completed' });
    });
    const expectedChild = f.project.decorate([f.store.summaries().find(row => row.id === child.id)])[0];
    const all = f.store.all.bind(f.store), depMap = f.store.depMap.bind(f.store);
    const dependencyWindows = [];
    f.store.depMap = ids => { dependencyWindows.push(ids); return depMap(ids); };
    f.store.summaries = () => { throw new Error('unbounded task summaries'); };
    let childRows = 0, edgeRows = 0;
    f.store.all = (sql, ...args) => {
      const rows = all(sql, ...args);
      if (sql.includes('FROM tasks WHERE parent_id=? ORDER BY id')) childRows += rows.length;
      if (sql.includes('FROM task_deps d JOIN tasks')) edgeRows += rows.length;
      return rows;
    };
    f.project.stopping = false;
    f.project.pump();
    f.project.stopping = true;
    expect(dependencyWindows).toEqual([[]]);
    expect(edgeRows).toBe(0);
    expect(f.project.inspect(child.id).children).toEqual([]);
    const children = f.project.inspect(parent.id).children;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject(expectedChild);
    expect(childRows).toBe(1);
  } finally { await f.close(); }
});

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    return done.promise;
  } };
}

test('context contains only causal neighbours and bounded summaries, not project history', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent', input_id: null });
    const task = f.store.create({ role: 'worker', goal: 'work', parent_id: parent.id, input_id: null });
    const upstream = f.store.create({ role: 'worker', goal: 'upstream', input_id: null });
    const foreign = f.store.create({ role: 'worker', goal: 'unrelated-secret', input_id: null });
    f.store.addDep(task.id, upstream.id, 'code');
    f.store.update(upstream.id, { result: 'x'.repeat(5000) });
    for (let i = 0; i < 52; i++) f.store.create({ role: 'research', goal: 'child', parent_id: task.id, input_id: null });
    const context = await f.project.invocationContext(task, { recordId: 7 });
    expect(context.parent.id).toBe(parent.id);
    expect(context.dependencies[0]).toMatchObject({ id: upstream.id, kind: 'code', truncated: true });
    expect(context.dependencies[0].result).toHaveLength(1500);
    expect(context.children).toHaveLength(50); expect(context.children_truncated).toBe(true);
    expect(context.recent_tasks).toBeUndefined(); expect(JSON.stringify(context)).not.toContain(foreign.goal);
    expect(context.invocation).toEqual({ task_id: task.id, run_id: 7, role: 'worker' });
  } finally { await f.close(); }
});

test('input.submit is retired and rejects the whole method as unknown', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('input.submit', { content: 'change exactly one thing', direct: true })).rejects.toThrow('unknown method');
    expect(f.project.inputs()).toHaveLength(0);
  } finally { await f.close(); }
});

test('cancellation while resolving startup context cannot launch a provider with an aborted signal', async () => {
  const provider = controlled(), f = fixture(provider), ready = gate(); let entered = false;
  f.project.invocationContext = async () => { entered = true; await ready.promise; return {}; };
  try {
    await repo(f.root);
    const task = (await f.project.say('cancel during context')).task;
    await until(() => entered);
    f.project.cancel(task.id); ready.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(provider.calls).toHaveLength(0); expect(f.store.task(task.id).status).toBe('cancelled');
  } finally { ready.resolve(); await f.close(); }
});

test('unreadPage bounds by count and bytes, prioritises user messages and never splits an oversize record', async () => {
  const f = fixture();
  try {
    const host = f.store.create({ role: 'worker', goal: 'inbox host' });
    const peer = f.store.create({ role: 'worker', goal: 'runtime peer' });
    const body = (label, size) => `${label} ${'x'.repeat(size)}`;
    for (let i = 0; i < 40; i++) f.store.message(host.id, body(`runtime-${i}`, 68), peer.id);
    const userIds = [];
    for (let i = 0; i < 5; i++) userIds.push(f.store.message(host.id, body(`user-${i}`, 68)));
    for (let i = 0; i < 20; i++) f.store.message(host.id, body(`runtime-late-${i}`, 68), peer.id);

    const page = f.store.unreadPage(host.id);
    expect(page.messages).toHaveLength(50);
    // User messages arrive first even though older runtime signals come first by id.
    expect(page.messages.slice(0, 5).map(row => row.id)).toEqual(userIds);
    expect(page.reordered).toBe(true);
    expect(page.has_more).toBe(true);
    expect(page.pending).toBe(15);
    expect(page.oversize).toBe(0);
    expect(page.bytes).toBe(page.messages.reduce((sum, row) => sum + Buffer.byteLength(row.body), 0));
    expect(page.truncated_bytes).toBeGreaterThan(0);
    // Reading never consumes: originals stay for the next batch.
    expect(f.store.unread(host.id)).toHaveLength(65);

    // Byte budget defers small following records, but the first record is always delivered.
    const tiny = f.store.unreadPage(host.id, { bytes: 1 });
    expect(tiny.messages.map(row => row.id)).toEqual(userIds);
    expect(tiny.oversize).toBe(5);
    expect(tiny.messages.every(row => row.oversize === true)).toBe(true);

    // A lone oversize runtime message is delivered whole, never truncated or summarized.
    const lone = f.store.create({ role: 'worker', goal: 'lone inbox' });
    f.store.message(lone.id, 'y'.repeat(5000), peer.id);
    const one = f.store.unreadPage(lone.id, { bytes: 1024 });
    expect(one.messages).toHaveLength(1);
    expect(one.messages[0].body).toHaveLength(5000);
    expect(one.messages[0].oversize).toBe(true);
    expect(one.has_more).toBe(false);
    expect(one.pending).toBe(0);
    expect(one.truncated_bytes).toBe(0);

    expect(() => f.store.unreadPage(host.id, { limit: 0 })).toThrow();
    expect(() => f.store.unreadPage(host.id, { bytes: 0 })).toThrow();
  } finally { await f.close(); }
});

test('invoke delivers one bounded batch, writes messages_page, consumes only delivered ids and re-queues for the rest', async () => {
  const seen = [];
  const provider = { resolve: () => ({ agent: 'mock', model: '', thinking: '', default_prompt: '', append_prompt: '' }),
    async run(ctx) { seen.push(ctx); return 'ok'; } };
  const f = fixture(provider); await repo(f.root); f.project.stopping = true;
  try {
    const say = (await f.project.say('batched inbox')).task;
    f.store.update(say.id, { status: 'waiting' });
    const body = label => `${label} ${'z'.repeat(400)}`;
    const runtime = [], users = [];
    for (let i = 0; i < 40; i++) runtime.push(f.store.message(say.id, body(`early-${i}`), say.id));
    for (let i = 0; i < 5; i++) users.push(f.store.message(say.id, body(`user-${i}`)));
    for (let i = 0; i < 20; i++) runtime.push(f.store.message(say.id, body(`late-${i}`), say.id));
    const originals = new Map(f.store.unread(say.id).map(row => [row.id, row.body]));

    await f.project.invoke(say.id, { controller: new AbortController(), token: 'test', recordId: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].messages).toHaveLength(50);
    expect(seen[0].messages.slice(0, 5).map(row => row.id)).toEqual(users);
    expect(seen[0].messagesPage).toEqual({ delivered: 50, has_more: true, pending: 15, truncated_bytes: expect.any(Number), reordered: true });
    const started = JSON.parse(f.store.get("SELECT data FROM events WHERE task_id=? AND type='invocation.started' ORDER BY id DESC LIMIT 1", say.id).data);
    expect(started.message_ids).toEqual(seen[0].messages.map(row => row.id));
    // Only the delivered batch is consumed; the remaining 15 stay complete and actionable.
    expect(f.store.unread(say.id)).toHaveLength(15);
    expect(f.store.task(say.id).status).toBe('queued');

    await f.project.invoke(say.id, { controller: new AbortController(), token: 'test', recordId: null });
    expect(seen).toHaveLength(2);
    expect(seen[1].messages).toHaveLength(15);
    expect(seen[1].messagesPage).toMatchObject({ delivered: 15, has_more: false, pending: 0, reordered: false });
    expect(f.store.unread(say.id)).toHaveLength(0);
    // Every original body was delivered exactly once and byte-for-byte intact (no summary).
    for (const [id, text] of originals) expect(seen.flatMap(ctx => ctx.messages).find(row => row.id === id).body).toBe(text);
    expect(seen.flatMap(ctx => ctx.messages)).toHaveLength(65);
  } finally { await f.close(); }
});

test('a failed invocation leaves the delivered batch unconsumed for an explicit retry', async () => {
  let calls = 0;
  const provider = { resolve: () => ({ agent: 'mock', model: '', thinking: '', default_prompt: '', append_prompt: '' }),
    async run(ctx) { calls += 1; if (calls === 1) throw new Error('controlled provider failure'); return 'ok'; } };
  const f = fixture(provider); await repo(f.root); f.project.stopping = true;
  try {
    const say = (await f.project.say('retry inbox')).task;
    f.store.update(say.id, { status: 'waiting' });
    f.store.message(say.id, 'first input');
    await f.project.invoke(say.id, { controller: new AbortController(), token: 'test', recordId: null });
    expect(f.store.task(say.id).status).toBe('failed');
    expect(f.store.unread(say.id)).toHaveLength(1);
    f.store.update(say.id, { status: 'queued' });
    await f.project.invoke(say.id, { controller: new AbortController(), token: 'test', recordId: null });
    expect(f.store.unread(say.id)).toHaveLength(0);
    expect(f.store.task(say.id).status).not.toBe('failed');
  } finally { await f.close(); }
});

test('a parked questionnaire consumes only the delivered batch and the remainder survives the answer', async () => {
  const seen = [];
  const provider = { resolve: () => ({ agent: 'mock', model: '', thinking: '', default_prompt: '', append_prompt: '' }),
    async run(ctx) {
      seen.push(ctx);
      if (seen.length === 1) ctx.api.notice(ctx.task.id, '分批决策', '请选择', 'question',
        [{ header: '范围', question: '如何处理剩余消息？',
          options: [{ label: '继续', description: '继续处理' }, { label: '停止', description: '稍后处理' }] }]);
      return 'ok';
    } };
  const f = fixture(provider); await repo(f.root); f.project.stopping = true;
  try {
    const say = (await f.project.say('parked inbox')).task;
    f.store.update(say.id, { status: 'queued' });
    const body = (label, pad) => `${label} ${'q'.repeat(pad)}`;
    for (let i = 0; i < 55; i++) f.store.message(say.id, body(`signal-${i}`, 300), say.id);
    f.store.message(say.id, body('user-last', 300));
    const originals = new Map(f.store.unread(say.id).map(row => [row.id, row.body]));
    f.project.stopping = false; f.project.pump();
    await until(() => seen.length === 1 && !f.project.running.has(say.id));
    f.project.stopping = true;
    // The park consumed exactly the delivered batch; the undelivered originals are untouched.
    expect(seen[0].messages).toHaveLength(50);
    expect(seen[0].messages[0].body).toBe(body('user-last', 300));
    expect(seen[0].messagesPage).toMatchObject({ has_more: true, pending: 6, reordered: true });
    const notice = f.store.get("SELECT * FROM notices WHERE task_id=? AND status='open'", say.id);
    expect(notice.kind).toBe('questionnaire');
    expect(f.store.unread(say.id)).toHaveLength(6);

    // Answering re-queues the Worker; the remaining originals are delivered intact and consumed.
    f.project.stopping = false;
    f.project.answer(notice.id, { answers: [{ selected: [0], custom: '' }] });
    await until(() => seen.length === 2 && !f.project.running.has(say.id) && f.store.unread(say.id).length === 0);
    // The remaining six signals plus the runtime receipt for this answer.
    expect(seen[1].messages).toHaveLength(7);
    expect(seen[1].messages.some(row => row.body.includes('notice_id'))).toBe(true);
    expect(seen[1].messagesPage).toMatchObject({ has_more: false, pending: 0 });
    for (const [messageId, text] of originals) {
      const delivered = seen.flatMap(ctx => ctx.messages).find(row => row.id === messageId);
      if (delivered) expect(delivered.body).toBe(text);
    }
  } finally { f.project.stopping = true; await f.close(); }
});

test('the startup prompt carries a bounded batch and explicit messages_page, never the whole inbox', async () => {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, '#!/usr/bin/env bun\nconsole.log("ok");\n', { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_PI_COMMAND: fake }) }); config.prepare();
  try {
    const page = { delivered: 2, has_more: true, pending: 3, truncated_bytes: 4096, reordered: true };
    await new PiProvider(config).run({ task: { id: 9, role: 'worker', goal: 'bounded' },
      context: { invocation: { run_id: 1 } }, messages: [{ id: 1, body: 'a' }, { id: 2, body: 'b' }], messagesPage: page,
      cwd: root, token: 'secret', signal: new AbortController().signal, onSpawn() {},
      agent: { agent: 'pi', model: '', thinking: '', soft_budget: undefined } });
    const body = JSON.parse(fs.readFileSync(path.join(config.home, 'sessions/task-9-input.md'), 'utf8'));
    expect(body.messages_page).toEqual(page);
    expect(body.messages.map(row => row.id)).toEqual([1, 2]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a route materialization failure rolls back input, specs and tasks', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  f.project.materializeSpec = () => { throw new Error('controlled compile failure'); };
  try {
    await expect(f.project.submit('开发 cannot materialize')).rejects.toThrow('controlled compile failure');
    expect(f.project.inputs()).toHaveLength(0); expect(f.store.tasks()).toHaveLength(0);
    expect(f.store.all('SELECT * FROM task_specs')).toHaveLength(0);
  } finally { await f.close(); }
});
