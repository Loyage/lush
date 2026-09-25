import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../config.js';
import { Store } from '../persistence/store.js';
import { Project } from '../core/project.js';
import { DaemonLock } from './locking.js';
import { Dispatcher } from '../rpc/protocol.js';
import { RPCServer } from '../rpc/server.js';
import { createSignal } from '../signal.js';
import { codeIdentity } from '../identity.js';

export async function serve(config) {
  config.prepare();
  const lock = new DaemonLock(config.home); lock.acquire();
  const stopping = createSignal();
  const stop = () => stopping.set();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let store, project, server;
  try {
    fs.rmSync(config.socket, { force: true });
    store = new Store(path.join(config.home, 'project.db'), config.project);
    project = new Project(config, store);
    // Establish the logical main owner before RPC accepts new say; this never starts an Agent.
    await project.bootstrapMain();
    const identity = { ...codeIdentity(), socket: config.socket, started_at: new Date().toISOString() };
    server = new RPCServer(config.socket, new Dispatcher(project, stopping, identity));
    await server.start();
    project.recover();
    console.error(`lush ready: ${config.project} (${config.provider})`);
    await stopping.promise;
  } finally {
    if (server) await server.close();
    if (project) await project.shutdown();
    if (store) store.close();
    fs.rmSync(config.socket, { force: true });
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    lock.release();
  }
}
export function main() {
  process.umask(0o077);
  serve(Config.fromEnv()).catch(error => { console.error(`lushd: ${error.message}`); process.exitCode = 1; });
}
if (import.meta.main) main();
