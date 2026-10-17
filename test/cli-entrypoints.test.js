import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { RPCServer } from '../src/rpc/server.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { CLI_EXECUTABLES, cliHelp } from '../src/cli/catalog.js';
import { AGENT_CAPABILITIES } from '../src/agent/capabilities.js';
import { createSignal } from '../src/signal.js';
import { tokenHash } from '../src/core/project/internal.js';
import { fixture, env, temp } from './helpers.js';

const root = path.resolve(import.meta.dir, '..');
const bin = path.join(root, 'bin/lushw');
async function invoke(command, args, options = {}) {
  const proc = Bun.spawn([command, ...args], { env: env(), stdout: 'pipe', stderr: 'pipe', ...options });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

test('published bins and source scripts expose executable lushw, not a lushc compatibility entry', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(manifest.bin.lushw).toBe('./bin/lushw');
  expect(manifest.scripts.lushw).toBe('bun ./bin/lushw');
  expect(JSON.stringify({ bin: manifest.bin, scripts: manifest.scripts })).not.toContain('lushc');
  expect(fs.existsSync(path.join(root, 'bin/lushc'))).toBe(false);
  expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
  expect(manifest.bin.lush).toBe('./bin/lush');
  expect(manifest.bin.lushd).toBe('./bin/lushd');
  expect(CLI_EXECUTABLES).toEqual(['lush', 'lushw']);
  expect(() => cliHelp('lushc')).toThrow('unknown CLI executable');
  const cwd = temp();
  try {
    // Execute the shipped shebang directly, without a project or daemon.
    const local = await invoke(bin, ['skills', 'list', '--json'], { cwd });
    expect(local.code, local.err).toBe(0);
    expect(JSON.parse(local.out).map(entry => entry.id)).toEqual(AGENT_CAPABILITIES.map(entry => entry.id));
    for (const script of ['lushw', 'progress', 'message']) {
      const result = await invoke(process.execPath, ['run', script, '--help'], { cwd: root });
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain('lushw [--project PATH]');
      expect(result.out).not.toContain('lushc');
    }
    const management = await invoke(path.join(root, 'bin/lush'), ['--help'], { cwd });
    expect(management.code, management.err).toBe(0);
    expect(management.out).toContain('lush [--project PATH]');
    expect(management.out).toContain('order');
    const migrated = await invoke(path.join(root, 'bin/lush'), ['worker', 'spawn', 'no alias'], { cwd });
    expect(migrated.code).toBe(1);
    expect(migrated.err).toContain('use lushw worker spawn');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('real lushw binary reaches authenticated RPC with unchanged development authorization and persisted results', async () => {
  const f = fixture(); f.project.kick = () => {};
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'CLI chain' });
  const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: task.id, goal: 'receive message' });
  const unrelated = f.store.create({ role: 'agent', task_kind: 'order', goal: 'not a relative' });
  const token = 'cli-chain-token';
  f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
  f.project.running.set(task.id, { token, controller: new AbortController() });
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  const call = (args, credential = token, executable = bin) => invoke(executable, [...args, '--json'], { cwd: f.root,
    env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home,
      LUSH_TASK_ID: String(task.id), ...(credential ? { LUSH_AGENT_TOKEN: credential } : {}) }) });
  const cli = async (...args) => {
    const result = await call(args); expect(result.code, result.err).toBe(0); return JSON.parse(result.out);
  };
  try {
    await rpc.start();
    const unauthenticated = await call(['worker', 'auto-title', 'not allowed'], null);
    expect(unauthenticated.code).toBe(1);
    expect(unauthenticated.err).toContain('automatic titles require an Agent invocation');
    const stale = await call(['worker', 'auto-title', 'not allowed'], 'expired-token');
    expect(stale.code).toBe(1);
    expect(f.store.task(task.id).auto_title).toBeNull();
    expect(await cli('worker', 'auto-title', '真实协作')).toMatchObject({ id: task.id, changed: true });
    expect((await cli('progress', 'plan', 'verify:真实链路')).progress.items[0].status).toBe('pending');
    expect((await cli('progress', 'complete', 'verify')).progress.items[0].status).toBe('completed');
    await cli('worker', 'message', String(child.id), 'new requirement');
    expect(f.store.unread(child.id)).toMatchObject([{ sender_id: task.id, body: 'new requirement' }]);
    expect((await cli('worker', 'inspect', String(task.id))).auto_title).toBe('真实协作');
    const denied = await call(['worker', 'message', String(unrelated.id), 'cross-tree forbidden']);
    expect(denied.code).toBe(1);
    expect(f.store.unread(unrelated.id)).toEqual([]);
    const management = await call(['worker', 'cancel', String(child.id)], token, path.join(root, 'bin/lush'));
    expect(management.code).toBe(1);
    expect(management.err).toContain('management command; development Agent invocations must use lushw');
    expect(f.store.task(child.id).status).not.toBe('cancelled');
    const userQuery = await call(['worker', 'inspect', String(task.id)], null, path.join(root, 'bin/lush'));
    expect(userQuery.code, userQuery.err).toBe(0);
    expect(JSON.parse(userQuery.out).id).toBe(task.id);
  } finally { f.project.running.delete(task.id); await rpc.close(); await f.close(); }
});
