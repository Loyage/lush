import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { LUSH_BIN_DIR, PiAgentProvider } from '../src/agent/pi.js';
import { agentGuide } from '../src/agent/guide.js';
import { configuredProvider } from '../src/agent/provider.js';
import { LUSH_CONTEXT_PREFIX } from '../src/context/context.js';
import { shellCommand } from '../src/shell.js';
import { cleanup, expectRejection, permissiveRoot, system, tmpdir } from './helpers.js';

// A fake `pi` binary: it records how Lush invoked it instead of calling a model.
const STUB = `#!/usr/bin/env bun
const mode = process.env.PI_STUB_MODE ?? 'ok';
if (process.env.PI_STUB_PID_FILE) await Bun.write(process.env.PI_STUB_PID_FILE, String(process.pid));
if (mode === 'fail') {
  console.error('stub pi exploded');
  process.exit(3);
}
if (mode === 'slow') await Bun.sleep(30000);
const argv = process.argv.slice(2);
if (argv.includes('--session-dir')) {
  const dir = argv[argv.indexOf('--session-dir') + 1];
  const id = argv[argv.indexOf('--session-id') + 1];
  await Bun.write(dir + '/2020-01-01T00-00-00-000Z_' + id + '.jsonl', '{}');
}
console.log(JSON.stringify({
  argv: process.argv.slice(1),
  cwd: process.cwd(),
  home: process.env.LUSH_HOME,
  pid: process.env.LUSH_PID,
  path: process.env.PATH,
}));
`;

function writeStub(dir, name = 'pi-stub') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, STUB);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Read a value that follows `flag` in an argv list. */
function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

