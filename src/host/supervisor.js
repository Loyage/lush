import cp from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../identity.js';

/** Own exactly one Host worker. Only an explicit restart exit is replayed. */
export async function superviseHost(args = process.argv.slice(2)) {
  let worker = null, stopping = false, port = null;
  const stop = signal => { stopping = true; worker?.kill(signal); };
  const term = () => stop('SIGTERM'), interrupt = () => stop('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  try {
    for (;;) {
      const nextArgs = [...args];
      if (port !== null) {
        if (/^\d+$/.test(nextArgs[0] ?? '')) nextArgs[0] = String(port);
        else nextArgs.unshift(String(port));
      }
      const result = await new Promise(resolve => {
        worker = cp.spawn(process.execPath, [path.join(ROOT, 'bin/lush-host-worker'), ...nextArgs], {
          cwd: process.cwd(), env: process.env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], serialization: 'json',
        });
        worker.on('message', message => {
          if (message?.type === 'host-ready' && Number.isInteger(message.port) && message.port > 0) port = message.port;
        });
        worker.once('error', error => { console.error(`lush-host: ${error.message}`); resolve(1); });
        worker.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
      });
      worker = null;
      if (stopping || result !== 75 || port === null) return stopping ? 0 : result;
    }
  } finally {
    process.off('SIGTERM', term); process.off('SIGINT', interrupt);
    worker?.kill('SIGTERM');
  }
}
