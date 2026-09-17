/**
 * How a pi invocation is described: session layout, argv construction and the
 * shell-ready command line.
 *
 * Everything here is pure resolution — no subprocess is started. `pi.js` uses
 * the same functions for a real call, for `call --dry-run` and for
 * `session --open`, so what a preview prints and what `call` runs cannot
 * drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LushError } from '../core/types.js';
import { lushContextMessage } from '../context/context.js';
import { shellCommand } from '../shell.js';

/** Repo `bin/` directory; prepended to PATH so the agent can always run `lush`. */
export const LUSH_BIN_DIR = path.dirname(fileURLToPath(new URL('../../bin/lush', import.meta.url)));
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
export function resolveCommand(command, env) {
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

/** Session flags + agent identity, shared by `call`, `preview` and `sessionInfo`. */
export function identityArgs(provider, invocation, { name = null } = {}) {
  const pid = invocation.pid;
  const args = [
    '--session-dir', provider.sessionDir,
    '--session-id', provider.sessionId(pid),
    '--name', name ?? `${invocation.context?.process?.name ?? 'process'}[${pid}]`,
    '--system-prompt', invocation.system_prompt,
    '--append-system-prompt', invocation.guide,
    '--append-system-prompt', lushContextMessage(invocation.context),
  ];
  if (provider.provider !== '') args.push('--provider', provider.provider);
  if (provider.model !== '') args.push('--model', provider.model);
  for (const arg of args) {
    if (arg.length > MAX_ARG) throw new LushError('agent context is too large for a pi invocation', -32020);
  }
  return args;
}

/** argv of `call`: `--print` makes pi answer once and exit. */
export function argsFor(provider, invocation) {
  const args = ['--print', ...identityArgs(provider, invocation), invocation.prompt];
  if (args[args.length - 1].length > MAX_ARG) {
    throw new LushError('agent context is too large for a pi invocation', -32020);
  }
  return args;
}

/**
 * argv of `call --interactive`: the same identity and prompt without
 * `--print`, so pi opens its TUI on that prompt and the terminal drives the
 * tool loop instead of the daemon.
 */
export function interactiveArgs(provider, invocation) {
  if (typeof invocation.prompt !== 'string' || invocation.prompt === '') {
    throw new LushError('pi agent requires the current call prompt', -32020);
  }
  const args = [...identityArgs(provider, invocation), invocation.prompt];
  if (args[args.length - 1].length > MAX_ARG) {
    throw new LushError('agent context is too large for a pi invocation', -32020);
  }
  return args;
}

/**
 * What `call` (or `call --interactive`) would run, without running it: the
 * exact argv, the working directory and the extra environment. `command` is
 * the shell-ready line.
 */
export function preview(provider, invocation, { interactive = false } = {}) {
  const argv = [provider.command, ...(interactive ? interactiveArgs(provider, invocation) : argsFor(provider, invocation))];
  return {
    executable: provider.command,
    argv,
    command: shellCommand(argv),
    cwd: invocation.cwd ?? provider.home,
    env: { LUSH_HOME: provider.home, LUSH_PID: String(invocation.pid) },
    path_prefix: LUSH_BIN_DIR,
  };
}

/** Where this process's pi session lives and which id it uses (no disk walk of the argv). */
export function sessions(provider, pid) {
  const sessionId = provider.sessionId(pid);
  return { session_dir: provider.sessionDir, session_id: sessionId, files: sessionFiles(provider.sessionDir, sessionId) };
}

/**
 * This process's pi session: where it lives, which id it uses, its files on
 * disk and the interactive argv that opens it (no `--print`).
 */
export function sessionInfo(provider, invocation) {
  const { session_dir: sessionDir, session_id: sessionId, files } = sessions(provider, invocation.pid);
  const argv = [provider.command, ...identityArgs(provider, invocation)];
  // Compact line for browsing the conversation in pi's own TUI (pi's default prompt).
  const browseArgv = [provider.command, '--session-dir', provider.sessionDir, '--session-id', sessionId];
  if (provider.provider !== '') browseArgv.push('--provider', provider.provider);
  if (provider.model !== '') browseArgv.push('--model', provider.model);
  return {
    session_dir: sessionDir,
    session_id: sessionId,
    files,
    file: files.length ? files[files.length - 1] : null,
    argv,
    command: shellCommand(argv),
    browse_command: shellCommand(browseArgv),
    cwd: invocation.cwd ?? provider.home,
    env: { LUSH_HOME: provider.home, LUSH_PID: String(invocation.pid) },
    path_prefix: LUSH_BIN_DIR,
  };
}
