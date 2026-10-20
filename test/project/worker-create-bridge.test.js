import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, env, until } from '../helpers.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { configurePiFixture } from './pi-runtime-fixture.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { tokenHash } from '../../src/core/project/internal.js';
import { UIClient } from '../../src/ui/client.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');

test('retired create CLI rejects; user RPC -> paused creation -> CLI first Input -> controlled Pi result', async () => {
  const f = fixture(undefined, { LUSH_PROVIDER: 'pi' }); f.project.kick = () => {};
  await repo(f.root); configurePiFixture(f);
  const log = path.join(f.config.home, 'controlled-pi.jsonl'), program = path.join(f.config.home, 'controlled-pi');
  fs.writeFileSync(program, `#!/usr/bin/env bun
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ task: process.env.LUSH_TASK_ID }) + '\\n');
console.log('controlled Pi result');
`, { mode: 0o755 });
  f.config.env.LUSH_PI_COMMAND = program;
  f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
  const cli = async (...args) => {
    const proc = Bun.spawn([process.execPath, bin, '--project', f.root, '--json', ...args], { cwd: f.root,
      env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`${err} ${out}`);
    expect(code).toBe(0); const value = JSON.parse(out); expect(value.version).toBe(1); return value.data;
  };
  try {
    const before = f.store.all('SELECT id FROM tasks ORDER BY id');
    await expect(cli('worker', 'create', '--title', 'blank')).rejects.toThrow('已移除');
    expect(f.store.all('SELECT id FROM tasks ORDER BY id')).toEqual(before);
    const created = await new UIClient(f.config).request('worker.create', { mode: 'spawn', title: 'blank' });
    expect(created.task).toMatchObject({ status: 'paused', input_id: null, calls: 0 });
    expect(fs.existsSync(log)).toBe(false);
    const actor = (await f.project.order('actor', 'main', [], null, false)).task;
    const token = 'test-invocation-secret'; f.store.update(actor.id, { status: 'running' }); f.store.armAgent(actor.id, tokenHash(token));
    f.project.running.set(actor.id, { token, controller: new AbortController() });
    await expect(dispatcher.dispatch('worker.create', { mode: 'spawn', _token: token })).rejects.toThrow('user approval');
    f.project.running.delete(actor.id); f.store.armAgent(actor.id, null); f.store.update(actor.id, { status: 'paused' });
    const first = await cli('worker', 'message', created.task.worker_number, 'blank first instruction');
    expect(first.input_id).toBeGreaterThan(0);
    f.project.pump();
    await until(() => !f.project.running.size && f.store.task(created.task.id).calls === 1, 10000);
    expect(f.store.task(created.task.id)).toMatchObject({ result: 'controlled Pi result', status: 'waiting' });
    expect(JSON.parse(fs.readFileSync(log, 'utf8').trim()).task).toBe(String(created.task.id));
    expect(await cli('worker', 'show', created.task.worker_number)).toMatchObject({ goal: 'blank first instruction', creation: { waiting_first_input: false } });
  } finally { await rpc.close(); await f.close(); }
});
