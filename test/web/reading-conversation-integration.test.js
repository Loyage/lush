import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';

// Real HTTP -> RPC -> Store projections fed into the merged parent reader; only DOM geometry is stubbed.
test('real reading projections integrate with parent input identity, reference lookup, UTF16 continuation and decision provenance', async () => {
  const f = await setup(), calls = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'integration' });
  const text = 'x'.repeat(23999) + '😀\nTailNeedle';
  const messageId = f.store.message(task.id, text);
  const inputId = f.store.event(task.id, 'message', { sender: null, message_id: messageId, append_number: 'A8-1' });
  const orphanId = f.store.message(task.id, JSON.stringify({ notice_id: 507, dismissed: false, answer_source: 'lush', answer: '旧消息' }));
  const answerId = f.store.event(task.id, 'notice.answered', { notice_id: 507, answer: { text: '自动答复' }, answer_source: 'lush' });
  const dom = installDom({ fetch: async (url, options) => {
    calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options);
  } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const root = renderConversation(task);
    expect(calls).toHaveLength(0);
    const input = await root.revealConversationReference({ kind: 'message', target: { task_id: task.id, message_id: messageId } });
    expect(input.dataset.conversationKey).toBe(`input:${inputId}`);
    expect(input.dataset.ref).toContain(`event-${inputId}`); expect(input.dataset.ref).toContain(`message-${messageId}`);
    expect(calls[0]).toContain('before_event=0'); expect(calls[0]).toContain(`before_message=${messageId + 1}`);
    expect(deepText(input)).toContain('正文尚未读完');
    await findByText(input, '继续读取正文').onclick();
    expect(calls.at(-1)).toContain(`reading-record?kind=event&record_id=${inputId}&offset=23999`);
    expect(input.querySelector('.conversation-read-more')).toBeNull();
    const original = input.querySelector('.message-original'); original.open = true;
    for (const listener of original.listeners.toggle || []) listener();
    expect(original.querySelector('pre').textContent).toBe(text);
    await findByText(root, '加载更早输入与结果').onclick();
    const other = root.querySelector('[data-conversation-filter="other"]'); other.checked = true; other.onchange();
    expect(root.querySelector(`[data-conversation-key="other:message:${orphanId}"]`).querySelector('.conversation-sender').textContent).toBe('来源不明');
    expect(root.querySelector(`[data-conversation-key="other:event:${answerId}"]`).querySelector('.conversation-sender').textContent).toBe('Lush 自动选择');
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(2);
    const keyword = root.querySelector('.conversation-search').querySelector('input'); keyword.value = 'tailneedle'; keyword.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
    await findByText(root, '查找全部历史').onclick();
    expect(deepText(root)).toContain('查找完成');
    expect(root.querySelectorAll('.conversation-input')).toHaveLength(1);
    expect(root.querySelector('.conversation-input').dataset.ref).toContain(`event-${inputId}`);
    expect(root.querySelector('.conversation-input').querySelector('.conversation-read-more')).toBeNull();
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', messageId).consumed).toBe(0);
    expect(f.project.running.size).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});
