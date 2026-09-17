import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../config.js';
import { AgentRuntime } from '../agent/runtime.js';
import { configuredProvider } from '../agent/provider.js';
import { ContextBuilder } from '../context/builder.js';
import { ProcessManager } from '../core/process_manager.js';
import { DaemonLock } from './locking.js';
import { Database } from '../persistence/database.js';
import { Repository } from '../persistence/repository.js';
import { Dispatcher } from '../rpc/protocol.js';
import { RPCServer } from '../rpc/server.js';
import { TemplateLoader } from '../template_loader.js';
import { codeIdentity } from '../identity.js';
import { createLogger } from '../log.js';
import { createSignal } from '../signal.js';

const log = createLogger('lush.daemon');

export async function serve(config) {
  config.prepare();
  const lock = new DaemonLock(config.home);
  lock.acquire();
  // Captured once: this daemon keeps answering with the code it started with,
  // and `system.status` must keep saying so after the checkout moves on.
  const startedAt = new Date().toISOString();
  const identity = { home: config.home, socket: config.socket, started_at: startedAt, ...codeIdentity() };

  let database = null;
  let server = null;
  let runtime = null;
  let repository = null;
  let orphanTimer = null;
  const stopping = createSignal();
  const onSignal = () => stopping.set();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    fs.rmSync(config.socket, { force: true }); // safe only while holding the daemon lock
    const templates = new TemplateLoader(path.join(config.home, 'templates'));
    const provider = await configuredProvider(process.env, { home: config.home });
    database = new Database(path.join(config.home, 'lush.db'));
    repository = new Repository(database);
    const manager = new ProcessManager(repository, templates, config.orphanPolicy);
    manager.ensureRoot();
    repository.recover();
    const backfill = manager.backfillTemplateSnapshots();
    if (backfill.filled.length) {
      log.info(`backfilled template snapshot fields for PIDs ${backfill.filled.join(', ')}`);
    }
    if (backfill.unknown_template.length) {
      log.warn(`cannot backfill PIDs whose template is not loaded: ${backfill.unknown_template.join(', ')}`);
    }
    runtime = new AgentRuntime(manager, provider,
      new ContextBuilder(repository, templates, { agentMode: provider.contextMode ?? 'tools' }), {
        timeout: config.callTimeout,
        maxRounds: config.maxRounds,
      });
    manager.runtime = runtime;
    server = new RPCServer(config.socket, new Dispatcher(manager, stopping, identity));
    await server.start();
    // Orphan supervision only runs when there is something to enforce: a sweep
    // interval of 0 means "never automatically", whatever the limit or TTL say.
    const policy = config.orphanPolicy;
    if (policy.sweepSeconds > 0 && (policy.limit > 0 || policy.ttlSeconds > 0)) {
      orphanTimer = setInterval(() => {
        try {
          const report = manager.superviseOrphans('timer');
          if (report.evicted.length) {
            const detail = report.evicted.map((item) => `${item.pid} (${item.reason})`).join(', ');
            log.info(`orphan supervision evicted PIDs ${detail}`);
          }
        } catch (err) {
          log.warn(`orphan supervision failed: ${err?.message ?? err}`);
        }
      }, policy.sweepSeconds * 1000);
      orphanTimer.unref?.(); // a pending sweep must never keep the daemon alive
    }
    log.info(`lushd ready at ${config.socket} (provider=${provider.name})`);
    await stopping.promise;
  } finally {
    // The timer must be gone before the database it reads from is closed.
    if (orphanTimer) clearInterval(orphanTimer);
    // Stop accepting new work before cancelling agent invocations.
    if (server) await server.close();
    if (runtime) await runtime.shutdown();
    if (repository && repository.exists(0)) repository.transition(0, 'stopped'); // no adoption on shutdown
    if (database) database.close();
    fs.rmSync(config.socket, { force: true });
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    lock.release();
  }
}

export function main() {
  process.umask(0o077);
  serve(Config.fromEnv()).catch((err) => {
    process.stderr.write(`lushd: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

if (import.meta.main) main();
