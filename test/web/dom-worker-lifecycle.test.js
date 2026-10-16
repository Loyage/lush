import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderWorkerTimeline } from '../../src/ui/web/assets/render-worker-timeline.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const at = n => `2026-10-16T05:${String(n).padStart(2, '0')}:00Z`;
const task = { id: 7, worker_number: 'W303', input_id: 303, role: 'agent', task_kind: 'order', status: 'waiting', goal: '原始输入',
  created_at: at(0), updated_at: at(8), runs: [{ id: 10, task_id: 7, attempt: 1, status: 'completed', started_at: at(0), ended_at: at(1), result: '第一轮回复' }],
  children: [{ id: 8, worker_number: 'W303-1', status: 'running' }] };
const e = (id, type, data = {}, minute = id) => ({ id, task_id: 7, type, data, created_at: at(minute) });
const page = (events = [], messages = [], more = false) => ({ events, messages, event_cursor: more ? events.at(-1)?.id : 0, message_cursor: 0,
  has_more_events: more, has_more_messages: false, scanned_events: events.length, scanned_messages: messages.length });
const history = [e(1, 'invocation.started', { run_id: 10, call: 1, message_ids: [] }, 0), e(2, 'invocation.completed', { run_id: 10, result: '第一轮回复' }, 1),
  e(3, 'worker.phase_changed', { version: 1, from: 'running', to: 'waiting_children', to_status: 'waiting', reason: 'children_unsettled',
    child_ids: [8], children: [{ id: 8, worker_number: 'W303-1' }], notice_ids: [], notices: [], run_id: 10 }, 1)];
async function fixture(run, fetch = async () => { throw new Error('no implicit network reads'); }) {
  const dom = installDom({ fetch }); resetUiState(); ui.view = { id: 'task', key: 'task-7' }; ui.hostSession = { status: 'ready', username: '用户' };
  try { await run(dom); } finally { resetUiState(); dom.restore(); }
}
const submit = (root, value) => { const input = root.querySelector('.search-field input') || root.querySelector('input'); input.value = value;
  input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); };

test('phase/time/call summaries are default, advanced records are separate and none of the controls call an Agent', () => fixture(async () => {
  const root = renderWorkerTimeline(task, { events: history });
  expect(root.querySelector('h2').textContent).toBe('时间线');
  expect(deepText(root.querySelector('.lifecycle-current'))).toContain('等待子 Worker');
  expect(deepText(root.querySelector('.lifecycle-current'))).toContain('W303-1');
  expect(root.querySelector('.lifecycle-advanced').open).not.toBe(true);
  expect(root.querySelectorAll('.lifecycle-call')).toHaveLength(1); expect(root.querySelectorAll('.lifecycle-phase')).toHaveLength(1);
  expect(root.querySelectorAll('.conversation-message')).toHaveLength(0);
  expect(root.querySelectorAll('.agent-call')).toHaveLength(0);
  await findByText(root, '正序').onclick(); expect(root.dataset.order).toBe('asc');
}));

test('same-Worker refresh retains independent modules, sorting, raw node expansion and full body', () => fixture(async dom => {
  renderDetail(task, { events: history }, null, null);
  const panel = dom.node('detail'), inputOutput = panel.querySelector('.conversation-panel'), timeline = panel.querySelector('.worker-timeline-panel');
  const node = await timeline.revealTimelineReference({ kind: 'history_event', target: { task_id: 7, event_id: 3 } });
  const body = node.querySelector('pre'); await findByText(timeline, '正序').onclick();
  renderDetail({ ...task, display_title: '刷新标题' }, { events: history }, null, null);
  expect(panel.querySelector('.conversation-panel')).toBe(inputOutput); expect(panel.querySelector('.worker-timeline-panel')).toBe(timeline);
  expect(timeline.querySelector('[data-lifecycle-record="event:3"]')).toBe(node); expect(node.querySelector('pre')).toBe(body);
  expect(node.expanded).toBe(true); expect(timeline.dataset.order).toBe('asc'); expect(timeline.querySelector('.lifecycle-advanced').open).toBe(true);
  expect(await timeline.revealTimelineReference({ kind: 'history_event', target: { task_id: 9, event_id: 3 } })).toBeNull();
}));

