import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, env, git, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');

test('real user CLI distinguishes settled/merged dependencies and lands both in dependency order', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd }) {
    const booking = task.reservation;
    if (booking?.status === 'resolving') {
      await git(cwd, 'merge', '--no-ff', booking.parent_commit, '-m', 'absorb fixed parent');
      return 'safe source repair';
    }
    fs.writeFileSync(path.join(cwd, `worker-${task.id}.txt`), `code ${task.id}\n`);
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `work ${task.id}`); return 'safe result';
  } });
  let rpc;
  try {
    const p = f.project; p.kick = () => {}; await repo(f.root); await p.bootstrapMain();
    const a = (await p.order('A')).task, b = (await p.order('B')).task;
    p.pump(); await until(() => !p.running.size && f.store.task(a.id).status === 'waiting' && f.store.task(b.id).status === 'waiting', 12000);
    f.store.update(b.id, { status: 'paused' });
    rpc = new RPCServer(f.config.socket, new Dispatcher(p, createSignal(), {})); await rpc.start();
    const cli = async (...args) => {
      const proc = Bun.spawn([process.execPath, bin, '--project', f.root, '--json', ...args], { cwd: f.root,
        env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, err).toBe(0); const value = JSON.parse(out); expect(value.version).toBe(1); return value.data;
    };
    const before = await cli('worker', 'merge', 'show', a.worker_number);
    expect(before).toMatchObject({ worker_id: a.id, state: 'idle' });
    const bBefore = await cli('worker', 'merge', 'show', b.worker_number);
    await cli('worker', 'merge', 'request', b.worker_number, '--after-merged', a.worker_number, '--revision', bBefore.revision);
    // A true merge/merge cycle is still rejected without saving any intent.
    expect(() => p.mergeTaskAfter(a.id, [{ kind: 'worker_merged', worker_id: b.id }], before.revision)).toThrow('cycle');
    expect(p.taskMergeConditions(a.id)).toMatchObject({ state: 'idle', revision: before.revision });
    const configured = await cli('worker', 'merge', 'request', a.worker_number, '--after-settled', b.worker_number, '--revision', before.revision);
    expect(configured).toMatchObject({ worker_id: a.id, state: 'waiting', conditions: [{ worker_id: b.id, kind: 'worker_settled' }] });
    f.store.update(b.id, { status: 'waiting' }); p.scheduleTaskHooks();
    await until(() => { p.pump(); return [a,b].every(task => f.store.task(task.id).integration === 'merged'); }, 12000);
    for (const task of [a,b]) {
      expect((await cli('worker', 'merge', 'show', task.worker_number)).state).toBe('consumed');
      expect(await git(f.root, 'show', `main:worker-${task.id}.txt`)).toBe(`code ${task.id}`);
    }
    expect(f.store.all("SELECT task_id FROM events WHERE type='task.merge_integrated' ORDER BY id").map(row => row.task_id)).toEqual([a.id,b.id]);
  } finally { await rpc?.close(); await f.close(); }
});
