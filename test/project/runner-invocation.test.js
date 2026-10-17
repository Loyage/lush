import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runnerProject } from './fixtures/runner-project.js';
import { until, git } from '../helpers.js';
import { RemoteBridgeClient } from '../../src/agent/remote-bridge.js';

async function commit(client, name, contents = 'remote') {
  const context = await client.call('context');
  await client.call('tool', { name: 'write', args: { path: name, content: contents, context_ack: context.fingerprint } });
  const result = await client.call('tool', { name: 'bash', args: {
    command: `git add -- '${name}'; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture; git rev-parse HEAD`, context_ack: context.fingerprint } });
  expect(result.isError).toBe(false);
  return result;
}

test('RPC creation/resume -> Project -> restricted Bridge -> independent Runner -> final objects and a second invocation', async () => {
  const seen = [];
  const f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    expect(ctx.cwd).not.toBe(ctx.remote_workspace.path); expect(fs.existsSync(path.join(ctx.cwd, '.git'))).toBe(false);
    // Production control cwd must already be canonical: Bridge control validation compares real paths.
    expect(ctx.cwd).toBe(fs.realpathSync(ctx.cwd));
    expect(ctx.task.workspace).toBeNull();
    expect((await client.call('hello')).tools).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'lushc', 'control']));
    await expect(client.call('tool', { name: 'lushc', args: { argv: ['worker', 'cancel', String(ctx.task.id)] } })).rejects.toThrow('Restricted operation');
    await commit(client, `round-${ctx.task.calls}.txt`);
    const result = await client.call('tool', { name: 'lushc', args: { argv: ['worker', 'inspect', String(ctx.task.id)] } });
    expect(result.content[0].text).toContain(String(ctx.task.id));
    seen.push({ descriptor: ctx.remote_workspace, cwd: ctx.cwd, token: ctx.token });
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
    const receipts = f.store.all("SELECT * FROM runner_receipts WHERE kind='objects' AND worker_id=?", task.id);
    expect(receipts).toHaveLength(1); expect(receipts[0].run_id).toBeNull(); expect(receipts[0].operation_id).toBeTruthy();
    await expect(f.dispatcher.dispatch('worker.inspect', { id: task.id, _token: seen[0].token })).rejects.toThrow('token');
    await f.dispatcher.dispatch('worker.message', { id: task.id, body: 'continue' });
    await until(() => !f.project.running.has(task.id) && f.store.task(task.id).calls === 2, 8000);
    task = f.store.task(task.id);
    expect(task.status).toBe('waiting'); expect(seen).toHaveLength(2);
    expect(seen[1].descriptor.identity.workspace_id).toBe(seen[0].descriptor.identity.workspace_id);
    expect(seen[1].descriptor.identity.run_id).not.toBe(seen[0].descriptor.identity.run_id);
    expect(await git(f.root, 'show', `${task.branch}:round-2.txt`)).toBe('remote');
    for (const call of seen) expect(fs.existsSync(call.cwd)).toBe(false);
    expect((await git(f.root, 'worktree', 'list', '--porcelain'))).not.toContain(`refs/heads/${task.branch}`);
  } finally { await f.close(); }
});

test('questionnaire immediately ends new developer authority but fixed stop and control object receipts finish', async () => {
  let question, denied = false;
  const f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    await commit(client, 'before-question.txt');
    await client.call('tool', { name: 'control', args: { action: 'write', id: 'questionnaire', content: JSON.stringify({
      questions: [{ header: 'Choose', question: 'Which option?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }],
    }) } });
    question = await client.call('tool', { name: 'lushc', args: { argv: ['notice', 'post', 'Choose', '--questions-file', 'control:questionnaire'] } });
    try { await client.call('context'); } catch { denied = true; }
    return 'asked';
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'question', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => !f.project.running.has(sent.task.id) && f.store.task(sent.task.id).calls === 1, 8000);
    expect(question).toBeTruthy(); expect(denied).toBe(true);
    expect(f.store.task(sent.task.id).status).toBe('awaiting');
    expect(f.store.runnerBarriers(sent.task.id)).toEqual({ bindings: [], runs: [], receipts: [] });
    expect(await git(f.root, 'show', `${sent.task.branch}:before-question.txt`)).toBe('remote');
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE task_id=? AND status='open'", sent.task.id).n).toBe(1);
  } finally { await f.close(); }
});