test('unloaded exact evidence reads a single targeted window, never labels isolated hits as a complete wait interval', () => {
  const calls = [];
  return fixture(async () => {
    const root = renderWorkerTimeline(task, { events: [history[2]] });
    const node = await root.revealTimelineReference({ kind: 'history_event', target: { task_id: 7, event_id: 20 } });
    expect(node.expanded).toBe(true); expect(calls).toHaveLength(1); expect(calls[0]).toContain('before_event=21'); expect(calls[0]).toContain('limit=1');
    expect(root.querySelectorAll('.lifecycle-phase')).toHaveLength(1);
  }, async url => { calls.push(String(url)); return new Response(JSON.stringify(page([e(20, 'worker.phase_changed', { version: 1, to: 'running', to_status: 'running' })]))); });
});

test('source evidence is a received batch, with persistent evidence aliases usable across pages', () => {
  const calls = [];
  return fixture(async () => {
    const events = [e(4, 'invocation.started', { run_id: 20, call: 2, message_ids: [30], source_scope: 'delivered_batch',
      input_sources: [{ message_id: 30, source: 'worker', sender_id: 8, sender_worker_number: 'W303-1', evidence_event_id: 1 }] })];
    const root = renderWorkerTimeline({ ...task, runs: [] }, { events });
    const row = root.querySelector('.lifecycle-call'); expect(deepText(row)).toContain('不代表唯一触发者');
    await findByText(row, 'Worker W303-1').onclick(); expect(calls).toHaveLength(1); expect(calls[0]).toContain('before_event=2');
    expect(root.querySelector('[data-lifecycle-record="event:1"]').expanded).toBe(true);
  }, async url => { calls.push(String(url)); return new Response(JSON.stringify(page([e(1, 'message', { sender: 8, message_id: 30, body: '接口确认' })]))); });
});

test('full safe metadata originals enrich bounded provenance only after explicit segmented reads', () => {
  const data = { run_id: 20, call: 2, message_ids: [30], source_scope: 'delivered_batch', input_sources: [{ message_id: 30, source: 'worker', sender_id: 8, sender_worker_number: 'W303-1' }] };
  const text = JSON.stringify(data), reads = [];
  return fixture(async () => {
    const root = renderWorkerTimeline({ ...task, runs: [] }, { events: [{ ...e(4, 'invocation.started', { run_id: 20, call: 2, message_ids: [30] }), limitations: ['event_metadata_bounded'] }] });
    expect(deepText(root.querySelector('.lifecycle-call'))).toContain('安全元数据受限');
    const node = await root.revealTimelineReference({ kind: 'history_event', target: { task_id: 7, event_id: 4 } });
    await findByText(node, '读取完整原文').onclick();
    expect(reads).toHaveLength(1); expect(deepText(root.querySelector('.lifecycle-call'))).toContain('Worker W303-1');
    expect(deepText(root.querySelector('.lifecycle-call'))).not.toContain('安全元数据受限');
  }, async url => { reads.push(String(url)); return new Response(JSON.stringify({ text, offset: 0, next_offset: text.length, has_more: false, total_chars: text.length })); });
});

test('local filtering waits for submit, full-history search is explicit and preserves query/records on refresh', () => {
  const calls = [];
  return fixture(async () => {
    const root = renderWorkerTimeline(task, { events: [e(4, 'merge.failed', { error: 'needle', hooks: { token: 'PRIVATE' } })] });
    expect(calls).toHaveLength(0); expect(deepText(root)).not.toContain('PRIVATE');
    const input = root.querySelector('input'); input.value = 'not found'; root.updateTimeline(task);
    expect(root.querySelectorAll('.lifecycle-evidence-record')).toHaveLength(1);
    submit(root, 'not found'); expect(root.querySelectorAll('.lifecycle-evidence-record')).toHaveLength(0);
    await findByText(root, '查找全部历史').onclick(); expect(calls).toHaveLength(1); expect(deepText(root)).toContain('历史命中 0 条');
    submit(root, ''); root.updateTimeline(task); expect(root.querySelectorAll('.lifecycle-evidence-record')).toHaveLength(1);
  }, async url => { calls.push(String(url)); return new Response(JSON.stringify(page())); });
});

