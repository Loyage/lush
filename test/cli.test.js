import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { forceStopDaemon, isLocked } from '../src/daemon/locking.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { formatOrphans } from '../src/cli/main.js';
import {
  formatCall, formatInspect, formatList, formatTaskList, formatTaskResult, formatTaskTree,
} from '../src/cli/format/service.js';
import { treeLines } from '../src/cli/format/primitives.js';
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

  test('complete MVP CLI flow: attach, restart and orphans', async () => {
    expect((await cli(['daemon', 'status'], { check: false })).code).not.toBe(0);

    const started = await data('daemon', 'start');
    expect((await cli(['service', 'tree'])).stdout.trim()).toBe('lush[0]');
    expect((await data('daemon', 'start')).daemon_pid).toBe(started.daemon_pid);
    // SID 0's snapshot only allows project-manager; every other template is refused.
    const denied = await cli(['service', 'spawn', '0', 'project'], { check: false });
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('cannot create template project');
    expect((await cli(['service', 'spawn', '0', 'project-manager', '--name', 'project-manager'])).stdout.trim())
      .toBe('SID 1');
    expect((await cli([
      'service', 'spawn', '1', 'project', '--name', 'implement-login', '--goal', '实现登录',
      '--vars', JSON.stringify({ path: state.dir }),
    ])).stdout.trim()).toBe('SID 2');
    // `call` is the entry point: it creates a task on the service and waits.
    const firstCall = await cli(['call', '2', '请介绍一下你当前的身份和任务']);
    expect(firstCall.stdout).toContain('project-manager[1]');
    expect(firstCall.stdout).toMatch(/^task #\d+ implement-login\[2\] completed$/m);
    const first = (await data('task', 'list'))[0];
    expect(first).toMatchObject({ sid: 2, status: 'completed', parent_task_id: null });
    expect((await cli(['task', 'tree', String(first.id)])).stdout).toContain(`#${first.id}`);
    expect((await cli(['task', 'inspect', String(first.id)])).stdout).toContain('goal');
    expect((await cli(['task', 'history', String(first.id)])).stdout).toContain('请介绍一下');

    await cli(['call', '1', '/tool service_spawn ' + JSON.stringify({
      template: 'project', name: 'research-oauth', goal: '研究 OAuth 登录实现方式', variables: { path: state.dir },
    })]);
    const tree = await cli(['service', 'tree']);
    expect(tree.stdout).toContain('lush[0]');
    expect(tree.stdout).toContain('implement-login[2]');
    expect(tree.stdout).toContain('research-oauth[3]');
    expect((await cli(['service', 'list'])).stdout).toContain('PPID');

    const info = await data('service', 'inspect', '2');
    expect(info.recent_tasks.length).toBeGreaterThan(0);
    expect(info.context.message_count).toBeGreaterThan(0);
    const tasksBefore = (await data('task', 'list')).length;

    await cli(['daemon', 'stop']);
    await cli(['daemon', 'start']);
    const restartedTree = await cli(['service', 'tree']);
    expect(restartedTree.stdout).toContain('lush[0]');
    expect(restartedTree.stdout).toContain('implement-login[2]');
    expect(restartedTree.stdout).toContain('research-oauth[3]');
    expect((await data('task', 'list')).length).toBe(tasksBefore);
    // The tasks themselves survive a restart; their status does too.
    expect((await data('task', 'result', String(first.id)).catch(() => null)) ?? (await data('task', 'inspect', String(first.id))).status)
      .toBeTruthy();

    await cli(['service', 'stop', '1']);
    expect((await data('service', 'inspect', '2')).parent_sid).toBe(0);
    expect((await data('service', 'inspect', '3')).original_parent_sid).toBe(1);
    await cli(['service', 'start', '1']);
    // A service with an active task cannot be stopped; the task has to end first.
    await cli(['service', 'stop', '2']);
    expect((await cli(['call', '2', 'x'], { check: false })).code).not.toBe(0);
    await cli(['service', 'start', '2']);
    // The mock agent can finish its own task through the tool path.
    await cli(['call', '2', '/tool task_complete {"result":"done"}']);
    expect((await data('task', 'list', '--sid', '2')).length).toBe(2);
    expect((await data('service', 'spawn', '1', 'project', '--name', 'next', '--vars', JSON.stringify({ path: state.dir }))).sid).toBe(4);
  }, 120_000);

  test('complete, update-state, variables and spawn over the CLI', async () => {
    await cli(['daemon', 'start']);
    await cli(['service', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    await cli(['service', 'spawn', '1', 'project', '--name', 'worker', '--goal', 'work', '--vars', JSON.stringify({ path: state.dir })]);
    expect((await data('service', 'update-state', '2', '--patch', '{"progress":"half"}')).progress).toBe('half');
    // Work verbs moved to tasks: `call` opens one, `task complete` finishes it.
    const task = await data('call', '2', 'work');
    expect(task.status).toBe('completed');
    expect((await data('task', 'result', String(task.id))).result).toContain('[Mock]');
    // `task spawn` starts the agent right away; the mock finishes immediately.
    const spawnedTask = await data('task', 'spawn', '2', '--goal', 'manual work');
    expect(spawnedTask.sid).toBe(2);
    await data('task', 'wait', String(spawnedTask.id));
    // An explicit result comes from the tool call, which is what an agent does.
    const manual = await data('call', '2', '/tool task_complete {"result":{"answer":42}}');
    expect(manual.status).toBe('completed');
    expect((await data('task', 'result', String(manual.id))).result).toEqual({ answer: 42 });
    expect((await data('task', 'list', '--sid', '2')).length).toBe(3);

    const spawned = await data('service', 'spawn', '1', 'project', '--name', 'p1', '--vars', JSON.stringify({ path: state.dir }));
    const project = await data('service', 'inspect', String(spawned.sid));
    expect(project.context.state).toEqual({ params: { path: state.dir }, vars: { branch: 'main' } });
    expect(project.variables.declarations.mutable.branch.default).toBe('main');
    // Tree text mode marks immutable values plain and mutable ones with `~` (long values truncate).
    const tree = (await cli(['service', 'tree'])).stdout;
    expect(tree).toContain(`p1[${spawned.sid}] path=${state.dir.slice(0, 10)}`);
    expect(tree).toContain('~branch=main');

    expect(await data('service', 'update-vars', String(spawned.sid), '--vars', '{"branch":"dev"}')).toEqual({ branch: 'dev' });
    expect((await data('service', 'inspect', String(spawned.sid))).variables.mutable).toEqual({ branch: 'dev' });
    expect((await cli(['service', 'update-vars', String(spawned.sid), '--vars', '{"branch":"release"}'])).stdout.trim())
      .toBe('branch=release');
    const locked = await cli(['service', 'update-vars', String(spawned.sid), '--vars', JSON.stringify({ path: '/tmp' })], { check: false });
    expect(locked.code).not.toBe(0);
    expect(locked.stderr).toContain('immutable');
    expect((await cli(['service', 'update-state', String(spawned.sid), '--patch', '{"params":{}}'], { check: false })).stderr)
      .toContain('update_vars');

    // --dry-run prints the invocation instead of calling the agent.
    const preview = await data('call', String(spawned.sid), 'hello', '--dry-run');
    expect(preview).toMatchObject({ dry_run: true, agent: 'mock', command: null });
    expect((await data('service', 'inspect', String(spawned.sid))).context.message_count).toBe(0);
    expect((await cli(['call', String(spawned.sid), 'hello', '--dry-run'])).stdout).toContain('runs in-service');

    const missing = await cli(['service', 'spawn', '1', 'project', '--name', 'p2'], { check: false });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('variables.path');
    const unknown = await cli(['service', 'spawn', '1', 'project', '--name', 'p3', '--vars', JSON.stringify({ path: state.dir, nope: 1 })], { check: false });
    expect(unknown.stderr).toContain('does not declare variable nope');
    expect((await cli(['service', 'update-vars', String(spawned.sid)], { check: false })).stderr).toContain('--vars');
    expect((await cli(['service', 'update-state', '2', '--patch', '{oops'], { check: false })).stderr).toContain('invalid JSON');

    // --interactive needs an external agent: the in-service runtime has no TUI.
    const enter = await cli(['call', String(spawned.sid), 'hello', '-i'], { check: false });
    expect(enter.code).not.toBe(0);
    expect(enter.stderr).toContain('runs in-service');
    expect((await cli(['call', String(spawned.sid), 'hello', '--interactive', '--dry-run'], { check: false })).code).toBe(2);
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
      "console.log(JSON.stringify({ tui: !argv.includes('--print'), sid: process.env.LUSH_SID }));",
      '',
    ].join('\n'));
    fs.chmodSync(stub, 0o755);
    const baseEnv = state.env;
    state.env = { ...baseEnv, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: stub };
    try {
      await cli(['daemon', 'start']);
      await cli(['service', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
      const project = await data('service', 'spawn', '1', 'project', '--name', 'p1', '--vars', JSON.stringify({ path: state.dir }));

      // A session belongs to a task, not to the service: a task has to exist.
      const task = await data('task', 'spawn', String(project.sid), '--goal', 'hi');
      const before = await data('task', 'session', String(task.id));
      expect(before).toMatchObject({ agent: 'pi', session_id: `lush-task-${task.id}`, file: null, files: [] });
      expect((await cli(['task', 'session', String(task.id)])).stdout).toContain('(none yet)');
      await data('task', 'cancel', String(task.id));

      const done = await data('call', String(project.sid), 'hi');
      const after = await data('task', 'session', String(done.id));
      expect(after.file.endsWith(`_lush-task-${done.id}.jsonl`)).toBe(true);
      const text = (await cli(['task', 'session', String(done.id)])).stdout;
      expect(text).toContain(path.join(state.dir, 'pi-sessions'));
      expect(text).toContain(`lush-task-${done.id}`);

      // --open runs pi in the foreground (no --print) with the Lush environment.
      const opened = await cli(['task', 'session', String(done.id), '--open']);
      expect(JSON.parse(opened.stdout)).toEqual({ tui: true, sid: String(project.sid) });
      expect((await cli(['--json', 'task', 'session', String(done.id), '--open'], { check: false })).code).toBe(2);
    } finally {
      state.env = baseEnv;
    }
  }, 60_000);


  test('task agents kill stops the worker and cancels its task', async () => {
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
      await cli(['service', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
      expect((await cli([
        'service', 'spawn', '1', 'project', '--name', 'worker', '--vars', JSON.stringify({ path: state.dir }),
      ])).stdout.trim()).toBe('SID 2');
      // A daemon-spawned agent: this CLI only waits for the call to finish.
      const call = Bun.spawn([process.execPath, CLI, 'call', '2', 'long work'], {
        cwd: ROOT, env: { ...state.env, PI_STUB_SLEEP: '3000' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr] = [new Response(call.stdout).text(), new Response(call.stderr).text()];
      let live = [];
      for (let attempt = 0; attempt < 300 && live.length === 0; attempt += 1) {
        await Bun.sleep(20);
        live = await data('task', 'agents', 'list');
      }
      const task = (await data('task', 'list', '--sid', '2'))[0];
      const agentId = `${task.id}.1`;
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: agentId, task_id: task.id, sid: 2, provider: 'pi', status: 'running',
        call_id: 1, interactive: false, cancellable: true,
      });
      expect(live[0].os_pid).toBeGreaterThan(0);
      // The tree shows the activity of that service only.
      const tree = (await cli(['service', 'tree'])).stdout;
      expect(tree).toContain(`agent ${agentId} running · `);
      expect(tree).toContain('lush[0]');
      expect(tree).not.toContain('agent 0.1');
      expect((await cli(['task', 'agents', 'list'])).stdout).toContain('pipe');

      // Killing the worker ends the invocation and cancels the task it served.
      expect(JSON.parse((await cli(['--json', 'task', 'agents', 'kill', agentId])).stdout))
        .toMatchObject({ id: agentId, outcome: 'killed' });
      expect(await call.exited).toBe(0);
      expect(await stdout).toContain('cancelled');
      expect(await data('task', 'inspect', String(task.id))).toMatchObject({
        status: 'cancelled',
        recent_calls: [expect.objectContaining({ status: 'interrupted', error: 'invocation cancelled' })],
      });
      expect(await data('task', 'agents', 'list')).toEqual([]);
      expect((await data('task', 'agents', 'list', '--all'))[0]).toMatchObject({ id: agentId, status: 'interrupted' });
      // A finished agent cannot be killed again, and the service stays usable.
      const again = await cli(['task', 'agents', 'kill', agentId], { check: false });
      expect(again.code).not.toBe(0);
      expect(again.stderr).toContain('is not running');
      const later = (await cli(['call', '2', 'hi'])).stdout;
      expect(later).toContain('completed');
      expect(later).toContain('late reply');
      expect((await data('task', 'list', '--sid', '2')).length).toBe(2);
      expect(await stderr).not.toContain('no such');
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
    expect((await data('service', 'list')).length).toBe(1);
  }, 60_000);

  test('daemon restart replaces the daemon and keeps the tree', async () => {
    const first = await data('daemon', 'start');
    await cli(['service', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    const tree = 'lush[0]\n└── project-manager[1]';
    expect((await cli(['service', 'tree'])).stdout.trim()).toBe(tree);

    const restarted = await data('daemon', 'restart');
    expect(restarted).toMatchObject({ restarted: true, was_running: true, started: true });
    expect(restarted.daemon_pid).not.toBe(first.daemon_pid); // a new daemon, not the old one
    expect(restarted.cli.code_match).toBe(true);
    expect((await cli(['service', 'tree'])).stdout.trim()).toBe(tree);

    // Restarting a stopped home is just a start, and says so.
    await cli(['daemon', 'stop']);
    const fromStopped = await data('daemon', 'restart');
    expect(fromStopped).toMatchObject({ restarted: true, was_running: false, started: true });
    expect((await cli(['service', 'tree'])).stdout.trim()).toBe(tree);
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
    expect((await cli(['service', 'list'])).stderr).not.toContain('runs different code');

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
    const sid = Number.parseInt(fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8'), 10);
    expect(isLocked(dir)).toBe(true);

    expect(await forceStopDaemon(dir)).toEqual({ pid: sid, killed: true, reason: 'SIGKILL' });
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
    expect(sleeper.exitCode).toBeNull(); // sids are recycled: the guard must hold

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
      const listed = await cli(['service', 'list'], { check: false, env });
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

  test('SIGKILL recovers an in-flight task without replaying its spawn', async () => {
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
                function: { name: 'service_spawn', arguments: '{"template":"project-manager","name":"only-once"}' },
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
      expect((await data('service', 'list')).length).toBe(2);
      const taskId = (await data('task', 'list'))[0].id;

      process.kill(status.daemon_pid, 'SIGKILL');
      expect(await waitUnlocked()).toBe(true);
      const [waiterCode] = await Promise.all([
        waiter.exited, new Response(waiter.stdout).text(), new Response(waiter.stderr).text(),
      ]);
      expect(waiterCode).not.toBe(0);

      state.env = { ...state.env, LUSH_PROVIDER: 'mock' };
      await cli(['daemon', 'start']); // the stale socket is removed under the daemon lock
      // The daemon that comes back fails the task it can no longer vouch for.
      expect(await data('task', 'inspect', String(taskId))).toMatchObject({
        status: 'failed',
        recent_calls: [expect.objectContaining({ status: 'interrupted' })],
      });
      await cli(['call', '0', 'who are you?']);
      // The committed spawn is not replayed by the next task.
      expect((await data('service', 'list')).length).toBe(2);
      expect((await data('service', 'inspect', '1')).name).toBe('only-once');
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

describe('service and task text output', () => {
  /** A read-model row shaped like `service.list` delivers them. */
  const row = ({ sid = 2, name = 'fix-login', title, detail, variables, ...rest } = {}) => ({
    sid,
    parent_sid: 1,
    original_parent_sid: 1,
    name,
    status: 'active',
    template: 'dev-task',
    goal: '修好登录',
    created_at: '2026-09-17T20:00:00.000Z',
    updated_at: '2026-09-17T20:00:00.000Z',
    children: [],
    variables: variables ?? {
      immutable: {
        name,
        ...(title === undefined ? {} : { title }),
        ...(detail === undefined ? {} : { detail }),
      },
      mutable: {},
      declarations: { immutable: {}, mutable: {} },
    },
    ...rest,
  });
  const inspectOf = (service) => formatInspect({
    ...service,
    context: { state: service.variables.immutable, message_count: 0 },
    recent_calls: [],
    recent_events: [],
    recent_tasks: [],
  });

  test('list carries SID / PPID / STATUS / NAME / TITLE and no type column', () => {
    const text = formatList([
      row({ title: '修复登录流程' }),
      row({ sid: 3, name: 'demo-project', template: 'project' }),
    ]);
    const [header, first, second] = text.split('\n');
    expect(header).toMatch(/^SID\s+PPID\s+STATUS\s+NAME\s+TITLE$/);
    expect(first).toMatch(/^2\s+1\s+active\s+fix-login\s+修复登录流程$/);
    expect(second).toMatch(/^3\s+1\s+active\s+demo-project\s+-$/);
    expect(text).not.toContain('service');
  });

  test('long titles are truncated in list and tree, and detail stays out of the tree', () => {
    const long = 'x'.repeat(50);
    expect(formatList([row({ title: long })])).toContain(`${'x'.repeat(37)}...`);
    const tree = treeLines([row({ title: long, detail: 'a\nb', parent_sid: null })]).join('\n');
    expect(tree).toContain(`fix-login[2] title=${'x'.repeat(45)}...`);
    // The `name` variable only repeats the service name; the body has no one-line form.
    expect(tree).not.toContain('name=fix-login');
    expect(tree).not.toContain('detail=');
    expect(tree.split('\n').length).toBe(1);
  });

  test('inspect shows title, detail and the tasks mounted on the service', () => {
    const text = inspectOf(row({ title: '修复登录流程', detail: '第一行\n第二行' }));
    expect(text).toMatch(/^ {2}title\s+修复登录流程$/m);
    expect(text).toMatch(/^detail\n {2}第一行\n {2}第二行$/m);
    expect(text).toMatch(/^tasks {2}\(none\)$/m);
    // Nothing is repeated: the variables row would only repeat the task fields.
    expect(text).not.toContain('variables');

    const withTasks = formatInspect({
      ...row({ title: 't' }),
      context: { state: {}, message_count: 0 },
      recent_calls: [],
      recent_events: [],
      recent_tasks: [{ id: 7, sid: 2, status: 'running', goal: 'do the thing' }],
    });
    expect(withTasks).toMatch(/^tasks · recent 1, newest first$/m);
    expect(withTasks).toContain('#7 sid 2 running · do the thing');

    // Data written before the three fields existed: no title row, no detail
    // block, no crash, and `--json` shape unchanged.
    const legacy = row({ variables: { immutable: {}, mutable: {}, declarations: { immutable: {}, mutable: {} } } });
    const legacyText = inspectOf(legacy);
    expect(legacyText).not.toContain('title');
    expect(legacyText).not.toContain('detail');
    expect(legacyText).toContain('sid 2 · fix-login · active');
    expect(formatList([legacy])).toMatch(/^2\s+1\s+active\s+fix-login\s+-$/m);
  });
});

describe('task list and tree text output', () => {
  const task = (overrides = {}) => ({
    id: 1,
    sid: 2,
    parent_task_id: null,
    root_task_id: 1,
    status: 'running',
    goal: 'do the thing',
    result: null,
    error: null,
    state: {},
    created_at: '2026-09-17T20:00:00.000Z',
    started_at: null,
    finished_at: null,
    updated_at: '2026-09-17T20:00:00.000Z',
    ...overrides,
  });

  test('list is one aligned row per task, with parent and result', () => {
    const text = formatTaskList([
      task(),
      task({ id: 2, parent_task_id: 1, sid: 3, status: 'completed', goal: 'child work', result: 'done' }),
    ]);
    const [header, parent, child] = text.split('\n');
    expect(header).toMatch(/^ID\s+SID\s+PARENT\s+STATUS\s+GOAL\s+RESULT$/);
    expect(parent).toMatch(/^#1\s+2\s+-\s+running\s+do the thing\s+-$/);
    expect(child).toMatch(/^#2\s+3\s+#1\s+completed\s+child work\s+done$/);
  });

  test('tree shows the delegation chain, results and failures', () => {
    const text = formatTaskTree(task({
      status: 'completed',
      result: 'shipped',
      children: [task({ id: 2, sid: 3, status: 'failed', goal: 'child work', error: 'boom' })],
    }));
    const [root, child] = text.split('\n');
    expect(root).toMatch(/^#1 sid 2 completed · do the thing → shipped$/);
    expect(child).toBe('└── #2 sid 3 failed · child work (boom)');
  });

  test('call output names the task and its outcome', () => {
    expect(formatCall({ service: { name: 'worker' }, task: task({ status: 'completed', result: 'all done' }) }))
      .toBe('task #1 worker[2] completed\nall done');
    expect(formatCall(task({ status: 'cancelled' }))).toBe('task #1 sid 2 cancelled');
    expect(formatTaskResult({ id: 1, sid: 2, status: 'running', finished: false, result: null, error: null }))
      .toBe("task #1 is running (not finished yet; use 'lush task wait 1')");
    expect(formatTaskResult({ id: 1, sid: 2, status: 'failed', finished: true, result: null, error: 'boom' }))
      .toBe('task #1 failed\n  error: boom');
  });
});

describe('orphan text output', () => {
  test('pool and sweep report are stable, human-readable and free of JSON blobs', () => {
    const pool = formatOrphans({
      policy: { adopt: 'adopt', limit: 2, ttl_seconds: 0.5, sweep_seconds: 30 },
      active_count: 3,
      busy_count: 1,
      over_limit: 1,
      orphans: [
        {
          sid: 4, name: 'cache', status: 'active', template: 'generic-service',
          original_parent_sid: 2, created_at: '2026-09-17T20:00:00.000Z', updated_at: '2026-09-17T20:00:00.000Z',
          last_activity_at: '2026-09-17T20:05:00.000Z', idle_seconds: 75, busy: true,
        },
        {
          sid: 5, name: 'worker', status: 'stopped', template: 'generic-task',
          original_parent_sid: 2, created_at: '2026-09-17T20:00:00.000Z', updated_at: '2026-09-17T20:00:00.000Z',
          last_activity_at: '2026-09-17T20:05:00.000Z', idle_seconds: 75, busy: false,
        },
      ],
    });
    const lines = pool.split('\n');
    expect(lines[0]).toBe('policy adopt=adopt limit=2 ttl=0.5s sweep=30s');
    expect(lines[1]).toBe('orphans active=3 busy=1 over_limit=1');
    expect(pool).toContain('cache');
    expect(pool).toContain('worker');
    expect(pool).toMatch(/^\s+4\s+active\s+1m15s\s+yes\s+cache$/m);
    expect(pool).toMatch(/^\s+5\s+stopped\s+1m15s\s+no\s+worker$/m);
    expect(pool).not.toContain('{');
    expect(formatOrphans({
      policy: { adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 },
      active_count: 0, busy_count: 0, over_limit: 0, orphans: [],
    })).toContain('(none');

    const report = formatOrphans({
      trigger: 'timer', skipped: false, checked: 3, active_before: 3, active_after: 1,
      evicted: [
        { sid: 4, name: 'cache', from: 'active', to: 'stopped', reason: 'orphan_ttl', idle_seconds: 900 },
        { sid: 5, name: 'worker', from: 'active', to: 'stopped', reason: 'orphan_limit', idle_seconds: 12 },
      ],
      deferred: [{ sid: 6, reason: 'busy' }],
      limit: 1, ttl_seconds: 600,
    });
    expect(report.split('\n')[0]).toBe('trigger=timer checked=3 active 3->1 evicted=2 deferred=1 (limit=1 ttl=600s)');
    expect(report).toMatch(/^ {2}evicted 4 active->stopped reason=orphan_ttl idle=900s cache$/m);
    expect(report).toMatch(/^ {2}evicted 5 active->stopped reason=orphan_limit idle=12s worker$/m);
    expect(report).toMatch(/^ {2}deferred 6 reason=busy .*busy/m);
  });
});