describe('pi agent backend', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let provider;

  beforeEach(() => {
    dir = tmpdir('lush-pi-');
    provider = new PiAgentProvider({ command: writeStub(dir), home: dir });
    ({ database: db, manager, runtime } = system(dir, provider));
    permissiveRoot(manager);
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  test('invocation carries system prompt, Lush guide, context, session and cwd', async () => {
    const result = await provider.call([], [], null, {
      pid: 4,
      prompt: 'do the thing',
      system_prompt: 'SYSTEM_PROMPT',
      guide: agentGuide('cli'),
      context: { process: { name: 'demo' }, pid: 4 },
      cwd: dir,
    });
    const payload = JSON.parse(result.content);
    expect(payload.argv[0].endsWith('pi-stub')).toBe(true);
    expect(payload.argv[1]).toBe('--print');
    expect(payload.argv[payload.argv.length - 1]).toBe('do the thing');
    expect(flagValue(payload.argv, '--session-id')).toBe('lush-4');
    expect(flagValue(payload.argv, '--session-dir')).toBe(path.join(dir, 'pi-sessions'));
    expect(flagValue(payload.argv, '--name')).toBe('demo[4]');
    expect(flagValue(payload.argv, '--system-prompt')).toBe('SYSTEM_PROMPT');
    const appended = payload.argv.filter((_value, index) => payload.argv[index - 1] === '--append-system-prompt');
    expect(appended[0]).toBe(agentGuide('cli'));
    expect(appended[1].startsWith(LUSH_CONTEXT_PREFIX)).toBe(true);
    expect(JSON.parse(appended[1].slice(LUSH_CONTEXT_PREFIX.length)).pid).toBe(4);
    expect(payload.cwd).toBe(fs.realpathSync(dir));
    expect(payload.home).toBe(dir);
    expect(payload.pid).toBe('4');
    expect(payload.path.startsWith(`${LUSH_BIN_DIR}${path.delimiter}`)).toBe(true);
    expect(fs.statSync(path.join(dir, 'pi-sessions')).mode & 0o777).toBe(0o700);
  });

  test('runtime call stores the pi final text', async () => {
    const result = await manager.call(0, 'hello');
    expect(JSON.parse(result.output).pid).toBe('0');
    expect(manager.inspect(0).recent_calls[0].status).toBe('succeeded');
    expect(manager.inspect(0).context.message_count).toBe(2);
    expect(manager.inspect(0).agent.provider).toBe('pi');
  });

  test('project processes run the agent in the immutable path variable', async () => {
    const real = fs.realpathSync(dir);
    const project = manager.load(0).createChild('project', { name: 'demo-project', goal: 'ship it', variables: { path: real } });
    expect(project.inspect().context.state.params).toEqual({ path: real });
    expect((await manager.call(project.pid, 'where?', true)).cwd).toBe(real);
    const result = await project.call('what is here?');
    const payload = JSON.parse(result.output);
    expect(payload.cwd).toBe(real);
    expect(flagValue(payload.argv, '--name')).toBe('demo-project[1]');
    expect(manager.repository.context(project.pid).state.params.path).toBe(real);
  });

  test('dry run prints the command without touching invocation history', async () => {
    const preview = await manager.call(0, 'preview me', true);
    expect(preview.dry_run).toBe(true);
    expect(preview.agent).toBe('pi');
    expect(preview.prompt).toBe('preview me');
    expect(preview.argv[0].endsWith('pi-stub')).toBe(true);
    expect(preview.executable.endsWith('pi-stub')).toBe(true);
    expect(preview.argv[1]).toBe('--print');
    expect(flagValue(preview.argv, '--session-id')).toBe('lush-0');
    expect(preview.command).toContain('--append-system-prompt');
    expect(preview.command.startsWith(preview.argv[0])).toBe(true);
    expect(preview.command.endsWith("'preview me'")).toBe(true);
    expect(preview.cwd).toBe(dir); // printed as configured; the child resolves symlinks itself
    expect(preview.env).toEqual({ LUSH_HOME: dir, LUSH_PID: '0' });
    expect(preview.path_prefix).toBe(LUSH_BIN_DIR);
    // A dry run records nothing and does not mark the process busy.
    expect(manager.inspect(0).recent_calls).toEqual([]);
    expect(manager.inspect(0).context.message_count).toBe(0);
    expect(runtime.isBusy(0)).toBe(false);
    // The real call then runs exactly the previewed argv (argv[0] may be canonicalized by the OS).
    const echoed = JSON.parse((await manager.call(0, 'preview me')).output).argv;
    expect(echoed.slice(1)).toEqual(preview.argv.slice(1));
    expect(fs.realpathSync(echoed[0])).toBe(fs.realpathSync(preview.argv[0]));
    await expectRejection(manager.call(0, 'again', 'yes'), /dry_run must be a boolean/);
  });

  test('non-zero exit becomes a provider error without leaking details', async () => {
    const env = { ...process.env, PI_STUB_MODE: 'fail' };
    const failing = new PiAgentProvider({ command: writeStub(dir, 'pi-fail'), home: dir, env });
    const error = await expectRejection(failing.call([], [], null, {
      pid: 1, prompt: 'x', system_prompt: 's', guide: 'g', context: { process: { name: 'x' } },
    }), /pi agent failed \(exit 3\)/);
    expect(error.code).toBe(-32020);
    expect(error.message).toContain('stub pi exploded');
  });

  test('abort kills the pi subprocess', async () => {
    const pidFile = path.join(dir, 'pi.pid');
    const env = { ...process.env, PI_STUB_MODE: 'slow', PI_STUB_PID_FILE: pidFile };
    const slow = new PiAgentProvider({ command: writeStub(dir, 'pi-slow'), home: dir, env });
    const controller = new AbortController();
    const pending = slow.call([], [], controller.signal, {
      pid: 1, prompt: 'x', system_prompt: 's', guide: 'g', context: { process: { name: 'x' } },
    });
    pending.catch(() => {});
    for (let attempt = 0; attempt < 100 && !fs.existsSync(pidFile); attempt += 1) await Bun.sleep(20);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    controller.abort();
    await expectRejection(pending, /aborted/);
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test('interactive call hands pi the terminal and still records one call', async () => {
    const opened = runtime.openInteractive(0, 'help me please');
    expect(opened).toMatchObject({ pid: 0, call_id: 1, agent: 'pi', prompt: 'help me please', interactive: true });
    // The interactive argv is the plain call argv without --print.
    expect(opened.argv.includes('--print')).toBe(false);
    expect(flagValue(opened.argv, '--session-id')).toBe('lush-0');
    expect(opened.argv[opened.argv.length - 1]).toBe('help me please');
    expect(opened.env).toEqual({ LUSH_HOME: dir, LUSH_PID: '0' });
    expect(opened.cwd).toBe(dir);

    // Opening the call is a real call: user message recorded, live agent registered.
    expect(runtime.isBusy(0)).toBe(true);
    expect(runtime.agentSummary(0)).toMatchObject({ running: 1, agents: [{ id: '0.1', call_id: 1, interactive: true }] });
    expect(manager.inspect(0).agent.status).toBe('busy');
    expect(manager.inspect(0).recent_calls[0]).toMatchObject({ status: 'running', prompt: 'help me please' });
    expect(manager.inspect(0).context.message_count).toBe(1);
    expect(() => manager.callBegin(0, 'again')).toThrow(/agent is busy/);
    await expectRejection(manager.call(0, 'again'), /agent is busy/);

    const settled = manager.callEnd(0, opened.call_id, 'succeeded');
    expect(settled).toEqual({ pid: 0, call_id: opened.call_id, settled: true, status: 'succeeded' });
    expect(runtime.isBusy(0)).toBe(false);
    expect(manager.inspect(0).recent_calls[0].status).toBe('succeeded');
    // Reporting twice is not an error: the daemon may have settled it first.
    expect(manager.callEnd(0, opened.call_id, 'failed').settled).toBe(false);
    expect(manager.inspect(0).recent_calls[0].status).toBe('succeeded');
    // The next (daemon-run) call continues the same pi session.
    expect(flagValue((await manager.call(0, 'hello', true)).argv, '--session-id')).toBe('lush-0');
    expect((await manager.call(0, 'hello')).output).toContain('lush-0');
  });

  test('kill marks an open interactive call; the terminal settles it as interrupted', async () => {
    const task = manager.load(0).createChild('generic-task', { name: 'worker' });
    const opened = runtime.openInteractive(task.pid, 'do the work');
    manager.kill(task.pid);
    expect(runtime.isBusy(task.pid)).toBe(true); // the terminal still runs pi
    const settled = manager.callEnd(task.pid, opened.call_id, 'succeeded');
    expect(settled).toMatchObject({ settled: true, status: 'interrupted' });
    expect(runtime.isBusy(task.pid)).toBe(false);
  });

  test('an interactive call nobody settles times out and frees the process', async () => {
    const other = tmpdir('lush-pi-open-');
    const parts = system(other, new PiAgentProvider({ command: writeStub(other, 'pi-stub'), home: other }),
      { timeout: 0.05 });
    try {
      const opened = parts.runtime.openInteractive(0, 'abandoned');
      expect(parts.runtime.isBusy(0)).toBe(true);
      await Bun.sleep(300);
      expect(parts.runtime.isBusy(0)).toBe(false);
      const [call] = parts.manager.inspect(0).recent_calls;
      expect(call.status).toBe('failed');
      expect(call.error).toContain('timed out');
      // The late terminal reports to nobody; the daemon's verdict stands.
      expect(parts.manager.callEnd(0, opened.call_id, 'succeeded').settled).toBe(false);
      expect(parts.manager.inspect(0).recent_calls[0].status).toBe('failed');
    } finally {
      await parts.runtime.shutdown();
      parts.database.close();
      cleanup(other);
    }
  });

  test('agent space: termination, live pids and the durable call behind it', async () => {
    const parent = manager.load(0).createChild('generic-task', { name: 'worker' });
    await parent.call('first round');
    const opened = runtime.openInteractive(parent.pid, 'interactive round');
    expect(opened.agent_id).toBe(`${parent.pid}.2`);
    expect(runtime.agentsList()).toEqual([
      expect.objectContaining({ id: `${parent.pid}.2`, interactive: true, os_pid: null, cancellable: false }),
    ]);
    expect(runtime.agentsList({ pid: 0 })).toEqual([]);

    // The terminal reports the OS pid of the pi process it runs.
    const terminal = cp.spawn(process.execPath, ['-e', 'await Bun.sleep(30000)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => terminal.on('close', resolve));
    expect(manager.callOsPid(parent.pid, opened.call_id, terminal.pid))
      .toEqual({ pid: parent.pid, call_id: opened.call_id, recorded: true, agent_id: `${parent.pid}.2` });
    expect(runtime.agentsList()[0]).toMatchObject({ os_pid: terminal.pid, cancellable: true });
    expect(manager.agentShow(`${parent.pid}.2`)).toMatchObject({
      id: `${parent.pid}.2`,
      call: { id: 2, prompt: 'interactive round', status: 'running' },
      session: { session_id: `lush-${parent.pid}` },
    });
    expect(manager.agentShow(`${parent.pid}.1`)).toMatchObject({
      status: 'succeeded', cancellable: false, call: { status: 'succeeded' },
    });

    // Killing one agent kills the OS process, not the logical Process, and
    // settles the interactive call on the spot: there is nobody left to report.
    const kill = manager.agentsKill(`${parent.pid}.2`);
    expect(kill).toMatchObject({ outcome: 'killed', os_pid: terminal.pid });
    expect('killed' in kill).toBe(false);
    expect(kill.cancellable).toBe(false);
    await exited;
    expect(runtime.agentsList()).toEqual([]);
    expect(manager.callEnd(parent.pid, opened.call_id, 'succeeded')).toMatchObject({ settled: false, status: 'interrupted' });
    expect(manager.inspect(parent.pid).status).toBe('running');
    expect(manager.agentsList(null, true).map((agent) => `${agent.id}:${agent.status}`))
      .toEqual([`${parent.pid}.1:succeeded`, `${parent.pid}.2:interrupted`]);
    expect(() => manager.agentsKill(`${parent.pid}.2`)).toThrow(/is not running/);
    expect(() => manager.agentShow(`${parent.pid}.3`)).toThrow(/agent not found/);
    // A report that arrives after the verdict is a no-op, not an error.
    expect(manager.callOsPid(parent.pid, opened.call_id, process.pid)).toEqual({
      pid: parent.pid, call_id: opened.call_id, recorded: false, agent_id: null,
    });
  });

  test('agents kill settles an interactive worker whose pi is already gone', async () => {
    const opened = runtime.openInteractive(0, 'interactive round');
    // A pi that exits on its own leaves the agent listed (only the terminal can
    // report back) with a pid that is no longer alive.
    const dead = cp.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => dead.on('close', resolve));
    expect(manager.callOsPid(0, opened.call_id, dead.pid)).toMatchObject({ recorded: true });
    await exited;
    // `gone`, not `no_pid`: the daemon still knows which pid it had, so it can
    // tell the terminal is not coming back and settle the call itself.
    expect(manager.agentsKill(opened.agent_id)).toMatchObject({ outcome: 'gone', os_pid: dead.pid, status: 'interrupted' });
    expect(runtime.agentsList()).toEqual([]);
    expect(runtime.isBusy(0)).toBe(false);
    expect(manager.inspect(0).recent_calls[0]).toMatchObject({
      id: opened.call_id, status: 'interrupted', error: `invocation ${opened.call_id} interrupted`,
    });
  });

  test('interactive settlement is validated', () => {
    expect(() => manager.callBegin(0, '')).toThrow(/prompt must be a non-empty string/);
    expect(() => manager.callEnd(0, 1.5, 'succeeded')).toThrow(/call_id must be a positive integer/);
    expect(() => manager.callEnd(0, 1, 'cancelled')).toThrow(/status must be/);
    expect(() => manager.callEnd(0, 1, 'succeeded', '')).toThrow(/output must be a non-empty string/);
    // A call the daemon already settled (timeout, kill, shutdown) reports settled: false.
    expect(manager.callEnd(0, 1, 'succeeded')).toEqual({ pid: 0, call_id: 1, settled: false, status: null });
  });

  test('session reports the pi session dir, id, file and open commands', async () => {
    const before = manager.session(0);
    expect(before).toMatchObject({
      pid: 0, name: 'lush', status: 'running', agent: 'pi', busy: false, session_id: 'lush-0', file: null, files: [],
    });
    expect(before.cwd).toBe(dir);
    // Read-only: no invocation was recorded.
    expect(manager.inspect(0).recent_calls).toEqual([]);
    expect(manager.inspect(0).context.message_count).toBe(0);
    // The listing summary reads host liveness only: no Context, no session walk.
    expect(runtime.agentSummary(0)).toEqual({ provider: 'pi', running: 0, agents: [] });

    await manager.call(0, 'hello');
    // The finished agent moved to the bounded in-memory log.
    expect(runtime.agentSummary(0)).toEqual({ provider: 'pi', running: 0, agents: [] });
    const [finished] = manager.agentsList(null, true);
    expect(finished).toMatchObject({
      id: '0.1', pid: 0, name: 'lush', provider: 'pi', status: 'succeeded', call_id: 1,
      interactive: false, os_pid: expect.any(Number), cancellable: false, error: null,
    });
    expect(finished.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(manager.agentsList()).toEqual([]); // live only
    expect(manager.tree().find((row) => row.pid === 0).agent).toEqual(runtime.agentSummary(0));
    const after = manager.session(0);
    expect(after.session_dir).toBe(path.join(dir, 'pi-sessions'));
    expect(after.file.endsWith('_lush-0.jsonl')).toBe(true);
    expect(after.files).toEqual([after.file]);
    // `--open` argv keeps the Lush identity and has no --print; browse_command is the short form.
    expect(after.argv.includes('--print')).toBe(false);
    expect(flagValue(after.argv, '--system-prompt')).toBe(manager.templates.get('lush-root').system_prompt);
    expect(after.command).toBe(shellCommand(after.argv));
    expect(after.browse_command).toContain('--session-id lush-0');
    expect(after.browse_command).not.toContain('--system-prompt');

    // Allowed for any status: a finished task can still be reviewed.
    const task = manager.load(0).createChild('generic-task');
    manager.complete(task.pid);
    expect(manager.session(task.pid).status).toBe('completed');
  });

  test('missing pi command fails fast and env overrides are honoured', async () => {
    expect(() => new PiAgentProvider({ command: 'definitely-not-a-real-agent', home: dir }))
      .toThrow(/pi agent command not found/);
    // LUSH_PROVIDER unset still means pi, and LUSH_PI_COMMAND picks the binary.
    const fromEnv = await configuredProvider({ LUSH_PI_COMMAND: writeStub(dir, 'pi-env') }, { home: dir });
    expect(fromEnv.name).toBe('pi');
    expect(fromEnv.contextMode).toBe('cli');
    expect(() => new PiAgentProvider({ command: writeStub(dir, 'pi-home'), home: undefined }))
      .toThrow(/home directory/);
  });
});
