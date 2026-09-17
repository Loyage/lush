import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { forceStopDaemon, isLocked } from '../src/daemon/locking.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { cleanup, deferred, system, tmpdir } from './helpers.js';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI = path.join(ROOT, 'src', 'cli', 'main.js');
const DAEMON = path.join(ROOT, 'src', 'daemon', 'main.js');

describe('cli, daemon lifecycle and attach', () => {
  const state = { dir: null, env: null };

  function setup() {
    state.dir = tmpdir('lush-cli-');
    state.env = {
      ...process.env,
      LUSH_HOME: state.dir,
      LUSH_PROVIDER: 'mock',
      LUSH_CALL_TIMEOUT: '10',
      LUSH_RPC_TIMEOUT: '15',
    };
  }

  async function cli(args, { input = null, env = null, check = true } = {}) {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: ROOT,
      env: env ?? state.env,
      stdin: input === null ? 'ignore' : Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (check) expect(code, `${args.join(' ')}: ${stderr}\n${stdout}`).toBe(0);
    return { code, stdout, stderr };
  }

  async function data(...args) {
    const { stdout } = await cli(['--json', ...args]);
    return JSON.parse(stdout);
  }

  async function waitUnlocked(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (isLocked(state.dir) && Date.now() < deadline) await Bun.sleep(20);
    return !isLocked(state.dir);
  }

  setup();

  afterEach(async () => {
    // Graceful stop first; then make sure no detached daemon survives the test.
    await cli(['daemon', 'stop'], { check: false });
    await forceStopDaemon(state.dir);
    expect(isLocked(state.dir)).toBe(false);
    cleanup(state.dir);
  });

  test('every command layer documents itself through help', async () => {
    const top = await cli(['help']);
    expect(top.stdout).toContain('覆盖范围');
    expect(top.stdout).toContain('daemon');
    expect(top.stdout).toContain('process');

    const group = await cli(['process', 'help']);
    expect(group.stdout).toContain('子命令');
    expect(group.stdout).toContain('update-state');
    expect(group.stdout).toContain('spawn');

    // Help is reachable from every layer, and every spelling agrees.
    const leaf = await cli(['process', 'spawn', '-h']);
    expect(leaf.stdout).toContain('lush process spawn —');
    expect((await cli(['process', 'spawn', '--help'])).stdout).toBe(leaf.stdout);
    expect((await cli(['process', 'spawn', 'help'])).stdout).toBe(leaf.stdout);
    expect((await cli(['help', 'process', 'spawn'])).stdout).toBe(leaf.stdout);
    expect((await cli(['daemon', 'help'])).stdout).toContain('lush daemon <command> [args]');
    // Help wins over a missing positional, so it never depends on a live daemon.
    expect((await cli(['process', 'call', '--help'])).stdout).toContain('lush process call —');

    const json = JSON.parse((await cli(['--json', 'help', 'process'])).stdout);
    expect(json.command).toBe('lush process');
    expect(json.subcommands.map((child) => child.name)).toContain('inspect');

    const bad = await cli(['help', 'process', 'nope'], { check: false });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid choice: 'nope'");

    // Agent state lives under the process it belongs to; there is no agent group.
    expect((await cli(['process', 'session', '-h'])).stdout).toContain('lush process session —');
    expect((await cli(['agent', 'session', '0'], { check: false })).code).toBe(2);

    const missing = await cli(['process'], { check: false });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('subcommand');
  });

  test('complete MVP CLI flow: attach, restart and orphans', async () => {
    expect((await cli(['daemon', 'status'], { check: false })).code).not.toBe(0);

    const started = await data('daemon', 'start');
    expect((await cli(['process', 'tree'])).stdout.trim()).toBe('lush[0]');
    expect((await data('daemon', 'start')).daemon_pid).toBe(started.daemon_pid);
    expect((await cli(['process', 'spawn', '0', 'generic-service', '--name', 'project-manager'])).stdout.trim()).toBe('PID 1');
    expect((await cli(['process', 'spawn', '1', 'generic-task', '--name', 'implement-login', '--goal', '实现登录'])).stdout.trim())
      .toBe('PID 2');
    expect((await cli(['process', 'call', '2', '请介绍一下你当前的身份和任务'])).stdout).toContain('project-manager[1]');

    const attached = await cli(['process', 'attach', '2'], { input: '当前任务是什么？\n查看你的子任务\n/exit\n' });
    expect(attached.stdout).toContain('attached to implement-login [2]');
    expect(attached.stdout.split('agent>').length - 1).toBe(2);

    await cli(['process', 'call', '1', '创建一个子任务，研究 OAuth 登录实现方式']);
    const expected = 'lush[0]\n└── project-manager[1]\n    ├── implement-login[2]\n    └── research-oauth[3]\n';
    expect((await cli(['process', 'tree'])).stdout).toBe(expected);
    expect((await cli(['process', 'list'])).stdout).toContain('PPID');

    const info = await data('process', 'inspect', '2');
    expect(info.context.message_count).toBe(8); // 2 text calls + children tool call

    await cli(['daemon', 'stop']);
    await cli(['daemon', 'start']);
    expect((await cli(['process', 'tree'])).stdout).toBe(expected);
    expect((await data('process', 'inspect', '2')).context).toEqual(info.context);

    await cli(['process', 'stop', '1']);
    expect((await data('process', 'inspect', '2')).parent_pid).toBe(0);
    expect((await data('process', 'inspect', '3')).original_parent_pid).toBe(1);
    await cli(['process', 'start', '1']);
    await cli(['process', 'call', '2', '/tool process.complete {"result":"done"}']);
    expect((await cli(['process', 'attach', '2'], { input: '/exit\n', check: false })).code).not.toBe(0);
    await cli(['process', 'reclaim', '2']);
    expect((await data('process', 'history', '2')).messages.length).toBeGreaterThan(0);
    expect((await data('process', 'spawn', '0', 'generic-task')).pid).toBe(4);
  }, 120_000);

  test('complete, update-state and spawn args over the CLI', async () => {
    await cli(['daemon', 'start']);
    await cli(['process', 'spawn', '0', 'generic-task', '--name', 'worker', '--goal', 'work']);
    expect((await data('process', 'update-state', '1', '--patch', '{"progress":"half"}')).progress).toBe('half');
    const done = await data('process', 'complete', '1', '--result', '{"answer":42}');
    expect(done.status).toBe('completed');
    expect((await data('process', 'inspect', '1')).context.state).toEqual({ result: { answer: 42 }, progress: 'half' });

    const spawned = await data('process', 'spawn', '0', 'project', '--name', 'p1', '--args', JSON.stringify({ path: state.dir }));
    expect((await data('process', 'inspect', String(spawned.pid))).context.state.params).toEqual({ path: state.dir });

    // --dry-run prints the invocation instead of calling the agent.
    const preview = await data('process', 'call', String(spawned.pid), 'hello', '--dry-run');
    expect(preview).toMatchObject({ dry_run: true, agent: 'mock', command: null });
    expect((await data('process', 'inspect', String(spawned.pid))).context.message_count).toBe(0);
    expect((await cli(['process', 'call', String(spawned.pid), 'hello', '--dry-run'])).stdout).toContain('runs in-process');

    const missing = await cli(['process', 'spawn', '0', 'project', '--name', 'p2'], { check: false });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('args.path');
    expect((await cli(['process', 'update-state', '1', '--patch', '{oops'], { check: false })).stderr).toContain('invalid JSON');

    // --interactive needs an external agent: the in-process runtime has no TUI.
    const enter = await cli(['process', 'call', String(spawned.pid), 'hello', '-i'], { check: false });
    expect(enter.code).not.toBe(0);
    expect(enter.stderr).toContain('runs in-process');
    expect((await cli(['process', 'call', String(spawned.pid), 'hello', '--interactive', '--dry-run'], { check: false })).code).toBe(2);
  }, 60_000);

  test('session lists the pi session and --open hands the terminal to pi', async () => {
    const stub = path.join(state.dir, 'pi-stub');
    fs.mkdirSync(state.dir, { recursive: true });
    fs.writeFileSync(stub, [
      '#!/usr/bin/env bun',
      'const argv = process.argv.slice(2);',
      "if (argv.includes('--session-dir')) {",
      "  const dir = argv[argv.indexOf('--session-dir') + 1];",
      "  const id = argv[argv.indexOf('--session-id') + 1];",
      "  await Bun.write(dir + '/2020-01-01T00-00-00-000Z_' + id + '.jsonl', '{}');",
      '}',
      "console.log(JSON.stringify({ tui: !argv.includes('--print'), pid: process.env.LUSH_PID }));",
      '',
    ].join('\n'));
    fs.chmodSync(stub, 0o755);
    const baseEnv = state.env;
    state.env = { ...baseEnv, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub };
    try {
      await cli(['daemon', 'start']);
      const project = await data('process', 'spawn', '0', 'project', '--name', 'p1', '--args', JSON.stringify({ path: state.dir }));

      const before = await data('process', 'session', String(project.pid));
      expect(before).toMatchObject({ agent: 'pi', session_id: `lush-${project.pid}`, file: null, files: [] });
      expect((await cli(['process', 'session', String(project.pid)])).stdout).toContain('(none yet)');

      await cli(['process', 'call', String(project.pid), 'hi']);
      const after = await data('process', 'session', String(project.pid));
      expect(after.file.endsWith(`_lush-${project.pid}.jsonl`)).toBe(true);
      const text = (await cli(['process', 'session', String(project.pid)])).stdout;
      expect(text).toContain(path.join(state.dir, 'pi-sessions'));
      expect(text).toContain(`lush-${project.pid}`);

      // --open runs pi in the foreground (no --print) with the Lush environment.
      const opened = await cli(['process', 'session', String(project.pid), '--open']);
      expect(JSON.parse(opened.stdout)).toEqual({ tui: true, pid: String(project.pid) });
      expect((await cli(['--json', 'process', 'session', String(project.pid), '--open'], { check: false })).code).toBe(2);
    } finally {
      state.env = baseEnv;
    }
  }, 60_000);

  test('process call --interactive enters the agent, holds busy and settles the call', async () => {
    const stub = path.join(state.dir, 'pi-interactive');
    fs.mkdirSync(state.dir, { recursive: true });
    fs.writeFileSync(stub, [
      '#!/usr/bin/env bun',
      'const argv = process.argv.slice(2);',
      'const sleep = Number(process.env.PI_STUB_SLEEP ?? 0);',
      'if (sleep > 0) await Bun.sleep(sleep);',
      // Faithful to pi: one file per session id, named by session start; extra rounds append.
      "if (argv.includes('--session-dir')) {",
      "  const dir = argv[argv.indexOf('--session-dir') + 1];",
      "  const id = argv[argv.indexOf('--session-id') + 1];",
      "  await Bun.write(`${dir}/2020-01-01T00-00-00-000Z_${id}.jsonl`, '{}');",
      '  if (process.env.PI_STUB_FORK === \'1\') await Bun.write(`${dir}/2020-01-01T00-00-01-000Z_${id}.jsonl`, \'{}\');',
      '}',
      "console.log(JSON.stringify({ tui: !argv.includes('--print'), pid: process.env.LUSH_PID, prompt: argv[argv.length - 1] }));",
      'process.exit(Number(process.env.PI_STUB_EXIT ?? 0));',
      '',
    ].join('\n'));
    fs.chmodSync(stub, 0o755);
    const baseEnv = state.env;
    state.env = { ...baseEnv, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub };
    try {
      await cli(['daemon', 'start']);
      expect((await cli(['process', 'spawn', '0', 'generic-task', '--name', 'worker'])).stdout.trim()).toBe('PID 1');
      const pid = '1';

      // The daemon opens the call, this terminal runs pi, then the call is settled.
      const running = Bun.spawn([process.execPath, CLI, 'process', 'call', pid, 'do the thing', '--interactive'], {
        cwd: ROOT, env: { ...state.env, PI_STUB_SLEEP: '1500' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr] = [new Response(running.stdout).text(), new Response(running.stderr).text()];
      // Poll until the terminal has reported the OS pid of the pi process it runs.
      let live = [];
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await Bun.sleep(20);
        live = await data('process', 'agents', 'list');
        if (live.length > 0 && live[0].os_pid !== null) break;
      }
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: `${pid}.1`, pid: Number(pid), provider: 'pi', status: 'running', call_id: 1, interactive: true, cancellable: true,
      });
      expect(live[0].os_pid).toBeGreaterThan(0);
      expect((await data('process', 'session', pid)).busy).toBe(true);
      // Busy protection: a second pi on the same session is refused while the TUI runs.
      const second = await cli(['process', 'call', pid, 'again'], { check: false });
      expect(second.code).not.toBe(0);
      expect(second.stderr).toContain('busy');
      expect((await data('process', 'inspect', pid)).recent_calls[0])
        .toMatchObject({ status: 'running', prompt: 'do the thing' });
      // The same activity is visible for the whole tree, without asking per PID.
      expect((await cli(['process', 'tree'])).stdout).toContain(`agent ${pid}.1 running · `);
      expect((await cli(['process', 'tree'])).stdout).toContain('· tty');
      expect((await cli(['process', 'tree', '--no-agents'])).stdout).not.toContain('agent ');
      expect((await data('process', 'tree'))[1].agent).toMatchObject({
        provider: 'pi', running: 1, agents: [{ id: `${pid}.1`, interactive: true, call_id: 1 }],
      });
      expect((await data('process', 'tree', '--no-agents'))[1].agent).toBeUndefined();
      // The agent space names it and shows the durable call behind it.
      expect((await cli(['process', 'agents', 'list'])).stdout).toContain(`${pid}.1`);
      expect((await cli(['process', 'agents', 'list'])).stdout).toContain('tty');
      expect((await data('process', 'agents', 'show', `${pid}.1`))).toMatchObject({
        id: `${pid}.1`,
        call: { id: 1, prompt: 'do the thing', status: 'running' },
        session: { session_id: `lush-${pid}` },
      });

      expect(await running.exited).toBe(0);
      // stdio is inherited, so pi's TUI output lands in this terminal, which is the point.
      expect(JSON.parse(await stdout)).toEqual({ tui: true, pid, prompt: 'do the thing' });
      expect(await stderr).toContain(`entering pi for pid ${pid} (call 1, agent ${pid}.1)`);
      expect((await data('process', 'inspect', pid)).recent_calls[0].status).toBe('succeeded');
      expect((await data('process', 'session', pid)).busy).toBe(false);
      // Only the call itself is recorded; the reply stays in the pi session.
      expect((await data('process', 'history', pid)).messages.length).toBe(1);
      // The worker is gone from the live list and kept (bounded) in the daemon's memory.
      expect(await data('process', 'agents', 'list')).toEqual([]);
      expect((await cli(['process', 'agents', 'list'])).stdout.trim()).toBe('no running agents');
      expect((await data('process', 'agents', 'list', '--all'))[0]).toMatchObject({
        id: `${pid}.1`, status: 'succeeded', cancellable: false,
      });
      expect((await data('process', 'agents', 'list', '--pid', pid, '--all')).map((agent) => agent.id)).toEqual([`${pid}.1`]);
      expect(await data('process', 'agents', 'list', '--pid', '0', '--all')).toEqual([]);

      // The next daemon-run call continues that same session, and the next agent gets the next id.
      expect(JSON.parse((await cli(['process', 'call', pid, 'hi'])).stdout)).toEqual({ tui: false, pid, prompt: 'hi' });
      // Multi-round calls append to the same transcript; a pi-side fork adds a second file.
      expect((await data('process', 'session', pid)).files).toHaveLength(1);
      await cli(['process', 'call', pid, 'fork', '-i'], { env: { ...state.env, PI_STUB_FORK: '1' } });
      expect((await data('process', 'session', pid)).files).toHaveLength(2);
      expect((await data('process', 'agents', 'list', '--all')).map((agent) => `${agent.id}:${agent.status}`))
        .toEqual([`${pid}.1:succeeded`, `${pid}.2:succeeded`, `${pid}.3:succeeded`]);

      // Usage errors and a failing agent both leave the process usable.
      expect((await cli(['process', 'call', pid, 'hi', '-i', '--dry-run'], { check: false })).code).toBe(2);
      expect((await cli(['--json', 'process', 'call', pid, 'hi', '-i'], { check: false })).code).toBe(2);
      const failing = await cli(['process', 'call', pid, 'hi', '-i'], { check: false, env: { ...state.env, PI_STUB_EXIT: '4' } });
      expect(failing.code).not.toBe(0);
      expect(failing.stderr).toContain('pi exited 4');
      const failed = (await data('process', 'inspect', pid)).recent_calls[0];
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('pi exited 4');
      expect((await data('process', 'session', pid)).busy).toBe(false);
    } finally {
      state.env = baseEnv;
    }
  }, 60_000);

  test('process agents kill stops the worker, not the process', async () => {
    const stub = path.join(state.dir, 'pi-slow-agent');
    fs.mkdirSync(state.dir, { recursive: true });
    fs.writeFileSync(stub, [
      '#!/usr/bin/env bun',
      'const argv = process.argv.slice(2);',
      "const dir = argv[argv.indexOf('--session-dir') + 1];",
      "const id = argv[argv.indexOf('--session-id') + 1];",
      "if (dir && id) await Bun.write(`${dir}/2020-01-01T00-00-00-000Z_${id}.jsonl`, '{}');",
      'await Bun.sleep(Number(process.env.PI_STUB_SLEEP ?? 0));',
      "console.log('late reply');",
      '',
    ].join('\n'));
    fs.chmodSync(stub, 0o755);
    const baseEnv = state.env;
    state.env = { ...baseEnv, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub };
    try {
      await cli(['daemon', 'start']);
      expect((await cli(['process', 'spawn', '0', 'generic-task', '--name', 'worker'])).stdout.trim()).toBe('PID 1');
      // A daemon-spawned agent: this CLI only waits for the call to finish.
      const call = Bun.spawn([process.execPath, CLI, 'process', 'call', '1', 'long work'], {
        cwd: ROOT, env: { ...state.env, PI_STUB_SLEEP: '3000' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr] = [new Response(call.stdout).text(), new Response(call.stderr).text()];
      let live = [];
      for (let attempt = 0; attempt < 300 && live.length === 0; attempt += 1) {
        await Bun.sleep(20);
        live = await data('process', 'agents', 'list');
      }
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: '1.1', pid: 1, provider: 'pi', status: 'running', call_id: 1, interactive: false, cancellable: true,
      });
      expect(live[0].os_pid).toBeGreaterThan(0);
      // The tree shows the activity of that process only.
      const tree = (await cli(['process', 'tree'])).stdout;
      expect(tree).toContain('agent 1.1 running · ');
      expect(tree).toContain('lush[0]');
      expect(tree).not.toContain('agent 0.1');
      expect((await cli(['process', 'agents', 'list'])).stdout).toContain('pipe');

      // Killing the worker ends the invocation; the process keeps running with its goal.
      expect(JSON.parse((await cli(['--json', 'process', 'agents', 'kill', '1.1'])).stdout)).toMatchObject({ id: '1.1', killed: true });
      expect(await call.exited).not.toBe(0);
      expect(await stderr).toContain('interrupted');
      expect(await stdout).toBe('');
      let info = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        info = await data('process', 'inspect', '1');
        if (info.recent_calls[0].status !== 'running') break;
        await Bun.sleep(20);
      }
      expect(info.recent_calls[0]).toMatchObject({ status: 'interrupted', error: 'invocation cancelled' });
      expect(info.status).toBe('running');
      expect(await data('process', 'agents', 'list')).toEqual([]);
      expect((await data('process', 'agents', 'list', '--all'))[0]).toMatchObject({ id: '1.1', status: 'interrupted' });
      // A finished agent cannot be killed again, and the process stays usable.
      const again = await cli(['process', 'agents', 'kill', '1.1'], { check: false });
      expect(again.code).not.toBe(0);
      expect(again.stderr).toContain('is not running');
      expect((await cli(['process', 'call', '1', 'hi'])).stdout.trim()).toBe('late reply');
      expect((await data('process', 'agents', 'list', '--all')).map((agent) => agent.id)).toEqual(['1.1', '1.2']);
    } finally {
      state.env = baseEnv;
    }
  }, 60_000);

  test('single instance, SIGTERM and socket cleanup', async () => {
    const status = await data('daemon', 'start');
    const duplicate = Bun.spawn([process.execPath, DAEMON], {
      cwd: ROOT, env: state.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([new Response(duplicate.stderr).text(), duplicate.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('already running');

    expect((await data('daemon', 'status')).daemon_pid).toBe(status.daemon_pid);
    process.kill(status.daemon_pid, 'SIGTERM');
    expect(await waitUnlocked()).toBe(true);
    expect(fs.existsSync(path.join(state.dir, 'lush.sock'))).toBe(false);

    await cli(['daemon', 'start']);
    expect((await data('process', 'list')).length).toBe(1);
  }, 60_000);

  test('daemon status reports which home and which code answer', async () => {
    await cli(['daemon', 'start']);
    const status = await data('daemon', 'status');
    expect(status.home).toBe(state.dir);
    expect(status.socket).toBe(path.join(state.dir, 'lush.sock'));
    expect(status.code_dir).toBe(ROOT);
    expect(status.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof status.started_at).toBe('string');
    expect(status.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(status.cli).toEqual({
      home: state.dir,
      socket: path.join(state.dir, 'lush.sock'),
      code_dir: ROOT,
      version: expect.any(String),
      fingerprint: status.fingerprint,
      code_match: true,
    });
    // A daemon running this exact code stays quiet on stderr.
    expect((await cli(['process', 'list'])).stderr).not.toContain('runs different code');

    // Text output is one aligned line per field, not a JSON blob.
    const text = await cli(['daemon', 'status']);
    expect(text.stdout).toMatch(new RegExp(`^home\\s+${state.dir}$`, 'm'));
    expect(text.stdout).toMatch(/^cli\.code_match\s+true$/m);
  }, 60_000);

  test('force stop reclaims the daemon that owns the home', async () => {
    const dir = tmpdir('lush-lock-');
    const env = { ...process.env, LUSH_HOME: dir, LUSH_PROVIDER: 'mock', LUSH_RPC_TIMEOUT: '15' };
    const start = Bun.spawn([process.execPath, CLI, 'daemon', 'start'], {
      cwd: ROOT, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    await new Response(start.stderr).text();
    expect(await start.exited).toBe(0);
    const pid = Number.parseInt(fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8'), 10);
    expect(isLocked(dir)).toBe(true);

    expect(await forceStopDaemon(dir)).toEqual({ pid, killed: true, reason: 'SIGKILL' });
    expect(isLocked(dir)).toBe(false);
    cleanup(dir);
  }, 30_000);

  test('force stop refuses a lock owner that is not a lush daemon', async () => {
    const dir = tmpdir('lush-lock-');
    const sleeper = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    fs.writeFileSync(path.join(dir, 'daemon.lock'), String(sleeper.pid), { mode: 0o600 });

    const forced = await forceStopDaemon(dir);
    expect(forced.pid).toBe(sleeper.pid);
    expect(forced.killed).toBe(false);
    expect(forced.reason).toContain('not a lush daemon');
    expect(sleeper.exitCode).toBeNull(); // pids are recycled: the guard must hold

    sleeper.kill();
    await sleeper.exited;
    expect(await forceStopDaemon(dir)).toEqual({ pid: sleeper.pid, killed: false, reason: 'lock owner is gone' });
    cleanup(dir);
  }, 30_000);

  test('warns when the daemon answering runs different code', async () => {
    const dir = tmpdir('lush-stale-');
    const { database: db, manager, runtime } = system(dir);
    const socket = path.join(dir, 'lush.sock');
    const server = new RPCServer(socket, new Dispatcher(manager, createSignal(), {
      home: dir, socket, started_at: '2020-01-01T00:00:00.000Z',
      code_dir: '/elsewhere/lush', version: '0.0.0', fingerprint: 'ffffffffffff',
    }));
    await server.start();
    const env = { ...state.env, LUSH_HOME: dir };
    try {
      const listed = await cli(['process', 'list'], { check: false, env });
      expect(listed.code).toBe(0);
      expect(listed.stderr).toContain('runs different code');
      expect(listed.stderr).toContain('different checkout');
      expect(listed.stderr).toContain(`LUSH_HOME=${dir} lush daemon restart`);

      const status = await cli(['--json', 'daemon', 'status'], { env });
      const parsed = JSON.parse(status.stdout);
      expect(parsed.home).toBe(dir);
      expect(parsed.code_dir).toBe('/elsewhere/lush');
      expect(parsed.cli.code_match).toBe(false);
      expect(parsed.cli.code_dir).toBe(ROOT);
    } finally {
      await server.close();
      await runtime.shutdown();
      db.close();
      cleanup(dir);
    }
  }, 60_000);

  test('SIGKILL recovers an in-flight call without replaying its spawn', async () => {
    const blocked = deferred();
    const release = deferred();
    const http = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const payload = await req.json();
        const last = payload.messages[payload.messages.length - 1];
        if (last.role === 'tool') {
          blocked.resolve();
          await release.promise;
          return Response.json({ choices: [{ message: { role: 'assistant', content: 'late result' } }] });
        }
        return Response.json({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'spawn-once',
                type: 'function',
                function: { name: 'process_spawn', arguments: '{"template":"generic-task","name":"only-once"}' },
              }],
            },
          }],
        });
      },
    });

    let waiter = null;
    try {
      state.env.LUSH_PROVIDER = 'openai';
      state.env.LUSH_API_KEY = 'local-test-key';
      state.env.LUSH_MODEL = 'test';
      state.env.LUSH_BASE_URL = `http://127.0.0.1:${http.port}/v1`;

      const status = await data('daemon', 'start');
      waiter = Bun.spawn([process.execPath, CLI, 'process', 'call', '0', 'spawn once'], {
        cwd: ROOT, env: state.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const guard = Bun.sleep(10_000).then(() => {
        throw new Error('provider never entered the second round');
      });
      await Promise.race([blocked.promise, guard]);
      expect((await data('process', 'list')).length).toBe(2);

      process.kill(status.daemon_pid, 'SIGKILL');
      expect(await waitUnlocked()).toBe(true);
      const [waiterCode] = await Promise.all([
        waiter.exited, new Response(waiter.stdout).text(), new Response(waiter.stderr).text(),
      ]);
      expect(waiterCode).not.toBe(0);

      state.env = { ...state.env, LUSH_PROVIDER: 'mock' };
      await cli(['daemon', 'start']); // the stale socket is removed under the daemon lock
      const info = await data('process', 'inspect', '0');
      expect(info.recent_calls[0].status).toBe('interrupted');
      expect(info.status).toBe('running');
      await cli(['process', 'call', '0', 'who are you?']);
      // The committed spawn is not replayed by the next invocation.
      expect((await data('process', 'list')).length).toBe(2);
      expect((await data('process', 'inspect', '1')).name).toBe('only-once');
    } finally {
      release.resolve();
      if (waiter && waiter.exitCode === null) {
        waiter.kill('SIGKILL');
        await waiter.exited;
      }
      http.stop(true);
    }
  }, 60_000);
});
