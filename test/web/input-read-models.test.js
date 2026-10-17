import { test, expect } from 'bun:test';
import { repo, until } from '../helpers.js';
import { RPCClient } from '../../src/rpc/client.js';
import { setup, fetch } from './harness.js';

async function prepared() {
  const f = await setup(); f.project.stopping = true; f.project.kick = () => {};
  f.project.scheduleInputEmissions = () => {};
  await repo(f.root); await f.project.ensureMainTask();
  f.get = async path => { const response = await fetch(f.url + path); expect(response.status).toBe(200); return response.json(); };
  f.action = async (method, params) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); return response.json();
  };
  f.drain = async () => { f.project.stopping = false; try { await f.project.drainInputEmissions(); } finally { f.project.stopping = true; } };
  return f;
}

test('real HTTP/RPC/SQLite/Git reads separate waiting drafts from actual sends and preserve conditional receipts and creation times', async () => {
  const f = await prepared();
  try {
    const original = await f.action('order.submit', { content: 'target', start: false });
    const order = await f.action('draft.add', { content: 'order later', exclusive: true });
    const append = await f.action('draft.add', { content: 'append later', mode: 'append', target_id: original.task.id, conditions: [{ kind: 'parent_quiet' }] });
    const old = '2001-01-01T00:00:00.000Z';
    f.store.run('UPDATE drafts SET created_at=? WHERE id IN (?,?)', old, order.id, append.id);
    await f.action('input.emit', { draft_id: order.id, expected_revision: order.revision });
    await f.action('input.emit', { draft_id: append.id, expected_revision: append.revision });
    expect((await f.get('/api/inputs')).items.map(item => item.kind)).toEqual(['input']);
    expect((await f.get('/api/inputs?view=drafts')).items.map(item => item.kind)).toEqual(['draft', 'draft']);
    expect((await f.get('/api/inputs?conditional=mounted')).items).toHaveLength(2);
    expect((await f.get('/api/inputs?conditional=configured')).items).toHaveLength(2);
    // Cancel just the append condition, then remount with no conditions so actual delivery is controllable.
    const cancelled = await f.action('input.emission_cancel', { draft_id: append.id, expected_revision: append.revision });
    expect(cancelled.dispatch.state).toBe('cancelled');
    expect((await f.get('/api/inputs?view=drafts')).items).toHaveLength(2);
    const edited = await f.action('draft.update', { id: append.id, expected_revision: append.revision, content: append.content, conditions: [] });
    await f.action('input.emit', { draft_id: append.id, expected_revision: edited.revision });
    // The original paused Worker would block exclusivity: release that option before dispatch.
    await f.action('input.emission_cancel', { draft_id: order.id, expected_revision: order.revision });
    const ready = await f.action('draft.update', { id: order.id, expected_revision: order.revision, content: order.content, exclusive: false, conditions: [] });
    await f.action('input.emit', { draft_id: order.id, expected_revision: ready.revision });
    await f.drain();
    const orderReceipt = await f.get(`/api/input/draft/${order.id}`);
    const appendReceipt = await f.get(`/api/input/draft/${append.id}`);
    expect(orderReceipt.dispatch.state).toBe('succeeded'); expect(appendReceipt.dispatch.state).toBe('succeeded');
    expect((await f.get('/api/inputs?view=drafts')).items).toEqual([]);
    const history = await f.get('/api/inputs');
    expect(history.items).toHaveLength(3); expect(history.items.some(item => item.kind === 'draft')).toBe(false);
    const input = await f.get(`/api/input/input/${orderReceipt.dispatch.input_id}`);
    const message = await f.get(`/api/input/message/${appendReceipt.dispatch.message_id}`);
    expect(input).toMatchObject({ kind: 'input', source_draft_id: order.id, content: order.content });
    expect(message).toMatchObject({ kind: 'message', source_draft_id: append.id, content: append.content, append_number: appendReceipt.dispatch.append_number });
    expect(input.created_at).not.toBe(old); expect(message.created_at).not.toBe(old);
    expect(input.created_at).toBe(f.store.get('SELECT created_at FROM inputs WHERE id=?', input.id).created_at);
    expect(message.created_at).toBe(f.store.get('SELECT created_at FROM messages WHERE id=?', message.id).created_at);
    expect(history.items.find(item => item.kind === 'message')).toMatchObject({ id: message.id, source_draft_id: append.id, created_at: message.created_at });
  } finally { await f.close(); }
});

