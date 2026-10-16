import { test, expect } from 'bun:test';
import { runnerProject } from './fixtures/runner-project.js';
import { until, gate } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';

for (const unknownStop of [false, true]) test(`command.start lost ACK is not stop proof; explicit verification ${unknownStop ? 'preserves unknown stop' : 'uses original execution and real stop'}`, async () => {
  const admitted = gate(), release = gate();
  let drop = true, forceUnknown = false, startCount = 0, originalRequest;
  const f = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token), context = await bridge.call('context');
    await bridge.call('tool', { name: 'bash', args: { command: 'sleep 5', context_ack: context.fingerprint } });
    return 'unreachable';
  } }, { async intercept(frame, request) {
    const result = await request();
    if (frame.method === 'command.start') {
      startCount++;
      if (drop) {
        drop = false; originalRequest = frame.request_id; admitted.resolve(); await release.promise;
        throw Object.assign(new Error('fixture start ACK lost'), { code: 'UNKNOWN' });
      }
    }
    if (forceUnknown && ['lease.revoke', 'workspace.barrier'].includes(frame.method) && result.result)
      result.result = { ...result.result, stopped: false, unknown: true };
    return result;
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'start ACK loss', start: false }), id = sent.task.id;
    await f.dispatcher.dispatch('worker.resume', { id });
    await admitted.promise;
    expect(f.store.runnerReceipt(originalRequest)).toMatchObject({ kind: 'tool', terminal: 0, state: 'prepared', data: { method: 'command.start' } });
    await expect(f.dispatcher.dispatch('runner.worker.reconcile', { id, expected_revision: f.store.runnerBinding(id).revision })).rejects.toThrow('active');
    release.resolve();
    await until(() => !f.project.running.has(id) && f.store.task(id).calls === 1, 8000);
    expect(f.store.runnerReceipt(originalRequest).state).toBe('unknown');
    forceUnknown = unknownStop;
    const result = await f.dispatcher.dispatch('runner.worker.reconcile', { id, expected_revision: f.store.runnerBinding(id).revision });
    expect(result).toMatchObject({ reconciled: !unknownStop, state: unknownStop ? 'unknown' : 'ready' });
    expect(f.store.runnerReceipt(originalRequest)).toMatchObject({ terminal: unknownStop ? 0 : 1, state: unknownStop ? 'unknown' : 'stopped' });
    expect(startCount).toBe(1); expect(f.store.task(id)).toMatchObject({ calls: 1, status: 'failed' });
  } finally { forceUnknown = false; release.resolve(); await f.close(); }
});
