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
  sid: process.env.LUSH_SID,
  task: process.env.LUSH_TASK_ID,
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

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  test('invocation carries system prompt, guide, context, task session and cwd', async () => {
    const result = await provider.call([], [], null, {
      task_id: 7,
      sid: 4,
      prompt: 'do the thing',
      system_prompt: 'SYSTEM_PROMPT',
      guide: agentGuide('cli'),
      context: { service: { name: 'demo' }, task: { id: 7 } },
      cwd: dir,
    });
    const payload = JSON.parse(result.content);
    expect(payload.argv[0].endsWith('pi-stub')).toBe(true);
    expect(payload.argv[1]).toBe('--print');
    expect(payload.argv[payload.argv.length - 1]).toBe('do the thing');
    // Sessions belong to tasks: the id names the task, not the service.
    expect(flagValue(payload.argv, '--session-id')).toBe('lush-task-7');
    expect(flagValue(payload.argv, '--session-dir')).toBe(path.join(dir, 'pi-sessions'));
    expect(flagValue(payload.argv, '--name')).toBe('demo[4]#7');
    expect(flagValue(payload.argv, '--system-prompt')).toBe('SYSTEM_PROMPT');
    const appended = payload.argv.filter((_value, index) => payload.argv[index - 1] === '--append-system-prompt');
    expect(appended[0]).toBe(agentGuide('cli'));
    expect(appended[1].startsWith(LUSH_CONTEXT_PREFIX)).toBe(true);
    expect(JSON.parse(appended[1].slice(LUSH_CONTEXT_PREFIX.length)).task.id).toBe(7);
    expect(payload.cwd).toBe(fs.realpathSync(dir));
    expect(payload.home).toBe(dir);
    expect(payload.sid).toBe('4');
    expect(payload.task).toBe('7');
    expect(payload.path.startsWith(`${LUSH_BIN_DIR}${path.delimiter}`)).toBe(true);
    expect(fs.statSync(path.join(dir, 'pi-sessions')).mode & 0o777).toBe(0o700);
  });

  test('a task run stores the pi final text', async () => {
    const task = await manager.call(0, 'hello');
    expect(task.status).toBe('completed');
    expect(JSON.parse(task.result).sid).toBe('0');
    expect(JSON.parse(task.result).task).toBe(String(task.id));
    expect(manager.repository.taskCalls(task.id)[0].status).toBe('succeeded');
    expect(manager.inspect(0).recent_calls[0].status).toBe('succeeded');
    expect(manager.inspect(0).agent.provider).toBe('pi');
  });

  test('services that declare path run the agent in it', async () => {
    const real = fs.realpathSync(dir);
    const project = manager.load(manager.construct(0, 'project', 'demo-project', 'ship it', { path: real }).sid);
    expect(project.inspect().context.state.params).toEqual({ path: real });
    const preview = await manager.callDescribe(project.sid, 'where?');
    expect(preview.cwd).toBe(real);
    const first = await manager.call(project.sid, 'what is here?');
    const payload = JSON.parse(first.result);
    expect(payload.cwd).toBe(real);
    expect(flagValue(payload.argv, '--name')).toBe('demo-project[1]#1');
    expect(manager.repository.context(project.sid).state.params.path).toBe(real);

    // The same binding carries a git worktree: the node a dev-task hands a
    // worktree to runs there, without anyone having to `cd`.
    const devTask = manager.load(manager.construct(project.sid, 'dev-task', 'fix-login', undefined, { title: '修登录' }).sid);
    const worktree = manager.load(manager.construct(devTask.sid, 'worktree-service', 'fix-login', undefined, { path: real }).sid);
    expect((await manager.callDescribe(worktree.sid, 'where?')).cwd).toBe(real);
    const done = await manager.call(worktree.sid, 'what is here?');
    expect(JSON.parse(done.result).cwd).toBe(real);
    expect(flagValue(JSON.parse(done.result).argv, '--name')).toBe('fix-login[3]#2');
  });

  test('dry run prints the command without creating a task', async () => {
    const preview = await manager.callDescribe(0, 'preview me');
    expect(preview.dry_run).toBe(true);
    expect(preview.agent).toBe('pi');
    expect(preview.prompt).toBe('preview me');
    expect(preview.argv[0].endsWith('pi-stub')).toBe(true);
    expect(preview.executable.endsWith('pi-stub')).toBe(true);
    expect(preview.argv[1]).toBe('--print');
    // No task exists yet, so the session id is a placeholder.
    expect(flagValue(preview.argv, '--session-id')).toBe('lush-task-preview');
    expect(preview.command).toContain('--append-system-prompt');
    expect(preview.command.startsWith(preview.argv[0])).toBe(true);
    expect(preview.command.endsWith("'preview me'")).toBe(true);
    expect(preview.cwd).toBe(dir); // printed as configured; the child resolves symlinks itself
    expect(preview.env).toEqual({ LUSH_HOME: dir, LUSH_SID: '0', LUSH_TASK_ID: '' });
    expect(preview.path_prefix).toBe(LUSH_BIN_DIR);
    // A dry run records nothing, creates no task and does not mark the service busy.
    expect(manager.inspect(0).recent_calls).toEqual([]);
    expect(manager.inspect(0).context.message_count).toBe(0);
    expect(manager.taskList()).toEqual([]);
    expect(runtime.isBusy(0)).toBe(false);
    // The real task then runs the same flags (only the session id differs).
    const task = await manager.call(0, 'preview me');
    const echoed = JSON.parse(task.result).argv;
    expect(echoed[echoed.indexOf('--session-id') + 1]).toBe(`lush-task-${task.id}`);
    expect(echoed.slice(1, echoed.indexOf('--session-id'))).toEqual(preview.argv.slice(1, preview.argv.indexOf('--session-id')));
    expect(fs.realpathSync(echoed[0])).toBe(fs.realpathSync(preview.argv[0]));
  });

  test('non-zero exit becomes a provider error without leaking details', async () => {
    const env = { ...process.env, PI_STUB_MODE: 'fail' };
    const failing = new PiAgentProvider({ command: writeStub(dir, 'pi-fail'), home: dir, env });
    const error = await expectRejection(failing.call([], [], null, {
      task_id: 1, sid: 1, prompt: 'x', system_prompt: 's', guide: 'g', context: { service: { name: 'x' } },
    }), /pi agent failed \(exit 3\)/);
    expect(error.code).toBe(-32020);
    expect(error.message).toContain('stub pi exploded');
  });

  test('abort kills the pi subservice', async () => {
    const pidFile = path.join(dir, 'pi.sid');
    const env = { ...process.env, PI_STUB_MODE: 'slow', PI_STUB_PID_FILE: pidFile };
    const slow = new PiAgentProvider({ command: writeStub(dir, 'pi-slow'), home: dir, env });
    const controller = new AbortController();
    const pending = slow.call([], [], controller.signal, {
      task_id: 1, sid: 1, prompt: 'x', system_prompt: 's', guide: 'g', context: { service: { name: 'x' } },
    });
    pending.catch(() => {});
    for (let attempt = 0; attempt < 100 && !fs.existsSync(pidFile); attempt += 1) await Bun.sleep(20);
    const childSid = Number(fs.readFileSync(pidFile, 'utf8'));
    controller.abort();
    await expectRejection(pending, /aborted/);
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
      try {
        process.kill(childSid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test('interactive task hands pi the terminal and still records one call', async () => {
    const task = manager.repository.createTask(0, null, 'help me please');
    const opened = runtime.openInteractive(task.id);
    expect(opened).toMatchObject({ task_id: task.id, sid: 0, call_id: 1, agent: 'pi', prompt: 'help me please', interactive: true });
    // The interactive argv is the plain call argv without --print.
    expect(opened.argv.includes('--print')).toBe(false);
    expect(flagValue(opened.argv, '--session-id')).toBe(`lush-task-${task.id}`);
    expect(opened.argv[opened.argv.length - 1]).toBe('help me please');
    expect(opened.env).toEqual({ LUSH_HOME: dir, LUSH_SID: '0', LUSH_TASK_ID: String(task.id) });
    expect(opened.cwd).toBe(dir);

    // Opening the task is real work: user message recorded, live agent registered.
    expect(runtime.isBusy(0)).toBe(true);
    expect(manager.repository.getTask(task.id).status).toBe('running');
    expect(runtime.agentSummary(0)).toMatchObject({
      running: 1, agents: [{ id: `${task.id}.1`, call_id: 1, interactive: true }],
    });
    expect(manager.inspect(0).agent.status).toBe('busy');
    expect(manager.repository.taskCalls(task.id)[0]).toMatchObject({ status: 'running', prompt: 'help me please' });
    // One active task per service: a second one is refused while the terminal owns pi.
    await expectRejection(manager.call(0, 'again'), /already working on task/);

    const settled = manager.callEnd(task.id, opened.call_id, 'succeeded');
    expect(settled).toEqual({ task_id: task.id, call_id: opened.call_id, settled: true, status: 'completed' });
    expect(runtime.isBusy(0)).toBe(false);
    expect(manager.repository.taskCalls(task.id)[0].status).toBe('succeeded');
    expect(manager.repository.getTask(task.id).status).toBe('completed');
    // Reporting twice is not an error: the daemon settled it first.
    expect(manager.callEnd(task.id, opened.call_id, 'failed').settled).toBe(false);
    expect(manager.repository.getTask(task.id).status).toBe('completed');

    // A new task on the same service gets its own session.
    const next = await manager.callDescribe(0, 'hello');
    expect(flagValue(next.argv, '--session-id')).toBe('lush-task-preview');
    const second = await manager.call(0, 'hello');
    expect(JSON.parse(second.result).argv[JSON.parse(second.result).argv.indexOf('--session-id') + 1])
      .toBe(`lush-task-${second.id}`);
  });

  test('cancelling an interactive task lets the terminal settle as interrupted', async () => {
    const task = manager.repository.createTask(
      manager.construct(0, 'generic-task', 'worker').sid, null, 'do the work',
    );
    const opened = runtime.openInteractive(task.id);
    manager.cancelTask(task.id);
    expect(runtime.isBusy(task.sid)).toBe(true); // the terminal still runs pi
    const settled = manager.callEnd(task.id, opened.call_id, 'succeeded');
    expect(settled).toMatchObject({ settled: true, status: 'cancelled' });
    expect(runtime.isBusy(task.sid)).toBe(false);
    expect(manager.repository.getTask(task.id).status).toBe('cancelled');
  });

  test('an interactive task nobody settles times out and fails', async () => {
    const other = tmpdir('lush-pi-open-');
    const parts = system(other, new PiAgentProvider({ command: writeStub(other, 'pi-stub'), home: other }),
      { timeout: 0.05 });
    try {
      const task = parts.manager.repository.createTask(0, null, 'abandoned');
      const opened = parts.runtime.openInteractive(task.id);
      expect(parts.runtime.isBusy(0)).toBe(true);
      await Bun.sleep(300);
      expect(parts.runtime.isBusy(0)).toBe(false);
      const [call] = parts.manager.repository.taskCalls(task.id);
      expect(call.status).toBe('failed');
      expect(call.error).toContain('timed out');
      expect(parts.manager.repository.getTask(task.id)).toMatchObject({
        status: 'failed', error: 'interactive invocation timed out',
      });
      // The late terminal reports to nobody; the daemon's verdict stands.
      expect(parts.manager.callEnd(task.id, opened.call_id, 'succeeded').settled).toBe(false);
      expect(parts.manager.repository.taskCalls(task.id)[0].status).toBe('failed');
    } finally {
      await parts.runtime.shutdown();
      parts.database.close();
      cleanup(other);
    }
  });

  test('agent space: per-task ids, live OS sids and the durable call behind it', async () => {
    const worker = manager.load(manager.construct(0, 'generic-task', 'worker').sid);
    const first = await manager.call(worker.sid, 'first round');
    const interactive = manager.repository.createTask(worker.sid, null, 'interactive round');
    const opened = runtime.openInteractive(interactive.id);
    // Ids are per task: the first task used 1.1, this one starts at 2.1.
    expect(opened.agent_id).toBe(`${interactive.id}.1`);
    expect(runtime.agentsList()).toEqual([
      expect.objectContaining({ id: `${interactive.id}.1`, task_id: interactive.id, interactive: true, os_pid: null, cancellable: false }),
    ]);
    expect(runtime.agentsList({ taskId: first.id })).toEqual([]);

    // The terminal reports the OS sid of the pi service it runs.
    const terminal = cp.spawn(process.execPath, ['-e', 'await Bun.sleep(30000)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => terminal.on('close', resolve));
    expect(manager.callOsPid(interactive.id, opened.call_id, terminal.pid))
      .toEqual({ task_id: interactive.id, call_id: opened.call_id, recorded: true, agent_id: `${interactive.id}.1` });
    expect(runtime.agentsList()[0]).toMatchObject({ os_pid: terminal.pid, cancellable: true });
    expect(manager.agentShow(`${interactive.id}.1`)).toMatchObject({
      id: `${interactive.id}.1`,
      task_id: interactive.id,
      call: { id: opened.call_id, prompt: 'interactive round', status: 'running' },
      session: { session_id: `lush-task-${interactive.id}` },
    });
    expect(manager.agentShow(`${first.id}.1`)).toMatchObject({
      status: 'succeeded', cancellable: false, call: { status: 'succeeded' },
    });

    // Killing one agent kills the OS service and cancels the task it served.
    const kill = manager.agentsKill(`${interactive.id}.1`);
    expect(kill).toMatchObject({ outcome: 'killed', os_pid: terminal.pid });
    expect(kill.cancellable).toBe(false);
    await exited;
    expect(runtime.agentsList()).toEqual([]);
    expect(manager.repository.getTask(interactive.id).status).toBe('cancelled');
    expect(manager.callEnd(interactive.id, opened.call_id, 'succeeded')).toMatchObject({ settled: false, status: 'cancelled' });
    expect(manager.inspect(worker.sid).status).toBe('active');
    expect(manager.agentsList(null, null, true).map((agent) => `${agent.id}:${agent.status}`))
      .toEqual([`${first.id}.1:succeeded`, `${interactive.id}.1:interrupted`]);
    expect(() => manager.agentsKill(`${interactive.id}.1`)).toThrow(/is not running/);
    expect(() => manager.agentShow(`${interactive.id}.3`)).toThrow(/agent not found/);
    // A report that arrives after the verdict is a no-op, not an error.
    expect(manager.callOsPid(interactive.id, opened.call_id, process.pid)).toEqual({
      task_id: interactive.id, call_id: opened.call_id, recorded: false, agent_id: null,
    });
  });

  test('agents kill settles an interactive worker whose pi is already gone', async () => {
    const task = manager.repository.createTask(0, null, 'interactive round');
    const opened = runtime.openInteractive(task.id);
    // A pi that exits on its own leaves the agent listed (only the terminal can
    // report back) with a sid that is no longer alive.
    const dead = cp.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => dead.on('close', resolve));
    expect(manager.callOsPid(task.id, opened.call_id, dead.pid)).toMatchObject({ recorded: true });
    await exited;
    // `gone`, not `no_pid`: the daemon still knows which sid it had, so it can
    // tell the terminal is not coming back and settle the call itself.
    expect(manager.agentsKill(opened.agent_id))
      .toMatchObject({ outcome: 'gone', os_pid: dead.pid, status: 'interrupted' });
    expect(runtime.agentsList()).toEqual([]);
    expect(runtime.isBusy(0)).toBe(false);
    expect(manager.repository.taskCalls(task.id)[0]).toMatchObject({
      id: opened.call_id, status: 'interrupted', error: `invocation ${opened.call_id} interrupted`,
    });
    expect(manager.repository.getTask(task.id).status).toBe('cancelled');
  });

  test('interactive settlement is validated', () => {
    const task = manager.repository.createTask(0, null, 'work');
    expect(() => runtime.openInteractive(manager.repository.createTask(0, null, 'x').id)).not.toThrow();
    expect(() => manager.callEnd(task.id, 1.5, 'succeeded')).toThrow(/call_id must be a positive integer/);
    expect(() => manager.callEnd(task.id, 1, 'cancelled')).toThrow(/status must be/);
    expect(() => manager.callEnd(task.id, 1, 'succeeded', '')).toThrow(/output must be a non-empty string/);
    // A call the daemon already settled (timeout, kill, shutdown) reports settled: false.
    expect(manager.callEnd(task.id, 1, 'succeeded')).toEqual({ task_id: task.id, call_id: 1, settled: false, status: 'created' });
  });

  test('session reports the pi session dir, id, file and open commands', async () => {
    // A task on SID 0: the session belongs to it, not to the service.
    const task = manager.repository.createTask(0, null, 'hello');
    const before = manager.session(task.id);
    expect(before).toMatchObject({
      task_id: task.id, sid: 0, name: 'lush', task_status: 'created', agent: 'pi', busy: false,
      session_id: `lush-task-${task.id}`, file: null, files: [],
    });
    expect(before.cwd).toBe(dir);
    // Read-only: no invocation was recorded.
    expect(manager.repository.calls(0)).toEqual([]);
    expect(runtime.agentSummary(0)).toEqual({ provider: 'pi', running: 0, agents: [] });

    manager.cancelTask(task.id);
    const done = await manager.call(0, 'hello');
    const [finished] = manager.agentsList(done.id, null, true);
    expect(finished).toMatchObject({
      id: `${done.id}.1`, sid: 0, name: 'lush', provider: 'pi', status: 'succeeded',
      interactive: false, os_pid: expect.any(Number), cancellable: false, error: null,
    });
    expect(finished.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(manager.agentsList()).toEqual([]); // live only
    expect(manager.tree().find((row) => row.sid === 0).agent).toEqual(runtime.agentSummary(0));
    const after = manager.session(done.id);
    expect(after.session_dir).toBe(path.join(dir, 'pi-sessions'));
    expect(after.file.endsWith(`_lush-task-${done.id}.jsonl`)).toBe(true);
    expect(after.files).toEqual([after.file]);
    // `--open` argv keeps the Lush identity and has no --print; browse_command is the short form.
    expect(after.argv.includes('--print')).toBe(false);
    expect(flagValue(after.argv, '--system-prompt')).toBe(manager.templates.get('lush-root').system_prompt);
    expect(after.command).toBe(shellCommand(after.argv));
    expect(after.browse_command).toContain(`--session-id lush-task-${done.id}`);
    expect(after.browse_command).not.toContain('--system-prompt');
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
