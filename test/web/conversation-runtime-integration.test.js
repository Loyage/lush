import { test, expect, setDefaultTimeout } from 'bun:test';
import { repo } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { rawFetch } from './auth-fixture.js';
import { installDom } from '../dom-stub.js';
import { renderConversation } from '../../src/ui/web/assets/render-conversation.js';
import { loadHostSession } from '../../src/ui/web/assets/host-session.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
setDefaultTimeout(30000);

const get = async (f, route) => (await fetch(f.url + route)).json();
async function post(f, method, params) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  expect(response.status).toBe(200); return response.json();
}

// Real Git/SQLite/RPC/HTTP identity and number projections, then the actual conversation renderer.
// No model calls or access to the user's project, authentication file, daemon or Host.
test('logged-in conversation renders original O, frozen durable A and historical message fallback from real HTTP', async () => {
  const f = await setup(); f.project.stopping = true;
  let dom;
  try {
    await repo(f.root);
    expect(f.web.hostname).toBe('127.0.0.1');
    expect((await rawFetch(f.url + '/api/host/session')).status).toBe(401);
    const { task } = await post(f, 'order.submit', { content: 'original conversation input', start: false });
    const child = await f.project.spawn(task.id, 'child conversation');
    // Historical records are not assigned an A number retroactively.
    const oldId = f.store.message(task.id, 'historical append');
    f.store.event(task.id, 'message', { sender: null, body: 'historical append', message_id: oldId });
    await post(f, 'worker.message', { id: child.id, body: 'first associated append' });
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1,
      status: 'blocked', parent_id: task.parent_id, commit: task.base_commit }) });
    const saved = await post(f, 'worker.message', { id: task.id, body: 'frozen user append' });
    expect(saved.input_queue.buffered).toBe(1);
    const inspected = await get(f, `/api/worker/${task.id}`);
    const childInspected = await get(f, `/api/worker/${child.id}`);
    expect(childInspected.messages.find(message => message.body === 'first associated append').append_number).toBe(`A${task.input_id}-1`);
    const appended = inspected.messages.find(message => message.body === 'frozen user append');
    expect(appended.append_number).toBe(`A${task.input_id}-2`);
    expect(appended.delivery_hold).toBe('frozen');
    const page = await get(f, `/api/worker/${task.id}/history-page`);
    const numberedEvent = page.events.find(event => event.data?.message_id === appended.id && event.type === 'message');
    expect(numberedEvent.data.append_number).toBe(appended.append_number);
    expect(numberedEvent.input_delivery.status).toBe('pending');
    const reads = [];
    dom = installDom({ fetch: (url, options) => { reads.push(String(url)); return fetch(f.url + url, options); } });
    resetUiState(); ui.view = { id: 'task', task: task.id };
    dom.location.pathname = '/p/0123456789abcdef/';
    await loadHostSession();
    expect(reads).toEqual(['/api/host/session']);
    expect(ui.hostSession.username).toBe('fixture-user');
    const root = renderConversation({ ...inspected, result: 'worker output' }, page);
    dom.node('detail').append(root);
    const original = root.querySelectorAll('.conversation-message').find(node => node.dataset.conversationKey === 'goal');
    expect(original.querySelector('.conversation-kind').textContent).toBe(`原始目标 · O${task.input_id}`);
    expect(original.querySelector('.conversation-sender').textContent).toBe('fixture-user');
    expect(original.querySelector('.conversation-avatar').textContent).toBe('f');
    const frozen = root.querySelectorAll('.conversation-message').find(node => node.dataset.conversationKey === `input:${numberedEvent.id}`);
    expect(frozen.querySelector('.conversation-kind').textContent).toBe(`追加输入 · A${task.input_id}-2`);
    expect(frozen.querySelector('.conversation-time').textContent).toBe('待输入');
    const oldEvent = page.events.find(event => event.data?.message_id === oldId && event.type === 'message');
    const historical = root.querySelectorAll('.conversation-message').find(node => node.dataset.conversationKey === `input:${oldEvent.id}`);
    expect(historical.querySelector('.conversation-kind').textContent).toBe(`追加输入 · 消息 #${oldId}`);
    expect(root.querySelector('.conversation-output').querySelector('.conversation-avatar').textContent).toBe('🤖');
    const communications = root.querySelector('[data-conversation-filter="other"]');
    communications.onclick();
    // Numbered/frozen appends and their joined routing/buffering events are still one user entry each.
    expect(root.querySelectorAll('.conversation-input')).toHaveLength(3);
    expect(root.querySelectorAll('.conversation-other')).toHaveLength(0);
    expect(frozen.querySelector('.conversation-kind').textContent).toBe(`追加输入 · A${task.input_id}-2`);
    expect(f.store.unreadPage(task.id).messages.some(message => message.id === appended.id)).toBe(false);
    expect(f.store.get('SELECT append_number FROM messages WHERE id=?', oldId).append_number).toBeNull();
  } finally { resetUiState(); dom?.restore(); await f.close(); }
});
