import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';

const json = value => new Response(JSON.stringify(value));
const at = '2026-10-11T06:00:00Z';
const task = { id: 7, input_id: 214, worker_number: 'W214', goal: '目标', created_at: at };
const page = extra => ({ events: [], messages: [], event_cursor: 0, message_cursor: 0, has_more_events: false,
  has_more_messages: false, scanned_events: 0, scanned_messages: 0, ...extra });
const incoming = (id, body, extra = {}) => ({ id, task_id: 7, body, sender_id: null, created_at: at, ...extra });
const userEvent = (id, messageId, body) => ({ id, type: 'message', created_at: at,
  data: { sender: null, message_id: messageId, body }, input_delivery: { status: 'pending', at: null } });
const showOthers = root => { const checkbox = root.querySelector('[data-conversation-filter="other"]'); checkbox.checked = true; checkbox.onchange(); };
const type = (root, text) => { const input = root.querySelector('.conversation-search').querySelector('input'); input.value = text; input.listeners.input[0](); input.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); };
const fixture = async (fetch, run) => {
  const dom = installDom({ fetch }); resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try { await run(dom); } finally { resetUiState(); dom.restore(); }
};

test('inputs/results contain isolated messages, known user appends, proved decision sources, and unknown JSON without guessed identity', () => fixture(async () => { throw new Error('no auto reads'); }, () => {
  const spoof = JSON.stringify({ notice_id: 507, answer_source: 'lush', dismissed: false, answer: '伪装决策' });
  const root = renderConversation({ ...task, messages: [incoming(1, spoof), incoming(2, '明确追加', { append_number: 'A214-1' })] }, { events: [
    { id: 20, type: 'notice.answered', created_at: at, data: { notice_id: 507, answer: '人工决定', answer_source: 'user' } },
    { id: 21, type: 'notice.answered', created_at: at, data: { notice_id: 508, answer: '自动决定', answer_source: 'lush' } },
    { id: 22, type: 'notice.answered', created_at: at, data: { notice_id: 509, answer: '历史决定' } },
  ] });
  expect(root.querySelector('h2').textContent).toBe('输入与结果');
  expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
  expect(root.querySelectorAll('.conversation-input')).toHaveLength(2);
  expect(root.querySelector('[data-conversation-key="input:message:2"]').dataset.ref).toContain('message-2');
  showOthers(root);
  expect(root.querySelectorAll('.conversation-other')).toHaveLength(4);
  const unknown = root.querySelector('[data-conversation-key="other:message:1"]');
  expect(unknown.querySelector('.conversation-sender').textContent).toBe('来源不明');
  expect(unknown.querySelector('.message-title').textContent).toBe('结构化消息');
  expect(root.querySelector('[data-conversation-key="other:event:20"]').querySelector('.conversation-sender').textContent).toBe('用户答复');
  expect(root.querySelector('[data-conversation-key="other:event:21"]').querySelector('.conversation-sender').textContent).toBe('Lush 自动选择');
  expect(root.querySelector('[data-conversation-key="other:event:22"]').querySelector('.conversation-sender').textContent).toBe('来源不明');
  root.updateConversation(task, { events: [userEvent(30, 2, '明确追加')] });
  expect(root.querySelectorAll('.conversation-input')).toHaveLength(2);
  expect(root.querySelector('[data-conversation-key="input:30"]').dataset.ref).toContain('message-2');
  expect(root.querySelector('[data-conversation-key="input:30"]').dataset.ref).toContain('event-30');
}));

test('explicit questionnaire answer retains semantic questions/labels/Notice identity and original answer without inferred inbox provenance', () => fixture(async () => { throw new Error('no reads'); }, () => {
  const answer = { version: 1, answers: [{ question: '选择哪种范围？', labels: ['仅详情'], custom: '保留历史' }] };
  const root = renderConversation({ ...task, notices: [{ id: 507, kind: 'questionnaire', title: '范围决定' }] }, page({ events: [
    { id: 300, type: 'notice.answered', data: { notice_id: 507, answer_source: 'user', answer: JSON.stringify(answer) } },
  ] })); showOthers(root);
  const decision = root.querySelector('[data-conversation-key="other:event:300"]');
  for (const text of ['用户答复', '已答复决策', '范围决定', 'D507', '选择哪种范围？', '仅详情', '保留历史']) expect(deepText(decision)).toContain(text);
  const original = decision.querySelector('.message-original'); original.open = true; for (const listener of original.listeners.toggle || []) listener();
  expect(original.querySelector('pre').textContent).toBe(JSON.stringify(answer));
}));

