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

test('unified timeline defaults, colored button counts, stable chronological interleave and filter/expansion refresh', () => fixture(async () => {
  const events = [event(1, 'created'), event(2, 'message', { sender: null, message_id: 20, body: '追加输入' }),
    event(3, 'invocation.completed', { run_id: 3, result: '结果正文' }), event(4, 'notice.opened', { kind: 'questionnaire', title: '范围决策' }),
    event(5, 'task.merge_integrated', { commit: 'abc123' }), event(6, 'invocation.blocked', { reason: 'missing_model_source' }),
    event(7, 'progress.completed', { key: 'implement' }), event(8, 'task.input_buffered', { message_id: 20, body: '追加输入' })];
  const current = { ...task, result: '结果正文', runs: [{ id: 3, result: '结果正文', ended_at: at(3) }],
    messages: [{ id: 20, task_id: 7, sender_id: null, body: '追加输入', append_number: 'A232-1' },
      { id: 21, task_id: 7, sender_id: 8, body: '隐藏通信' }] };
  const root = renderConversation(current, { events });
  expect(root.querySelector('h2').textContent).toBe('时间线');
  expect(root.querySelector('.conversation-filters').querySelectorAll('input')).toHaveLength(0);
  for (const key of ['input','output','decision','lifecycle','delivery','failure']) expect(toggle(root, key).getAttribute('aria-pressed')).toBe('true');
  for (const key of ['other','detail']) expect(toggle(root, key).getAttribute('aria-pressed')).toBe('false');
  expect(toggle(root, 'detail').textContent).toBe('细粒度事件 2');
  expect(toggle(root, 'input').textContent).toBe('用户输入 2');
  expect(toggle(root, 'output').style.color).toBe('var(--queued)');
  expect(root.querySelectorAll('.conversation-output')).toHaveLength(1);
  expect(root.querySelectorAll('.conversation-input')).toHaveLength(2);
  expect(root.querySelectorAll('.conversation-event')).toHaveLength(4);
  await findByText(root, '正序').onclick();
  expect(keys(root)).toEqual(['goal','history:1','input:2','run:3','history:4','history:5','history:6']);
  const failure = root.querySelector('[data-conversation-key="history:6"]');
  expect(deepText(failure)).toContain('missing_model_source');
  expect(failure.querySelector('.conversation-expand').hidden).toBe(false);
  await failure.querySelector('.conversation-expand').onclick();
  expect(failure.expanded).toBe(true); expect(failure.querySelector('.conversation-expand').textContent).toBe('收起详情');
  await toggle(root, 'detail').onclick(); await toggle(root, 'lifecycle').onclick();
  renderConversation(current, { events }, root);
  expect(root.querySelector('[data-conversation-key="history:6"]')).toBe(failure);
  expect(failure.expanded).toBe(true); expect(root.dataset.order).toBe('asc');
  expect(toggle(root, 'detail').getAttribute('aria-pressed')).toBe('true');
  expect(toggle(root, 'lifecycle').getAttribute('aria-pressed')).toBe('false');
  expect(root.querySelectorAll('.conversation-input')).toHaveLength(2);
}));

test('event types and safe metadata search explicitly submit text, clear preserves categories, and legacy projection is bounded', () => fixture(async () => {
  const root = renderConversation(task, { events: [event(1, 'merge.enqueued', { commit: 'SearchCommit',
    metadata: { hooks: { token: 'SECRET' }, path: 'src/timeline.js' }, management: 'HIDDEN', huge: 'z'.repeat(50000) }),
    event(2, 'workspace.created', { branch: 'branch-needle' })] });
  const metadata = root.querySelector('[data-conversation-key="history:1"]').entry.metadata;
  expect(JSON.stringify(metadata)).not.toContain('SECRET'); expect(JSON.stringify(metadata)).not.toContain('HIDDEN');
  expect(metadata.huge.length).toBeLessThanOrEqual(2048); expect(deepText(root)).toContain('附属字段受限');
  const input = root.querySelector('.conversation-search').querySelector('input'); input.value = 'no match';
  await toggle(root, 'detail').onclick(); expect(keys(root)).toContain('history:1');
  submit(root, 'merge.enqueued'); expect(keys(root)).toEqual(['history:1']);
  submit(root, 'src/timeline.js'); expect(keys(root)).toEqual(['history:1']);
  submit(root, 'SECRET'); expect(keys(root)).toEqual([]);
  await findByText(root, '清空').onclick();
  expect(toggle(root, 'detail').getAttribute('aria-pressed')).toBe('true'); expect(keys(root)).toContain('history:2');
  const long = previewHistoryEvent(event(3, 'failed', { body: 'x'.repeat(50000), retry_profile: 'SECRET' }));
  expect(long.data.body.length).toBe(24000); expect(long.total_chars).toBe(50000); expect(long.text_truncated).toBe(true);
  expect(long.data.retry_profile).toBeUndefined();
}));

