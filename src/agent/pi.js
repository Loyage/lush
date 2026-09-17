/**
 * The default call agent: the `pi` CLI as an external, subprocess-based agent.
 *
 * One `pi --print` process per call, one pi session per Lush PID. pi runs its
 * own tool loop (read/bash/edit/write) and reaches Lush through the `lush` CLI
 * from its bash tool; Lush only supplies the template system prompt, the shared
 * Lush guide and the LUSH_CONTEXT payload, then stores the final text.
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../log.js';
import { AgentResponse } from './provider.js';
import { LushError } from '../core/types.js';
import { lushContextMessage } from '../context/context.js';
import { shellCommand } from '../shell.js';

const log = createLogger('lush.agent.pi');

/** Repo `bin/` directory; prepended to PATH so the agent can always run `lush`. */
export const LUSH_BIN_DIR = path.dirname(fileURLToPath(new URL('../../bin/lush', import.meta.url)));
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const MAX_ARG = 100_000;

/** Session files for one id, oldest first (`<timestamp>_<id>.jsonl`). */
export function sessionFiles(sessionDir, sessionId) {
  let names;
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(`_${sessionId}.jsonl`))
    .sort()
    .map((name) => path.join(sessionDir, name));
}

/** Resolve `command` against PATH, or accept an explicit path. */
function resolveCommand(command, env) {
  if (command.includes('/')) {
    return fs.existsSync(command) ? command : null;
  }
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter((part) => part !== '');
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export class PiAgentProvider {
  static fromEnv(env = process.env, { home } = {}) {
    return new PiAgentProvider({
      command: env.LUSH_PI_COMMAND || 'pi',
      provider: env.LUSH_PI_PROVIDER || '',
      model: env.LUSH_PI_MODEL || '',
      home,
      env,
    });
  }

  constructor({ command = 'pi', provider = '', model = '', home, env = process.env, sessionDir = null } = {}) {
    if (typeof home !== 'string' || home === '') {
      throw new LushError('pi agent requires the Lush home directory', -32602);
    }
    const resolved = resolveCommand(command, env);
    if (resolved === null) {
      throw new LushError(`pi agent command not found: ${command} (set LUSH_PI_COMMAND or LUSH_PROVIDER=mock)`, -32602);
    }
    this.name = 'pi';
    /** External agents reach Lush through the CLI, not through process_* tools. */
    this.contextMode = 'cli';
    this.command = resolved;
    this.provider = provider;
    this.model = model;
    this.home = home;
    this.sessionDir = sessionDir ?? path.join(home, 'pi-sessions');
    this.env = env;
  }

  /** Session flags + agent identity, shared by `call`, `preview` and `sessionInfo`. */
  identityArgs(invocation, { name = null } = {}) {
    const pid = invocation.pid;
    const args = [
      '--session-dir', this.sessionDir,
      '--session-id', this.sessionId(pid),
      '--name', name ?? `${invocation.context?.process?.name ?? 'process'}[${pid}]`,
      '--system-prompt', invocation.system_prompt,
      '--append-system-prompt', invocation.guide,
      '--append-system-prompt', lushContextMessage(invocation.context),
    ];
    if (this.provider !== '') args.push('--provider', this.provider);
    if (this.model !== '') args.push('--model', this.model);
    for (const arg of args) {
      if (arg.length > MAX_ARG) throw new LushError('agent context is too large for a pi invocation', -32020);
    }
    return args;
  }

  sessionId(pid) {
    return `lush-${pid}`;
  }

  argsFor(invocation) {
    const args = ['--print', ...this.identityArgs(invocation), invocation.prompt];
    if (args[args.length - 1].length > MAX_ARG) {
      throw new LushError('agent context is too large for a pi invocation', -32020);
    }
    return args;
  }

  /**
   * What `call` would run, without running it: the exact argv, the working
   * directory and the extra environment. `command` is the shell-ready line.
   */
  preview(invocation) {
    const argv = [this.command, ...this.argsFor(invocation)];
    return {
      executable: this.command,
      argv,
      command: shellCommand(argv),
      cwd: invocation.cwd ?? this.home,
      env: { LUSH_HOME: this.home, LUSH_PID: String(invocation.pid) },
      path_prefix: LUSH_BIN_DIR,
    };
  }

  /**
   * This process's pi session: where it lives, which id it uses, its files on
   * disk and the interactive argv that opens it (no `--print`).
   */
  sessionInfo(invocation) {
    const sessionId = this.sessionId(invocation.pid);
    const files = sessionFiles(this.sessionDir, sessionId);
    const argv = [this.command, ...this.identityArgs(invocation)];
    // Compact line for browsing the conversation in pi's own TUI (pi's default prompt).
    const browseArgv = [this.command, '--session-dir', this.sessionDir, '--session-id', sessionId];
    if (this.provider !== '') browseArgv.push('--provider', this.provider);
    if (this.model !== '') browseArgv.push('--model', this.model);
    return {
      session_dir: this.sessionDir,
      session_id: sessionId,
      files,
      file: files.length ? files[files.length - 1] : null,
      argv,
      command: shellCommand(argv),
      browse_command: shellCommand(browseArgv),
      cwd: invocation.cwd ?? this.home,
      env: { LUSH_HOME: this.home, LUSH_PID: String(invocation.pid) },
      path_prefix: LUSH_BIN_DIR,
    };
  }

  async call(_messages, _tools, signal, invocation = {}) {
    if (typeof invocation.prompt !== 'string' || invocation.prompt === '') {
      throw new LushError('pi agent requires the current call prompt', -32020);
    }
    const args = this.argsFor(invocation);
    const cwd = invocation.cwd ?? this.home;
    const env = {
      ...this.env,
      LUSH_HOME: this.home,
      LUSH_PID: String(invocation.pid),
      PATH: `${LUSH_BIN_DIR}${path.delimiter}${this.env.PATH ?? ''}`,
    };
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    log.info(`pi call pid=${invocation.pid} cwd=${cwd} session=lush-${invocation.pid}`);

    const child = cp.spawn(this.command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    let overflow = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > MAX_OUTPUT) {
        overflow = true;
        output = output.slice(0, MAX_OUTPUT);
        return;
      }
      output += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });

    // Cancellation must stop the agent subprocess, not only the waiter.
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const { code, signalName, error } = await new Promise((resolve) => {
      child.on('error', (err) => resolve({ code: null, signalName: null, error: err }));
      child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signalName: exitSignal, error: null }));
    });
    if (signal) signal.removeEventListener('abort', onAbort);

    if (signal?.aborted) {
      const aborted = new Error('aborted');
      aborted.name = 'AbortError';
      aborted.aborted = true;
      throw aborted;
    }
    if (error) {
      log.warn(`pi could not start for pid=${invocation.pid}: ${error.message}`);
      throw new LushError(`pi agent could not start: ${error.message}`, -32020);
    }
    if (code !== 0) {
      const detail = stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? '';
      log.warn(`pi exited ${code ?? signalName} for pid=${invocation.pid}: ${stderr.trim().slice(0, 2000)}`);
      throw new LushError(`pi agent failed (exit ${code ?? signalName})${detail ? `: ${detail}` : ''}`, -32020);
    }
    if (overflow) {
      log.warn(`pi output truncated for pid=${invocation.pid}`);
      throw new LushError('pi agent output is too large', -32020);
    }
    return new AgentResponse(output.trim());
  }
}