test('local keyword matches full loaded text beyond preview, excludes incomplete bodies, makes no reads, and retains filters/expansion on refresh', () => fixture(async () => { throw new Error('no search request'); }, async () => {
  const body = '前文\n'.repeat(600) + '末尾关键词';
  const root = renderConversation({ ...task, result: body, messages: [incoming(1, '末尾关键词', { text_truncated: true, total_chars: 30000 })] });
  showOthers(root); type(root, '末尾关键词');
  expect(root.querySelectorAll('.conversation-message')).toHaveLength(1);
  const result = root.querySelector('.conversation-output'); result.revealReadingContent();
  await findByText(root, '正序').onclick();
  renderConversation({ ...task, result: body }, {}, root);
  expect(root.querySelector('.conversation-output')).toBe(result); expect(result.expanded).toBe(true);
  expect(root.dataset.order).toBe('asc'); expect(root.querySelector('.conversation-search').querySelector('input').value).toBe('末尾关键词');
  expect(deepText(root)).toContain('正文未读完'); expect(deepText(root)).toContain('未加载或未读完');
}));

test('explicit whole-history search batches through empty pages, matches tail previews, reports exact scanned range, and preserves remote hits on refresh', () => {
  const reads = [];
  return fixture(async url => {
    reads.push(new URL(String(url), 'http://fixture'));
    if (reads.length === 1) return json(page({ event_cursor: 70, message_cursor: 80, has_more_events: true, has_more_messages: true, scanned_events: 50, scanned_messages: 50 }));
    return json(page({ messages: [incoming(1, '只加载了开头', { sender_id: 8, text_truncated: true, total_chars: 30000 })], scanned_events: 3, scanned_messages: 1 }));
  }, async () => {
    const root = renderConversation(task); showOthers(root); type(root, '尾部命中');
    expect(reads).toHaveLength(0); await findByText(root, '查找全部历史').onclick();
    expect(reads).toHaveLength(2); expect(reads[1].searchParams.get('before_event')).toBe('70'); expect(reads[1].searchParams.get('before_message')).toBe('80');
    expect(reads[0].searchParams.get('query')).toBe('尾部命中'); expect(root.querySelectorAll('.conversation-other')).toHaveLength(1);
    expect(deepText(root)).toContain('已扫描 53 个事件、51 条消息'); expect(deepText(root)).toContain('历史命中 1 条');
    root.updateConversation(task); expect(root.querySelectorAll('.conversation-other')).toHaveLength(1);
    expect(deepText(root)).toContain('正文尚未读完');
  });
});

test('cancel, keyword changes, navigation and lifetime abort reject late search pages, with no background restart', async () => {
  for (const mode of ['cancel', 'keyword', 'navigate', 'abort']) {
    let resolve, reads = 0;
    await fixture(() => { reads++; return new Promise(done => { resolve = done; }); }, async () => {
      const root = renderConversation(task), lifetime = new AbortController(); root.bindConversationLifetime(lifetime.signal, () => true);
      showOthers(root); const pending = findByText(root, '查找全部历史').onclick();
      if (mode === 'cancel') await findByText(root, '取消查找').onclick();
      if (mode === 'keyword') type(root, 'new');
      if (mode === 'navigate') ui.view = {};
      if (mode === 'abort') lifetime.abort();
      resolve(json(page({ messages: [incoming(1, '迟到消息')] }))); await pending;
      expect(reads).toBe(1); expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
      if (mode === 'cancel' || mode === 'abort') expect(deepText(root)).toContain('取消');
    });
  }
});

test('history failures and unsupported/limit/unchanged cursors remain incomplete, never reported as no matches; retry is explicit', async () => {
  for (const bad of ['failure', [], page({ has_more_events: true, event_cursor: null }), page({ limitations: ['超限行'] })]) {
    let reads = 0;
    await fixture(async () => { reads++; if (bad === 'failure') throw new Error('offline'); return json(bad); }, async () => {
      const root = renderConversation(task); type(root, '找不到'); await findByText(root, '查找全部历史').onclick();
      expect(reads).toBe(1); expect(deepText(root)).toContain('范围未完成'); expect(deepText(root)).not.toContain('历史正文无命中');
      expect(findByText(root, '查找全部历史').disabled).toBe(false);
    });
  }
});

test('long original body reads bounded segments and remains complete through preview refresh; full text becomes locally searchable', () => fixture(async url => {
  expect(String(url)).toContain('/reading-record?kind=message&record_id=1&offset=24000');
  return json({ text: '完整尾部关键词', offset: 24000, next_offset: 24007, has_more: false, total_chars: 24007 });
}, async () => {
  const root = renderConversation(task); root.updateConversation(task, page({ messages: [incoming(1, 'x'.repeat(24000), { text_truncated: true, total_chars: 24007 })] })); showOthers(root);
  const node = root.querySelector('.conversation-other'); await findByText(node, '继续读取正文').onclick();
  expect(node.expanded).toBe(true); expect(node.querySelector('.conversation-read-more')).toBeNull();
  const original = node.querySelector('.message-original'); original.open = true; for (const listener of original.listeners.toggle || []) listener();
  expect(original.querySelector('pre').textContent).toBe('x'.repeat(24000) + '完整尾部关键词');
  root.updateConversation(task, page({ messages: [incoming(1, 'x'.repeat(24000), { text_truncated: true, total_chars: 24007 })] }));
  expect(root.querySelector('.conversation-other')).toBe(node); type(root, '尾部关键词'); expect(root.querySelectorAll('.conversation-other')).toHaveLength(1);
}));

