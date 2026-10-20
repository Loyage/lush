import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, env, until } from '../helpers.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { configurePiFixture } from './pi-runtime-fixture.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { UIClient } from '../../src/ui/client.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');

test('retired create CLI rejects; user RPC self-copy runs its CLI first Input from the inherited Pi checkpoint', async () => {
  const f = fixture(undefined, { LUSH_PROVIDER: 'pi' });
  f.project.kick = () => {}; f.project.scheduleInputEmissions = () => {};
  await repo(f.root); const { agent } = configurePiFixture(f);
  let rpc;
  try {
    const current = (await f.project.order('current Worker', 'main', [], null, false)).task;
    f.project.configureTask(current.id, agent);
    fs.writeFileSync(path.join(current.workspace, 'current-code.txt'), 'current committed code\n');
    await git(current.workspace, 'add', '.'); await git(current.workspace, 'commit', '-m', 'current baseline');
    const commit = await git(current.workspace, 'rev-parse', 'HEAD');
    const session = path.join(f.config.home, 'sessions', 'current.jsonl');
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, [{ type: 'session', id: 'current-session' }, { type: 'message', id: 'current-entry', parentId: null,
      message: { role: 'user', content: 'checkpoint' } }].map(JSON.stringify).join('\n') + '\n');
    f.store.run('INSERT INTO commit_contexts(commit_hash,task_id,session_path,entry_id) VALUES (?,?,?,?)', commit, current.id, session, 'current-entry');
    const log = path.join(f.config.home, 'controlled-child-pi.jsonl'), program = path.join(f.config.home, 'controlled-child-pi');
    fs.writeFileSync(program, `#!/usr/bin/env bun
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ task: process.env.LUSH_TASK_ID, args: process.argv.slice(2) }) + '\\n');
console.log('controlled child result');
`, { mode: 0o755 });
    f.config.env.LUSH_PI_COMMAND = program; f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const envelopes = [];
    const cli = async (...args) => {
      const proc = Bun.spawn([process.execPath, bin, '--project', f.root, '--json', ...args], { cwd: f.root,
        env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`${err} ${out}`);
      expect(code).toBe(0); const value = JSON.parse(out); expect(value.version).toBe(1); envelopes.push(value); return value.data;
    };
    const before = f.store.all('SELECT id FROM tasks ORDER BY id');
    await expect(cli('worker', 'create', '--parent', current.worker_number, '--from', current.worker_number)).rejects.toThrow('已移除');
    expect(f.store.all('SELECT id FROM tasks ORDER BY id')).toEqual(before);
    const child = (await new UIClient(f.config).request('worker.create', { mode: 'fork', parent: current.id, source: current.id })).task;
    expect(child).toMatchObject({ parent_id: current.id, task_kind: 'order', status: 'paused', input_id: null, base_commit: commit,
      target_branch: current.branch, creation: { source_id: current.id, session_inherited: true } });
    expect(f.project.autoMergeView(f.store.task(child.id))).toMatchObject({ enabled: false, locked: false });
    expect(fs.readFileSync(path.join(child.workspace, 'current-code.txt'), 'utf8')).toBe('current committed code\n');
    expect(fs.existsSync(log)).toBe(false);
    const saved = await cli('input', 'draft', 'create', 'child first real instruction', '--append-to', child.worker_number);
    expect(envelopes.at(-1).outcome.status).toBe('saved');
    const first = await cli('input', 'draft', 'submit', String(saved.id), '--revision', String(saved.revision));
    expect(envelopes.at(-1).outcome.status).toBe('scheduled');
    await f.project.drainInputEmissions();
    const receipt = f.project.inputEmissionResult(first.draft_id).dispatch;
    expect(receipt).toMatchObject({ state: 'succeeded', worker_id: child.id, input_id: 2 });
    expect(f.project.inputGet('input', receipt.input_id).source_draft_id).toBe(first.draft_id);
    f.project.pump(); await until(() => !f.project.running.size && f.store.task(child.id).calls === 1, 10000);
    expect(f.store.task(child.id).result).toBe('controlled child result');
    const invocation = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    expect(Number(invocation.task)).toBe(child.id); expect(invocation.args).toContain('--fork');
    expect(fs.readFileSync(invocation.args[invocation.args.indexOf('--fork') + 1], 'utf8')).toContain('current-entry');
    expect(await git(current.workspace, 'rev-parse', 'HEAD')).toBe(commit);
  } finally { await rpc?.close(); await f.close(); }
});
