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
    const manager = new ProcessManager(repository, templates);
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
    log.info(`lushd ready at ${config.socket} (provider=${provider.name})`);
    await stopping.promise;
  } finally {
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
