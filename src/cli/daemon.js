import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { ROOT, codeIdentity } from '../identity.js';
import { UIClient } from '../ui/client.js';
import { isLocked } from '../daemon/locking.js';
import { check } from '../core/types.js';

export async function daemon(config, command) {
  const client = new UIClient(config);
  if (command === 'status') return client.request('system.status');
  if (command === 'stop' || command === 'restart') {
    if (isLocked(config.home)) {
      await client.request('system.stop');
      const deadline = Date.now() + 15000;
      while (isLocked(config.home) && Date.now() < deadline) await Bun.sleep(30);
      check(!isLocked(config.home), 'daemon is still shutting down; inspect before retrying');
    }
    if (command === 'stop') return { stopped: true, project: config.project };
  }
  if (command === 'start' || command === 'restart') {
    config.prepare();
    if (isLocked(config.home)) {
      const status = await client.request('system.status');
      const local = codeIdentity();
      check(status.project === config.project, 'daemon belongs to another project');
      return { ...status, already_running: true, code_match: status.fingerprint === local.fingerprint && status.code_dir === local.code_dir };
    }
    const fd = fs.openSync(path.join(config.home, 'daemon.log'), 'a', 0o600);
    const child = cp.spawn(process.execPath, [path.join(ROOT, 'bin/lushd')], {
      cwd: config.project, env: config.env, detached: true, stdio: ['ignore',fd,fd],
    });
    fs.closeSync(fd); child.unref();
    let error = null;
    child.on('error', err => { error = err; });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !error) {
      try { return await client.request('system.status'); } catch {}
      if (child.exitCode !== null) break;
      await Bun.sleep(50);
    }
    throw new Error(`daemon failed to start: ${error?.message || `see ${config.home}/daemon.log`}`);
  }
  throw new Error('daemon command must be start, stop, restart or status');
}
