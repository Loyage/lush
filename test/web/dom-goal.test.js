import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { absolute } from '../../src/ui/web/assets/format.js';
import { revealDetailPreview } from '../../src/ui/web/assets/detail-preview.js';

const at = '2026-10-02T09:00:00Z';
const task = { id: 7, worker_number: 'W182', role: 'agent', task_kind: 'order', status: 'waiting', goal: '**原始目标**',
  created_at: at, updated_at: at, result: '最新结果' };
const event = (id, body, sender = null) => ({ id, task_id: 7, type: 'message', created_at: `2026-10-02T10:${String(id).padStart(2, '0')}:00Z`,
  input_delivery: { status: 'pending', at: null }, data: { sender, body, message_id: id + 40 } });

test('timeline shows inputs, results and decisions by default; communication remains hidden', () => {
  const dom = installDom();
  try {
    const history = { events: [event(1, '**补充**\n\n- 新要求'), event(2, '**补充**\n\n- 新要求'),
      event(3, 'Agent 消息', 8), { id: 4, type: 'notice.answered', data: { answer: '决策答复' } },
      { id: 5, type: 'task.signal', message: { sender_id: null, body: '系统信号' } }] };
    renderDetail({ ...task, messages: [{ id: 90, sender_id: null, body: '仅属于收件箱的系统消息' }] }, history, null, null);
    const panel = dom.node('detail'), conversation = panel.querySelector('.conversation-panel');
    expect(panel.querySelector('.goal-panel')).toBeNull(); expect(panel.querySelector('.result-panel')).toBeNull();
    expect(deepText(conversation)).toContain('原始目标'); expect(conversation.querySelector('strong')).toBeTruthy();
    expect(conversation.querySelectorAll('.conversation-input')).toHaveLength(3);
    expect(conversation.querySelectorAll('.conversation-output')).toHaveLength(1);
    expect(conversation.querySelectorAll('.conversation-avatar').map(node => node.textContent)).toEqual(['🤖', '?', '?', '?', '决']);
    expect(deepText(conversation)).toContain('决策答复');
    for (const text of ['Agent 消息', '系统信号', '仅属于收件箱']) expect(deepText(conversation)).not.toContain(text);
    const entries = conversation.querySelectorAll('.conversation-message');
    expect(entries.map(node => node.dataset.conversationKey)).toEqual(['latest', 'input:2', 'input:1', 'goal', 'other:event:4']);
    expect(deepText(entries[1])).toContain('账号名称未知'); expect(deepText(entries[0]).replace(/\s+/g, ' ')).toContain('Worker W182');
    expect(entries[1].dataset.ref).toContain('event-2');
    expect(conversation.querySelectorAll('.message-original')).toHaveLength(4); // Decision full text is read on demand.
    renderDetail(task, { events: [...history.events, event(6, '新的输入')] }, null, null);
    expect(panel.querySelector('.conversation-panel')).toBe(conversation);
    expect(conversation.querySelectorAll('.conversation-message')[0]).toBe(entries[0]);
    expect(deepText(conversation)).toContain('新的输入');
  } finally { dom.restore(); }
});

test('content categories retain choices/nodes across refresh while communication-only pages advance without bubbles', async () => {
  const dom = installDom({ fetch: async () => new Response(JSON.stringify({ events: [event(8, '较早通信', 9)], messages: [], event_cursor: 0, message_cursor: 0, has_more_events: false, has_more_messages: false })) });
  try {
    const incoming = { id: 43, task_id: 7, sender_id: 8, sender_worker_number: 'W185-1', body: 'Agent 消息', created_at: at };
    const outgoing = { id: 44, task_id: 8, sender_id: 7, body: '发给其他 Worker', created_at: at };
    const history = { events: [event(1, '用户补充'), event(3, 'Agent 消息', 8),
      { id: 4, type: 'task.signal', message: { id: 45, task_id: 7, sender_id: 8, body: '结算信号' } },
      { id: 5, type: 'task.signal', message: outgoing }], cursor: 50, has_more: true };
    const current = { ...task, messages: [incoming, outgoing] }, root = renderConversation(current, history);
    const filters = root.querySelectorAll('.conversation-filter');
    const selection = () => filters.map(node => node.getAttribute('aria-pressed') === 'true');
    expect(root.querySelector('.conversation-filters').querySelectorAll('input')).toHaveLength(0);
    expect(selection()).toEqual([true, true, true, false]);
    const result = root.querySelector('.conversation-output'), user = root.querySelector('.conversation-input');
    for (const category of ['input', 'output']) await root.querySelector(`[data-conversation-filter="${category}"]`).onclick();
    await root.querySelector('.conversation-more').onclick(); renderConversation(current, history, root);
    expect(selection()).toEqual([false, false, true, false]); expect(root.querySelectorAll('.conversation-message')).toHaveLength(0);
    for (const text of ['Agent 消息', '较早通信', '结算信号', '发给其他 Worker']) expect(deepText(root)).not.toContain(text);
    expect(deepText(root)).toContain('历史已遍历');
    for (const category of ['input', 'output']) await root.querySelector(`[data-conversation-filter="${category}"]`).onclick();
    expect(root.querySelectorAll('.conversation-output')).toContain(result); expect(root.querySelectorAll('.conversation-input')).toContain(user);
    expect(renderConversation({ id: 8, goal: '另一 Worker' }).querySelectorAll('.conversation-filter').map(node => node.getAttribute('aria-pressed') === 'true')).toEqual([true, true, true, false]);
  } finally { dom.restore(); }
});

