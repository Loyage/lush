/**
 * The default call agent: the `pi` CLI as an external, subprocess-based agent.
 *
 * One `pi --print` process per call, one pi session per Lush PID. pi runs its
 * own tool loop (read/bash/edit/write) and reaches Lush through the `lush` CLI
 * from its bash tool; Lush only supplies the template system prompt, the shared
 * Lush guide and the LUSH_CONTEXT payload, then stores the final text.
 *
 * `call --interactive` drops `--print`: the same session runs as pi's TUI inside
 * the caller's terminal, so a human can watch and steer that same tool loop.
 * How an invocation is described (session, argv, command line) lives in
 * `pi_args.js`; this file owns the provider class and running the subprocess.
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../log.js';
import { AgentResponse } from './provider.js';
import { LushError } from '../core/types.js';
import {
  LUSH_BIN_DIR, argsFor, identityArgs, interactiveArgs, preview, resolveCommand, sessionInfo, sessions,
} from './pi_args.js';

export { LUSH_BIN_DIR, sessionFiles } from './pi_args.js';

const log = createLogger('lush.agent.pi');

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

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

  sessionId(pid) {
    return `lush-${pid}`;
  }

  // ── How an invocation is described (see pi_args.js) ───────────────────────

  identityArgs(invocation, options) {
    return identityArgs(this, invocation, options);
  }

  argsFor(invocation) {
    return argsFor(this, invocation);
  }

  interactiveArgs(invocation) {
    return interactiveArgs(this, invocation);
  }

  preview(invocation, options) {
    return preview(this, invocation, options);
  }

  sessions(pid) {
    return sessions(this, pid);
  }

  sessionInfo(invocation) {
    return sessionInfo(this, invocation);
  }

  // ── Running one invocation ────────────────────────────────────────────────

  async call(_messages, _tools, signal, invocation = {}) {
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
    // Hand the OS pid to the runtime before waiting: the agent space needs to
    // name the process while it is still running.
    invocation.on_spawn?.(child.pid);
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
