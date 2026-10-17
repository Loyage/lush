import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';

test('real HTTP reading projections locate a user input and search all its stored history', async () => {
  const f = await setup(), calls = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'integration' });
  const messageId = f.store.message(task.id, '记录中的 needle 输入');
  const eventId = f.store.event(task.id, 'message', { sender: null, message_id: messageId, append_number: 'A8-1' });
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const root = renderConversation(task); expect(calls).toHaveLength(0);
    const input = await root.revealConversationReference({ kind: 'message', target: { task_id: task.id, message_id: messageId } });
    expect(input.dataset.conversationKey).toBe(`input:${eventId}`); expect(deepText(input)).toContain('needle 输入');
    const keyword = root.querySelector('.conversation-search').querySelector('input');
    keyword.value = 'needle'; keyword.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
    await findByText(root, '查找全部历史').onclick();
    expect(deepText(root)).toContain('查找完成'); expect(root.querySelectorAll('.conversation-input')).toHaveLength(1);
    expect(root.querySelector('.conversation-input').dataset.ref).toContain(`event-${eventId}`);
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', messageId).consumed).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});