test('one pager loads both directions of history, retries failure and retains older pages across refresh', async () => {
  const requests = []; let fail = true;
  const dom = installDom({ fetch: async url => {
    if (String(url) === '/api/host/session') return new Response(JSON.stringify({ username: null }));
    requests.push(String(url));
    if (fail) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
    if (!String(url).includes('before_event=20')) return new Response(JSON.stringify({ events: [event(25, 'Agent 消息', 8)], messages: [], event_cursor: 20, message_cursor: 0, has_more_events: true, has_more_messages: false }));
    return new Response(JSON.stringify({ events: [event(1, '<script>old</script>\n第二行'), event(2, '旧输入'),
      { id: 3, type: 'invocation.completed', created_at: at, data: { run_id: 1, result: '更早结果' } }], messages: [], event_cursor: 0, message_cursor: 0, has_more_events: false, has_more_messages: false }));
  } });
  try {
    const history = { events: [event(30, '新输入')], cursor: 50, truncated: true };
    const root = renderConversation(task, history);
    expect(requests).toHaveLength(0);
    await root.querySelector('.conversation-more').onclick(); expect(deepText(root)).toContain('offline');
    fail = false;
    await root.querySelector('.conversation-more').onclick();
    expect(requests.filter(url => url.endsWith('/reading-page?'))).toHaveLength(2);
    await root.querySelector('.conversation-more').onclick();
    expect(requests.some(url => url.includes('before_event=20') && url.includes('before_message=0'))).toBe(true);
    expect(root.querySelector('script')).toBeNull(); expect(deepText(root)).toContain('<script>old</script>');
    expect(deepText(root)).toContain('更早结果'); expect(deepText(root)).toContain('历史已遍历');
    expect(renderConversation(task, history, root)).toBe(root);
    expect(root.querySelector('.conversation-more').hidden).toBe(true);
    await findByText(root, '正序').onclick();
    expect(root.dataset.order).toBe('asc'); expect(findByText(root, '正序').getAttribute('aria-pressed')).toBe('true');
    const nodes = [...root.querySelector('.conversation-list').children];
    renderConversation(task, history, root);
    expect(root.querySelector('.conversation-list').children).toEqual(nodes);
    await findByText(root, '倒序').onclick();
    expect(root.querySelector('.conversation-list').children).toEqual([...nodes].reverse());
  } finally { dom.restore(); }
});

test('input header uses delivery evidence, receipt patch preserves original body and unknown does not invent time', () => {
  const dom = installDom();
  try {
    const followup = event(1, '尚未投递');
    const pending = { ...task, goal_input_delivery: { status: 'pending', at: null } };
    const root = renderConversation(pending, { events: [followup] });
    const entry = root.querySelectorAll('.conversation-input').find(node => node.dataset.conversationKey === 'input:1');
    const body = entry.querySelector('.conversation-prose');
    expect(deepText(entry)).toContain('待输入'); expect(deepText(entry)).not.toContain(absolute(followup.created_at));
    const delivery = { status: 'delivered', at: '2026-10-03T10:30:00Z' };
    renderConversation({ ...task, goal_input_delivery: delivery }, { events: [{ id: 100, type: 'invocation.inputs_delivered',
      input_deliveries: [{ message_id: 41, ...delivery }] }] }, root);
    expect(entry.querySelector('.conversation-prose')).toBe(body);
    expect(deepText(entry)).toContain(`输入时间：${absolute(delivery.at)}`);
    expect(entry.querySelector('time').getAttribute('datetime')).toBe(delivery.at);
    root.updateConversation(task, { events: [{ ...followup, input_delivery: { status: 'unknown', at: null } }] });
    expect(deepText(entry)).toContain('输入时间未知'); expect(entry.querySelector('time').getAttribute('datetime')).toBeNull();
    expect(deepText(root)).toContain('结果时间未知');
  } finally { dom.restore(); }
});

test('long messages retain full DOM, collapse independently and reveal before reference navigation', async () => {
  const dom = installDom();
  try {
    const long = '完整正文\n'.repeat(250);
    renderDetail({ ...task, goal: long }, { events: [event(1, long)] }, null, null);
    const root = dom.node('detail').querySelector('.conversation-panel');
    const entry = root.querySelectorAll('.conversation-input')[0], body = entry.querySelector('.conversation-prose');
    expect(entry.classList.contains('conversation-long')).toBe(true);
    const original = body.querySelector('.message-original'); original.open = true; for (const listener of original.listeners.toggle || []) listener();
    expect(original.querySelector('pre').textContent).toBe(long);
    const toggle = entry.querySelector('.conversation-expand');
    expect(toggle.getAttribute('aria-controls')).toBe(entry.querySelector('.conversation-body').id);
    await toggle.onclick(); expect(toggle.getAttribute('aria-expanded')).toBe('true');
    renderDetail({ ...task, goal: long }, { events: [event(1, long)] }, null, null);
    expect(entry.querySelector('.conversation-prose')).toBe(body); expect(entry.expanded).toBe(true);
    await toggle.onclick(); expect(entry.expanded).toBe(false);
    expect(revealDetailPreview(body)).toBe(true); expect(entry.expanded).toBe(true);
    expect(root.classList.contains('detail-preview-expanded')).toBe(true);
    const short = root.querySelector('.conversation-output'); expect(short.querySelector('.conversation-expand').hidden).toBe(true);
    localStorage.setItem('lush.markdown', '0');
    const plain = renderConversation({ id: 9, goal: '**原文**\n第二行' });
    expect(plain.querySelector('.conversation-prose').querySelector('strong')).toBeNull(); expect(deepText(plain)).toContain('**原文**\n第二行');
    await Promise.resolve();
  } finally { dom.restore(); }
});
