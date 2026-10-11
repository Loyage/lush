import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { Store } from '../../src/persistence/store.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

function installConversationDom() {
  const dom = installDom();
  resetUiState();
  ui.hostSession = { status: 'ready', username: '测试用户', pending: null };
  const restore = dom.restore;
  dom.restore = () => { resetUiState(); restore(); };
  return dom;
}

const at = '2026-10-11T06:00:00Z';
const task = { id: 7, worker_number: 'W201', input_id: 201, goal: '目标', created_at: at };
const showCommunication = root => {
  const filter = root.querySelector('[data-conversation-filter="other"]');
  filter.checked = true; filter.onchange();
};
const expand = node => { node.open = true; for (const handler of node.listeners.toggle || []) handler(); };
const user = (id, body) => ({ id, task_id: 7, sender_id: null, body, created_at: at });
const userEvent = message => ({ id: message.id, type: 'message', created_at: at,
  data: { sender: null, message_id: message.id, body: message.body, append_number: message.append_number }, input_delivery: { status: 'pending', at: null } });
const lifecycle = (message, type, id) => ({ id, type, created_at: at, data: { message_id: message.id }, message });

test('routing, frozen/released events never repeat user input as system communication, across pages and refresh', () => {
  const dom = installConversationDom();
  try {
    // A user can paste a signal-shaped JSON object: source identity must not depend on its text.
    const messages = [user(41, '用户追加需求'), user(42, '{"version":1,"signal":"child.completed","payload":{"result":"用户粘贴"}}')]
      .map((message, i) => ({ ...message, append_number: `A201-${i + 1}` }));
    const root = renderConversation({ ...task, messages }, { events: messages.flatMap(message =>
      ['task.input_routed', 'task.input_buffered', 'task.input_released'].map((type, i) => lifecycle(message, type, message.id + 100 + i))) });
    showCommunication(root);
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    root.updateConversation({ ...task, messages }, { events: messages.map(userEvent) });
    expect(root.querySelectorAll('.conversation-input')).toHaveLength(3);
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    root.updateConversation({ ...task, messages }, { events: messages.map(message => lifecycle(message, 'task.input_routed', message.id + 100)) });
    expect(root.querySelectorAll('.conversation-input')).toHaveLength(3);
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    const pasted = root.querySelectorAll('.conversation-input').find(node => node.dataset.conversationKey === 'input:42');
    expect(pasted.querySelector('.conversation-sender').textContent).toBe('测试用户');
    expect(pasted.querySelector('.conversation-avatar').textContent).toBe('测');
    expect(pasted.querySelector('.conversation-kind').textContent).toBe('追加输入 · A201-2');
    expect(root.querySelector('[data-conversation-key="goal"]').querySelector('.conversation-kind').textContent).toBe('原始目标 · O201');
    expect(deepText(pasted)).toContain(messages[1].body);
    expect(pasted.querySelector('.message-title')).toBeNull();
  } finally { dom.restore(); }
});

test('SQLite history projection joins lifecycle messages without creating duplicate conversation bubbles', () => {
  const dom = installConversationDom(), store = new Store(':memory:', '/tmp/lush-w201-conversation-test');
  try {
    const current = store.create({ role: 'agent', goal: '目标' });
    const child = store.create({ parent_id: current.id, role: 'agent', goal: '子目标' });
    const messageId = store.message(current.id, '追加需求');
    const inputEvent = store.event(current.id, 'message', { sender: null, body: '追加需求', message_id: messageId });
    for (const type of ['task.input_buffered', 'task.input_released', 'task.input_routed']) store.event(current.id, type, { message_id: messageId });
    const signal = store.signal(current.id, child.id, 'child.completed', 'settled',
      JSON.stringify({ version: 1, signal: 'child.completed', payload: { result: '子成果' } }));
    store.event(current.id, 'task.signal', { message_id: signal.id });
    // The latest page contains joined message bodies but not the original user event.
    const latest = store.historyPage(current.id, null, 4);
    expect(latest.events.filter(event => event.message?.id === messageId)).toHaveLength(3);
    const root = renderConversation(current, latest); showCommunication(root);
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(1);
    expect(deepText(root)).not.toContain('追加需求');
    root.updateConversation(current, store.historyPage(current.id, latest.cursor));
    root.updateConversation(current, latest);
    expect(root.querySelectorAll('.conversation-input')).toHaveLength(2);
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(1);
    expect(root.querySelector(`[data-conversation-key="input:${inputEvent}"]`)).toBeTruthy();
    expect(deepText(root)).toContain('子 Worker 完成'); expect(deepText(root)).toContain('子成果');
  } finally { store.close(); dom.restore(); }
});

