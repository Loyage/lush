/**
 * Shared runtime for the `package.json` scripts that replaced the Justfile.
 *
 * The Justfile's job was mostly isolation: every command ran against a data
 * directory inside this checkout (`.lush/`), so each worktree got its own
 * daemon, database and socket. These helpers keep that contract:
 *
 *   LUSH_HOME        defaults to <repo>/.lush; an exported value always wins
 *   LUSH_PROVIDER    defaults to "pi"
 *   LUSH_CALL_TIMEOUT defaults to "900"
 *   LUSH_RPC_TIMEOUT defaults to "910"
 *
 * The CLI is always this checkout's `bin/lush` (and `bin/lushd` for the
 * daemon), never a globally installed one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the package root (the directory holding package.json). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BIN = {
  lush: path.join(PACKAGE_ROOT, 'bin', 'lush'),
  lushd: path.join(PACKAGE_ROOT, 'bin', 'lushd'),
  'lush-web': path.join(PACKAGE_ROOT, 'bin', 'lush-web'),
};

/** A usage error: prints `usage: bun run ...` and exits 2, like the CLI does. */
export class UsageError extends Error {}

/** Require at least `count` positional arguments; `usage` is shown on failure. */
export function need(args, count, usage) {
  if (args.length < count) throw new UsageError(usage);
  return args;
}

/**
 * The environment every script runs with: the process environment plus the
 * Justfile's defaults, with anything already exported taking precedence.
 */
export function scriptEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  env.LUSH_HOME = env.LUSH_HOME || path.join(PACKAGE_ROOT, '.lush');
  env.LUSH_PROVIDER = env.LUSH_PROVIDER || 'pi';
  env.LUSH_CALL_TIMEOUT = env.LUSH_CALL_TIMEOUT || '900';
  env.LUSH_RPC_TIMEOUT = env.LUSH_RPC_TIMEOUT || '910';
  return env;
}

function spawn(entry, args, options = {}) {
  const proc = Bun.spawnSync([process.execPath, entry, ...args], {
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: scriptEnv(options.env),
    stdin: options.stdin ?? 'inherit',
    stdout: options.stdout ?? 'inherit',
    stderr: options.stderr ?? 'inherit',
  });
  return proc.exitCode ?? 0;
}

/** Run `bun <repo>/bin/lush ...`, sharing stdio, returning the exit code. */
export function runLush(args, options = {}) {
  return spawn(BIN.lush, args, options);
}

/** Run `bun <repo>/bin/lushd ...` or `bin/lush-web ...`. */
export function runBin(name, args = [], options = {}) {
  return spawn(BIN[name], args, options);
}

/**
 * Like `runLush`, but captures output: returns `{ code, out, err }` with both
 * streams decoded. Used by the scripts that parse CLI output or filter it.
 */
export function captureLush(args, options = {}) {
  const proc = Bun.spawnSync([process.execPath, BIN.lush, ...args], {
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: scriptEnv(options.env),
    stdin: options.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode ?? 0,
    out: proc.stdout ? proc.stdout.toString() : '',
    err: proc.stderr ? proc.stderr.toString() : '',
  };
}

/** Run an arbitrary argv (e.g. `ps`, `lsof`, `tail`) with the script environment. */
export function capture(argv, options = {}) {
  const proc = Bun.spawnSync(argv, {
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: scriptEnv(options.env),
    stdin: options.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode ?? 0,
    out: proc.stdout ? proc.stdout.toString() : '',
    err: proc.stderr ? proc.stderr.toString() : '',
  };
}