test('aborting navigation rejects late record publication and retains the original preview', () => {
  let resolve, signal;
  return fixture(async () => {
    const root = renderWorkerTimeline(task, { events: [e(4, 'workspace.created', { branch: 'original' })] });
    const controller = new AbortController(); root.bindTimelineLifetime(controller.signal, () => true);
    const node = await root.revealTimelineReference({ kind: 'history_event', target: { task_id: 7, event_id: 4 } });
    const reading = findByText(node, '读取完整原文').onclick(); expect(signal.aborted).toBe(false);
    controller.abort(); expect(signal.aborted).toBe(true);
    resolve(new Response(JSON.stringify({ text: 'late replacement', offset: 0, next_offset: 16, has_more: false }))); await reading;
    expect(deepText(node)).not.toContain('late replacement'); expect(deepText(node)).toContain('original');
  }, (_url, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); });
});

test('a stalled cursor or unreadable record is a failed range, not a complete empty history', () => fixture(async () => {
  const root = renderWorkerTimeline(task, { events: history });
  await findByText(root, '加载更早时间线').onclick(); expect(deepText(root)).toContain('历史游标未前进');
  expect(deepText(root)).toContain('历史范围未完成'); expect(findByText(root, '加载更早时间线').hidden).toBe(false);
}, async () => new Response(JSON.stringify({ ...page(), has_more_events: true, event_cursor: 1 }))));

test('active selections defer timeline reconciliation; release retains focused evidence and original body nodes', () => fixture(async dom => {
  const root = renderWorkerTimeline(task, { events: history });
  root.bindTimelineLifetime(new AbortController().signal, () => true);
  const node = await root.revealTimelineReference({ kind: 'history_event', target: { task_id: 7, event_id: 3 } });
  const body = node.querySelector('pre'), control = node.querySelector('button'); control.focus();
  let selected = true; dom.window.getSelection = () => ({ isCollapsed: !selected, anchorNode: body, focusNode: body });
  const count = root.querySelectorAll('.lifecycle-row').length;
  root.updateTimeline(task, { events: [e(4, 'merge.failed', { error: '新的失败记录' })] });
  expect(root.querySelectorAll('.lifecycle-row')).toHaveLength(count);
  selected = false; for (const listener of dom.documentListeners.selectionchange) listener();
  expect(root.querySelectorAll('.lifecycle-row')).toHaveLength(count + 1);
  expect(root.querySelector('[data-lifecycle-record="event:3"]')).toBe(node); expect(node.querySelector('pre')).toBe(body);
  expect(dom.document.activeElement).toBe(control);
}));

test('an oversized new window fails atomically and keeps the prior reading nodes instead of truncating silently', () => fixture(async () => {
  const root = renderWorkerTimeline(task, { events: history });
  const node = await root.revealTimelineReference({ kind: 'history_event', target: { task_id: 7, event_id: 3 } });
  root.updateTimeline(task, { events: Array.from({ length: 5001 }, (_, n) => e(100 + n, 'message', { body: 'old' }, 1)) });
  expect(deepText(root)).toContain('5000 条阅读预算'); expect(deepText(root)).toContain('历史范围未完成');
  expect(root.querySelector('[data-lifecycle-record="event:3"]')).toBe(node);
  expect(root.querySelector('[data-lifecycle-record="event:100"]')).toBeNull();
}));

test('older completion-only Runs remain separate timeline rows even outside inspect Run windows', () => fixture(async () => {
  const root = renderWorkerTimeline({ ...task, runs: [] }, { events: [e(1, 'invocation.completed', { run_id: 91, result: '重复文本' }),
    e(2, 'invocation.completed', { run_id: 92, result: '重复文本' })] });
  expect(root.querySelectorAll('.lifecycle-call')).toHaveLength(2);
  expect(deepText(root)).toContain('调用 #91（轮次未知）'); expect(deepText(root)).toContain('调用 #92（轮次未知）');
}));
