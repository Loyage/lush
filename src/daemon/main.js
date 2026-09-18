import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../config.js';
import { AgentRuntime } from '../agent/runtime.js';
import { AgentCatalog } from '../agent/catalog.js';
import { ContextBuilder } from '../context/builder.js';
import { ServiceManager } from '../core/service_manager.js';
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
    // The catalog is created once and stays valid for the whole daemon run: it
    // re-reads `$LUSH_HOME/agents/<name>.json` per call, so editing a profile
    // takes effect immediately while the daemon's own fallback provider (env over
    // the built-in pure-pi default) is built here and never changes.
    const catalog = new AgentCatalog({ home: config.home, env: process.env });
    const provider = catalog.defaultProvider();
    database = new Database(path.join(config.home, 'lush.db'));
    repository = new Repository(database);
    const manager = new ServiceManager(repository, templates, config.orphanPolicy);
    manager.agentCatalog = catalog;
    manager.ensureRoot();
    // SID 0 is the only service whose snapshot tracks the loaded template: the
    // root whitelist is whatever `lush-root` currently says, once per start.
    const rootTemplate = manager.refreshRootTemplate();
    if (rootTemplate.missing) {
      log.warn('lush-root template is not loaded; SID 0 keeps its stored snapshot');
    } else if (rootTemplate.changed.length) {
      log.info(`refreshed SID 0 template snapshot: ${rootTemplate.changed.join(', ')}`);
    }
    repository.recover();
    const backfill = manager.backfillTemplateSnapshots();
    if (backfill.filled.length) {
      log.info(`backfilled template snapshot fields for SIDs ${backfill.filled.join(', ')}`);
    }
    if (backfill.unknown_template.length) {
      log.warn(`cannot backfill SIDs whose template is not loaded: ${backfill.unknown_template.join(', ')}`);
    }
    runtime = new AgentRuntime(manager, provider,
      new ContextBuilder(repository, templates, { agentMode: provider.contextMode ?? 'tools' }), {
        timeout: config.callTimeout,
        maxRounds: config.maxRounds,
        maxCalls: config.taskCalls,
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
            const detail = report.evicted.map((item) => `${item.sid} (${item.reason})`).join(', ');
            log.info(`orphan supervision evicted SIDs ${detail}`);
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
