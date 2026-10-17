import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runnerProject } from './fixtures/runner-project.js';
import { until, git } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';

test('RPC creation/resume -> Project -> Bridge -> independent Runner -> received commit and a second invocation', async () => {
  const seen = [];
  const f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    expect(ctx.cwd).not.toBe(ctx.remote_workspace.path); expect(fs.existsSync(path.join(ctx.cwd, '.git'))).toBe(false);
    expect(ctx.cwd).toBe(fs.realpathSync(ctx.cwd)); expect(ctx.task.workspace).toBeNull();
    expect((await client.call('hello')).tools).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'lushc', 'control']));
    const context = await client.call('context'), name = `round-${ctx.task.calls}.txt`;
    await client.call('tool', { name: 'write', args: { path: name, content: 'remote', context_ack: context.fingerprint } });
    const committed = await client.call('tool', { name: 'bash', args: {
      command: `git add -- '${name}'; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture`, context_ack: context.fingerprint } });
    expect(committed.isError).toBe(false);
    const inspected = await client.call('tool', { name: 'lushc', args: { argv: ['worker', 'inspect', String(ctx.task.id)] } });
    expect(inspected.content[0].text).toContain(String(ctx.task.id));
    seen.push({ descriptor: ctx.remote_workspace, cwd: ctx.cwd });
    return 'remote result';
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'remote', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => !f.project.running.has(sent.task.id) && f.store.task(sent.task.id).calls === 1, 8000);
    let task = f.store.task(sent.task.id);
    expect({ status: task.status, error: task.error }).toEqual({ status: 'waiting', error: null });
    expect(task.result).toBe('remote result');
    expect(await git(f.root, 'show', `${task.branch}:round-1.txt`)).toBe('remote');
    expect(f.store.runnerBarriers(task.id)).toEqual({ bindings: [], runs: [], receipts: [] });
    expect(f.store.runsForTask(task.id).at(-1).status).toBe('completed');
    await f.dispatcher.dispatch('worker.message', { id: task.id, body: 'continue' });
    await until(() => !f.project.running.has(task.id) && f.store.task(task.id).calls === 2, 8000);
    task = f.store.task(task.id);
    expect(task.status).toBe('waiting'); expect(seen).toHaveLength(2);
    expect(seen[1].descriptor.identity.workspace_id).toBe(seen[0].descriptor.identity.workspace_id);
    expect(seen[1].descriptor.identity.run_id).not.toBe(seen[0].descriptor.identity.run_id);
    expect(await git(f.root, 'show', `${task.branch}:round-2.txt`)).toBe('remote');
    for (const call of seen) expect(fs.existsSync(call.cwd)).toBe(false);
    expect(await git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(`refs/heads/${task.branch}`);
  } finally { await f.close(); }
});