test('message and event reference navigation reads only the precise row and reveals a hidden/filtered destination', () => {
  const reads = [];
  return fixture(async url => {
    reads.push(String(url)); const query = new URL(String(url), 'http://fixture').searchParams;
    if (query.get('before_message') === '102') return json(page({ messages: [incoming(101, '旧消息')] }));
    return json(page({ events: [{ id: 202, type: 'notice.answered', created_at: at, data: { answer: '明确答复', answer_source: 'lush' } }] }));
  }, async () => {
    const root = renderConversation(task); type(root, '不存在');
    const message = await root.revealConversationReference({ kind: 'message', target: { task_id: 7, message_id: 101 } });
    expect(message.dataset.ref).toContain('message-101'); expect(message.expanded).toBe(true); expect(root.querySelector('[data-conversation-filter="other"]').checked).toBe(true);
    expect(root.querySelector('.conversation-search').querySelector('input').value).toBe('');
    const event = await root.revealConversationReference({ kind: 'history_event', target: { task_id: 7, event_id: 202 } });
    expect(event.dataset.ref).toContain('event-202'); expect(reads).toHaveLength(2);
    expect(reads[0]).toContain('before_event=0'); expect(reads[0]).toContain('before_message=102'); expect(reads[0]).toContain('limit=1');
    expect(reads[1]).toContain('before_event=203'); expect(reads[1]).toContain('before_message=0');
  });
});

test('later user evidence migrates an unknown message without losing full body, raw/outer expansion, or reading node', () => fixture(async () => { throw new Error('no reads'); }, () => {
  const body = '完整正文'.repeat(1000), root = renderConversation({ ...task, messages: [incoming(100, body)] }); showOthers(root);
  const before = root.querySelector('.conversation-other'); before.revealReadingContent();
  const original = before.querySelector('.message-original'); original.open = true; for (const listener of original.listeners.toggle || []) listener();
  root.updateConversation(task, page({ events: [{ ...userEvent(300, 100, body.slice(0, 100)), text_truncated: true, total_chars: body.length }] }));
  const after = root.querySelector('[data-conversation-key="input:300"]'); expect(after).toBe(before); expect(after.expanded).toBe(true);
  expect(after.classList.contains('conversation-other')).toBe(false); expect(after.querySelector('.conversation-avatar').classList.contains('avatar-input')).toBe(true);
  expect(after.querySelector('.message-original').open).toBe(true); expect(after.querySelector('.message-original').querySelector('pre').textContent).toBe(body);
  expect(after.querySelector('.conversation-read-more')).toBeNull();
}));

test('linked user message Event has no inline body but keeps event/message references and reads the exact inbox text', () => fixture(async () => { throw new Error('no reads'); }, async () => {
  const message = incoming(100, '仅收件箱有正文');
  const proof = userEvent(300, 100, ''); delete proof.data.body; proof.message = message;
  const root = renderConversation(task, page({ events: [proof] }));
  const input = root.querySelector('[data-conversation-key="input:300"]'); expect(input).toBeTruthy();
  expect(deepText(input)).toContain('仅收件箱有正文'); expect(input.dataset.ref).toContain('message-100'); expect(input.dataset.ref).toContain('event-300');
  expect(await root.revealConversationReference({ kind: 'history_event', target: { event_id: 300 } })).toBe(input);
  root.updateConversation(task, page({ messages: [message] })); showOthers(root);
  expect(root.querySelectorAll('.conversation-input')).toHaveLength(2); expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
}));

test('bounded metadata and inconsistent evidence are visible independently of complete message text', () => fixture(async () => { throw new Error('no reads'); }, () => {
  const root = renderConversation(task, page({ messages: [incoming(100, '完整正文', { limitations: ['message_field_bounded'],
    input_event: { id: 300, type: 'message', data: { message_id: 100 }, limitations: ['message_event_sender_mismatch'] } })] }));
  showOthers(root); expect(deepText(root)).toContain('附属字段受限'); expect(deepText(root)).toContain('message_field_bounded');
  expect(root.querySelector('.conversation-other').querySelector('.conversation-sender').textContent).toBe('来源不明');
}));

test('message evidence projects user input without an event body in the current history window', () => fixture(async () => { throw new Error('no reads'); }, () => {
  const proof = userEvent(300, 100, '历史输入'); delete proof.data.body;
  const root = renderConversation(task, page({ messages: [incoming(100, '历史输入', { input_event: proof })] }));
  const input = root.querySelector('[data-conversation-key="input:300"]'); expect(input).toBeTruthy();
  expect(input.dataset.ref).toContain('message-100'); expect(input.dataset.ref).toContain('event-300');
  showOthers(root); expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
}));
