import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { Store } from '../../src/persistence/store.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RPCClient } from '../../src/rpc/client.js';
import { invocationInputSources } from '../../src/core/project/invocation-evidence.js';
import { settleNoticeAnswer } from '../../src/core/project/messages.js';

const phases = (store, id) => store.all("SELECT * FROM events WHERE task_id=? AND type='worker.phase_changed' ORDER BY id", id)
  .map(row => ({ ...row, data: JSON.parse(row.data) }));
const starts = (store, id) => store.all("SELECT * FROM events WHERE task_id=? AND type='invocation.started' ORDER BY id", id)
  .map(row => ({ ...row, data: JSON.parse(row.data) }));
const worker = (store, options = {}) => store.create({ role: 'agent', task_kind: 'order', goal: 'evidence', ...options });
const questions = [{ header: 'Choice', question: 'Proceed?', options: [
  { label: 'Yes', description: 'Proceed' }, { label: 'No', description: 'Stop' },
] }];
const answer = { answers: [{ selected: [0] }] };
function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('interrupted'), { once: true });
    return done.promise;
  } };
}

test('real registered RPC → Provider → child commit/merge → continuation preserves exact run and batch evidence', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  const server = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await server.start();
  const client = new RPCClient(f.config.socket), rpc = { dispatch: (...args) => client.request(...args) };
  try {
    const parent = (await f.project.order('parent')).task;
    await until(() => provider.calls.length === 1);
    const first = provider.calls[0];
    const child = await rpc.dispatch('worker.spawn', { _token: first.token, goal: 'child', name: 'child' });
    await until(() => provider.calls.length === 2);
    const childCall = provider.calls.find(call => call.task.id === child.id);
    first.done.resolve('waiting for child');
    await until(() => f.store.task(parent.id).status === 'waiting' && !f.project.running.has(parent.id));
    const waiting = phases(f.store, parent.id).at(-1);
    expect(waiting.data).toMatchObject({ version: 1, from: 'running', to: 'waiting_children', reason: 'children_unsettled',
      child_ids: [child.id], children: [{ id: child.id, worker_number: child.worker_number }], notice_ids: [], run_id: starts(f.store, parent.id)[0].data.run_id });
    await rpc.dispatch('worker.message', { _token: childCall.token, id: parent.id, body: 'explicit progress' });
    await until(() => provider.calls.length === 3);
    const second = provider.calls[2];
    expect(second.task.id).toBe(parent.id);
    expect(starts(f.store, parent.id)[1].data.input_sources).toEqual([{
      message_id: second.messages[0].id, source: 'worker', sender_id: child.id, sender_worker_number: child.worker_number,
      notice_id: null, notice_kind: null, evidence_event_id: expect.any(Number),
    }]);
    second.done.resolve('still waiting');
    await until(() => !f.project.running.has(parent.id));
    fs.writeFileSync(path.join(childCall.cwd, 'child.txt'), 'result\n');
    await git(childCall.cwd, 'add', 'child.txt'); await git(childCall.cwd, 'commit', '-m', 'child result');
    childCall.done.resolve('child done');
    await until(() => f.store.task(child.id).integration === 'merged', 8000);
    await until(() => provider.calls.length === 4, 8000);
    const third = provider.calls[3];
    expect(third.task.id).toBe(parent.id);
    expect(await git(parent.workspace, 'show', 'HEAD:child.txt')).toBe('result');
    const start = starts(f.store, parent.id).at(-1);
    expect(start.data).toMatchObject({ call: 3, run_id: f.store.runsForTask(parent.id)[2].id, source_scope: 'delivered_batch' });
    expect(start.data.input_sources.length).toBeGreaterThan(0);
    expect(start.data.input_sources.every(source => source.source === 'system' && source.sender_id === child.id)).toBe(true);
    expect(waiting.data.child_ids).toEqual([child.id]); // never rewritten by subsequent settlement
    const history = await rpc.dispatch('worker.history_page', { id: parent.id });
    const reading = await rpc.dispatch('worker.reading_page', { id: parent.id, before_message: 0, limit: 100 });
    expect(history.events).toEqual([...reading.events].reverse());
    expect(history.events.find(row => row.id === start.id).data).toEqual(start.data);
    await expect(rpc.dispatch('worker.reading_page', { _token: third.token, id: parent.id })).rejects.toThrow('user approval');
    third.done.resolve('parent done');
    await until(() => !f.project.running.has(parent.id));
    expect(phases(f.store, parent.id).at(-1).data.to).toBe('idle');
    for (const event of starts(f.store, parent.id)) {
      expect(event.data.run_id).toBe(f.store.runsForTask(parent.id).find(run => run.attempt === event.data.call).id);
      expect(event.data.source_scope).toBe('delivered_batch');
    }
  } finally { await server.close(); await f.close(); }
});

