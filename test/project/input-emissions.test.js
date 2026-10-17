import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';

test('buffered input mounts durably then runtime creates and executes its Worker once', async () => {
  const f = fixture({ async run() { return 'safe answer'; } });
  f.project.stopping = true; await repo(f.root);
  try {
    const draft = await f.project.addBufferedDraft('automatic', [], 'main');
    const receipt = await f.project.emitBufferedInput({ draft_id: draft.id,
      expected_revision: draft.revision, client_request_id: 'runtime-once' });
    expect(receipt).toMatchObject({ emitted: true, draft_id: draft.id, dispatch: { state: 'queued' } });
    expect(receipt.task).toBeUndefined();
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.inputEmissionResult(draft.id).dispatch.state === 'succeeded');
    const dispatch = f.project.inputEmissionResult(draft.id).dispatch;
    await until(() => f.store.task(dispatch.worker_id).result && !f.project.running.has(dispatch.worker_id));
    expect(f.store.task(dispatch.worker_id)).toMatchObject({ calls: 1, result: 'safe answer' });
    expect(f.project.inputGet('input', dispatch.input_id).content).toBe('automatic');
    expect(f.store.task(f.store.task(dispatch.worker_id).parent_id).calls).toBe(0);
    expect(f.project.inputGet('draft', draft.id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});
