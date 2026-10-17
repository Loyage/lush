import { test, expect } from 'bun:test';
import { runnerProject } from './fixtures/runner-project.js';
import { until, git } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';

async function commit(client, file) {
  const context = await client.call('context');
  await client.call('tool', { name: 'write', args: { path: file, content: file, context_ack: context.fingerprint } });
  const result = await client.call('tool', { name: 'bash', args: { context_ack: context.fingerprint,
    command: `git add -- '${file}'; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture` } });
  expect(result.isError).toBe(false);
}

test('remote order and cross-node child deliver through parent ACK, main landing and whole-tree acceptance', async () => {
  let f, childId;
  f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    if (ctx.task.task_kind === 'child') await commit(client, 'child.txt');
    else if (ctx.task.calls === 1) {
      await commit(client, 'parent.txt');
      const spawned = await client.call('tool', { name: 'lushc', args: { argv: [
        'worker', 'spawn', 'cross-node work', '--parent', String(ctx.task.id), '--runner-node', f.nodes[1].id,
      ] } });
      expect(spawned.isError).not.toBe(true);
      childId = f.store.children(ctx.task.id)[0]?.id; expect(childId).toBeTruthy();
    }
    return 'reviewed result';
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'parent', start: false, runner_node_id: f.nodes[0].id });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => {
      const failed = f.store.tasks().find(task => task.status === 'failed');
      if (failed) throw new Error(`fixture Worker failed: ${failed.error}`);
      return childId && f.store.task(childId).integration === 'merged'
        && f.store.task(sent.task.id).calls >= 2 && !f.project.running.size;
    }, 12000);
    const parent = f.store.task(sent.task.id), child = f.store.task(childId);
    expect(parent.workspace).toBeNull(); expect(child.workspace).toBeNull();
    expect(f.store.runnerBinding(parent.id).node_id).toBe(f.nodes[0].id);
    expect(f.store.runnerBinding(child.id).node_id).toBe(f.nodes[1].id);
    expect(await git(f.root, 'show', `${parent.branch}:parent.txt`)).toBe('parent.txt');
    expect(await git(f.root, 'show', `${parent.branch}:child.txt`)).toBe('child.txt');
    expect(f.store.all("SELECT state FROM runner_receipts WHERE worker_id=? AND kind='parent_sync'", parent.id))
      .toEqual([{ state: 'acknowledged' }]);
    for (const id of [parent.id, child.id]) expect(f.store.runnerBarriers(id)).toEqual({ bindings: [], runs: [], receipts: [] });
    await f.dispatcher.dispatch('worker.reserve', { id: parent.id, kind: 'merge' });
    await until(() => {
      const task = f.store.task(parent.id), request = JSON.parse(task.reservation);
      if (['blocked', 'suspended'].includes(request.status)) throw new Error(`fixture delivery blocked: ${request.blocked_reason}`);
      return task.integration === 'merged' && !f.project.taskMergeBusy?.size;
    }, 4000);
    expect(await git(f.root, 'show', `${parent.target_branch}:child.txt`)).toBe('child.txt');
    await f.dispatcher.dispatch('worker.accept', { id: parent.id });
    for (const id of [parent.id, child.id]) {
      expect(f.store.task(id).status).toBe('completed');
      expect(f.store.runnerBinding(id).state).toBe('removed');
      expect(f.store.branch(f.store.task(id).branch).status).toBe('archived');
    }
  } finally { await f.close(); }
});
