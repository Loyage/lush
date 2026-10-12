import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';

// Isolated, authenticated real Host -> RPC -> Store and actual reader; never the user's project.
test('old inbox-only user Event and arbitrary historical Event references load exact rows, retain nodes on refresh, without scanning whole history', async () => {
  const f = await setup(), calls = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: '引用整合' });
  const messageId = f.store.message(task.id, '历史原文只有收件箱有');
  const eventId = f.store.event(task.id, 'message', { sender: null, message_id: messageId, append_number: 'A214-7' });
  const reservedId = f.store.event(task.id, 'task.reserved', { marker: '历史事件准确定位' });
  for (let i = 0; i < 150; i++) f.store.event(task.id, 'invocation.completed', { run_id: 1000 + i, result: `无关结果 ${i}` });
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const initial = f.store.historyPage(task.id); expect(initial.events.some(event => event.id === eventId)).toBe(false);
    renderDetail(task, initial, null, null); const panel = dom.node('detail'), root = panel.querySelector('.conversation-panel');
    expect(calls).toHaveLength(0);
    expect(root.attachReferencedHistoryEvent).toBeUndefined();
    expect(panel.querySelectorAll('h2').map(node => node.textContent)).not.toContain('事件时间线');
    const input = await root.revealConversationReference({ kind: 'history_event', target: { task_id: task.id, event_id: eventId } });
    expect(input).toBeTruthy(); expect(deepText(input)).toContain('历史原文只有收件箱有');
    expect(input.dataset.ref).toContain(`message-${messageId}`); expect(input.dataset.ref).toContain(`event-${eventId}`);
    expect(input.querySelector('.conversation-kind').textContent).toContain('A214-7');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('before_message=0'); expect(calls[0]).toContain(`before_event=${eventId + 1}`);
    const event = await root.revealConversationReference({ kind: 'history_event', target: { task_id: task.id, event_id: reservedId } });
    expect(event.dataset.ref).toBe(`event-${reservedId}`); expect(deepText(event)).toContain('历史事件准确定位');
    expect(root.querySelector(`[data-conversation-key="history:${reservedId}"]`)).toBe(event);
    expect(event.expanded).toBe(true);
    expect(calls).toHaveLength(2); expect(calls[1]).toContain('limit=1');
    renderDetail({ ...task, display_title: '刷新后的标题' }, initial, null, null);
    expect(panel.querySelector('.conversation-panel')).toBe(root); expect(root.querySelector(`[data-conversation-key="input:${eventId}"]`)).toBe(input);
    expect(panel.querySelector(`[data-ref="event-${reservedId}"]`)).toBe(event);
    expect(panel.querySelectorAll('h2').map(node => node.textContent)).not.toContain('事件时间线');
    const fromMessage = await root.revealConversationReference({ kind: 'message', target: { task_id: task.id, message_id: messageId } });
    expect(fromMessage).toBe(input); expect(calls).toHaveLength(2);
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', messageId).consumed).toBe(0);
    expect(f.project.running.size).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});

test('whole-history search reaches past 100 records and preview, preserves unguessed sources, accurate no-hit range and unreadable failure', async () => {
  const f = await setup(), calls = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: '查找整合' });
  const body = '前文'.repeat(15000) + '😀TailNeedle';
  const messageId = f.store.message(task.id, body);
  const inputId = f.store.event(task.id, 'message', { sender: null, message_id: messageId });
  const rawId = f.store.message(task.id, JSON.stringify({ notice_id: 507, answer_source: 'lush', dismissed: false, answer: 'TailNeedle' }));
  const decisionId = f.store.event(task.id, 'notice.answered', { answer_source: 'user', answer: 'TailNeedle' });
  f.store.transaction(() => {
    for (let i = 0; i < 155; i++) { f.store.message(task.id, `无关旧消息 ${i}`); f.store.event(task.id, 'invocation.completed', { run_id: i, result: `无关结果 ${i}` }); }
  });
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const root = renderConversation(task), keyword = root.querySelector('.conversation-search').querySelector('input');
    keyword.value = 'TailNeedle'; keyword.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); expect(calls).toHaveLength(0);
    await findByText(root, '查找全部历史').onclick(); expect(calls).toHaveLength(4);
    expect(deepText(root)).toContain('查找完成'); expect(deepText(root)).toContain('已扫描 158 个事件、157 条消息');
    const input = root.querySelector('.conversation-input'); expect(input.dataset.ref).toContain(`event-${inputId}`);
    expect(input.querySelector('.conversation-read-more')).toBeTruthy(); expect(deepText(input)).not.toContain('😀TailNeedle');
    await findByText(input, '继续读取正文').onclick();
    const original = input.querySelector('.message-original'); original.open = true; for (const listener of original.listeners.toggle || []) listener();
    expect(original.querySelector('pre').textContent).toBe(body);
    const show = root.querySelector('[data-conversation-filter="other"]'); show.onclick();
    expect(root.querySelector(`[data-conversation-key="other:message:${rawId}"]`).querySelector('.conversation-sender').textContent).toBe('来源不明');
    expect(root.querySelector(`[data-conversation-key="other:event:${decisionId}"]`).querySelector('.conversation-sender').textContent).toBe('用户答复');
    keyword.value = '不存在的词'; keyword.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); await findByText(root, '查找全部历史').onclick();
    expect(deepText(root)).toContain('历史正文无命中'); expect(deepText(root)).toContain('已扫描 158 个事件、157 条消息');
    f.store.run('INSERT INTO events(task_id,type,data) VALUES (?,?,?)', task.id, 'old', '{broken');
    await findByText(root, '查找全部历史').onclick();
    expect(deepText(root)).toContain('invalid_event_json'); expect(deepText(root)).toContain('范围未完成');
    expect(deepText(root)).not.toContain('历史正文无命中'); expect(deepText(root)).toContain('已扫描 50 个事件、50 条消息');
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', messageId).consumed).toBe(0); expect(f.project.running.size).toBe(0);
  } finally { resetUiState(); dom.restore(); await f.close(); }
});
