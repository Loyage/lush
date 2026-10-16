import { test, expect } from 'bun:test';
import { runnerProject } from './fixtures/runner-project.js';
import { until } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';

// The upstream Runner bootstrap/early-stop fix is required. Keep the actual Project/Bridge
// regression rather than substituting a READY-output wait which removes the starting window.
test('Project cancellation immediately after command admission confirms real stop before releasing the Run', async () => {
  let f, admitted = false, workerId;
  const trace = []; const began = Date.now();
  f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token), context = await client.call('context');
    try {
      await client.call('tool', { name: 'bash', args: { command: 'sleep 5', context_ack: context.fingerprint } });
    } catch { /* Expected aborted tool; only central stop receipts below decide safety. */ }
    return 'cancelled, not a successful delivery';
  } }, { async intercept(frame, request) {
    const result = await request();
    trace.push({ method: frame.method, elapsed_ms: Date.now() - began, state: result.result?.state,
      stopped: result.result?.stopped, stop_confirmed: result.result?.stop_confirmed });
    if (trace.length > 20) trace.shift();
    if (frame.method === 'command.start' && !admitted) {
      admitted = true;
      // No wait for shell output/guard readiness. This is a real user cancellation through RPC,
      // while the admitted command is still being returned to the genuine Bridge.
      await f.dispatcher.dispatch('worker.cancel', { id: frame.identity.worker_id });
    }
    return result;
  } });
  try {
    const created = await f.dispatcher.dispatch('order.submit', { content: 'early cancel', start: false });
    workerId = created.task.id;
    await f.dispatcher.dispatch('worker.resume', { id: created.task.id });
    await until(() => admitted && !f.project.running.has(created.task.id) && !f.project.runnerStopJobs?.size, 16000);
    expect(f.store.task(created.task.id).status).toBe('cancelled');
    const run = f.store.runsForTask(created.task.id).at(-1), remote = f.store.runnerRun(run.id);
    expect({ state: remote.state, stop_confirmed: remote.stop_confirmed }).toEqual({ state: 'released', stop_confirmed: 1 });
    expect(f.store.runnerBarriers(created.task.id)).toEqual({ bindings: [], runs: [], receipts: [] });
    expect(await f.dispatcher.dispatch('worker.code_state', { id: created.task.id })).toMatchObject({ availability: 'available' });
  } catch (error) {
    console.error('early cancellation diagnostic', { trace, state: workerId ? f.store.runnerBinding(workerId)?.state : null,
      active: workerId ? f.project.running.has(workerId) : false, stop_jobs: f.project.runnerStopJobs?.size ?? 0 });
    throw error;
  } finally { await f.close(); }
});
