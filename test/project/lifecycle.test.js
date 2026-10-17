import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiProvider } from '../../src/agent/provider.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';

// Main development smoke: real Provider subprocesses and the pinned RPC CLI,
// without a model/account call. Keep this chain when trimming isolated edge cases.
test('real Provider order delegates a child through lushw and consumes its returned result on the next invocation', async () => {
  const f = fixture(); let server;
  try {
    f.project.stopping = true; await repo(f.root);
    const cli = fileURLToPath(new URL('../../bin/lushw', import.meta.url));
    const executable = path.join(f.config.home, 'controlled-lifecycle-pi');
    fs.writeFileSync(executable, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const input = JSON.parse(fs.readFileSync(path.join(process.env.LUSH_HOME, 'sessions', 'task-' + process.env.LUSH_TASK_ID + '-input.md'), 'utf8'));
const task = input.task;
fs.appendFileSync(path.join(process.env.LUSH_HOME, 'lifecycle-proof.jsonl'), JSON.stringify({ id: task.id, kind: task.task_kind, calls: task.calls, messages: input.messages }) + '\\n');
if (task.task_kind === 'order' && task.calls === 1) {
  const child = Bun.spawnSync([process.execPath, ${JSON.stringify(cli)}, 'worker', 'spawn', 'controlled child', '--name', 'provider-child', '--json'], { stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode) throw new Error(new TextDecoder().decode(child.stderr));
  console.log('parent delegated');
} else if (task.task_kind === 'child') {
  console.log('controlled child result');
} else {
  if (!input.messages.some(message => message.body.includes('controlled child result'))) throw new Error('child result missing from parent inbox');
  console.log('parent consumed child result');
}
`, { mode: 0o755 });
    f.config.env.LUSH_PI_COMMAND = executable;
    const profile = { agent: 'pi', config_mode: 'pi', model: '', thinking: '', extensions: [], skills: [], default_prompt: '', append_prompt: '', soft_budget: {} };
    f.project.provider = { resolve: () => profile, reportsInputDelivery: true, run: options => new PiProvider(f.config).run(options) };
    server = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
    await server.start();
    const { task } = await f.project.order('controlled real Provider lifecycle');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(task.id).calls === 2 && f.store.task(task.id).status === 'waiting' && !f.project.running.size, 12000);
    const [child] = f.store.children(task.id);
    expect(child).toMatchObject({ task_kind: 'child', status: 'awaiting_acceptance', result: 'controlled child result', calls: 1 });
    expect(child.workspace).not.toBe(task.workspace);
    expect(f.store.task(task.id).result).toBe('parent consumed child result');
    expect(f.store.unread(task.id)).toEqual([]);
    const proof = fs.readFileSync(path.join(f.config.home, 'lifecycle-proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(proof.map(row => row.kind)).toEqual(['order', 'child', 'order']);
    expect(proof.at(-1).messages.some(message => message.body.includes('controlled child result'))).toBe(true);
    for (const row of [f.store.task(task.id), child]) {
      expect(row.agent_token_hash).toBeNull();
      expect(f.store.runsForTask(row.id).every(run => run.status === 'completed')).toBe(true);
    }
  } finally { await server?.close(); await f.close(); }
});

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

test('messages arriving during an invocation are delivered exactly on the next invocation', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.order('work')).task;
    await until(() => provider.calls.length === 1);
    f.project.message(task.id, 'new requirement');
    expect(provider.calls[0].messages).toEqual([]);
    provider.calls[0].done.resolve('first');
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].messages.map(m => m.body)).toEqual(['new requirement']);
    provider.calls[1].done.resolve('second');
    // A new order Task stays idle between invocations; it is not completed by an ordinary return.
    await until(() => f.store.task(task.id).status === 'waiting');
    expect(f.store.unread(task.id)).toEqual([]);
  } finally { await f.close(); }
});
