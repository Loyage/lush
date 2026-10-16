import { test, expect } from 'bun:test';
import { runnerProject } from './fixtures/runner-project.js';
import { runnerIdentity } from '../../src/core/runner-service.js';

test('Worker inspect/tree expose only durable remote location, barriers and authorization without contacting Runner or reading secrets', async () => {
  const f = await runnerProject({ async run() { throw new Error('read projection must not run'); } });
  try {
    const remote = (await f.dispatcher.dispatch('order.submit', { content: 'remote', start: false })).task;
    const local = (await f.dispatcher.dispatch('order.submit', { content: 'local', start: false, runner_node_id: 'local' })).task;
    f.service.transport_factory = () => { throw new Error('unexpected Runner contact'); };
    f.service.credentials.snapshot = () => { throw new Error('unexpected credential read'); };
    const inspected = await f.dispatcher.dispatch('worker.inspect', { id: remote.id });
    expect(inspected.runner).toMatchObject({ node_id: f.nodes[0].id, runner_id: f.nodes[0].expected_runner_id,
      generation: 1, revision: f.store.runnerBinding(remote.id).revision, state: 'preparing', head_commit: remote.base_commit, authorized: true,
      barriers: { bindings: 1, runs: 0, receipts: 0 } });
    expect(inspected.runner).not.toHaveProperty('ssh_alias');
    expect(inspected.runner).not.toHaveProperty('directory');
    expect((await f.dispatcher.dispatch('worker.tree', { id: remote.id })).runner).toEqual(inspected.runner);
    expect(await f.dispatcher.dispatch('worker.inspect', { id: local.id })).not.toHaveProperty('runner');
    expect(f.project.progressView({ progress_plan: null, reservation: null, status: 'waiting' }).runner).toBeUndefined();
    const binding = f.store.runnerBinding(remote.id);
    f.store.markRunnerWorkspaceUnknown(runnerIdentity(binding), binding.revision);
    await f.service.savePolicy({ allowed_node_ids: [], default_node_id: 'local' }, f.service.readPolicy().revision);
    expect((await f.dispatcher.dispatch('worker.inspect', { id: remote.id })).runner)
      .toMatchObject({ state: 'unknown', authorized: false, node_id: f.nodes[0].id });
    // Changing the default did not turn either existing Worker into a different location.
    expect(f.store.runnerBinding(local.id)).toBeNull();
    expect(f.store.runnerBinding(remote.id).node_id).toBe(f.nodes[0].id);
  } finally { await f.close(); }
});
