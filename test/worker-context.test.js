import { test, expect } from 'bun:test';
import path from 'node:path';
import { fixture, repo, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';

test('runtime-issued invocation -> shipped bin -> RPC registration -> real spawn/message/Notice effects and expired-token rejection', async () => {
  const entered = gate(), finish = gate(); let runtimeToken, result, failure;
  const f = fixture({ async run({ task, token }) {
    runtimeToken = token;
    const cli = async (...args) => {
      const proc = Bun.spawn([path.resolve(import.meta.dir, '../bin/lushw'), '--json', ...args], { cwd: task.workspace,
        env: { ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home, LUSH_TASK_ID: '9007199254740991', LUSH_AGENT_TOKEN: token },
        stdout: 'pipe', stderr: 'pipe' });
      const [out, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code) throw Error(error); return JSON.parse(out);
    };
    try {
      const self = await cli('self','inspect');
      const child = await cli('children','spawn','runtime delegated child','--name','runtime-child');
      await cli('children','message', String(child.id), 'runtime message');
      const notice = await cli('self','notice','post','runtime notice','--kind','info');
      result = { self, child, notice };
    } catch (error) { failure = error; }
    entered.resolve(); await finish.promise; return 'runtime CLI verified';
  } });
  let rpc;
  try {
    f.project.kick = () => {}; await repo(f.root);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const task = (await f.project.order('runtime context', 'main', [], null, false)).task;
    f.store.update(task.id, { status: 'queued' }); f.project.pump();
    await entered.promise; if (failure) throw failure;
    expect(result.self.id).toBe(task.id);
    expect(f.store.task(result.child.id).parent_id).toBe(task.id);
    expect(f.store.unread(result.child.id)).toMatchObject([{ sender_id: task.id, body: 'runtime message' }]);
    expect(f.store.get('SELECT task_id,title FROM notices WHERE id=?', result.notice.id)).toEqual({ task_id: task.id, title: 'runtime notice' });
    const run = f.project.running.get(task.id); finish.resolve(); await run.promise;
    await expect(new Dispatcher(f.project).dispatch('context.inspect', { _token: runtimeToken })).rejects.toThrow('invalid or expired');
  } finally { finish.resolve(); await rpc?.close(); await f.close(); }
});
