import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { check, LushError } from '../core/types.js';
import { AdministratorService } from './service.js';
import { AdministratorClient } from './client.js';
import { administratorHome, ensurePrivateDirectory, assertPrivateFile } from './paths.js';

/** Assemble only delivered adapters. A missing runner fails explicitly, never a fabricated result. */
export async function serveAdministrator({ env = process.env, home = env.LUSH_ADMINISTRATOR_HOME || administratorHome(env), runner = null, executor = null,
  signals = true, ...options } = {}) {
  const service = new AdministratorService({ env, home, runner, executor, ...options });
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const onStop = () => { service.close().catch(() => { process.exitCode = 1; }); };
  service.onClosed = () => {
    if (signals) { process.off('SIGTERM', onStop); process.off('SIGINT', onStop); }
    release();
  };
  if (signals) { process.once('SIGTERM', onStop); process.once('SIGINT', onStop); }
  try { await service.start(); }
  catch (error) { if (signals) { process.off('SIGTERM', onStop); process.off('SIGINT', onStop); } throw error; }
  return { service, closed };
}

/** Explicit user launch. Reads/Host teardown never invoke this function. entrypoint is code-owned. */
export async function startAdministratorProcess({ env = process.env, home = administratorHome(env), entrypoint,
  timeoutMs = 5000 } = {}) {
  const client = new AdministratorClient({ env, home });
  client.assertUserControl();
  const current = await client.readStatus();
  if (current.online) return current;
  check(typeof entrypoint === 'string' && path.isAbsolute(entrypoint) && fs.statSync(entrypoint).isFile(), 'trusted administrator service entrypoint required');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000, 'invalid administrator startup timeout');
  ensurePrivateDirectory(home);
  const logPath = path.join(home, 'service.log'); assertPrivateFile(logPath, { missing: true });
  const log = fs.openSync(logPath, 'a', 0o600);
  const childEnv = { ...env, LUSH_ADMINISTRATOR_HOME: home };
  // A device service never inherits the launching development/Valet invocation or project binding.
  for (const key of ['LUSH_PROJECT', 'LUSH_HOME', 'LUSH_TASK_ID', 'LUSH_AGENT_TOKEN', 'LUSH_RUNTIME_CONTEXT',
    'LUSH_ADMINISTRATOR_TOKEN', 'LUSH_ADMINISTRATOR_SOCKET']) delete childEnv[key];
  for (const key of Object.keys(childEnv)) if (key.startsWith('LUSH_MANAGER_') || key.startsWith('LUSH_ADMIN_')) delete childEnv[key];
  let child, launchError = false;
  try {
    child = cp.spawn(process.execPath, [entrypoint], { env: childEnv, detached: true, stdio: ['ignore', log, log] });
    child.once('error', () => { launchError = true; }); child.unref();
  } finally { fs.closeSync(log); }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launchError) throw new LushError('administrator service launch failed; inspect its private service log', -32060);
    const state = await client.readStatus();
    if (state.online) return state;
    await Bun.sleep(30);
  }
  // Do not kill a PID inferred from a stale file, repeat launch, or claim the process never started.
  throw new LushError('administrator service startup was not confirmed; inspect status and the private service log before retrying', -32060);
}

export async function readAdministratorStatus(options = {}) { return new AdministratorClient(options).readStatus(); }
export async function stopAdministratorProcess(userBinding, options = {}) { return new AdministratorClient(options).shutdown(userBinding); }
