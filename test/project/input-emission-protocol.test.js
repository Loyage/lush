import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { validateInputEmissionRequest as validate } from '../../src/core/input-emission-protocol.js';

test('real Dispatcher mount -> runtime -> controlled Provider -> Input and append Message retain their draft source', async () => {
  let calls = 0;
  const f = fixture({ async run() { calls++; return 'controlled input result'; } });
  f.project.stopping = true; await repo(f.root);
  const rpc = new Dispatcher(f.project), emit = params => rpc.dispatch('input.emit', params);
  try {
    const reference = { kind: 'text', label: 'saved quote', quote: 'original selection' };
    const request = { content: 'real schema chain', references: [reference], client_request_id: 'real-chain' };
    const receipt = await emit(validate(request));
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0); expect(calls).toBe(0);
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.inputEmissionResult(receipt.draft_id).dispatch.state === 'succeeded');
    const dispatch = f.project.inputEmissionResult(receipt.draft_id).dispatch;
    await until(() => f.store.task(dispatch.worker_id).result && !f.project.running.has(dispatch.worker_id));
    f.project.stopping = true;
    expect(calls).toBe(1);
    expect(f.project.inputGet('input', dispatch.input_id)).toMatchObject({ content: request.content, source_draft_id: receipt.draft_id });
    expect((await emit(request)).dispatch).toMatchObject(dispatch);
    const appendRequest = { content: 'follow-up verbatim', mode: 'append', target_id: String(dispatch.worker_id), client_request_id: 'append-chain' };
    const append = await emit(validate(appendRequest));
    expect(append.dispatch.state).toBe('queued');
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.inputEmissionResult(append.draft_id).dispatch.state === 'succeeded');
    const delivered = f.project.inputEmissionResult(append.draft_id).dispatch;
    expect(delivered.input_id).toBeUndefined(); expect(delivered.message_id).toBeGreaterThan(0);
    expect(f.project.inputGet('message', delivered.message_id)).toMatchObject({ content: appendRequest.content, source_draft_id: append.draft_id });
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
  } finally { await f.close(); }
});