test('successful conditional order remains addressable outside drafts and links from history without leaking private authorization', async () => {
  const f = await prepared();
  try {
    const emitted = await f.action('input.emit', { content: 'after quiet', conditions: [{ kind: 'parent_quiet' }], client_request_id: 'private-client-key' });
    await f.drain();
    const receipt = await f.get(`/api/input/draft/${emitted.draft_id}`);
    expect(receipt.dispatch.state).toBe('succeeded');
    expect((await f.get('/api/inputs?view=drafts')).items).toEqual([]);
    expect((await f.get('/api/inputs')).items).toMatchObject([{ kind: 'input', id: receipt.input_id, source_draft_id: receipt.id }]);
    for (const conditional of ['configured', 'mounted']) {
      const items = (await f.get(`/api/inputs?conditional=${conditional}`)).items;
      expect(items).toMatchObject([{ kind: 'draft', id: receipt.id, dispatch: { state: 'succeeded' } }]);
      expect(JSON.stringify(items)).not.toContain('private-client-key');
      expect(JSON.stringify(items)).not.toContain('fingerprint');
    }
  } finally { await f.close(); }
});

test('append into a frozen queue is actual history, not an unsent draft or proof of Agent delivery', async () => {
  const f = await prepared(); let calls = 0;
  try {
    f.project.provider = { async run() { calls++; throw new Error('frozen worker must not run'); } };
    const original = await f.action('order.submit', { content: 'frozen target', start: false });
    const task = original.task;
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ version: 2, kind: 'merge', queue_protocol: 1,
      status: 'resolving', parent_id: task.parent_id, commit: task.base_commit, baseline: task.base_commit, attempt_id: 123 }) });
    const emitted = await f.action('input.emit', { content: 'reliably inboxed', mode: 'append', target_id: task.id });
    await f.drain();
    const receipt = await f.get(`/api/input/draft/${emitted.draft_id}`);
    expect(receipt.dispatch.state).toBe('succeeded');
    expect((await f.get('/api/inputs?view=drafts')).items).toEqual([]);
    expect((await f.get('/api/inputs?modes=%5B%22append%22%5D')).items).toMatchObject([{ kind: 'message', id: receipt.dispatch.message_id, source_draft_id: emitted.draft_id }]);
    expect(f.project.inspect(task.id).input_queue.buffered).toBe(1);
    expect(f.project.hasActionableMessages(task.id)).toBe(false);
    expect(f.store.unreadPage(task.id).messages).toEqual([]);
    expect(f.store.history(task.id).find(row => row.type === 'message').input_delivery.status).toBe('pending');
    expect(calls).toBe(0);
  } finally { await f.close(); }
});

test('real management provider bridge discovers and reads drafts using existing permission and registered view parameter', async () => {
  const f = await prepared(); const rpc = new RPCClient(f.config.socket); let observed;
  try {
    const draft = await f.action('draft.add', { content: 'manage this buffered idea' });
    f.project.provider = { async run({ task, token }) {
      expect(task.role).toBe('manager');
      const catalog = await rpc.request('manager.catalog', { _token: token });
      const capability = catalog.methods.find(item => item.method === 'input.history');
      expect(capability.access).toBe('read'); expect(capability.parameters).toContain('view');
      await expect(rpc.request('input.history', { view: 'drafts', _token: token })).rejects.toThrow('requires user approval');
      const history = await rpc.request('manager.call', { method: 'input.history', params: {} , _token: token });
      const drafts = await rpc.request('manager.call', { method: 'input.history', params: { view: 'drafts' }, _token: token });
      observed = { history, drafts }; return 'read-only management';
    } };
    const management = await f.action('management.submit', { instruction: 'inspect buffered ideas' });
    f.project.stopping = false; f.project.pump();
    await until(() => !f.project.running.has(management.task.id) && ['completed', 'failed'].includes(f.store.task(management.task.id).status));
    expect(f.store.task(management.task.id).error).toBeNull();
    expect(observed.history.result.items.map(item => item.kind)).toEqual(['management']);
    expect(observed.drafts).toMatchObject({ status: 'succeeded', result: { items: [{ id: draft.id, kind: 'draft' }] } });
    expect(f.store.all('SELECT * FROM inputs')).toEqual([]);
  } finally { await f.close(); }
});
