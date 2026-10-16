import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { previewHistoryEvent } from '../../src/ui/web/assets/reading-projection.js';

const at = n => `2026-10-12T08:${String(n).padStart(2, '0')}:00Z`;
const task = { id: 7, worker_number: 'W232', input_id: 232, goal: '原始输入', created_at: at(0) };
const event = (id, type, data = {}) => ({ id, type, data, task_id: 7, created_at: at(id) });
const toggle = (root, key) => root.querySelector(`[data-conversation-filter="${key}"]`);
const keys = root => root.querySelectorAll('.conversation-message').map(node => node.dataset.conversationKey);
const submit = (root, value) => {
  const input = root.querySelector('.conversation-search').querySelector('input'); input.value = value;
  input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
};
const page = events => ({ events, messages: [], has_more_events: false, has_more_messages: false, event_cursor: 0, message_cursor: 0 });
const fixture = async (run, fetch = async () => { throw new Error('must not read automatically'); }) => {
  const dom = installDom({ fetch }); resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try { await run(); } finally { resetUiState(); dom.restore(); }
};
const expand = node => { node.open = true; for (const listener of node.listeners.toggle || []) listener(); };

test('input/output content defaults, quick-only filters and chronological rounds retain nodes and expansion on refresh', () => fixture(async () => {
  const events = [event(1, 'created'), event(2, 'message', { sender: null, message_id: 20, body: '追加输入' }),
    event(3, 'invocation.completed', { run_id: 3, result: '第一轮结果' }), event(4, 'notice.opened', { notice_id: 544, kind: 'questionnaire', title: '范围决策' }),
    event(5, 'task.merge_integrated', { commit: 'abc123' }), event(6, 'invocation.blocked', { reason: 'missing_model_source' }),
    event(7, 'invocation.completed', { run_id: 7, result: '第二轮结果' }), event(8, 'task.input_buffered', { message_id: 20, body: '追加输入' })];
  const current = { ...task, result: '第二轮结果', runs: [{ id: 3, result: '第一轮结果', ended_at: at(3) }, { id: 7, result: '第二轮结果', ended_at: at(7) }],
    messages: [{ id: 20, task_id: 7, sender_id: null, body: '追加输入', append_number: 'A232-1' }, { id: 21, task_id: 7, sender_id: 8, body: '隐藏通信' }] };
  const root = renderConversation(current, { events });
  expect(root.querySelector('h2').textContent).toBe('输入输出');
  expect(root.querySelectorAll('.conversation-filter')).toHaveLength(4);
  for (const key of ['input', 'output', 'decision']) expect(toggle(root, key).getAttribute('aria-pressed')).toBe('true');
  expect(toggle(root, 'unknown').getAttribute('aria-pressed')).toBe('false');
  expect(toggle(root, 'input').textContent).toBe('我的输入 2'); expect(toggle(root, 'output').textContent).toBe('Agent 回复 2');
  expect(toggle(root, 'decision').textContent).toBe('决策摘要 1');
  expect(root.querySelector('.conversation-event')).toBeNull(); expect(deepText(root)).not.toContain('隐藏通信');
  expect(keys(root)).toEqual(['run:7', 'other:event:4', 'run:3', 'input:2', 'goal']);
  await findByText(root, '正序').onclick(); expect(keys(root)).toEqual(['goal', 'input:2', 'run:3', 'other:event:4', 'run:7']);
  const reply = root.querySelector('[data-conversation-key="run:3"]'); reply.revealReadingContent();
  await findByText(root, '只看 Agent 回复').onclick(); expect(keys(root)).toEqual(['run:3', 'run:7']);
  root.updateConversation(current, { events }); expect(root.querySelector('[data-conversation-key="run:3"]')).toBe(reply); expect(reply.expanded).toBe(true);
  await findByText(root, '只看我的输入').onclick(); expect(keys(root)).toEqual(['goal', 'input:2']);
  await findByText(root, '恢复默认内容').onclick(); expect(keys(root)).toHaveLength(5); expect(root.dataset.order).toBe('asc');
}));