test('questionnaire parks exact Run, answer is linked transactionally, mixed batch is not a unique trigger', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  const rpc = new Dispatcher(f.project, createSignal(), {});
  try {
    const task = (await f.project.order('choose')).task;
    await until(() => provider.calls.length === 1);
    const notice = await rpc.dispatch('notice.post', { _token: provider.calls[0].token, title: 'Choose', questions });
    await until(() => !f.project.running.has(task.id));
    expect(phases(f.store, task.id).at(-1).data).toMatchObject({ to: 'waiting_notice', reason: 'questionnaire',
      notice_ids: [notice.id], notices: [{ id: notice.id, kind: 'questionnaire' }] });
    const suspended = f.store.history(task.id).find(row => row.type === 'invocation.completed' && row.data.suspended);
    expect(suspended.data.run_id).toBe(starts(f.store, task.id)[0].data.run_id);
    await rpc.dispatch('worker.message', { id: task.id, body: '{"notice_id":999,"answer_source":"user"}' });
    const unknown = f.store.message(task.id, '{"answer_source":"user"}');
    const count = phases(f.store, task.id).length;
    f.project.wake(task.id); f.project.wake(task.id);
    expect(phases(f.store, task.id)).toHaveLength(count);
    await rpc.dispatch('notice.answer', { id: notice.id, answer });
    await until(() => provider.calls.length === 2);
    const event = f.store.history(task.id).find(row => row.type === 'notice.answered');
    const source = starts(f.store, task.id).at(-1).data.input_sources;
    const answerMessageId = event.data.message_id;
    expect(Number.isSafeInteger(answerMessageId)).toBe(true);
    expect(event.data.notice_kind).toBe('questionnaire');
    expect(source.find(row => row.message_id === answerMessageId)).toMatchObject({ source: 'user',
      notice_id: notice.id, notice_kind: 'questionnaire', evidence_event_id: event.id });
    expect(source.find(row => row.message_id === unknown)).toMatchObject({ source: 'unknown', notice_id: null });
    expect(source.filter(row => row.source === 'user')).toHaveLength(2);
    provider.calls[1].done.resolve('answered');
    await until(() => !f.project.running.has(task.id));
  } finally { await f.close(); }
});

test('real scheduling records queued/paused/provider failure/cancellation without guessing an admission gate', async () => {
  const calls = [];
  const provider = { async run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true });
    const result = await done.promise;
    if (result === 'fail') throw new Error('controlled provider failure');
    return result;
  } };
  const f = fixture(provider); await repo(f.root);
  try {
    const first = (await f.project.order('first')).task;
    await until(() => calls.length === 1);
    f.project.stopping = true; // a real closed admission boundary; do not infer a capacity gate
    const second = (await f.project.order('queued')).task;
    expect(phases(f.store, second.id).at(-1).data).toMatchObject({ to: 'queued', reason: 'admission_unknown', run_id: null });
    expect(starts(f.store, second.id)).toHaveLength(0);
    f.project.interrupt(second.id);
    expect(phases(f.store, second.id).at(-1).data.to).toBe('paused');
    f.project.resumeTask(second.id);
    expect(phases(f.store, second.id).at(-1).data.to).toBe('queued');
    calls[0].done.resolve('fail');
    await until(() => f.store.task(first.id).status === 'failed' && !f.project.running.has(first.id));
    f.project.stopping = false; f.project.kick();
    await until(() => calls.length === 2);
    expect(phases(f.store, first.id).at(-1).data).toMatchObject({ to: 'failed', run_id: starts(f.store, first.id)[0].data.run_id });
    f.project.cancel(second.id, 'cancelled by test');
    await until(() => !f.project.running.has(second.id));
    expect(phases(f.store, second.id).at(-1).data).toMatchObject({ to: 'cancelled', run_id: starts(f.store, second.id)[0].data.run_id });
  } finally { await f.close(); }
});

