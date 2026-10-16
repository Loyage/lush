import { test, expect } from 'bun:test';
import { runnerProject } from '../project/fixtures/runner-project.js';
import { until } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { runnerIdentity } from '../../src/core/runner-service.js';

// D656 regression replacing the original missing-receipt characterization. Keep the
// same real Bridge/Runner ACK-loss reproduction; only explicit user verification may clear it.
test('completed write ACK loss retains its central receipt and requires explicit verification without replay', async () => {
  let dropped, writes = 0;
  const f = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    const context = await bridge.call('context');
    await bridge.call('tool', { name: 'write', args: { path: 'ack-lost.txt', content: 'accepted exactly once',
      context_ack: context.fingerprint } });
    return 'unreachable';
  } }, { async intercept(frame, request) {
    if (frame.method === 'file.write') writes++;
    const response = await request();
    if (!dropped && frame.method === 'file.write') {
      dropped = frame;
      throw Object.assign(new Error('review dropped write ACK after node completion'), { code: 'UNKNOWN' });
    }
    return response;
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'write ACK loss', start: false });
    const id = sent.task.id;
    await f.dispatcher.dispatch('worker.resume', { id });
    await until(() => !f.project.running.has(id) && f.store.task(id).calls === 1, 8000);
    expect(dropped?.method).toBe('file.write');
    expect(f.store.task(id).status).toBe('failed');
    expect(f.store.runnerBinding(id).state).toBe('unknown');
    // The production journal, not this interception, owns the original request identity.
    expect(f.store.runnerReceipt(dropped.request_id)).toMatchObject({ kind: 'tool', state: 'unknown', terminal: 0,
      worker_id: id, run_id: dropped.identity.run_id, data: { method: 'file.write' } });
    const connection = await f.service.connect(runnerIdentity(f.store.runnerBinding(id), { operation_id: 'review-reconcile' }), { observation: true });
    try {
      const status = await connection.client.call('request.status', { request_id: dropped.request_id });
      expect(status.state).toBe('completed');
      expect(status.result.path).toBe('ack-lost.txt');
    } finally { await connection.close(); }
    expect(f.store.all('SELECT request_id FROM runner_receipts WHERE worker_id=?', id)).toEqual([{ request_id: dropped.request_id }]);
    await expect(f.dispatcher.dispatch('worker.retry', { id })).rejects.toThrow('explicitly verify');
    expect(f.store.runnerBinding(id).state).toBe('unknown');
    expect(await f.dispatcher.dispatch('runner.worker.reconcile', { id, expected_revision: f.store.runnerBinding(id).revision }))
      .toMatchObject({ reconciled: true, state: 'ready', pending: 0 });
    const observed = await f.service.connect(runnerIdentity(f.store.runnerBinding(id), { operation_id: 'review-preserved-file' }), { observation: true });
    try { expect((await observed.client.call('file.read', { path: 'ack-lost.txt' })).text).toBe('accepted exactly once'); }
    finally { await observed.close(); }
    expect(f.store.runnerReceipt(dropped.request_id)).toMatchObject({ state: 'completed', terminal: 1 });
    expect(f.store.task(id)).toMatchObject({ status: 'failed', calls: 1 });
    expect(writes).toBe(1);
  } finally { await f.close(); }
});