test('only explicit decision kinds are questions, info is excluded, sources are evidence-based and full content is lazy', () => fixture(async () => {
  const answer = JSON.stringify({ version: 1, answers: [{ question: '选择范围？', labels: ['仅详情'], custom: '保留原文' }] });
  const root = renderConversation({ ...task, notices: [{ id: 666, kind: 'questionnaire', title: '范围决定' }] }, { events: [
    event(1, 'notice.opened', { notice_id: 666, kind: 'questionnaire', title: '范围决定' }),
    event(2, 'notice.answered', { notice_id: 666, answer_source: 'user', answer }),
    event(3, 'notice.answered', { notice_id: 667, answer_source: 'lush', answer: '自动选择' }),
    event(4, 'notice.answered', { notice_id: 668, answer: '旧答复' }),
    event(5, 'notice.opened', { notice_id: 669, kind: 'info', title: '不能冒充决策' }),
    event(6, 'notice.answered', { notice_id: 669, notice_kind: 'info', answer: '告知已读' }),
    event(7, 'notice.opened', { notice_id: 670, title: '种类未知不猜决策' }),
    event(8, 'notice.answered', { notice_id: 671, notice_kind: 'question', answer_source: 'user', dismiss: true, answer: '拒绝选择' }),
  ] });
  expect(root.querySelectorAll('[data-conversation-category="decision"]')).toHaveLength(5);
  expect(root.querySelectorAll('.conversation-other')).toHaveLength(5);
  const question = root.querySelector('[data-conversation-key="other:event:1"]');
  expect(deepText(question)).toContain('D666'); expect(deepText(question)).toContain('决策提问');
  const decision = root.querySelector('[data-conversation-key="other:event:2"]');
  expect(decision.querySelector('.message-original')).toBeNull(); expect(decision.querySelector('.conversation-sender').textContent).toBe('用户答复');
  expect(deepText(decision)).toContain('仅详情、保留原文'); expect(deepText(decision)).not.toContain('"version"');
  expand(decision.querySelector('.conversation-decision-details'));
  for (const text of ['D666', '选择范围？', '仅详情', '保留原文']) expect(deepText(decision)).toContain(text);
  expand(decision.querySelector('.message-original')); expect(decision.querySelector('pre').textContent).toBe(answer);
  const raw = decision.querySelector('pre'); root.updateConversation({ ...task, notices: [{ id: 666, kind: 'questionnaire', title: '范围决定' }] });
  expect(decision.querySelector('pre')).toBe(raw);
  expect(root.querySelector('[data-conversation-key="other:event:3"]').querySelector('.conversation-sender').textContent).toBe('Lush 自动选择');
  expect(root.querySelector('[data-conversation-key="other:event:4"]').querySelector('.conversation-sender').textContent).toBe('来源不明');
  expect(deepText(root)).toContain('N668'); expect(deepText(root)).toContain('不代表接受推荐项');
  for (const text of ['不能冒充决策', '告知已读', '种类未知不猜决策']) expect(deepText(root)).not.toContain(text);
}));

test('decision kinds retain explicit opened evidence across pages; unknown kinds stay N and info never re-enters content', () => fixture(async () => {
  const root = renderConversation(task, { events: [event(2, 'notice.answered', { notice_id: 666, answer: '历史答复' })] });
  let answer = root.querySelector('[data-conversation-key="other:event:2"]'); expect(deepText(answer)).toContain('N666');
  root.updateConversation(task, { events: [event(1, 'notice.opened', { notice_id: 666, kind: 'questionnaire', title: '较早提问' }),
    event(3, 'notice.opened', { notice_id: 667, kind: 'info', title: '告知' })] });
  expect(root.querySelector('[data-conversation-key="other:event:2"]')).toBe(answer); expect(deepText(answer)).toContain('D666');
  expect(answer.querySelector('.conversation-sender').textContent).toBe('来源不明');
  root.updateConversation(task, { events: [event(4, 'notice.answered', { notice_id: 667, answer: '告知已读' })] });
  expect(root.querySelector('[data-conversation-key="other:event:4"]')).toBeNull();
}));

