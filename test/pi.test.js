import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { LUSH_BIN_DIR, PiAgentProvider } from '../src/agent/pi.js';
import { agentGuide } from '../src/agent/guide.js';
import { configuredProvider } from '../src/agent/provider.js';
import { LUSH_CONTEXT_PREFIX } from '../src/context/context.js';
import { shellCommand } from '../src/shell.js';
import { cleanup, expectRejection, system, tmpdir } from './helpers.js';

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

  test('project processes run the agent in args.path', async () => {
    const real = fs.realpathSync(dir);
    const project = manager.load(0).createChild('project', { name: 'demo-project', goal: 'ship it', args: { path: real } });
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

  test('session reports the pi session dir, id, file and open commands', async () => {
    const before = manager.session(0);
    expect(before).toMatchObject({
      pid: 0, name: 'lush', status: 'running', agent: 'pi', busy: false, session_id: 'lush-0', file: null, files: [],
    });
    expect(before.cwd).toBe(dir);
    // Read-only: no invocation was recorded.
    expect(manager.inspect(0).recent_calls).toEqual([]);
    expect(manager.inspect(0).context.message_count).toBe(0);

    await manager.call(0, 'hello');
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
