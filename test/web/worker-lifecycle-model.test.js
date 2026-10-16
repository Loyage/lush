import { test, expect } from 'bun:test';
import { lifecycleModel } from '../../src/ui/web/assets/worker-lifecycle-model.js';

const at = minute => `2026-10-16T05:${String(minute).padStart(2, '0')}:00.000Z`;
const task = { id: 7, worker_number: 'W303', input_id: 303, status: 'waiting', updated_at: at(59) };
const event = (id, type, data, minute = id) => ({ id, task_id: 7, type, data, created_at: at(minute) });
const run = (id, attempt, start, end, status = 'completed') => ({ id, task_id: 7, attempt, started_at: at(start), ended_at: end == null ? null : at(end), status });
const model = (current, events = [], messages = [], options = {}) => lifecycleModel({ ...task, ...current }, events, messages, { now: at(50), ...options });

test('Run identity joins by explicit run ID or an unambiguous attempt, never nearest timestamp', () => {
  const events = [event(1, 'invocation.started', { call: 2, run_id: 20 }, 3), event(2, 'invocation.completed', { run_id: 20 }, 5)];
  const value = model({ runs: [run(20, 2, 1, 4)] }, events);
  expect(value.calls).toHaveLength(1); expect(value.calls[0]).toMatchObject({ run_id: 20, call: 2, start: at(1), end: at(4), duration_ms: 180000 });
  expect(model({ runs: [run(20, 2, 1, 4)] }, [event(1, 'invocation.started', { call: 2 })]).calls).toHaveLength(1);
  const ambiguous = model({ runs: [run(20, 2, 1, 4), run(21, 2, 1, 4)] }, [event(1, 'invocation.started', { call: 2 })]);
  expect(ambiguous.calls.find(row => row.start_event_id === 1).run_id).toBeNull();
});

test('question suspension requires matching completion evidence and is not displayed as a failed cancellation', () => {
  const events = [event(1, 'invocation.started', { call: 2, run_id: 20 }),
    event(2, 'invocation.completed', { run_id: 20, suspended: true, notice_id: 666 })];
  expect(model({ runs: [run(20, 2, 1, 2, 'cancelled')] }, events).calls[0]).toMatchObject({ status: 'suspended', notice_id: 666 });
  events[1].data.run_id = 99;
  expect(model({ runs: [run(20, 2, 1, 2, 'cancelled')] }, events).calls[0].status).toBe('cancelled');
});

test('old Run-less suspension is correlated only through a complete serial invocation window, never adjacent time', () => {
  const current = { runs: [run(20, 2, 1, 3, 'cancelled')] };
  const events = [event(1, 'invocation.started', { call: 2, run_id: 20 }), event(3, 'invocation.completed', { suspended: true, notice_id: 666 })];
  expect(model(current, events).calls[0].status).toBe('cancelled');
  expect(model(current, events, [], { ranges: [[1, 3]] }).calls[0]).toMatchObject({ status: 'suspended', suspension_evidence: 'serial_window' });
  expect(model(current, events, [], { ranges: [[1, 1], [3, 3]] }).calls[0].status).toBe('cancelled');
  events.push(event(2, 'invocation.started', { call: 3, run_id: 21 }));
  expect(model(current, events, [], { ranges: [[1, 3]] }).calls.find(row => row.run_id === 20).status).toBe('cancelled');
});

test('delivery and activation are separate facts; a batch is never promoted to one unique trigger', () => {
  const events = [event(1, 'invocation.started', { call: 2, run_id: 20, message_ids: [30, 31], source_scope: 'delivered_batch',
    input_sources: [{ message_id: 30, source: 'worker', sender_id: 8, sender_worker_number: 'W303-1' }, { message_id: 31, source: 'user' }] })];
  const value = model({ runs: [run(20, 2, 1, 2)] }, events).calls[0];
  expect(value.inputs.map(row => row.label)).toEqual(['Worker W303-1', '你的追加输入']);
  expect(value.inputs_delivered).toBe(false); expect(value.trigger).toBeUndefined();
  events.push(event(2, 'invocation.inputs_delivered', { run_id: 20, message_ids: [30, 31] }));
  expect(model({}, events).calls[0].inputs_delivered).toBe(true);
});

