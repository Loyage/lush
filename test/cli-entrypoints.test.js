import { test, expect } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { CLI_COMMANDS, cliCommands, CLI_EXECUTABLES, LUSHC_PATHS, SHARED_CLI_PATHS } from '../src/cli/catalog.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';
import { RPCServer } from '../src/rpc/server.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { createSignal } from '../src/signal.js';
import { tokenHash } from '../src/core/project/internal.js';
import { fixture, env, temp } from './helpers.js';

const bins = Object.fromEntries(CLI_EXECUTABLES.map(executable => [executable, path.resolve(import.meta.dir, `../bin/${executable}`)]));
async function cli(executable, args, root, extra = {}) {
  const process = Bun.spawn([Bun.which('bun'), bins[executable], ...args], {
    cwd: root, env: env(extra), stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { out, err, code };
}

test('fixed binaries expose disjoint development/management help and shared reads without project discovery', async () => {
  const root = temp();
  try {
    for (const executable of CLI_EXECUTABLES) {
      const result = await cli(executable, ['worker', 'spawn', '--help'], root, {
        LUSH_PROJECT: '/missing-project', LUSH_HOME: '/invalid-home', LUSH_AGENT_TOKEN: 'invalid',
      });
      expect(result.code).toBe(0); expect(result.err).toBe('');
      expect(result.out).toContain(`${executable} [--project PATH]`);
      expect(result.out).toContain('worker inspect');
      expect(result.out.includes("worker spawn '目标'")).toBe(executable === 'lushc');
      expect(result.out.includes("order '目标'")).toBe(executable === 'lush');
      expect(result.out.includes('progress plan')).toBe(executable === 'lushc');
    }
    expect(fs.readdirSync(root)).toEqual([]);
    const packageInfo = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../package.json')));
    expect(packageInfo.bin.lushc).toBe('./bin/lushc'); expect(packageInfo.scripts.lushc).toBe('bun ./bin/lushc');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('exclusive leaves reject wrong executable with a migration hint before configuration or RPC', async () => {
  const root = temp();
  try {
    for (const entry of CLI_COMMANDS.filter(item => !item.directory && LUSHC_PATHS.has(item.path) && !SHARED_CLI_PATHS.has(item.path))) {
      const result = await cli('lush', entry.path.split(' '), root, { LUSH_PROJECT: '/missing-project', LUSH_HOME: '/invalid-home' });
      expect(result.code).toBe(1); expect(result.out).toBe(''); expect(result.err).toContain(`use lushc ${entry.path}`);
    }
    for (const args of [['order', 'goal'], ['worker', 'resolve', '1'], ['agent', 'env', 'agent'], ['host', 'start']]) {
      const result = await cli('lushc', args, root, { LUSH_PROJECT: '/missing-project', LUSH_HOME: '/invalid-home' });
      expect(result.code).toBe(1); expect(result.out).toBe(''); expect(result.err).toContain('use lush ');
    }
    expect(fs.readdirSync(root)).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('development invocation cannot bypass migrated acceptance via management aliases or executable argv', async () => {
  const root = temp();
  try {
    for (const args of [['worker', 'resolve', '1'], ['worker', 'integrate', '1', 'sha'], ['order', 'goal'], ['worker', 'cleanup', '1']]) {
      const result = await cli('lush', args, root, { LUSH_PROJECT: '/missing-project', LUSH_HOME: '/invalid-home', LUSH_AGENT_TOKEN: 'active' });
      expect(result.code).toBe(1); expect(result.err).toContain('management command'); expect(result.out).toBe('');
    }
    const result = await cli('lush', ['--executable', 'lushc', 'worker', 'spawn', 'goal'], root);
    expect(result.code).toBe(1); expect(result.err).toContain('unknown command: --executable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real lushc binary -> parser -> Unix RPC registry -> invocation permission -> execution returns persistent results', async () => {
  const f = fixture(); f.project.kick = () => {};
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  const task = f.store.create({ role: 'agent', task_kind: 'order', goal: 'CLI chain', name: 'cli-chain' });
  const token = 'cli-chain-token'; f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
  f.project.running.set(task.id, { token, controller: new AbortController() });
  const extra = { ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home, LUSH_TASK_ID: String(task.id), LUSH_AGENT_TOKEN: token };
  try {
    await rpc.start();
    const title = await cli('lushc', ['worker', 'auto-title', '双入口验证', '--json'], f.root, extra);
    expect(title.code).toBe(0); expect(title.err).toBe(''); expect(JSON.parse(title.out)).toMatchObject({ id: task.id, auto_title: '双入口验证', changed: true });
    expect(f.store.task(task.id).auto_title).toBe('双入口验证');
    const plan = await cli('lushc', ['progress', 'plan', 'verify:真实链路', '--json'], f.root, extra);
    expect(plan.code).toBe(0); expect(JSON.parse(plan.out).progress.items[0]).toMatchObject({ key: 'verify', status: 'pending' });
    const complete = await cli('lushc', ['progress', 'complete', 'verify', '--json'], f.root, extra);
    expect(complete.code).toBe(0); expect(JSON.parse(complete.out).progress.items[0].status).toBe('completed');
    for (const executable of CLI_EXECUTABLES) {
      const result = await cli(executable, ['worker', 'inspect', String(task.id), '--json'], f.root, extra);
      expect(result.code).toBe(0); expect(JSON.parse(result.out).auto_title).toBe('双入口验证');
    }
    const rejected = await cli('lushc', ['worker', 'auto-title', 'invalid', '--json'], f.root, { ...extra, LUSH_AGENT_TOKEN: 'stale' });
    expect(rejected.code).toBe(1); expect(rejected.err).toContain('lushc:'); expect(f.store.task(task.id).auto_title).toBe('双入口验证');
  } finally { f.project.running.delete(task.id); await rpc.close(); await f.close(); }
});

test('bun run progress/message source shortcuts select lushc and complete a real invocation-bound RPC chain', async () => {
  const f = fixture(); f.project.kick = () => {};
  const rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  const parent = f.store.create({ role: 'agent', task_kind: 'order', goal: 'source shortcuts', name: 'shortcut-parent' });
  const child = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'child', goal: 'receive input', name: 'shortcut-child' });
  const token = 'source-shortcut-token'; f.store.update(parent.id, { status: 'running' }); f.store.armAgent(parent.id, tokenHash(token));
  f.project.running.set(parent.id, { token, controller: new AbortController() });
  const run = async (command, ...args) => {
    const process = Bun.spawn([Bun.which('bun'), 'run', command, ...args, '--json'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: env({ ...f.config.env, LUSH_PROJECT: f.root, LUSH_HOME: f.config.home, LUSH_TASK_ID: String(parent.id), LUSH_AGENT_TOKEN: token }),
      stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(code).toBe(0); expect(err).not.toContain('not available'); expect(err).not.toContain('management command');
    return JSON.parse(out);
  };
  try {
    await rpc.start();
    const plan = await run('progress', 'plan', 'verify:快捷入口');
    expect(plan.progress.items[0]).toMatchObject({ key: 'verify', status: 'pending' });
    const complete = await run('progress', 'complete', 'verify');
    expect(complete.progress.items[0].status).toBe('completed');
    expect((await run('message', String(child.id), '来自真实快捷入口的补充')).id).toBe(child.id);
    expect(f.store.get('SELECT sender_id,body FROM messages WHERE task_id=?', child.id))
      .toEqual({ sender_id: parent.id, body: '来自真实快捷入口的补充' });
  } finally { f.project.running.delete(parent.id); await rpc.close(); await f.close(); }
});

test('public catalogue and per-executable registration are identical including fully-qualified parent links', () => {
  const catalog = cliCatalog();
  for (const executable of CLI_EXECUTABLES) {
    expect(catalog.commands.filter(entry => entry.executable === executable).map(entry => entry.command_path))
      .toEqual(cliCommands(executable).map(entry => entry.path));
  }
  for (const entry of catalog.commands) {
    expect(entry.path).toBe(`${entry.executable} ${entry.command_path}`);
    if (entry.parent) expect(catalog.commands.some(parent => parent.path === entry.parent && parent.executable === entry.executable && parent.directory)).toBe(true);
  }
});