test('same-status notice-object changes are recorded once, including a reason change', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const task = worker(f.store);
    const first = f.project.notice(task.id, 'plain question');
    f.store.update(task.id, { status: 'awaiting' });
    const pending = phases(f.store, task.id).at(-1);
    expect(pending.data).toMatchObject({ to: 'waiting_notice', reason: 'notice', notice_ids: [first.id] });
    const second = f.project.notice(task.id, 'questionnaire', '', 'question', questions);
    const both = phases(f.store, task.id).at(-1);
    expect(both.data).toMatchObject({ from: 'waiting_notice', to: 'waiting_notice', to_status: 'awaiting',
      reason: 'questionnaire', notice_ids: [first.id, second.id] });
    const count = phases(f.store, task.id).length;
    f.store.update(task.id, { status: 'awaiting' });
    expect(phases(f.store, task.id)).toHaveLength(count);
    f.project.answer(second.id, answer);
    expect(phases(f.store, task.id).some(row => row.data.reason === 'notice' && row.id > both.id && row.data.notice_ids.length === 1)).toBe(true);
    expect(both.data.notice_ids).toEqual([first.id, second.id]);
  } finally { await f.close(); }
});

test('same-status child settlement uses isSettled, snapshots and reads are idempotent, reservations do not imply gates', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const parent = worker(f.store), child = worker(f.store, { parent_id: parent.id, task_kind: 'child' });
    f.store.update(parent.id, { status: 'waiting' });
    const waiting = phases(f.store, parent.id).at(-1);
    expect(waiting.data.child_ids).toEqual([child.id]);
    f.store.update(child.id, { status: 'awaiting_acceptance', integration: 'pending' });
    expect(phases(f.store, parent.id).at(-1).id).toBe(waiting.id); // awaiting_acceptance alone is not settled
    f.store.update(child.id, { integration: 'none' });
    expect(phases(f.store, parent.id).at(-1).data).toMatchObject({ from: 'waiting_children', to: 'idle', to_status: 'waiting', child_ids: [] });
    const count = phases(f.store, parent.id).length;
    f.store.update(parent.id, { status: 'waiting', result: 'same' });
    f.store.update(parent.id, { reservation: JSON.stringify({ version: 2, status: 'executing', secret: 'PRIVATE' }) });
    f.store.update(parent.id, { status: 'waiting' });
    f.store.history(parent.id); f.store.historyPage(parent.id); f.store.readingPage(parent.id);
    expect(phases(f.store, parent.id)).toHaveLength(count);
    expect(JSON.stringify(phases(f.store, parent.id))).not.toContain('PRIVATE');
    f.store.update(parent.id, { status: 'queued' });
    expect(phases(f.store, parent.id).at(-1).data).toMatchObject({ to: 'queued', reason: 'admission_unknown' });
    f.store.update(parent.id, { status: 'paused' });
    expect(phases(f.store, parent.id).at(-1).data.to).toBe('paused');
    f.store.update(parent.id, { status: 'failed' });
    expect(phases(f.store, parent.id).at(-1).data.to).toBe('failed');
    f.store.update(parent.id, { status: 'cancelled' });
    expect(phases(f.store, parent.id).at(-1).data.to).toBe('cancelled');
    expect(waiting.data.child_ids).toEqual([child.id]);
  } finally { await f.close(); }
});

