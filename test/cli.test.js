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

  test('complete MVP CLI flow: attach, restart and orphans', async () => {
    expect((await cli(['status'], { check: false })).code).not.toBe(0);

    const started = await data('daemon', 'start');
    expect((await cli(['tree'])).stdout.trim()).toBe('lush[0]');
    expect((await data('daemon', 'start')).daemon_pid).toBe(started.daemon_pid);
    expect((await cli(['spawn', '0', 'generic-service', '--name', 'project-manager'])).stdout.trim()).toBe('PID 1');
    expect((await cli(['spawn', '1', 'generic-task', '--name', 'implement-login', '--goal', '实现登录'])).stdout.trim())
      .toBe('PID 2');
    expect((await cli(['call', '2', '请介绍一下你当前的身份和任务'])).stdout).toContain('project-manager[1]');

    const attached = await cli(['attach', '2'], { input: '当前任务是什么？\n查看你的子任务\n/exit\n' });
    expect(attached.stdout).toContain('attached to implement-login [2]');
    expect(attached.stdout.split('agent>').length - 1).toBe(2);

    await cli(['call', '1', '创建一个子任务，研究 OAuth 登录实现方式']);
    const expected = 'lush[0]\n└── project-manager[1]\n    ├── implement-login[2]\n    └── research-oauth[3]\n';
    expect((await cli(['tree'])).stdout).toBe(expected);
    expect((await cli(['ps'])).stdout).toContain('PPID');

    const info = await data('inspect', '2');
    expect(info.context.message_count).toBe(8); // 2 text calls + children tool call

    await cli(['daemon', 'stop']);
    await cli(['daemon', 'start']);
    expect((await cli(['tree'])).stdout).toBe(expected);
    expect((await data('inspect', '2')).context).toEqual(info.context);

    await cli(['stop', '1']);
    expect((await data('inspect', '2')).parent_pid).toBe(0);
    expect((await data('inspect', '3')).original_parent_pid).toBe(1);
    await cli(['start', '1']);
    await cli(['call', '2', '/tool process.complete {"result":"done"}']);
    expect((await cli(['attach', '2'], { input: '/exit\n', check: false })).code).not.toBe(0);
    await cli(['reclaim', '2']);
    expect((await data('history', '2')).messages.length).toBeGreaterThan(0);
    expect((await data('spawn', '0', 'generic-task')).pid).toBe(4);
  }, 120_000);

  test('single instance, SIGTERM and socket cleanup', async () => {
    const status = await data('daemon', 'start');
    const duplicate = Bun.spawn([process.execPath, DAEMON], {
      cwd: ROOT, env: state.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([new Response(duplicate.stderr).text(), duplicate.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('already running');

    expect((await data('status')).daemon_pid).toBe(status.daemon_pid);
    process.kill(status.daemon_pid, 'SIGTERM');
    expect(await waitUnlocked()).toBe(true);
    expect(fs.existsSync(path.join(state.dir, 'lush.sock'))).toBe(false);

    await cli(['daemon', 'start']);
    expect((await data('ps')).length).toBe(1);
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
      waiter = Bun.spawn([process.execPath, CLI, 'call', '0', 'spawn once'], {
        cwd: ROOT, env: state.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const guard = Bun.sleep(10_000).then(() => {
        throw new Error('provider never entered the second round');
      });
      await Promise.race([blocked.promise, guard]);
      expect((await data('ps')).length).toBe(2);

      process.kill(status.daemon_pid, 'SIGKILL');
      expect(await waitUnlocked()).toBe(true);
      const [waiterCode] = await Promise.all([
        waiter.exited, new Response(waiter.stdout).text(), new Response(waiter.stderr).text(),
      ]);
      expect(waiterCode).not.toBe(0);

      state.env = { ...state.env, LUSH_PROVIDER: 'mock' };
      await cli(['daemon', 'start']); // the stale socket is removed under the daemon lock
      const info = await data('inspect', '0');
      expect(info.recent_calls[0].status).toBe('interrupted');
      expect(info.status).toBe('running');
      await cli(['call', '0', 'who are you?']);
      // The committed spawn is not replayed by the next invocation.
      expect((await data('ps')).length).toBe(2);
      expect((await data('inspect', '1')).name).toBe('only-once');
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
