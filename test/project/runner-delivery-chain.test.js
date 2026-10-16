import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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

test('three-level remote delegation receives each live parent tip and converges recursively across nodes', async () => {
  let f;
  f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    if (ctx.task.calls !== 1) return 'reviewed descendants';
    const name = ctx.task.task_kind === 'order' ? 'root' : ctx.task.goal;
    const sessions = path.join(f.config.home, 'sessions');
    if (name !== 'root') expect(ctx.forkPointer).toMatchObject({
      session: path.join(sessions, `fixture-${ctx.task.parent_id}.jsonl`), entry: 'boundary',
    });
    // Model/SDK fixture supplies a trusted CENTRAL boundary marker; the node never supplies a
    // session path or writes Store. Real SDK checkpoint production is covered separately.
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    const session = path.join(sessions, `fixture-${ctx.task.id}.jsonl`);
    fs.writeFileSync(session, JSON.stringify({ type: 'session', id: `fixture-${ctx.task.id}` }) + '\n'
      + JSON.stringify({ type: 'message', id: 'boundary', parentId: null, message: { role: 'user', content: 'trusted boundary' } }) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(sessions, `task-${ctx.task.id}-context.json`), JSON.stringify({
      task_id: ctx.task.id, run_id: ctx.remote_workspace.identity.run_id, session, entry: 'boundary',
    }), { mode: 0o600 });
    await commit(client, `${name}.txt`);
    if (name !== 'leaf') {
      const child = name === 'root' ? 'middle' : 'leaf';
      const node = name === 'root' ? f.nodes[1] : f.nodes[0];
      await client.call('tool', { name: 'lushc', args: { argv: ['worker', 'spawn', child, '--runner-node', node.id] } });
    }
    return 'delegated or completed leaf';
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'root', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => {
      const failed = f.store.tasks().find(task => task.status === 'failed');
      if (failed) throw new Error(`recursive Worker failed: ${failed.error}`);
      const children = f.store.tasks().filter(task => task.task_kind === 'child');
      return children.length === 2 && children.every(task => task.integration === 'merged')
        && f.store.task(sent.task.id).calls === 2 && !f.project.running.size && !f.project.taskMergeBusy?.size;
    }, 16000);
    const root = f.store.task(sent.task.id), middle = f.store.children(root.id)[0], leaf = f.store.children(middle.id)[0];
    for (const [task, node] of [[root, f.nodes[0]], [middle, f.nodes[1]], [leaf, f.nodes[0]]]) {
      expect(task.workspace).toBeNull(); expect(f.store.runnerBinding(task.id).node_id).toBe(node.id);
      expect(f.store.runnerBarriers(task.id)).toEqual({ bindings: [], runs: [], receipts: [] });
    }
    expect(await git(f.root, 'show', `${middle.base_commit}:root.txt`)).toBe('root.txt');
    expect(await git(f.root, 'show', `${leaf.base_commit}:middle.txt`)).toBe('middle.txt');
    for (const task of [middle, leaf]) expect(fs.existsSync(path.join(f.config.home, 'session-checkpoints', `${task.base_commit}.jsonl`))).toBe(true);
    expect(f.store.all('SELECT task_id FROM commit_contexts ORDER BY task_id').map(row => row.task_id)).toEqual([root.id, middle.id, leaf.id]);
    for (const name of ['root', 'middle', 'leaf']) expect(await git(f.root, 'show', `${root.branch}:${name}.txt`)).toBe(`${name}.txt`);
    expect(f.store.all("SELECT state FROM runner_receipts WHERE kind='parent_sync' ORDER BY rowid"))
      .toEqual([{ state: 'acknowledged' }, { state: 'acknowledged' }]);
  } finally { await f.close(); }
});

test('actual remote order and cross-node child invocation deliver through parent ACK and checked whole-tree acceptance', async () => {
  let f, childId, cooperationError;
  f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    if (ctx.task.task_kind === 'child') await commit(client, 'child.txt');
    else if (ctx.task.calls === 1) {
      await commit(client, 'parent.txt');
      const spawned = await client.call('tool', { name: 'lushc', args: { argv: [
        'worker', 'spawn', 'cross-node work', '--parent', String(ctx.task.id), '--runner-node', f.nodes[1].id,
      ] } });
      expect(spawned.isError).not.toBe(true);
      childId = f.store.children(ctx.task.id)[0]?.id;
      expect(childId).toBeTruthy();
    }
    return 'reviewed result';
  } });
  const dispatch = f.dispatcher.dispatch.bind(f.dispatcher);
  f.dispatcher.dispatch = async (method, params) => {
    try { return await dispatch(method, params); }
    catch (error) { if (method === 'worker.spawn') cooperationError = error; throw error; }
  };
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'parent', start: false, runner_node_id: f.nodes[0].id });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => {
      const failed = f.store.tasks().find(task => task.status === 'failed');
      if (failed) throw cooperationError ?? new Error(`fixture Worker failed: ${failed.error}`);
      return childId && f.store.task(childId).integration === 'merged'
        && f.store.task(sent.task.id).calls >= 2 && !f.project.running.size;
    }, 12000);
    const parent = f.store.task(sent.task.id), child = f.store.task(childId);
    expect(parent.workspace).toBeNull(); expect(child.workspace).toBeNull();
    expect(f.store.runnerBinding(parent.id).node_id).toBe(f.nodes[0].id);
    expect(f.store.runnerBinding(child.id).node_id).toBe(f.nodes[1].id);
    expect(await git(f.root, 'show', `${parent.branch}:child.txt`)).toBe('child.txt');
    const sync = f.store.all("SELECT state FROM runner_receipts WHERE worker_id=? AND kind='parent_sync'", parent.id);
    expect(sync).toEqual([{ state: 'acknowledged' }]);
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
  } catch (error) {
    console.error('chain diagnostic', { tasks: f.store.tasks().map(({ id, status, integration, error, reservation }) =>
      ({ id, status, integration, error, reservation })), dirty: await git(f.root, 'status', '--porcelain'),
      running: [...f.project.running.keys()], merging: [...(f.project.taskMergeBusy ?? [])] });
    throw error;
  } finally { await f.close(); }
});
