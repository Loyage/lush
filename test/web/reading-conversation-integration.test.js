import { test, expect } from 'bun:test';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { renderWorkerTimeline } from '../../src/ui/web/assets/render-worker-timeline.js';
import { clear } from '../../src/ui/web/assets/messages.js';

test('real HTTP reading projections preserve submitters, locate an input and search its stored history', async () => {
  const f = await setup(), calls = [];
  const valet = f.store.create({ role: 'manager', task_kind: 'management', goal: 'submit inputs' });
  const source = { kind: 'valet', worker_id: valet.id, worker_number: valet.worker_number };
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'integration', input_source: source });
  const messageId = f.store.message(task.id, '记录中的 needle 输入');
  const eventId = f.store.event(task.id, 'message', { sender: null, message_id: messageId, append_number: 'A8-1' });
  const valetMessage = f.store.message(task.id, '管家挂载追加');
  f.store.event(task.id, 'message', { sender: null, message_id: valetMessage, body: '管家挂载追加', input_source: source, user_append: false });
  const user = f.store.create({ role: 'agent', goal: 'user goal', input_source: { kind: 'user' } });
  const legacy = f.store.create({ role: 'agent', goal: 'old goal without source' });
  const inspect = async id => (await httpFetch(`${f.url}/api/worker/${id}`)).json();
  const [detail, userDetail, legacyDetail] = await Promise.all([inspect(task.id), inspect(user.id), inspect(legacy.id)]);
  const dom = installDom({ fetch: (url, options) => { calls.push(String(url)); return httpFetch(new URL(String(url), f.url).href, options); } });
  resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户' };
  try {
    const root = renderConversation(detail); expect(calls).toHaveLength(0);
    expect(root.querySelector('[data-conversation-key="goal"]').querySelector('.conversation-sender').textContent).toBe(`管家 ${valet.worker_number}`);
    expect(root.querySelector('[data-conversation-key="goal"]').querySelector('.conversation-avatar').textContent).toBe('🤖');
    expect(renderConversation(userDetail).querySelector('.conversation-sender').textContent).toBe('测试用户');
    expect(renderConversation(legacyDetail).querySelector('.conversation-sender').textContent).toBe('来源未知');
    expect(root.querySelector('[data-conversation-filter="input"]').textContent).toContain('输入指令');
    const mounted = root.querySelector(`[data-conversation-key="input:message:${valetMessage}"]`);
    expect(mounted.querySelector('.conversation-sender').textContent).toBe(`管家 ${valet.worker_number}`);
    expect(mounted.querySelector('.conversation-kind').textContent).not.toContain('A');
    await findByText(root, '加载更早输入输出').onclick();
    expect(root.querySelectorAll('.conversation-input').find(node => node.entry.messageId === valetMessage)
      .querySelector('.conversation-sender').textContent).toBe(`管家 ${valet.worker_number}`);
    const input = await root.revealConversationReference({ kind: 'message', target: { task_id: task.id, message_id: messageId } });
    expect(input.dataset.conversationKey).toBe(`input:${eventId}`); expect(deepText(input)).toContain('needle 输入');
    expect(input.querySelector('.conversation-sender').textContent).toBe('测试用户');
    const sort = root.querySelector('.conversation-order').querySelector('button'), reads = calls.length;
    await sort.onclick(); expect(deepText(sort).trim()).toBe('最早在前'); expect(calls).toHaveLength(reads);
    expect(root.querySelector(`[data-conversation-key="input:${eventId}"]`)).toBe(input);
    expect(root.querySelector('.ui-list-pagination').querySelector('.conversation-more')).not.toBeNull();
    const keyword = root.querySelector('.conversation-search').querySelector('input');
    keyword.value = 'needle'; keyword.listeners.keydown[0]({ key: 'Enter', preventDefault() {} });
    await findByText(root, '查找全部历史').onclick();
    expect(deepText(root)).toContain('查找完成'); expect(root.querySelectorAll('.conversation-input')).toHaveLength(1);
    expect(root.querySelector('.conversation-input').dataset.ref).toContain(`event-${eventId}`);
    expect(f.store.get('SELECT consumed FROM messages WHERE id=?', messageId).consumed).toBe(0);
    const timeline = renderWorkerTimeline(task);
    await findByText(timeline, '加载更早时间线').onclick();
    const record = timeline.querySelector(`[data-lifecycle-record="event:${eventId}"]`), timelineReads = calls.length;
    expect(record.dataset.lifecycleRecord).toBe(`event:${eventId}`);
    expect(deepText(record)).toContain('A8-1');
    await timeline.querySelector('.lifecycle-order').querySelector('button').onclick();
    expect(timeline.querySelector(`[data-lifecycle-record="event:${eventId}"]`)).toBe(record); expect(calls).toHaveLength(timelineReads);
    expect(timeline.querySelector('.ui-list-pagination').querySelector('.lifecycle-more')).not.toBeNull();
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
