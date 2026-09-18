import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { forceStopDaemon, isLocked } from '../src/daemon/locking.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { formatOrphans } from '../src/cli/main.js';
import { formatAgentKill, formatInspect, formatList } from '../src/cli/format/process.js';
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
    // PID 0's snapshot only allows project-manager; every other template is refused.
    const denied = await cli(['process', 'spawn', '0', 'generic-task'], { check: false });
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('cannot create template generic-task');
    expect((await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager'])).stdout.trim())
      .toBe('PID 1');
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
    expect((await data('process', 'spawn', '1', 'generic-task', '--name', 'next')).pid).toBe(4);
  }, 120_000);

  test('complete, update-state, variables and spawn over the CLI', async () => {
    await cli(['daemon', 'start']);
    await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    await cli(['process', 'spawn', '1', 'generic-task', '--name', 'worker', '--goal', 'work']);
    expect((await data('process', 'update-state', '2', '--patch', '{"progress":"half"}')).progress).toBe('half');
    const done = await data('process', 'complete', '2', '--result', '{"answer":42}');
    expect(done.status).toBe('completed');
    expect((await data('process', 'inspect', '2')).context.state).toEqual({ result: { answer: 42 }, progress: 'half' });

    const spawned = await data('process', 'spawn', '1', 'project', '--name', 'p1', '--vars', JSON.stringify({ path: state.dir }));
    const project = await data('process', 'inspect', String(spawned.pid));
    expect(project.context.state).toEqual({ params: { path: state.dir }, vars: { branch: 'main' } });
    expect(project.variables.declarations.mutable.branch.default).toBe('main');
    // Tree text mode marks immutable values plain and mutable ones with `~` (long values truncate).
    const tree = (await cli(['process', 'tree'])).stdout;
    expect(tree).toContain(`p1[${spawned.pid}] path=${state.dir.slice(0, 10)}`);
    expect(tree).toContain('~branch=main');

    expect(await data('process', 'update-vars', String(spawned.pid), '--vars', '{"branch":"dev"}')).toEqual({ branch: 'dev' });
    expect((await data('process', 'inspect', String(spawned.pid))).variables.mutable).toEqual({ branch: 'dev' });
    expect((await cli(['process', 'update-vars', String(spawned.pid), '--vars', '{"branch":"release"}'])).stdout.trim())
      .toBe('branch=release');
    const locked = await cli(['process', 'update-vars', String(spawned.pid), '--vars', JSON.stringify({ path: '/tmp' })], { check: false });
    expect(locked.code).not.toBe(0);
    expect(locked.stderr).toContain('immutable');
    expect((await cli(['process', 'update-state', String(spawned.pid), '--patch', '{"params":{}}'], { check: false })).stderr)
      .toContain('update_vars');

    // --dry-run prints the invocation instead of calling the agent.
    const preview = await data('process', 'call', String(spawned.pid), 'hello', '--dry-run');
    expect(preview).toMatchObject({ dry_run: true, agent: 'mock', command: null });
    expect((await data('process', 'inspect', String(spawned.pid))).context.message_count).toBe(0);
    expect((await cli(['process', 'call', String(spawned.pid), 'hello', '--dry-run'])).stdout).toContain('runs in-process');

    const missing = await cli(['process', 'spawn', '1', 'project', '--name', 'p2'], { check: false });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('variables.path');
    const unknown = await cli(['process', 'spawn', '1', 'project', '--name', 'p3', '--vars', JSON.stringify({ path: state.dir, nope: 1 })], { check: false });
    expect(unknown.stderr).toContain('does not declare variable nope');
    expect((await cli(['process', 'update-vars', String(spawned.pid)], { check: false })).stderr).toContain('--vars');
    expect((await cli(['process', 'update-state', '2', '--patch', '{oops'], { check: false })).stderr).toContain('invalid JSON');

    // --interactive needs an external agent: the in-process runtime has no TUI.
    const enter = await cli(['process', 'call', String(spawned.pid), 'hello', '-i'], { check: false });
    expect(enter.code).not.toBe(0);
    expect(enter.stderr).toContain('runs in-process');
    expect((await cli(['process', 'call', String(spawned.pid), 'hello', '--interactive', '--dry-run'], { check: false })).code).toBe(2);
  }, 60_000);

  test('dev-task fields: creation, validation, and list / tree / inspect rendering', async () => {
    await cli(['daemon', 'start']);
    await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    await cli(['process', 'spawn', '1', 'project', '--name', 'demo-project', '--goal', '示例项目',
      '--vars', JSON.stringify({ path: state.dir })]);
    const spawned = await data('process', 'spawn', '2', 'dev-task', '--name', 'fix-login', '--goal', '修好登录',
      '--title', '修复登录流程', '--detail', '第一行\n第二行');
    const pid = String(spawned.pid);
    expect(spawned.name).toBe('fix-login');

    // --json carries every field, where the text output only shows the summary.
    const info = await data('process', 'inspect', pid);
    expect(info.variables.immutable).toEqual({ name: 'fix-login', title: '修复登录流程', detail: '第一行\n第二行' });
    expect(info.context.state.params).toMatchObject({ name: 'fix-login', title: '修复登录流程', detail: '第一行\n第二行' });
    const listed = (await data('process', 'list')).find((row) => String(row.pid) === pid);
    expect(listed.variables.immutable.title).toBe('修复登录流程');

    // `list` adds a TITLE column without moving the ones that were already there.
    const listText = (await cli(['process', 'list'])).stdout;
    expect(listText.split('\n')[0].slice(0, 38)).toBe('PID   PPID  TYPE      STATUS      NAME');
    expect(listText.split('\n')[0]).toMatch(/^PID\s+PPID\s+TYPE\s+STATUS\s+NAME\s+TITLE$/);
    expect(listText).toMatch(/^\d+\s+\d+\s+task\s+running\s+fix-login\s+修复登录流程$/m);
    // A process without a task title keeps the row, with a placeholder.
    expect(listText).toMatch(/^\d+\s+\d+\s+service\s+running\s+demo-project\s+-$/m);

    // `tree` shows the title, but neither the duplicate name nor the multi-line body.
    const tree = (await cli(['process', 'tree'])).stdout;
    expect(tree).toContain(`fix-login[${pid}] title=修复登录流程`);
    expect(tree).not.toContain('name=fix-login');
    expect(tree).not.toContain('detail=');

    // `inspect` renders the headline as a row and the body as its own block.
    const inspectText = (await cli(['process', 'inspect', pid])).stdout;
    expect(inspectText).toMatch(/^ {2}title\s+修复登录流程$/m);
    expect(inspectText).toMatch(/^detail\n {2}第一行\n {2}第二行$/m);
    // The variables row does not repeat what the task fields already show.
    expect(inspectText).not.toContain('title=');

    // Illegal name / missing title: exit 2 (the CLI's usage-error code) with the
    // contract quoted in the message.
    const badName = await cli(['process', 'spawn', '2', 'dev-task', '--name', 'fix login', '--title', '标题'], { check: false });
    expect(badName.code).toBe(2);
    expect(badName.stderr).toContain('does not match');
    expect(badName.stderr).toContain('worktree');
    const noTitle = await cli(['process', 'spawn', '2', 'dev-task', '--name', 'no-title'], { check: false });
    expect(noTitle.code).toBe(2);
    expect(noTitle.stderr).toContain('variables.title');
    const both = await cli(['process', 'spawn', '2', 'dev-task', '--name', 'both', '--title', 'a', '--vars', '{"title":"b"}'], { check: false });
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('cannot both set title');
    const tooLong = await cli(['process', 'spawn', '2', 'dev-task', '--name', 'a'.repeat(65), '--title', '标题'], { check: false });
    expect(tooLong.code).toBe(2);
    expect(tooLong.stderr).toContain('max_length 64');
    expect((await data('process', 'list')).filter((row) => row.template === 'dev-task').length).toBe(1);
  }, 60_000);

  test('orphan supervision is visible and runnable from the CLI', async () => {
    await cli(['daemon', 'start']);
    // A stopped parent hands its active child to PID 0; that child is the orphan.
    await cli(['process', 'spawn', '0', 'project-manager', '--name', 'parent']);
    await cli(['process', 'spawn', '1', 'generic-task', '--name', 'kid']);
    await cli(['process', 'stop', '1']);

    const pool = await data('process', 'orphans');
    expect(pool.policy).toEqual({ adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 });
    expect(pool).toMatchObject({ active_count: 1, busy_count: 0, over_limit: 0 });
    expect(pool.orphans.map((orphan) => orphan.name)).toEqual(['kid']);
    expect(pool.orphans[0]).toMatchObject({
      pid: 2, type: 'task', status: 'running', busy: false, original_parent_pid: 1,
    });
    expect(typeof pool.orphans[0].idle_seconds).toBe('number');

    const text = (await cli(['process', 'orphans'])).stdout;
    expect(text).toContain('policy adopt=adopt limit=0 ttl=0s sweep=30s');
    expect(text).toContain('orphans active=1 busy=0 over_limit=0');
    expect(text).toMatch(/^\s+2\s+task\s+running\s+\S+\s+no\s+kid$/m);

    // The default policy has nothing to freeze, and --sweep still reports the pass.
    const report = await data('process', 'orphans', '--sweep');
    expect(report).toMatchObject({
      trigger: 'manual', skipped: false, checked: 1, active_before: 1, active_after: 1, evicted: [], deferred: [],
    });
    expect((await cli(['process', 'orphans', '--sweep'])).stdout.trim())
      .toBe('trigger=manual checked=1 active 1->1 evicted=0 deferred=0 (limit=0 ttl=0s)');
    expect((await data('process', 'inspect', '2')).status).toBe('running');

    // Help documents the leaf, the command tree lists it, and bad flags are usage errors.
    const help = (await cli(['process', 'orphans', '-h'])).stdout;
    expect(help).toContain('孤儿');
    expect(help).toContain('--sweep');
    expect(JSON.parse((await cli(['--json', 'help', 'process'])).stdout).subcommands.map((child) => child.name))
      .toContain('orphans');
    expect((await cli(['process', 'orphans', '--bogus'], { check: false })).code).toBe(2);
  }, 60_000);

  test('the daemon timer sweeps idle orphans by ttl without a manual call', async () => {
    // The policy is read at startup, so the timer is configured through the env.
    await cli(['daemon', 'start'], { env: { ...state.env, LUSH_ORPHAN_TTL: '1', LUSH_ORPHAN_SWEEP: '1' } });
    await cli(['process', 'spawn', '0', 'project-manager', '--name', 'parent']);
    await cli(['process', 'spawn', '1', 'generic-task', '--name', 'kid']);
    await cli(['process', 'stop', '1']);
    expect((await data('process', 'orphans')).active_count).toBe(1);

    let status = 'running';
    const deadline = Date.now() + 10_000;
    while (status === 'running' && Date.now() < deadline) {
      await Bun.sleep(250);
      status = (await data('process', 'inspect', '2')).status;
    }
    expect(status).toBe('cancelled');
    expect((await data('process', 'inspect', '2')).recent_events[0])
      .toMatchObject({ kind: 'transition', data: { from: 'running', to: 'cancelled', cause: 'orphan_ttl' } });
    // The pass is the daemon's own: it reports itself in daemon.log, not to a client.
    expect(fs.readFileSync(path.join(state.dir, 'daemon.log'), 'utf8'))
      .toContain('orphan supervision evicted PIDs 2 (orphan_ttl)');
  }, 60_000);

  test('text output defaults to human-readable, --json stays the machine path', async () => {
    await cli(['daemon', 'start']);
    await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    expect((await cli(['process', 'spawn', '1', 'generic-task', '--name', 'reader', '--goal', 'read stuff'])).stdout.trim())
      .toBe('PID 2');
    await cli(['process', 'call', '2', 'hello']);
    await cli(['process', 'call', '2', '/tool process.update_state {"progress":"half"}']);

    // history: one block per message, body verbatim, pagination cursor last.
    const history = (await cli(['process', 'history', '2'])).stdout;
    expect(history).toMatch(/^#1 user · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · call 1$/m);
    expect(history).toMatch(/^#2 assistant · /m);
    expect(history).toContain('hello');
    expect(history).toContain('[Mock] 我是 reader');
    expect(history).toMatch(/^\(\d+ messages · next --after \d+\)$/m);
    expect(() => JSON.parse(history)).toThrow();
    const messages = await data('process', 'history', '2');
    expect(history).toContain(`(${messages.messages.length} messages · next --after ${messages.next_after})`);

    // inspect: sectioned text, no metadata dump; --json keeps the full snapshot.
    const inspect = (await cli(['process', 'inspect', '2'])).stdout;
    expect(inspect).toMatch(/^pid 2 · reader · task · running$/m);
    expect(inspect).toMatch(/^context · \d+ messages$/m);
    expect(inspect).toMatch(/^calls · recent \d+, newest first$/m);
    expect(inspect).toMatch(/^events · recent \d+, newest first$/m);
    expect(inspect).toContain('progress');
    expect(inspect).not.toContain('"template_snapshot"');
    expect((await data('process', 'inspect', '2')).template_snapshot.name).toBe('generic-task');

    // --with prints only the requested sections.
    const view = (await cli(['process', 'inspect', '2', '--with', 'parent,children'])).stdout;
    expect(view).toContain('pid 1 · project-manager · service · running');
    expect(view).not.toContain('call_prompt');

    // Nested state is aligned, not a JSON blob.
    expect((await cli(['process', 'update-state', '2', '--patch', '{"progress":"done"}'])).stdout.trim())
      .toBe('progress  done');

    // Lifecycle commands answer with one summary line, not the whole metadata row.
    expect((await cli(['process', 'complete', '2', '--result', '{"ok":true}'])).stdout.trim())
      .toBe('completed pid 2 · reader · task · completed');
    expect((await cli(['process', 'reclaim', '2'])).stdout.trim())
      .toBe('reclaimed pid 2 · reader · task · reclaimed');
    const service = await data('process', 'spawn', '1', 'generic-service', '--name', 'stopper');
    expect((await cli(['process', 'stop', String(service.pid)])).stdout.trim())
      .toBe(`stopped pid ${service.pid} · stopper · service · stopped`);
    expect((await cli(['process', 'start', String(service.pid)])).stdout.trim())
      .toBe(`started pid ${service.pid} · stopper · service · running`);
    expect((await cli(['process', 'kill', String(service.pid)])).stdout.trim())
      .toBe(`killed pid ${service.pid} · stopper · service · stopped`);
  }, 60_000);

  test('delete and purge remove a process and its record', async () => {
    await cli(['daemon', 'start']);
    await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
    const died = await data('process', 'spawn', '1', 'generic-task', '--name', 'died');
    await data('process', 'complete', String(died.pid));
    const text = (await cli(['process', 'delete', String(died.pid)])).stdout.trim();
    expect(text).toContain(`deleted pid ${died.pid}`);
    expect(text).toContain('processes=1');
    expect(text).toContain('messages=0');
    expect((await cli(['process', 'inspect', String(died.pid)], { check: false })).stderr).toContain('not found');
    // The parent is where the disappearance is recorded.
    expect((await data('process', 'inspect', '1')).recent_events[0])
      .toMatchObject({ kind: 'child_deleted', data: { pid: died.pid, name: 'died' } });

    // A running process: delete refuses, purge terminates and removes it.
    const live = await data('process', 'spawn', '1', 'generic-service', '--name', 'live');
    const refused = await cli(['process', 'delete', String(live.pid)], { check: false });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('purge');
    expect(await data('process', 'purge', String(live.pid)))
      .toMatchObject({ status: 'running', terminated: [live.pid], deleted: [live.pid] });
    expect((await cli(['process', 'purge', String(live.pid)], { check: false })).code).not.toBe(0);

    // A subtree: refused without --recursive, removed from the leaves up with it.
    const branch = await data('process', 'spawn', '1', 'generic-service', '--name', 'branch');
    const leaf = await data('process', 'spawn', String(branch.pid), 'generic-task', '--name', 'leaf');
    await data('process', 'complete', String(leaf.pid));
    expect((await cli(['process', 'delete', String(branch.pid)], { check: false })).stderr).toContain('has children');
    await cli(['process', 'stop', String(branch.pid)]);
    const expected = [branch.pid, leaf.pid].sort((left, right) => left - right);
    expect((await data('process', 'delete', String(branch.pid), '--recursive')).deleted).toEqual(expected);
    expect((await cli(['process', 'delete', '0'], { check: false })).stderr).toContain('PID 0');
    expect((await cli(['process', 'delete'], { check: false })).code).toBe(2);
    expect((await cli(['process', 'purge', String(died.pid)], { check: false })).code).not.toBe(0);
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
      await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
      const project = await data('process', 'spawn', '1', 'project', '--name', 'p1', '--vars', JSON.stringify({ path: state.dir }));

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
      await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
      expect((await cli(['process', 'spawn', '1', 'generic-task', '--name', 'worker'])).stdout.trim()).toBe('PID 2');
      const pid = '2';

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
      expect((await data('process', 'tree'))[2].agent).toMatchObject({
        provider: 'pi', running: 1, agents: [{ id: `${pid}.1`, interactive: true, call_id: 1 }],
      });
      expect((await data('process', 'tree', '--no-agents'))[2].agent).toBeUndefined();
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
      await cli(['process', 'spawn', '0', 'project-manager', '--name', 'project-manager']);
      expect((await cli(['process', 'spawn', '1', 'generic-task', '--name', 'worker'])).stdout.trim()).toBe('PID 2');
      // A daemon-spawned agent: this CLI only waits for the call to finish.
      const call = Bun.spawn([process.execPath, CLI, 'process', 'call', '2', 'long work'], {
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
        id: '2.1', pid: 2, provider: 'pi', status: 'running', call_id: 1, interactive: false, cancellable: true,
      });
      expect(live[0].os_pid).toBeGreaterThan(0);
      // The tree shows the activity of that process only.
      const tree = (await cli(['process', 'tree'])).stdout;
      expect(tree).toContain('agent 2.1 running · ');
      expect(tree).toContain('lush[0]');
      expect(tree).not.toContain('agent 0.1');
      expect((await cli(['process', 'agents', 'list'])).stdout).toContain('pipe');

      // Killing the worker ends the invocation; the process keeps running with its goal.
      expect(JSON.parse((await cli(['--json', 'process', 'agents', 'kill', '2.1'])).stdout))
        .toMatchObject({ id: '2.1', outcome: 'killed' });
      expect(await call.exited).not.toBe(0);
      expect(await stderr).toContain('interrupted');
      expect(await stdout).toBe('');
      let info = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        info = await data('process', 'inspect', '2');
        if (info.recent_calls[0].status !== 'running') break;
        await Bun.sleep(20);
      }
      expect(info.recent_calls[0]).toMatchObject({ status: 'interrupted', error: 'invocation cancelled' });
      expect(info.status).toBe('running');
      expect(await data('process', 'agents', 'list')).toEqual([]);
      expect((await data('process', 'agents', 'list', '--all'))[0]).toMatchObject({ id: '2.1', status: 'interrupted' });
      // A finished agent cannot be killed again, and the process stays usable.
      const again = await cli(['process', 'agents', 'kill', '2.1'], { check: false });
      expect(again.code).not.toBe(0);
      expect(again.stderr).toContain('is not running');
      expect((await cli(['process', 'call', '2', 'hi'])).stdout.trim()).toBe('late reply');
      expect((await data('process', 'agents', 'list', '--all')).map((agent) => agent.id)).toEqual(['2.1', '2.2']);
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
                function: { name: 'process_spawn', arguments: '{"template":"project-manager","name":"only-once"}' },
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

describe('task field text output', () => {
  /** A read-model row shaped like `process.list` delivers them. */
  const row = ({ pid = 2, name = 'fix-login', title, detail, variables, ...rest } = {}) => ({
    pid,
    parent_pid: 1,
    original_parent_pid: 1,
    name,
    type: 'task',
    status: 'running',
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
  const inspectOf = (process) => formatInspect({
    ...process, context: { state: process.variables.immutable, message_count: 0 }, recent_calls: [], recent_events: [],
  });

  test('list adds a TITLE column and never moves the existing ones', () => {
    const text = formatList([
      row({ title: '修复登录流程' }),
      row({ pid: 3, name: 'demo-project', type: 'service', template: 'project' }),
    ]);
    const [header, task, service] = text.split('\n');
    // The historical prefix is untouched; TITLE is appended.
    expect(header.slice(0, 38)).toBe('PID   PPID  TYPE      STATUS      NAME');
    expect(header).toMatch(/^PID\s+PPID\s+TYPE\s+STATUS\s+NAME\s+TITLE$/);
    expect(task).toMatch(/^2\s+1\s+task\s+running\s+fix-login\s+修复登录流程$/);
    expect(service).toMatch(/^3\s+1\s+service\s+running\s+demo-project\s+-$/);
  });

  test('long titles are truncated in list and tree, and detail stays out of the tree', () => {
    const long = 'x'.repeat(50);
    expect(formatList([row({ title: long })])).toContain(`${'x'.repeat(37)}...`);
    const tree = treeLines([row({ title: long, detail: 'a\nb', parent_pid: null })]).join('\n');
    expect(tree).toContain(`fix-login[2] title=${'x'.repeat(45)}...`);
    // The `name` variable only repeats the process name; the body has no one-line form.
    expect(tree).not.toContain('name=fix-login');
    expect(tree).not.toContain('detail=');
    expect(tree.split('\n').length).toBe(1);
  });

  test('inspect shows title and detail, and old rows without them still render', () => {
    const text = inspectOf(row({ title: '修复登录流程', detail: '第一行\n第二行' }));
    expect(text).toMatch(/^ {2}title\s+修复登录流程$/m);
    expect(text).toMatch(/^detail\n {2}第一行\n {2}第二行$/m);
    // Nothing is repeated: the variables row would only repeat the task fields.
    expect(text).not.toContain('variables');

    // Data written before the three fields existed: no title row, no detail
    // block, no crash, and `--json` shape unchanged.
    const legacy = row({ variables: { immutable: {}, mutable: {}, declarations: { immutable: {}, mutable: {} } } });
    const legacyText = inspectOf(legacy);
    expect(legacyText).not.toContain('title');
    expect(legacyText).not.toContain('detail');
    expect(legacyText).toContain('pid 2 · fix-login · task · running');
    expect(formatList([legacy])).toMatch(/^2\s+1\s+task\s+running\s+fix-login\s+-$/m);

    // A very long body is capped in text, and says so.
    const long = inspectOf(row({ title: 't', detail: 'y'.repeat(5000) }));
    expect(long).toContain('more characters; --json has the full value');
  });
});

describe('agents kill text output', () => {
  // The three outcomes of `process.agents_kill`: the OS pid is only one of them,
  // and "no OS pid" must not be claimed when the pid simply died first.
  const view = (extra) => ({ id: '1.1', interactive: true, os_pid: 35692, ...extra });

  test('a delivered SIGKILL names the pid it killed', () => {
    expect(formatAgentKill(view({ outcome: 'killed' }))).toBe('killed agent 1.1 (os 35692)');
  });

  test('a pid that was already gone says so instead of "no pid"', () => {
    expect(formatAgentKill(view({ outcome: 'gone' })))
      .toBe('killed agent 1.1 (os 35692 was already gone; call interrupted)');
  });

  test('tty and in-process agents without a pid explain what actually happened', () => {
    expect(formatAgentKill(view({ outcome: 'no_pid', os_pid: null })))
      .toBe('cancellation requested for agent 1.1 (no OS pid reported yet; its terminal still owns that pi)');
    expect(formatAgentKill(view({ outcome: 'no_pid', os_pid: null, interactive: false })))
      .toBe('killed agent 1.1 (in-process provider; call interrupted)');
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
          pid: 4, name: 'cache', type: 'service', status: 'running', template: 'generic-service',
          original_parent_pid: 2, created_at: '2026-09-17T20:00:00.000Z', updated_at: '2026-09-17T20:00:00.000Z',
          last_activity_at: '2026-09-17T20:05:00.000Z', idle_seconds: 75, busy: true,
        },
        {
          pid: 5, name: 'worker', type: 'task', status: 'cancelled', template: 'generic-task',
          original_parent_pid: 2, created_at: '2026-09-17T20:00:00.000Z', updated_at: '2026-09-17T20:00:00.000Z',
          last_activity_at: '2026-09-17T20:05:00.000Z', idle_seconds: 75, busy: false,
        },
      ],
    });
    const lines = pool.split('\n');
    expect(lines[0]).toBe('policy adopt=adopt limit=2 ttl=0.5s sweep=30s');
    expect(lines[1]).toBe('orphans active=3 busy=1 over_limit=1');
    expect(pool).toContain('cache');
    expect(pool).toContain('worker');
    expect(pool).toMatch(/^\s+4\s+service\s+running\s+1m15s\s+yes\s+cache$/m);
    expect(pool).toMatch(/^\s+5\s+task\s+cancelled\s+1m15s\s+no\s+worker$/m);
    expect(pool).not.toContain('{');
    expect(formatOrphans({
      policy: { adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 },
      active_count: 0, busy_count: 0, over_limit: 0, orphans: [],
    })).toContain('(none');

    const report = formatOrphans({
      trigger: 'timer', skipped: false, checked: 3, active_before: 3, active_after: 1,
      evicted: [
        { pid: 4, name: 'cache', type: 'service', from: 'running', to: 'stopped', reason: 'orphan_ttl', idle_seconds: 900 },
        { pid: 5, name: 'worker', type: 'task', from: 'running', to: 'cancelled', reason: 'orphan_limit', idle_seconds: 12 },
      ],
      deferred: [{ pid: 6, reason: 'busy' }],
      limit: 1, ttl_seconds: 600,
    });
    expect(report.split('\n')[0]).toBe('trigger=timer checked=3 active 3->1 evicted=2 deferred=1 (limit=1 ttl=600s)');
    expect(report).toMatch(/^ {2}evicted 4 service running->stopped reason=orphan_ttl idle=900s cache$/m);
    expect(report).toMatch(/^ {2}evicted 5 task running->cancelled reason=orphan_limit idle=12s worker$/m);
    expect(report).toMatch(/^ {2}deferred 6 reason=busy .*busy/m);
  });
});
