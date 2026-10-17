import { test, expect } from 'bun:test';
import path from 'node:path';
import { RPCServer } from '../src/rpc/server.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { createSignal } from '../src/signal.js';
import { tokenHash } from '../src/core/project/internal.js';
import { fixture, env } from './helpers.js';

const bin = path.resolve(import.meta.dir, '../bin/lushc');
test('real lushc binary reaches authenticated RPC and persists title, progress and child messages', async () => {
  const f = fixture(); f.project.kick = () => {};
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'CLI chain' });
  const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: task.id, goal: 'receive message' });
  const token = 'cli-chain-token';
  f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
  f.project.running.set(task.id, { token, controller: new AbortController() });
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  const cli = async (...args) => {
    const proc = Bun.spawn([process.execPath, bin, ...args, '--json'], { cwd: f.root,
      env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home,
        LUSH_TASK_ID: String(task.id), LUSH_AGENT_TOKEN: token }), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0); return JSON.parse(out);
  };
  try {
    await rpc.start();
    expect(await cli('worker', 'auto-title', '真实协作')).toMatchObject({ id: task.id, changed: true });
    expect((await cli('progress', 'plan', 'verify:真实链路')).progress.items[0].status).toBe('pending');
    expect((await cli('progress', 'complete', 'verify')).progress.items[0].status).toBe('completed');
    await cli('worker', 'message', String(child.id), 'new requirement');
    expect(f.store.unread(child.id)).toMatchObject([{ sender_id: task.id, body: 'new requirement' }]);
    expect((await cli('worker', 'inspect', String(task.id))).auto_title).toBe('真实协作');
  } finally { f.project.running.delete(task.id); await rpc.close(); await f.close(); }
});