test('local search is content-only, explicit, and clear preserves categories; metadata safety projection remains bounded', () => fixture(async () => {
  const root = renderConversation(task, { events: [event(1, 'message', { sender: null, message_id: 1, body: '正文命中', marker: 'MetadataNeedle', hooks: { token: 'SECRET' } }),
    event(2, 'workspace.created', { branch: '正文命中' })] });
  const input = root.querySelector('.conversation-search').querySelector('input'); input.value = 'no match';
  await toggle(root, 'decision').onclick(); expect(keys(root)).toContain('input:1');
  for (const text of ['MetadataNeedle', 'message', 'SECRET']) { submit(root, text); expect(keys(root)).toEqual([]); }
  submit(root, '正文命中'); expect(keys(root)).toEqual(['input:1']);
  await findByText(root, '清空').onclick(); expect(toggle(root, 'decision').getAttribute('aria-pressed')).toBe('false'); expect(keys(root)).toContain('goal');
  const long = previewHistoryEvent(event(3, 'failed', { body: 'x'.repeat(50000), retry_profile: 'SECRET' }));
  expect(long.data.body.length).toBe(24000); expect(long.total_chars).toBe(50000); expect(long.text_truncated).toBe(true); expect(long.data.retry_profile).toBeUndefined();
}));

test('non-content message/event references return null after a bounded exact lookup, never exposing events or clearing filters', () => {
  const calls = [];
  return fixture(async () => {
    const root = renderConversation(task); submit(root, 'no match');
    expect(await root.revealConversationReference({ kind: 'history_event', target: { task_id: 7, event_id: 9 } })).toBeNull();
    expect(await root.revealConversationReference({ kind: 'message', target: { task_id: 7, message_id: 22 } })).toBeNull();
    expect(root.querySelector('.conversation-search').querySelector('input').value).toBe('no match'); expect(keys(root)).toEqual([]);
    expect(calls).toHaveLength(2); expect(calls[0]).toContain('before_event=10'); expect(calls[0]).toContain('before_message=0'); expect(calls[0]).toContain('limit=1');
    expect(calls[1]).toContain('before_message=23'); expect(calls[1]).toContain('before_event=0');
    expect(await root.revealConversationReference({ kind: 'history_event', target: { task_id: 8, event_id: 9 } })).toBeNull(); expect(calls).toHaveLength(2);
  }, async url => { calls.push(String(url)); return new Response(JSON.stringify(String(url).includes('before_message=23')
    ? { ...page([]), messages: [{ id: 22, sender_id: 8, body: 'Worker 通信' }] }
    : page([event(9, 'workspace.created', { branch: 'same' })]))); });
});

test('all lifecycle and automation event families stay out of content counts, search and display, even after reference reveal', () => fixture(async () => {
  const types = ['management.created', 'management.signal_submitted', 'management.invocation_started', 'management.action_submitted',
    'management.action_completed', 'management.settled', 'management.failed', 'management.unknown', 'automation.operation_submitted',
    'automation.operation_finished', 'delivery.requested', 'completion.execution_submitted', 'merge.failed', 'invocation.started', 'invocation.inputs_delivered'];
  const root = renderConversation(task, { events: types.map((type, i) => event(i + 1, type, { status: 'failed', reason: '不可混入', hooks: { secret: 'SECRET' } })) });
  expect(keys(root)).toEqual(['goal']); expect(toggle(root, 'decision').textContent).toBe('决策摘要 0');
  for (const category of ['lifecycle', 'delivery', 'failure', 'other', 'detail']) expect(toggle(root, category)).toBeNull();
  submit(root, '不可混入'); expect(keys(root)).toEqual([]); expect(deepText(root)).not.toContain('SECRET');
}));

test('independent identical long runs survive latest-result deduplication', () => fixture(async () => {
  const text = '结果'.repeat(20000);
  const root = renderConversation({ ...task, result: text }, { events: [event(1, 'invocation.completed', { run_id: 10, result: text }), event(2, 'invocation.completed', { run_id: 11, result: text })] });
  expect(root.querySelectorAll('.conversation-output')).toHaveLength(2); expect(root.querySelector('[data-conversation-key="latest"]')).toBeNull();
  expect(root.querySelectorAll('.conversation-read-more')).toHaveLength(0);
}));

test('unreadable excluded events still fail whole-history range without rendering lifecycle as content', () => fixture(async () => {
  const root = renderConversation(task); await findByText(root, '查找全部历史').onclick();
  expect(root.querySelector('.conversation-event')).toBeNull(); expect(deepText(root)).toContain('invalid_event_json');
  expect(deepText(root)).toContain('范围未完成'); expect(deepText(root)).not.toContain('查找完成');
}, async () => new Response(JSON.stringify({ ...page([{ id: 1, type: 'failed', error: 'invalid_event_json', text_truncated: true, total_chars: null }]),
  errors: [{ kind: 'event', record_id: 1, error: 'invalid_event_json' }] }))));
