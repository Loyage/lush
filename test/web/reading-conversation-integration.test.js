import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { clear } from '../../src/ui/web/assets/messages.js';

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

test('copy raw output follows real HTTP reading-record pagination and preserves exact persisted text', async () => {
  const f = await setup(), calls = [], copied = [];
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'copy integration' });
  const source = '# 完整原文\n\n' + '  保留空格与换行\n'.repeat(6500) + '\n```\n末尾代码\n```\n';
  const eventId = f.store.event(task.id, 'invocation.completed', { run_id: 88, result: source });
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => copied.push(text) } } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const root = renderConversation(task); expect(calls).toHaveLength(0);
    await findByText(root, '加载更早输入输出').click();
    const output = root.querySelector('[data-conversation-key="run:88"]');
    expect(deepText(output)).toContain('正文尚未读完');
    await output.querySelector('.conversation-copy').click();
    expect(copied).toEqual([source]);
    const reads = calls.filter(url => url.includes('/reading-record?'));
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every(url => url.includes(`record_id=${eventId}`) && url.includes('kind=event'))).toBe(true);
    expect(root.querySelectorAll('.message-original')).toHaveLength(0);
    expect(JSON.parse(f.store.get('SELECT data FROM events WHERE id=?', eventId).data).result).toBe(source);
  } finally {
    clear(); if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
    resetUiState(); dom.restore(); await f.close();
  }
});