test('arbitrary event references load precisely into the same panel, expose hidden class and reject wrong Worker identity', () => {
  const calls = [];
  return fixture(async () => {
    const root = renderConversation(task); submit(root, 'no match');
    root.attachReferencedHistoryEvent = () => { throw new Error('must not use external timeline'); };
    const node = await root.revealConversationReference({ kind: 'history_event', target: { task_id: 7, event_id: 9 } });
    expect(node.dataset.conversationKey).toBe('history:9'); expect(node.dataset.ref).toContain('event-9');
    expect(node.expanded).toBe(true); expect(toggle(root, 'detail').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.conversation-search').querySelector('input').value).toBe('');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('before_event=10'); expect(calls[0]).toContain('before_message=0'); expect(calls[0]).toContain('limit=1');
    root.updateConversation(task, page([event(9, 'workspace.created', { branch: 'same' })]));
    expect(root.querySelector('[data-conversation-key="history:9"]')).toBe(node); expect(node.expanded).toBe(true);
    expect(await root.revealConversationReference({ kind: 'history_event', target: { task_id: 8, event_id: 9 } })).toBeNull();
    expect(calls).toHaveLength(1);
  }, async url => { calls.push(String(url)); return new Response(JSON.stringify(page([event(9, 'workspace.created', { branch: 'same' })]))); });
});

test('message/event aliases deduplicate communication and linked decision answers without losing any reference or sender source', () => fixture(async () => {
  const message = { id: 22, task_id: 7, body: '子 Worker 消息', sender_id: 8 };
  const decisionMessage = { id: 23, task_id: 7, body: '{"answer":"same"}', signal_type: 'notice.answered', sender_id: null };
  const events = [event(1, 'message', { sender: 8, message_id: 22, body: message.body }),
    { ...event(2, 'task.signal', { message_id: 22 }), message },
    event(3, 'notice.answered', { notice_id: 544, message_id: 23, answer_source: 'lush', answer: '已选范围' })];
  const root = renderConversation({ ...task, messages: [message, decisionMessage] }, { events });
  await toggle(root, 'other').onclick();
  expect(root.querySelectorAll('.conversation-other')).toHaveLength(2);
  const comm = root.querySelector('[data-conversation-key="other:message:22"]');
  expect(comm.dataset.ref).toContain('event-1'); expect(comm.dataset.ref).toContain('event-2');
  const answer = root.querySelector('[data-conversation-key="other:message:23"]');
  expect(answer.querySelector('.conversation-sender').textContent).toBe('Lush 自动选择'); expect(deepText(answer)).toContain('已选范围');
  root.updateConversation({ ...task, messages: [message, decisionMessage] });
  expect(answer.querySelector('.conversation-sender').textContent).toBe('Lush 自动选择');
  expect(await root.revealConversationReference({ kind: 'history_event', target: { event_id: 1 } })).toBe(comm);
  expect(await root.revealConversationReference({ kind: 'message', target: { message_id: 23 } })).toBe(answer);
}));

test('key management activity is visible by default with exact Chinese labels, safe details, failures and event reference reveal', () => fixture(async () => {
  const types = ['management.created', 'management.signal_submitted', 'management.invocation_started', 'management.action_submitted',
    'management.action_completed', 'management.settled', 'management.failed', 'management.unknown'];
  const root = renderConversation({ ...task, role: 'manager', task_kind: 'management' }, { events: types.map((type, index) => event(index + 1, type,
    { cwd: '/project/.lush/management/200', reason: type.endsWith('failed') ? '缺少管理模型来源' : '管理运行事实', management: { secret: 'PRIVATE-MANAGEMENT' } })) });
  expect(root.querySelectorAll('.conversation-event')).toHaveLength(8);
  expect(toggle(root, 'lifecycle').textContent).toBe('关键生命周期 6'); expect(toggle(root, 'failure').textContent).toBe('失败与受阻 2');
  expect(deepText(root)).toContain('管理信号已提交待执行'); expect(deepText(root)).toContain('缺少管理模型来源');
  expect(deepText(root)).toContain('管理结果未知，待核验'); expect(deepText(root)).not.toContain('PRIVATE-MANAGEMENT');
  const submitted = await root.revealConversationReference({ kind: 'history_event', target: { task_id: 7, event_id: 2 } });
  expect(submitted.expanded).toBe(true); expect(deepText(submitted)).toContain('/project/.lush/management/200');
  expect(submitted.dataset.ref).toContain('event-2'); expect(submitted.entry.metadata.management).toBeUndefined();
}));

test('unified automation submissions stay visible as delivery facts and explicit failed or unknown outcomes remain failure facts', () => fixture(async () => {
  const events = [
    event(1, 'automation.operation_submitted', { tool: 'request_merge' }),
    event(2, 'automation.operation_submitted', { tool: 'accept_worker' }),
    event(3, 'delivery.requested', { tool: 'integrate_deliveries', strategy: 'serial', delivery_id: 31 }),
    event(4, 'completion.execution_submitted', { phase: 'accept' }),
    event(5, 'automation.operation_finished', { tool: 'request_merge', status: 'succeeded' }),
    event(6, 'automation.operation_finished', { tool: 'accept_worker', status: 'failed' }),
    event(7, 'automation.operation_finished', { tool: 'request_merge', status: 'unknown' }),
    event(8, 'automation.operation_submitted', { tool: 'future_tool' }),
  ];
  const root = renderConversation(task, { events });
  expect(toggle(root, 'delivery').textContent).toBe('交付与合并 5');
  expect(toggle(root, 'failure').textContent).toBe('失败与受阻 2');
  expect(toggle(root, 'detail').textContent).toBe('细粒度事件 1');
  for (let id = 1; id <= 7; id++) {
    const node = root.querySelector(`[data-conversation-key="history:${id}"]`);
    expect(node).toBeTruthy(); expect(node.dataset.timelineCategory).toBe(id <= 5 ? 'delivery' : 'failure');
    expect(node.dataset.ref).toContain(`event-${id}`);
    if (id <= 4) for (const claim of ['已完成', '成功', '已合入']) expect(node.entry.kind).not.toContain(claim);
  }
  expect(root.querySelector('[data-conversation-key="history:8"]')).toBeNull();
  expect(deepText(root)).toContain('未新增授权');
  expect(root.querySelector('[data-conversation-key="history:5"]').entry.kind).toContain('不代表代码合入或测试通过');
  for (const id of [6, 7]) expect(root.querySelector(`[data-conversation-key="history:${id}"]`).entry.kind).not.toContain('已完成');
  expect(root.querySelector('[data-conversation-key="history:6"]').entry.kind).toContain('失败');
  expect(root.querySelector('[data-conversation-key="history:7"]').entry.kind).toContain('待核验');
  await toggle(root, 'delivery').onclick(); root.updateConversation(task, { events });
  expect(keys(root)).toEqual(['history:7', 'history:6', 'goal']);
  expect(toggle(root, 'delivery').getAttribute('aria-pressed')).toBe('false');
  expect(toggle(root, 'failure').getAttribute('aria-pressed')).toBe('true');
}));

test('complete known long results deduplicate the latest bubble but independent identical runs remain; user evidence leaves hidden communication category', () => fixture(async () => {
  const text = '结果'.repeat(20000);
  const root = renderConversation({ ...task, result: text }, { events: [event(1, 'invocation.completed', { run_id: 10, result: text }),
    event(2, 'invocation.completed', { run_id: 11, result: text })],
    messages: [{ id: 23, task_id: 7, sender_id: null, body: '待证明用户追加' }] });
  expect(root.querySelectorAll('.conversation-output')).toHaveLength(2);
  expect(root.querySelector('[data-conversation-key="latest"]')).toBeNull();
  expect(root.querySelectorAll('.conversation-read-more')).toHaveLength(0);
  await toggle(root, 'other').onclick();
  const node = root.querySelector('[data-conversation-key="other:message:23"]'); node.revealReadingContent();
  await toggle(root, 'other').onclick();
  root.updateConversation({ ...task, result: text }, { events: [event(3, 'message', { sender: null, message_id: 23, body: '待证明用户追加' })] });
  expect(root.querySelector('[data-conversation-key="input:3"]')).toBe(node);
  expect(node.dataset.timelineCategory).toBe('input'); expect(node.expanded).toBe(true);
  expect(toggle(root, 'other').getAttribute('aria-pressed')).toBe('false');
}));

test('unreadable events render exact failure and incomplete range, not an empty successful scan', () => fixture(async () => {
  const root = renderConversation(task);
  await findByText(root, '查找全部历史').onclick();
  const failed = root.querySelector('[data-conversation-key="history:1"]');
  expect(failed).toBeTruthy(); expect(deepText(failed)).toContain('invalid_event_json');
  expect(failed.querySelector('.conversation-read-more')).toBeNull();
  expect(deepText(root)).toContain('1 条正文不可读'); expect(deepText(root)).toContain('范围未完成');
  expect(deepText(root)).not.toContain('查找完成');
}, async () => new Response(JSON.stringify({ ...page([{ id: 1, type: 'failed', error: 'invalid_event_json', text_truncated: true, total_chars: null }]),
  errors: [{ kind: 'event', record_id: 1, error: 'invalid_event_json' }] }))));