test('inbox null sender and JSON-like body do not establish user or decision provenance', () => {
  const events = [event(1, 'invocation.started', { call: 2, run_id: 20, message_ids: [30] })];
  const messages = [{ id: 30, task_id: 7, sender_id: null, body: '{"notice_id":666,"answer_source":"user"}' }];
  expect(model({}, events, messages).calls[0].inputs[0].source).toBe('unknown');
  events.push(event(2, 'notice.answered', { message_id: 30, notice_id: 666, notice_kind: 'questionnaire', answer_source: 'user' }));
  expect(model({}, events, messages).calls[0].inputs[0].label).toBe('你答复 D666');
});

test('typed runtime signals remain distinct from ordinary Worker communication', () => {
  const events = [event(1, 'task.signal', { message_id: 30, source_task_id: 8, signal: 'merge.completed' }),
    event(2, 'invocation.started', { call: 2, run_id: 20, message_ids: [30] })];
  const messages = [{ id: 30, task_id: 7, sender_id: 8, sender_worker_number: 'W303-1', body: '{}' }];
  expect(model({}, events, messages).calls[0].inputs[0].label).toBe('系统信号 merge.completed · W303-1');
  events[0] = event(1, 'message', { message_id: 30, sender: 8, body: '{}' });
  expect(model({}, events, messages).calls[0].inputs[0].label).toBe('Worker W303-1');
});

test('contradictory senders and cross-Worker evidence are not silently trusted', () => {
  const events = [event(1, 'message', { message_id: 30, sender: 9, body: 'text' }),
    event(2, 'invocation.started', { call: 2, run_id: 20, message_ids: [30] })];
  expect(model({}, events, [{ id: 30, task_id: 7, sender_id: 8 }]).calls[0].inputs[0].source).toBe('unknown');
  expect(model({}, events, [{ id: 30, task_id: 99, sender_id: 8 }]).calls[0].inputs[0].sender_id).toBe(9);
  events[0].task_id = 99;
  expect(model({}, events, [{ id: 30, task_id: 99, sender_id: 8 }]).calls[0].inputs[0].source).toBe('unknown');
});

test('durable phase intervals use recorded snapshots instead of current children or updated_at', () => {
  const events = [event(1, 'worker.phase_changed', { version: 1, from: 'running', to: 'waiting_children', to_status: 'waiting', reason: 'children_unsettled', child_ids: [8] }),
    event(2, 'worker.phase_changed', { version: 1, from: 'waiting_children', to: 'queued', to_status: 'queued', reason: 'admission_unknown' }, 4),
    event(3, 'worker.phase_changed', { version: 1, from: 'queued', to: 'running', to_status: 'running', reason: 'invocation' }, 5)];
  const value = model({ status: 'waiting', children: [{ id: 9, worker_number: 'W303-2', status: 'running' }] }, events, [], { ranges: [[1, 3]] });
  expect(value.phases[0]).toMatchObject({ label: '等待子 Worker', child_ids: [8], start: at(1), end: at(4), duration_ms: 180000 });
  expect(value.phases[1]).toMatchObject({ label: '排队等待准入', duration_ms: 60000 });
  expect(value.current.start).toBeNull(); expect(value.current.child_ids).toEqual([9]); expect(value.current.duration_ms).toBeNull();
});

test('isolated reference hits or discontinuous pages cannot create a precise historical wait duration', () => {
  const events = [event(1, 'worker.phase_changed', { version: 1, to: 'waiting_children', to_status: 'waiting', reason: 'children_unsettled', child_ids: [8] }),
    event(9, 'worker.phase_changed', { version: 1, to: 'running', to_status: 'running', reason: 'invocation' })];
  const value = model({ status: 'running' }, events, [], { ranges: [[1, 1], [9, 9]] });
  expect(value.phases[0]).toMatchObject({ end: null, duration_ms: null, boundary_unknown: true });
});