test('unknown final remote stop persists a barrier and cannot be reported as successful invocation', async () => {
  let failBarrier = false;
  const f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    await commit(client, 'not-delivered.txt');
    failBarrier = true;
    return 'must not deliver';
  } }, { intercept(frame, request) {
    if (failBarrier && frame.method === 'workspace.barrier') {
      // The safety watcher can abort while unknown stop is being settled; this is not worker.cancel.
      f.project.running.get(frame.identity.worker_id)?.controller.abort('fixture safety stop');
      return Promise.reject(Object.assign(new Error('fixture disconnected'), { code: 'UNAVAILABLE' }));
    }
    return request();
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'unknown', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => !f.project.running.has(sent.task.id) && f.store.task(sent.task.id).calls === 1, 8000);
    expect(f.store.task(sent.task.id).status).toBe('failed');
    expect(f.store.task(sent.task.id).result).not.toBe('must not deliver');
    expect(f.store.runnerBinding(sent.task.id).state).toBe('unknown');
    expect(f.store.runnerBarriers(sent.task.id).runs).toHaveLength(1);
    expect(f.store.runsForTask(sent.task.id).at(-1).status).toBe('failed');
    expect(await git(f.root, 'rev-parse', sent.task.branch)).toBe(sent.task.base_commit);
  } finally { failBarrier = false; await f.close(); }
});

test('connection budget rotation after handshake refuses preparation before Run/lease admission', async () => {
  let rotated = false, leases = 0, f;
  f = await runnerProject({ async run() { throw new Error('must not run'); } }, { async intercept(frame, request) {
    const result = await request();
    if (frame.method === 'lease.grant') leases++;
    if (f && !rotated && frame.method === 'workspace.inspect') {
      const current = f.service.readNodes(); rotated = true;
      f.service.settings.save({ nodes: current.nodes.map(node => ({ ...node,
        budgets: { ...node.budgets, timeout_ms: node.budgets.timeout_ms + 1 } })) }, current.revision);
    }
    return result;
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'rotated preparation', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => !f.project.running.has(sent.task.id) && f.store.task(sent.task.id).status === 'failed', 8000);
    expect(rotated).toBe(true); expect(leases).toBe(0);
    expect(f.store.runsForTask(sent.task.id)).toHaveLength(0);
    expect(f.store.runnerBinding(sent.task.id).state).toBe('unknown');
    expect(f.store.task(sent.task.id).error).toContain('configuration changed');
  } finally { await f.close(); }
});

test('rotated invocation connection refuses tools and final object acceptance but retains fixed lease stop', async () => {
  let denied = false, f;
  f = await runnerProject({ async run(ctx) {
    const client = new RemoteBridgeClient(ctx.remote_workspace, ctx.token);
    await commit(client, 'before-rotation.txt');
    const current = f.service.readNodes();
    f.service.settings.save({ nodes: current.nodes.map(node => ({ ...node,
      budgets: { ...node.budgets, timeout_ms: node.budgets.timeout_ms + 1 } })) }, current.revision);
    // Synchronous authorization check also covers the interval before the policy watch fires.
    expect(() => f.project.running.get(ctx.task.id).remote.authorize()).toThrow('configuration changed');
    await expect(client.call('context')).rejects.toThrow(); denied = true;
    return 'must not accept';
  } });
  try {
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'rotated invocation', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => !f.project.running.has(sent.task.id) && f.store.task(sent.task.id).calls === 1, 8000);
    expect(denied).toBe(true);
    expect(f.store.task(sent.task.id).status).toBe('failed');
    expect(f.store.runnerBinding(sent.task.id).state).toBe('unknown');
    expect(f.store.runnerBarriers(sent.task.id).runs).toHaveLength(0);
    expect(f.store.get("SELECT count(*) AS n FROM runner_receipts WHERE worker_id=? AND kind='objects'", sent.task.id).n).toBe(0);
    expect(await git(f.root, 'rev-parse', sent.task.branch)).toBe(sent.task.base_commit);
  } finally { await f.close(); }
});

test('incompatible SDK refuses before Run admission and never creates a local fallback checkout', async () => {
  const f = await runnerProject({ async run() { throw new Error('must not run'); } });
  try {
    fs.writeFileSync(path.join(f.sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.0.0', exports: './index.js' }));
    const sent = await f.dispatcher.dispatch('order.submit', { content: 'incompatible', start: false });
    await f.dispatcher.dispatch('worker.resume', { id: sent.task.id });
    await until(() => f.store.task(sent.task.id).status === 'failed', 8000);
    expect(f.store.runsForTask(sent.task.id)).toHaveLength(0);
    expect(f.store.task(sent.task.id).calls).toBe(0);
    expect(f.store.task(sent.task.id).workspace).toBeNull();
    expect(f.store.task(sent.task.id).error).toContain('verified SDK');
  } finally { await f.close(); }
});
