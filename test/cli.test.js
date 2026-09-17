import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { isLocked } from '../src/daemon/locking.js';
import { cleanup, deferred, tmpdir } from './helpers.js';

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
    await cli(['daemon', 'stop'], { check: false });
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

      const before = await data('agent', 'session', String(project.pid));
      expect(before).toMatchObject({ agent: 'pi', session_id: `lush-${project.pid}`, file: null, files: [] });
      expect((await cli(['agent', 'session', String(project.pid)])).stdout).toContain('(none yet)');

      await cli(['process', 'call', String(project.pid), 'hi']);
      const after = await data('agent', 'session', String(project.pid));
      expect(after.file.endsWith(`_lush-${project.pid}.jsonl`)).toBe(true);
      const text = (await cli(['agent', 'session', String(project.pid)])).stdout;
      expect(text).toContain(path.join(state.dir, 'pi-sessions'));
      expect(text).toContain(`lush-${project.pid}`);

      // --open runs pi in the foreground (no --print) with the Lush environment.
      const opened = await cli(['agent', 'session', String(project.pid), '--open']);
      expect(JSON.parse(opened.stdout)).toEqual({ tui: true, pid: String(project.pid) });
      expect((await cli(['--json', 'agent', 'session', String(project.pid), '--open'], { check: false })).code).toBe(2);
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