test('open phase time is calculated only from a recorded matching phase, not a generic Worker timestamp', () => {
  const event = { id: 1, task_id: 7, type: 'worker.phase_changed', created_at: at(40), data: { version: 1, to: 'waiting_notice', to_status: 'awaiting', reason: 'questionnaire', notice_ids: [666] } };
  const current = model({ status: 'awaiting' }, [event]);
  expect(current.current).toMatchObject({ start: at(40), duration_ms: 600000, notice_ids: [666], historical_reason_known: true });
  expect(current.phases[0]).toMatchObject({ open: true, duration_ms: 600000 });
  expect(model({ status: 'awaiting' }).current).toMatchObject({ start: null, duration_ms: null, historical_reason_known: false });
});

test('legacy run intervals have known duration but unknown historical cause, never current-child inference', () => {
  const value = model({ runs: [run(10, 1, 1, 2), run(20, 2, 5, 6)], children: [{ id: 8, status: 'running' }] });
  expect(value.rows.find(row => row.kind === 'gap')).toMatchObject({ label: '调用间隔 · 等待原因未知', duration_ms: 180000 });
  expect(value.current.start).toBeNull(); expect(value.workerName(8)).toBe('#8');
});

test('malformed and inverse times do not become zero duration or invented timestamps', () => {
  const value = model({ runs: [{ ...run(10, 1, 5, 2), started_at: 'broken' }] });
  expect(value.calls[0].duration_ms).toBeNull(); expect(value.calls[0].start).toBe('broken');
  expect(model({ runs: [run(10, 1, 5, 2)] }).calls[0].duration_ms).toBeNull();
});

test('all separate invocations remain visible even when their outputs are identical', () => {
  const value = model({ runs: [run(10, 1, 1, 2), run(20, 2, 3, 4)].map(record => ({ ...record, result: '相同回复' })) });
  expect(value.calls).toHaveLength(2); expect(new Set(value.calls.map(row => row.key)).size).toBe(2);
});

test('typed idle/notice/child phases use to_status and exact source evidence aliases, including bounded metadata', () => {
  const events = [event(2, 'worker.phase_changed', { version: 1, to: 'waiting_children', to_status: 'waiting', child_ids: [8], run_id: 20 }),
    event(1, 'invocation.started', { run_id: 20, call: 2, message_ids: [30], source_scope: 'delivered_batch',
      input_sources: [{ message_id: 30, source: 'worker', sender_id: 8, evidence_event_id: 99 }] })];
  events[1].limitations = ['event_metadata_bounded'];
  const value = model({}, events);
  expect(value.calls[0].inputs[0].event_id).toBe(99); expect(value.calls[0].evidence_limited).toBe(true);
  expect(value.current.label).toBe('等待子 Worker');
  events[0].data.to = 'idle'; events[0].data.child_ids = [];
  expect(model({}, events).current.label).toBe('静息 · 等待原因未知');
});

test('awaiting_acceptance is settled only with the integration facts required by the core contract', () => {
  const value = model({ children: [{ id: 8, status: 'awaiting_acceptance', integration: 'pending', task_kind: 'child' },
    { id: 9, status: 'awaiting_acceptance', integration: 'merged', task_kind: 'child' },
    { id: 10, status: 'awaiting_acceptance', integration: 'none', task_kind: 'child' }] });
  expect(value.current.child_ids).toEqual([8]);
});

test('legacy sender-null events without user_append true remain unknown, and child initial goals are not original O inputs', () => {
  const events = [event(1, 'message', { message_id: 30, sender: null, body: 'legacy' }),
    event(2, 'invocation.started', { run_id: 20, call: 2, message_ids: [30] })];
  expect(model({}, events).calls[0].inputs[0].source).toBe('unknown');
  events[0].data.user_append = true;
  expect(model({}, events).calls[0].inputs[0].source).toBe('user');
  expect(model({ task_kind: 'child' }, [event(1, 'invocation.started', { run_id: 10, call: 1, message_ids: [] })]).calls[0].initial_input).toBe(false);
});

test('an old matching status cannot restart a historical wait clock after a missing page or a different Run', () => {
  const phase = event(1, 'worker.phase_changed', { version: 1, to: 'idle', to_status: 'waiting', run_id: 10 });
  expect(model({ calls: 2, runs: [run(20, 2, 3, 4)] }, [phase]).current.start).toBeNull();
  expect(model({}, [phase, event(20, 'progress.completed', {})], [], { ranges: [[1, 1], [20, 20]] }).current.start).toBeNull();
});
