import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { Store } from '../../src/persistence/store.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

function installConversationDom() {
  const dom = installDom(); resetUiState(); ui.hostSession = { status: 'ready', username: '测试用户', pending: null };
  const restore = dom.restore; dom.restore = () => { resetUiState(); restore(); }; return dom;
}
const at = '2026-10-11T06:00:00Z';
const task = { id: 7, worker_number: 'W201', input_id: 201, goal: '目标', created_at: at };
const user = (id, body) => ({ id, task_id: 7, sender_id: null, body, created_at: at });
const userEvent = message => ({ id: message.id, type: 'message', created_at: at,
  data: { sender: null, message_id: message.id, body: message.body, append_number: message.append_number }, input_delivery: { status: 'pending', at: null } });
const lifecycle = (message, type, id) => ({ id, type, created_at: at, data: { message_id: message.id }, message });

test('routing/frozen/released events never repeat user input; JSON-looking pasted input stays user content across pages', async () => {
  const dom = installConversationDom();
  try {
    const messages = [user(41, '用户追加需求'), user(42, '{"version":1,"signal":"child.completed","payload":{"result":"用户粘贴"}}')]
      .map((message, i) => ({ ...message, append_number: `A201-${i + 1}` }));
    const root = renderConversation({ ...task, messages }, { events: messages.flatMap(message =>
      ['task.input_routed', 'task.input_buffered', 'task.input_released'].map((type, i) => lifecycle(message, type, message.id + 100 + i))) });
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    root.updateConversation({ ...task, messages }, { events: messages.map(userEvent) });
    root.updateConversation({ ...task, messages }, { events: messages.map(message => lifecycle(message, 'task.input_routed', message.id + 100)) });
    expect(root.querySelectorAll('.conversation-input')).toHaveLength(3); expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    const pasted = root.querySelector('[data-conversation-key="input:42"]');
    expect(pasted.querySelector('.conversation-sender').textContent).toBe('测试用户'); expect(pasted.querySelector('.conversation-avatar').textContent).toBe('测');
    expect(pasted.querySelector('.conversation-kind').textContent).toBe('追加输入 · A201-2'); expect(deepText(pasted)).toContain(messages[1].body);
    expect(pasted.querySelector('.message-title')).toBeNull();
    expect(await root.revealConversationReference({ kind: 'history_event', target: { event_id: 141 } })).toBeNull();
  } finally { dom.restore(); }
});

test('real SQLite history keeps communication and routing available but only original user evidence enters input/output', async () => {
  const dom = installConversationDom(), store = new Store(':memory:', '/tmp/lush-input-output-communication-test');
  try {
    const current = store.create({ role: 'agent', goal: '目标' }), child = store.create({ parent_id: current.id, role: 'agent', goal: '子目标' });
    const messageId = store.message(current.id, '追加需求');
    const inputEvent = store.event(current.id, 'message', { sender: null, body: '追加需求', message_id: messageId });
    for (const type of ['task.input_buffered', 'task.input_released', 'task.input_routed']) store.event(current.id, type, { message_id: messageId });
    const signal = store.signal(current.id, child.id, 'child.completed', 'settled', JSON.stringify({ version: 1, signal: 'child.completed', payload: { result: '子成果' } }));
    const signalEvent = store.event(current.id, 'task.signal', { message_id: signal.id });
    const latest = store.historyPage(current.id, null, 4);
    expect(latest.events.filter(event => event.message?.id === messageId)).toHaveLength(3);
    expect(latest.events.find(event => event.id === signalEvent).message.body).toContain('子成果');
    const root = renderConversation(current, latest);
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(0); expect(deepText(root)).not.toContain('追加需求');
    root.updateConversation(current, store.historyPage(current.id, latest.cursor)); root.updateConversation(current, latest);
    expect(root.querySelectorAll('.conversation-input')).toHaveLength(2); expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    expect(root.querySelector(`[data-conversation-key="input:${inputEvent}"]`)).toBeTruthy(); expect(deepText(root)).not.toContain('子成果');
    expect(await root.revealConversationReference({ kind: 'message', target: { message_id: signal.id } })).toBeNull();
    expect(await root.revealConversationReference({ kind: 'history_event', target: { event_id: signalEvent } })).toBeNull();
    expect(store.readingPage(current.id).messages.find(message => message.id === signal.id).body).toContain('子成果');
  } finally { store.close(); dom.restore(); }
});

test('typed system/Worker signals, JSON envelopes and outbound communication never get content filters or reference aliases', async () => {
  const dom = installConversationDom();
  try {
    const bodies = ['{"items":[1,2],"text":"第一行\\n第二行"}', '[1,2]', '{"broken":\n<script>alert(1)</script>',
      '{"notice_id":472,"notice_kind":"questionnaire","dismissed":false,"answer":"不能靠外观识别决策"}'];
    const messages = bodies.map((body, i) => ({ id: i + 61, task_id: 7, sender_id: null, signal_type: 'runtime.test', body, created_at: at }));
    const worker = { id: 51, task_id: 7, sender_id: 8, sender_worker_number: 'W201-1', body: '其他 Worker 成果' };
    const outgoing = { id: 80, sender_id: 7, task_id: 8, body: '发给其他 Worker' };
    const root = renderConversation({ ...task, messages: [...messages, worker, outgoing] }, { events: [...messages, worker, outgoing].map((message, i) => lifecycle(message, 'task.signal', 180 + i)) });
    expect(root.querySelectorAll('.conversation-message')).toHaveLength(1); expect(root.querySelector('[data-conversation-filter="other"]')).toBeNull();
    for (const message of [...messages, worker, outgoing]) {
      expect(await root.revealConversationReference({ kind: 'message', target: { message_id: message.id } })).toBeNull();
      expect(deepText(root)).not.toContain(message.body);
    }
    expect(root.querySelector('script')).toBeNull();
  } finally { dom.restore(); }
});
