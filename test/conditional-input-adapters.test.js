import { test, expect } from 'bun:test';
import { handlers } from '../src/rpc/handlers/input.js';
import { run as order } from '../src/cli/commands/intent.js';

function fixture() {
  const calls = [];
  const project = Object.fromEntries(['emitBufferedInput', 'order', 'submitBufferedDraft', 'addBufferedDraft',
    'updateBufferedDraft', 'cancelInputEmission', 'releaseInputExclusive'].map(method => [method, (...args) => {
    calls.push({ method, args }); return { method, args };
  }]));
  return { calls, project };
}
function client() {
  const calls = [];
  return { calls, token: null, async request(method, params) {
    calls.push({ method, params });
    if (method === 'worker.lookup') return { id: 17, worker_number: params.number };
    return {};
  } };
}

test('default public order emission delegates durable intent; explicit creation stays compatible', () => {
  const { project, calls } = fixture();
  handlers['order.submit'](project, { content: 'goal', _token: 'never-forward', defer: true });
  expect(calls.at(-1)).toEqual({ method: 'emitBufferedInput', args: [{ content: 'goal' }] });
  handlers['order.submit'](project, { content: 'goal', start: false });
  expect(calls.at(-1).method).toBe('order');
  expect(calls.at(-1).args[4]).toBe(false);
  handlers['order.submit'](project, { draft_id: 4, expected_revision: 2, profile: { agent: 'pi' } });
  expect(calls.at(-1)).toEqual({ method: 'emitBufferedInput', args: [{ draft_id: 4, expected_revision: 2, profile: { agent: 'pi' } }] });
});

test('emission transports fixed condition and append identities, not an invocation token', () => {
  const { project, calls } = fixture();
  const definition = { mode: 'append', target_id: 8, content: 'later', conditions: [{ kind: 'worker_merged', worker_id: 3 }], client_request_id: 'once' };
  handlers['input.emit'](project, { ...definition, _token: 'secret' });
  expect(calls.at(-1)).toEqual({ method: 'emitBufferedInput', args: [definition] });
  for (const key of ['content', 'references', 'branch', 'mode', 'target_id', 'conditions', 'exclusive']) {
    expect(() => handlers['input.emit'](project, { draft_id: 1, expected_revision: 1, [key]: null })).toThrow('draft_id cannot be combined');
  }
  expect(() => handlers['input.emit'](project, { content: 'x', expected_revision: 1 })).toThrow('expected_revision requires draft_id');
});

test('draft adapters preserve new options at the final argument and preserve existing positions', () => {
  const { project, calls } = fixture();
  const options = { mode: 'append', target_id: 8, conditions: [{ kind: 'worker_settled', worker_id: 3 }], exclusive: false };
  handlers['draft.add'](project, { content: 'x', ...options });
  expect(calls.at(-1)).toEqual({ method: 'addBufferedDraft', args: ['x', [], undefined, options] });
  handlers['draft.update'](project, { id: 2, content: 'edit', expected_revision: 3, ...options });
  expect(calls.at(-1)).toEqual({ method: 'updateBufferedDraft', args: [2, 'edit', undefined, undefined, 3, options] });
  handlers['input.emission_cancel'](project, { draft_id: 2, expected_revision: 3 });
  expect(calls.at(-1)).toEqual({ method: 'cancelInputEmission', args: [2, 3] });
  handlers['input.exclusive_release'](project, { draft_id: 2, expected_revision: 3 });
  expect(calls.at(-1)).toEqual({ method: 'releaseInputExclusive', args: [2, 3] });
});

test('CLI combines all requested conditions and resolves only explicit Worker labels', async () => {
  const c = client();
  await order('order', ['later', '--after-merged', 'W12-1', '--after-settled', '4', '--after-merged', '5', '--quiet', '--exclusive'], { client: c, json: true });
  expect(c.calls[0]).toEqual({ method: 'worker.lookup', params: { number: 'W12-1' } });
  expect(c.calls.at(-1)).toMatchObject({ method: 'input.emit', params: { content: 'later', exclusive: true, conditions: [
    { kind: 'worker_settled', worker_id: 4 }, { kind: 'worker_merged', worker_id: 17 },
    { kind: 'worker_merged', worker_id: 5 }, { kind: 'parent_quiet' },
  ] } });
  expect(c.calls.at(-1).params.client_request_id).toMatch(/^[0-9a-f-]{36}$/);
});

test('CLI append buffering stores target and conditions without scheduling a model', async () => {
  const c = client();
  await order('order', ['more', '--append', 'W12', '--buffer', '--after-settled', '3'], { client: c, json: true });
  expect(c.calls.at(-1)).toEqual({ method: 'draft.add', params: { content: 'more', mode: 'append', target_id: 17, conditions: [{ kind: 'worker_settled', worker_id: 3 }] } });
});

test('CLI management input uses a dedicated no-development endpoint', async () => {
  const c = client();
  await order('order', ['diagnose the recent flow', '--management'], { client: c, json: true });
  expect(c.calls.at(-1)).toMatchObject({ method: 'management.submit', params: { instruction: 'diagnose the recent flow' } });
  expect(c.calls).toHaveLength(1);
});

test('CLI rejects incompatible target/management/exclusive flags before requesting', async () => {
  for (const args of [['x', '--management', '--quiet'], ['x', '--management', '--buffer'], ['x', '--append', '2', '--exclusive'],
    ['x', '--append', '2', '--branch', 'main'], ['x', '--quiet', '--quiet']]) {
    const c = client();
    await expect(order('order', args, { client: c, json: true })).rejects.toThrow();
    expect(c.calls).toHaveLength(0);
  }
  const c = client(); c.token = 'agent';
  await expect(order('order', ['x', '--management'], { client: c, json: true })).rejects.toThrow('agents cannot submit');
  expect(c.calls).toHaveLength(0);
});
