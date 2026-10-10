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

test('one conversation shows original goal, explicit user followups and results; excludes runtime/Agent messages', () => {
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
    expect(conversation.querySelectorAll('.conversation-avatar').map(node => node.textContent)).toEqual(['W', '人', '人', '人']);
    for (const text of ['Agent 消息', '决策答复', '系统信号', '仅属于收件箱']) expect(deepText(conversation)).not.toContain(text);
    const entries = conversation.querySelectorAll('.conversation-message');
    expect(entries.map(node => node.dataset.conversationKey)).toEqual(['latest', 'input:2', 'input:1', 'goal']);
    expect(deepText(entries[1])).toContain('用户'); expect(deepText(entries[0]).replace(/\s+/g, ' ')).toContain('Worker W182');
    expect(entries[1].dataset.ref).toContain('event-2');
    expect(conversation.querySelectorAll('details')).toHaveLength(0);
    renderDetail(task, { events: [...history.events, event(6, '新的输入')] }, null, null);
    expect(panel.querySelector('.conversation-panel')).toBe(conversation);
    expect(conversation.querySelectorAll('.conversation-message')[0]).toBe(entries[0]);
    expect(deepText(conversation)).toContain('新的输入');
  } finally { dom.restore(); }
});

test('one pager loads both directions of history, retries failure and retains older pages across refresh', async () => {
  const requests = []; let fail = true;
  const dom = installDom({ fetch: async url => {
    requests.push(String(url));
    if (fail) return new Response(JSON.stringify({ error: 'offline' }), { status: 500 });
    if (String(url).includes('before=50')) return new Response(JSON.stringify({ events: [event(25, 'Agent 消息', 8)], cursor: 20, has_more: true }));
    return new Response(JSON.stringify({ events: [event(1, '<script>old</script>\n第二行'), event(2, '旧输入'),
      { id: 3, type: 'invocation.completed', created_at: at, data: { run_id: 1, result: '更早结果' } }], cursor: 1, has_more: false }));
  } });
  try {
    const history = { events: [event(30, '新输入')], cursor: 50, truncated: true };
    const root = renderConversation(task, history);
    expect(requests).toHaveLength(0);
    await findByText(root, '加载更早对话').onclick(); expect(deepText(root)).toContain('offline');
    fail = false;
    await findByText(root, '加载更早对话').onclick();
    expect(requests.filter(url => url.includes('before=50'))).toHaveLength(2);
    await findByText(root, '加载更早对话').onclick();
    expect(requests.some(url => url.includes('before=20'))).toBe(true);
    expect(root.querySelector('script')).toBeNull(); expect(deepText(root)).toContain('<script>old</script>');
    expect(deepText(root)).toContain('更早结果'); expect(deepText(root)).toContain('已读取全部对话历史');
    expect(renderConversation(task, history, root)).toBe(root);
    expect(findByText(root, '加载更早对话').hidden).toBe(true);
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
    expect(deepText(body).replace(/\s+/g, '')).toBe(long.replace(/\s+/g, ''));
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
