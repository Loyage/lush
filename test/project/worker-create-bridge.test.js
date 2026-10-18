import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, env, git, until } from '../helpers.js';
import { AgentProvider } from '../../src/agent/provider.js';
import { configurePiFixture } from './pi-runtime-fixture.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { createSignal } from '../../src/signal.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';
import { LUSHW_METHODS } from '../../src/cli/catalog.js';
import { tokenHash } from '../../src/core/project/internal.js';

const bin = path.resolve(import.meta.dir, '../../bin/lush');

test('real user CLI -> registry/RPC -> user-only permission -> paused creation -> first input -> controlled Pi CLI and frozen fork return chain', async () => {
  const f = fixture(undefined, { LUSH_PROVIDER: 'pi' }); f.project.kick = () => {};
  await repo(f.root);
  const log = path.join(f.config.home, 'controlled-pi.jsonl'), program = path.join(f.config.home, 'controlled-pi');
  fs.writeFileSync(program, `#!/usr/bin/env bun
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ task: process.env.LUSH_TASK_ID, args: process.argv.slice(2) }) + '\\n');
console.log('controlled Pi result');
`, { mode: 0o755 });
  f.config.env.LUSH_PI_COMMAND = program;
  const { agent: managedProfile } = configurePiFixture(f);
  f.project.provider = new AgentProvider(f.config, f.project.agentSettings);
  const dispatcher = new Dispatcher(f.project, createSignal(), {}), rpc = new RPCServer(f.config.socket, dispatcher); await rpc.start();
  async function cli(...args) {
    const proc = Bun.spawn([process.execPath, bin, '--project', f.root, '--json', ...args], { cwd: f.root,
      env: env(f.config.env), stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, err, value: out.trim() ? JSON.parse(out) : null };
  }
  try {
    const catalog = await dispatcher.dispatch('cli.catalog', {});
    const command = catalog.commands.find(c => c.path === 'lush worker create');
    expect(command.rpc.find(r => r.method === 'worker.create').parameters).toEqual(PARAMS['worker.create']);
    expect(USER_ONLY.has('worker.create')).toBe(true); expect(LUSHW_METHODS.has('worker.create')).toBe(false);
    const sourceResult = await cli('worker', 'create', 'spawn', '--title', 'source');
    expect(sourceResult).toMatchObject({ code: 0, err: '', value: { task: { status: 'paused', input_id: null } } });
    const source = sourceResult.value.task;
    const snapshot = async () => ({ tasks: f.store.tasks().length, inputs: f.store.all('SELECT id FROM inputs').length,
      branches: f.store.all('SELECT branch FROM branches').map(row => row.branch),
      worktrees: fs.readdirSync(path.join(f.config.home, 'worktrees')).sort(),
      refs: await git(f.root, 'for-each-ref', '--format=%(refname)') });
    async function rejected(expected, ...extra) {
      const before = await snapshot();
      const response = await cli('worker', 'create', 'fork', '--source', source.worker_number, ...extra);
      expect(response.code).not.toBe(0); expect(response.err).toContain(expected);
      expect(await snapshot()).toEqual(before);
    }
    await rejected('没有 Pi 检查点');
    const pointer = path.join(f.config.home, 'sessions', 'fork-source.jsonl'); fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, [{ type: 'session', id: 'fork-source' }, { type: 'message', id: 'fixed-entry', parentId: null,
      message: { role: 'user', content: 'fixed context' } }, { type: 'message', id: 'later-entry', parentId: 'fixed-entry',
      message: { role: 'user', content: 'must not inherit later entry' } }].map(JSON.stringify).join('\n') + '\n');
    f.store.run('INSERT INTO commit_contexts(commit_hash,task_id,session_path,entry_id) VALUES (?,?,?,?)', source.base_commit, source.id, pointer, 'fixed-entry');
    f.store.run('UPDATE commit_contexts SET entry_id=? WHERE commit_hash=?', 'invalid-entry', source.base_commit);
    await rejected('检查点无效或不可用');
    f.store.run('UPDATE commit_contexts SET entry_id=? WHERE commit_hash=?', 'fixed-entry', source.base_commit);
    for (const profile of [{ agent: 'pi', config_mode: 'pi' }, { agent: 'codex' }]) {
      f.project.configureTask(source.id, profile);
      await rejected('Pi 默认模式或 Codex'); // inherited effective mode must be compatible, not silently replaced
    }
    f.project.configureTask(source.id, managedProfile);
    const privateProfile = path.join(f.config.home, 'fork-profile.json');
    fs.writeFileSync(privateProfile, JSON.stringify({ agent: 'pi', config_mode: 'pi' }), { mode: 0o600 });
    await rejected('Pi 默认模式或 Codex', '--profile-file', privateProfile);
    const forkResult = await cli('worker', 'create', 'fork', '--source', source.worker_number);
    expect(forkResult).toMatchObject({ code: 0, value: { task: { status: 'paused', input_id: null,
      parent_id: source.parent_id, target_branch: 'main', creation: { session_inherited: true, source_id: source.id } } } });
    const fork = forkResult.value.task;
    const cached = path.join(f.config.home, 'session-checkpoints', `${source.base_commit}.jsonl`);
    const savedCache = fs.readFileSync(cached, 'utf8');
    fs.writeFileSync(cached, '{broken cached checkpoint');
    await rejected('检查点无效或不可用');
    fs.writeFileSync(cached, savedCache);
    const blank = (await cli('worker', 'create', 'spawn')).value.task;
    expect((await cli('worker', 'resume', fork.worker_number)).code).not.toBe(0);
    expect(fs.existsSync(log)).toBe(false);
    f.store.run('UPDATE commit_contexts SET entry_id=? WHERE commit_hash=?', 'later-entry', source.base_commit);
    // Valid ordinary Agent identity must still fail at the RPC user-only gate, before resource creation.
    const agent = (await f.project.order('actor', 'main', [], null, false)).task;
    const token = 'test-invocation-secret'; f.store.update(agent.id, { status: 'running' }); f.store.armAgent(agent.id, tokenHash(token));
    f.project.running.set(agent.id, { token, controller: new AbortController() });
    await expect(dispatcher.dispatch('worker.create', { mode: 'spawn', _token: token })).rejects.toThrow('user approval');
    f.project.running.delete(agent.id); f.store.armAgent(agent.id, null); f.store.update(agent.id, { status: 'paused' });
    expect((await cli('worker', 'message', fork.worker_number, 'fork first instruction')).value.input_id).toBe(2);
    expect((await cli('worker', 'message', blank.worker_number, 'blank first instruction')).code).toBe(0);
    f.project.pump();
    await until(() => !f.project.running.size && f.store.task(fork.id).calls === 1 && f.store.task(blank.id).calls === 1, 10000);
    for (const task of [fork, blank]) expect(f.store.task(task.id)).toMatchObject({ result: 'controlled Pi result', status: 'waiting' });
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(runs).toHaveLength(2);
    const forkArgs = runs.find(r => Number(r.task) === fork.id).args;
    const forkFile = forkArgs[forkArgs.indexOf('--fork') + 1];
    expect(forkArgs).toContain('--fork');
    const inherited = fs.readFileSync(forkFile, 'utf8'); expect(inherited).toContain('fixed-entry'); expect(inherited).not.toContain('later-entry');
    expect(runs.find(r => Number(r.task) === blank.id).args).not.toContain('--fork');
    const read = await cli('worker', 'inspect', fork.worker_number);
    expect(read.value).toMatchObject({ goal: 'fork first instruction', creation: { waiting_first_input: false, commit: source.base_commit } });
    expect(read.value.session_fork).toBeUndefined();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(source.base_commit);
  } finally { await rpc.close(); await f.close(); }
});
