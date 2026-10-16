import { test, expect } from 'bun:test';
import { runnerProject } from '../project/fixtures/runner-project.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';
import { until } from '../helpers.js';

// Integration across the fixed parent lifecycle and the code-reader delivery: no manual binding,
// lease, checkout or HEAD setup. The Provider is controlled; the Bridge and Runner are real.
test('RPC-created remote order is unreadable while preparing, readable during idle Run and after final object reception', async () => {
  let live, liveHead, denied = false;
  const f = await runnerProject({ async run(ctx) {
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    const context = await bridge.call('context');
    await bridge.call('tool', { name: 'write', args: { path: 'lifecycle.txt', content: 'live code\n', context_ack: context.fingerprint } });
    live = await f.dispatcher.dispatch('worker.code_file', { id: ctx.task.id, path: 'lifecycle.txt', view: 'content' });
    try { await f.dispatcher.dispatch('worker.code_state', { id: ctx.task.id, _token: ctx.token }); }
    catch { denied = true; }
    const committed = await bridge.call('tool', { name: 'bash', args: {
      command: 'git add lifecycle.txt; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m reader', context_ack: context.fingerprint } });
    expect(committed.isError).toBe(false);
    liveHead = await f.dispatcher.dispatch('worker.code_state', { id: ctx.task.id });
    expect(liveHead.head_commit).not.toBe(f.store.runnerBinding(ctx.task.id).head_commit);
    return 'code reader integrated';
  } });
  try {
    const created = await f.dispatcher.dispatch('order.submit', { content: 'remote code integration', start: false });
    expect(created.task.workspace).toBeNull();
    expect((await f.dispatcher.dispatch('worker.code_state', { id: created.task.id }))).toMatchObject({ availability: 'unavailable', source: 'none' });
    await f.dispatcher.dispatch('worker.resume', { id: created.task.id });
    await until(() => !f.project.running.has(created.task.id) && f.store.task(created.task.id).calls === 1, 8000);
    const settled = f.store.task(created.task.id);
    expect({ status: settled.status, error: settled.error }).toEqual({ status: 'waiting', error: null });
    expect(denied).toBe(true);
    expect(live).toMatchObject({ availability: 'available', source: 'workspace', content: { text: 'live code\n' }, status: 'A' });
    expect(liveHead).toMatchObject({ availability: 'available', source: 'workspace', base_commit: created.task.base_commit });
    const final = await f.dispatcher.dispatch('worker.code_file', { id: created.task.id, path: 'lifecycle.txt', view: 'content' });
    expect(final).toMatchObject({ availability: 'available', source: 'workspace', head_commit: settled.head_commit,
      base_commit: created.task.base_commit, content: { text: 'live code\n' } });
    expect(final.head_commit).toBe(liveHead.head_commit);
    expect(f.store.runnerBinding(created.task.id).head_commit).toBe(final.head_commit);
    expect(f.store.runnerBarriers(created.task.id)).toEqual({ bindings: [], runs: [], receipts: [] });
  } finally { await f.close(); }
});
