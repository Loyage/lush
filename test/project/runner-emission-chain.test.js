import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runnerProject } from './fixtures/runner-project.js';
import { until, git, env } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';

test('user CLI -> persisted selected node -> actual Project creation -> leased Bridge/Runner -> received commit', async () => {
  let observed;
  const f = await runnerProject({ async run(ctx) {
    observed = ctx;
    const bridge = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    const context = await bridge.call('context');
    await bridge.call('tool', { name: 'write', args: { path: 'cli-emission.txt', content: 'selected node B', context_ack: context.fingerprint } });
    const result = await bridge.call('tool', { name: 'bash', args: { context_ack: context.fingerprint,
      command: 'git add cli-emission.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m cli-emission' } });
    expect(result.isError).toBe(false);
    return 'CLI emission delivered';
  } });
  f.project.stopping = true;
  const rpc = new RPCServer(f.config.socket, f.dispatcher); await rpc.start();
  try {
    const selected = f.nodes[1].id;
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../../bin/lush'), '--project', f.root,
      '--json', 'order', 'selected node', '--runner-node', selected], { cwd: f.root, env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const receipt = JSON.parse(out);
    expect(receipt).toMatchObject({ emitted: true, runner_node_id: selected });
    expect(receipt.task).toBeUndefined(); expect(f.service.readPolicy().default_node_id).toBe(f.nodes[0].id);
    expect(JSON.parse(f.store.draft(receipt.draft_id).input_options).runner_node_id).toBe(selected);
    f.project.stopping = false;
    await f.project.drainInputEmissions(); f.project.kick();
    const dispatched = f.project.inputEmissionResult(receipt.draft_id);
    expect(dispatched.dispatch.state).toBe('succeeded');
    const taskId = dispatched.dispatch.worker_id;
    await until(() => !f.project.running.has(taskId) && f.store.task(taskId).calls === 1, 8000);
    const task = f.store.task(taskId);
    expect({ status: task.status, error: task.error }).toEqual({ status: 'waiting', error: null });
    expect(task.result).toBe('CLI emission delivered'); expect(task.workspace).toBeNull();
    expect(f.store.runnerBinding(taskId).node_id).toBe(selected);
    expect(observed.remote_workspace.identity.node_id).toBe(selected);
    expect(await git(f.root, 'show', `${task.branch}:cli-emission.txt`)).toBe('selected node B');
    expect(fs.existsSync(path.join(f.root, 'cli-emission.txt'))).toBe(false);
    expect((await git(f.root, 'worktree', 'list', '--porcelain'))).not.toContain(`refs/heads/${task.branch}`);
    expect(f.store.runnerBarriers(taskId)).toEqual({ bindings: [], runs: [], receipts: [] });
  } finally { await rpc.close(); await f.close(); }
});