test('left-side communication reuses semantic bodies, original envelope and stable expansion without duplicating metadata', () => {
  const dom = installConversationDom();
  try {
    const incoming = { id: 51, task_id: 7, sender_id: 8, sender_worker_number: 'W201-1', signal_type: 'child.failed',
      created_at: at, body: JSON.stringify({ version: 1, signal: 'child.failed', key: 'internal-key',
        payload: { error: '测试失败\n保留日志', result: '**部分结果**', commit: 'abc123', result_truncated: true } }) };
    const root = renderConversation({ ...task, messages: [incoming] }, { events: [lifecycle(incoming, 'task.signal', 101)] });
    expect(deepText(root)).toContain('系统与 Worker 通信');
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    showCommunication(root);
    const cards = root.querySelectorAll('.conversation-other');
    expect(cards).toHaveLength(1);
    const card = cards[0], text = deepText(card);
    for (const word of ['Worker W201-1', 'Worker 通信', '通信时间', '子 Worker 失败', '测试失败', '部分结果', '提交', 'abc123', '截断']) expect(text).toContain(word);
    expect(text).not.toContain('internal-key');
    expect(card.classList.contains('conversation-input')).toBe(false);
    expect(card.classList.contains('conversation-output')).toBe(false);
    expect(card.classList.contains('conversation-failed')).toBe(true);
    expect(card.querySelector('.message-meta')).toBeNull();
    expect(card.querySelector('strong')).toBeTruthy();
    expect(card.dataset.ref).toContain('message-51'); expect(card.dataset.ref).toContain('event-101');
    const original = card.querySelector('.message-original');
    expect(original.querySelector('pre')).toBeNull();
    expand(original);
    expect(original.querySelector('pre').textContent).toBe(incoming.body);
    const body = card.querySelector('.conversation-prose');
    root.updateConversation({ ...task, messages: [incoming] }, { events: [lifecycle(incoming, 'task.signal', 101)] });
    expect(root.querySelector('.conversation-other')).toBe(card);
    expect(card.querySelector('.conversation-prose')).toBe(body);
    expect(original.open).toBe(true);
  } finally { dom.restore(); }
});

test('unknown JSON uses bounded trees; invalid JSON is safe text; only explicit system evidence admits senderless messages', () => {
  const dom = installConversationDom();
  try {
    const bodies = ['{"items":[1,2],"text":"第一行\\n第二行"}', '[1,2]', '{"broken":\n<script>alert(1)</script>',
      '{"notice_id":472,"notice_kind":"questionnaire","dismissed":false,"answer":"继续靠左"}'];
    const messages = bodies.map((body, i) => ({ id: i + 61, task_id: 7, sender_id: null, signal_type: 'runtime.test', body, created_at: at }));
    const outgoing = { id: 80, sender_id: 7, task_id: 8, body: '发给其他 Worker' };
    const root = renderConversation({ ...task, messages: [...messages, outgoing] }, { events: [lifecycle(outgoing, 'task.signal', 180)] });
    showCommunication(root);
    const cards = root.querySelectorAll('.conversation-other');
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(deepText(card)).toContain('系统'); expect(deepText(card)).toContain('系统通信');
      const original = card.querySelector('.message-original'); expand(original);
      expect(original.querySelector('pre').textContent).toBe(messages.find(message => `other:message:${message.id}` === card.dataset.conversationKey).body);
    }
    expect(cards.filter(card => card.querySelector('.json-tree'))).toHaveLength(2);
    expect(root.querySelector('script')).toBeNull();
    expect(deepText(root)).toContain('alert(1)');
    expect(deepText(root)).toContain('已答复决策'); expect(deepText(root)).toContain('继续靠左');
    expect(deepText(root)).not.toContain('发给其他 Worker');
  } finally { dom.restore(); }
});
