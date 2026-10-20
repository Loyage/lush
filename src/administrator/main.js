import { fileURLToPath } from 'node:url';
import { administratorHome } from './paths.js';
import { serveAdministrator, startAdministratorProcess } from './lifecycle.js';

export const ADMINISTRATOR_ENTRYPOINT = fileURLToPath(import.meta.url);
export function startAdministrator(options = {}) {
  return startAdministratorProcess({ ...options, entrypoint: ADMINISTRATOR_ENTRYPOINT });
}

/** Legacy ADM history/stop process only; no Provider, executor or new authorization. */
export async function runAdministrator({ env = process.env, home = env.LUSH_ADMINISTRATOR_HOME || administratorHome(env), signals = true } = {}) {
  return serveAdministrator({ env, home, signals });
}

if (import.meta.main) {
  try { const running = await runAdministrator(); await running.closed; }
  catch { console.error('管理员服务未确认启动或收口；检查服务状态和私有日志，不自动重放。'); process.exitCode = 1; }
}
