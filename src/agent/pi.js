/**
 * The default call agent: the `pi` CLI as an external, subprocess-based agent.
 *
 * One `pi --print` service per call, one pi session per Lush SID. pi runs its
 * own tool loop (read/bash/edit/write) and reaches Lush through the `lush` CLI
 * from its bash tool; Lush only supplies the template system prompt, the shared
 * Lush guide and the LUSH_CONTEXT payload, then stores the final text.
 *
 * `call --interactive` drops `--print`: the same session runs as pi's TUI inside
 * the caller's terminal, so a human can watch and steer that same tool loop.
 * How an invocation is described (session, argv, command line) lives in
 * `pi_args.js`; this file owns the provider class and running the subprocess.
 *
 * `plugins` is the agent profile's switch: `false` (the default) adds the pure
 * pi flag set so no user extension / skill / prompt template / theme / AGENTS.md
 * is loaded, `true` leaves pi's own defaults alone. `flags` are extra pi flags
 * a profile asked for, appended after the plugin switches.
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
  /** The env-only fallback tier: environment variables over the built-in defaults. */
  static fromEnv(env = process.env, { home } = {}) {
    return new PiAgentProvider({
      command: env.LUSH_PI_COMMAND || 'pi',
      provider: env.LUSH_PI_PROVIDER || '',
      model: env.LUSH_PI_MODEL || '',
      home,
      env,
    });
  }

  /** One resolved agent profile (`resolveAgentSpec`). */
  static fromSpec(spec, env = process.env, { home, sessionDir = null } = {}) {
    return new PiAgentProvider({
      command: spec.command || 'pi',
      provider: spec.pi_provider ?? '',
      model: spec.model ?? '',
      plugins: spec.plugins === true,
      flags: spec.flags ?? [],
      home,
      env,
      sessionDir,
    });
  }

  /** Same as `fromSpec`, but a missing binary is kept as-is instead of throwing (argv preview). */
  static forPreview(spec, env = process.env, { home } = {}) {
    return new PiAgentProvider({
      command: spec.command || 'pi',
      provider: spec.pi_provider ?? '',
      model: spec.model ?? '',
      plugins: spec.plugins === true,
      flags: spec.flags ?? [],
      home,
      env,
      requireCommand: false,
    });
  }

  constructor({
    command = 'pi', provider = '', model = '', plugins = false, flags = [],
    home, env = process.env, sessionDir = null, requireCommand = true,
  } = {}) {
    if (typeof home !== 'string' || home === '') {
      throw new LushError('pi agent requires the Lush home directory', -32602);
    }
    const resolved = resolveCommand(command, env);
    if (resolved === null && requireCommand) {
      throw new LushError(`pi agent command not found: ${command} (set LUSH_PI_COMMAND, the profile command, or LUSH_PROVIDER=mock)`, -32602);
    }
    this.name = 'pi';
    /** External agents reach Lush through the CLI, not through service_* tools. */
    this.contextMode = 'cli';
    this.command = resolved ?? command;
    this.provider = provider;
    this.model = model;
    /** `false` = pure pi: no user extensions / skills / prompt templates / themes / AGENTS.md. */
    this.plugins = plugins;
    this.flags = [...flags];
    this.home = home;
    this.sessionDir = sessionDir ?? path.join(home, 'pi-sessions');
    this.env = env;
  }

  /** One pi session per task: a task's conversation is its own agent's memory. */
  sessionId(taskId) {
    return taskId === null || taskId === undefined ? 'lush-task-preview' : `lush-task-${taskId}`;
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

  sessions(taskId) {
    return sessions(this, taskId);
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
      // The agent acts on a task, and needs to name it: `$LUSH_TASK_ID` is how
      // it reaches `lush task ...` for the very task it is working on.
      LUSH_SID: String(invocation.sid),
      LUSH_TASK_ID: invocation.task_id === null || invocation.task_id === undefined
        ? ''
        : String(invocation.task_id),
      PATH: `${LUSH_BIN_DIR}${path.delimiter}${this.env.PATH ?? ''}`,
    };
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    log.info(`pi call task=${invocation.task_id ?? '-'} sid=${invocation.sid} cwd=${cwd} session=${this.sessionId(invocation.task_id)}`);

    const child = cp.spawn(this.command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Hand the OS PID to the runtime before waiting: the agent space needs to
    // name the service while it is still running.
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
      log.warn(`pi could not start for sid=${invocation.sid}: ${error.message}`);
      throw new LushError(`pi agent could not start: ${error.message}`, -32020);
    }
    if (code !== 0) {
      const detail = stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? '';
      log.warn(`pi exited ${code ?? signalName} for sid=${invocation.sid}: ${stderr.trim().slice(0, 2000)}`);
      throw new LushError(`pi agent failed (exit ${code ?? signalName})${detail ? `: ${detail}` : ''}`, -32020);
    }
    if (overflow) {
      log.warn(`pi output truncated for sid=${invocation.sid}`);
      throw new LushError('pi agent output is too large', -32020);
    }
    return new AgentResponse(output.trim());
  }
}
