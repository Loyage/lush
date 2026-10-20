import { fileURLToPath } from 'node:url';
import { createAdministratorExecutor } from './execution.js';
import { createAdministratorRunner } from './runner.js';
import { administratorHome } from './paths.js';
import { serveAdministrator, startAdministratorProcess } from './lifecycle.js';

export const ADMINISTRATOR_ENTRYPOINT = fileURLToPath(import.meta.url);
export function startAdministrator(options = {}) {
  return startAdministratorProcess({ ...options, entrypoint: ADMINISTRATOR_ENTRYPOINT });
}

/** Device service, not a Host or project daemon. Only the trusted broker owns adapters. */
export async function runAdministrator({ env = process.env, home = env.LUSH_ADMINISTRATOR_HOME || administratorHome(env),
  runner = null, executor = null, signals = true } = {}) {
  const tools = executor ?? createAdministratorExecutor({ env, home });
  const provider = runner ?? createAdministratorRunner({ env, home });
  try {
    const running = await serveAdministrator({ env, home, runner: provider, executor: tools, signals });
    return { ...running, closed: running.closed.finally(() => tools.close?.()) };
  } catch (error) { await tools.close?.(); throw error; }
}

if (import.meta.main) {
  try { const running = await runAdministrator(); await running.closed; }
  catch { console.error('管理员服务未确认启动或收口；检查服务状态和私有日志，不自动重放。'); process.exitCode = 1; }
}