test('status and observation roll back together; notice settlement cannot leave a half-linked message', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const task = worker(f.store);
    const before = f.store.all('SELECT * FROM events');
    f.store.run(`CREATE TEMP TRIGGER reject_phase BEFORE INSERT ON events WHEN NEW.type='worker.phase_changed'
      BEGIN SELECT RAISE(ABORT, 'phase failure'); END`);
    expect(() => f.store.update(task.id, { status: 'paused' })).toThrow('phase failure');
    expect(f.store.task(task.id).status).toBe('queued'); expect(f.store.all('SELECT * FROM events')).toEqual(before);
    f.store.run('DROP TRIGGER reject_phase');
    const child = worker(f.store, { parent_id: task.id, task_kind: 'child' });
    f.store.update(task.id, { status: 'waiting' });
    const beforeParent = f.store.all('SELECT * FROM events');
    f.store.run(`CREATE TEMP TRIGGER reject_parent_phase BEFORE INSERT ON events
      WHEN NEW.type='worker.phase_changed' AND NEW.task_id=${task.id}
      BEGIN SELECT RAISE(ABORT, 'parent phase failure'); END`);
    expect(() => f.store.update(child.id, { status: 'completed' })).toThrow('parent phase failure');
    expect(f.store.task(child.id).status).toBe('queued');
    expect(f.store.all('SELECT * FROM events')).toEqual(beforeParent);
    f.store.run('DROP TRIGGER reject_parent_phase');
    const notice = f.project.notice(task.id, 'Choose', '', 'question', questions);
    const messages = f.store.all('SELECT * FROM messages');
    f.store.run(`CREATE TEMP TRIGGER reject_answer BEFORE INSERT ON events WHEN NEW.type='notice.answered'
      BEGIN SELECT RAISE(ABORT, 'answer failure'); END`);
    expect(() => f.project.answer(notice.id, answer)).toThrow('answer failure');
    expect(f.store.all('SELECT * FROM messages')).toEqual(messages);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('open');
    f.store.run('DROP TRIGGER reject_answer');
    settleNoticeAnswer(f.project, notice.id, answer, false, 'lush');
    const row = f.store.get("SELECT * FROM events WHERE task_id=? AND type='notice.answered'", task.id);
    const data = JSON.parse(row.data);
    expect(invocationInputSources(f.store, task.id, f.store.unread(task.id))).toEqual([{
      message_id: data.message_id, source: 'system', sender_id: null, sender_worker_number: null,
      notice_id: notice.id, notice_kind: 'questionnaire', evidence_event_id: row.id,
    }]);
  } finally { await f.close(); }
});

test('legacy/foreign/body-only provenance stays unknown and opening Store or reading does not backfill phases', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const task = worker(f.store), other = worker(f.store);
    f.store.run("DELETE FROM events WHERE type='worker.phase_changed'");
    const unknown = f.store.message(task.id, '{"notice_id":1,"answer_source":"user"}');
    f.store.event(other.id, 'message', { sender: null, user_append: true, message_id: unknown });
    f.store.event(task.id, 'message', { sender: null, message_id: unknown });
    f.store.event(task.id, 'invocation.started', { call: 1, message_ids: [unknown] });
    expect(invocationInputSources(f.store, task.id, f.store.unread(task.id))[0]).toMatchObject({ source: 'unknown', notice_id: null });
    const before = f.store.all('SELECT * FROM events');
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root); reopened.close();
    f.store.historyPage(task.id); f.store.readingPage(task.id); f.store.update(task.id, { status: 'queued' });
    expect(f.store.all('SELECT * FROM events')).toEqual(before);
    expect(f.store.history(task.id).find(row => row.type === 'invocation.started').data.run_id).toBeUndefined();
    f.store.update(task.id, { status: 'paused' });
    expect(phases(f.store, task.id)[0].data.from).toBe('queued');
    expect(invocationInputSources(f.store, task.id, Array.from({ length: 60 }, () => ({ id: unknown })))).toHaveLength(50);
  } finally { await f.close(); }
});
