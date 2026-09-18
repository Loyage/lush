/**
 * `bun run prune [all]` — stop leftover daemons from other LUSH_HOMEs.
 *
 * Ports the Justfile's `prune` recipe. By default it only stops daemons whose
 * working directory no longer exists (a home directory that was deleted by a
 * test or demo); `bun run prune all` also stops daemons whose temporary home
 * still exists. It never touches the current LUSH_HOME or the default home.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, scriptEnv } from './lib.js';

/**
 * Pids of the running lush daemons. `pid` is portable across macOS and Linux
 * (the Justfile asked for `sid`, which BSD ps rejects), and the daemon is
 * detached, so it is its own session anyway.
 */
function daemonPids() {
  const ps = capture(['ps', '-eo', 'pid=,command=']);
  const pids = [];
  for (const line of ps.out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    if (/daemon\/main\.js$/.test(match[2].trim())) pids.push(Number(match[1]));
  }
  return pids;
}

/** The working directory a process was started in, or null when unreadable. */
function cwdOf(pid) {
  const proc = `/proc/${pid}/cwd`;
  if (fs.existsSync(proc)) {
    try {
      return fs.readlinkSync(proc);
    } catch {
      return null;
    }
  }
  const lsof = capture(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  for (const line of lsof.out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1);
  }
  return null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function prune(args = []) {
  const mode = args[0] ?? '';
  const currentHome = scriptEnv().LUSH_HOME;
  const defaultHome = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'lush');
  const removeAll = ['all', '--all', '-a'].includes(mode);

  const pids = daemonPids();
  if (pids.length === 0) {
    process.stdout.write('没有运行中的 daemon\n');
    return 0;
  }

  const doomed = [];
  let kept = 0;
  for (const pid of pids) {
    const home = cwdOf(pid);
    if (home === null) {
      process.stdout.write(`保留 pid=${pid}（读不到工作目录，不动）\n`);
      kept += 1;
    } else if (home === currentHome) {
      process.stdout.write(`保留 pid=${pid} home=${home}（当前 LUSH_HOME）\n`);
      kept += 1;
    } else if (home === defaultHome) {
      process.stdout.write(`保留 pid=${pid} home=${home}（默认 home）\n`);
      kept += 1;
    } else if (!fs.existsSync(home)) {
      process.stdout.write(`清理 pid=${pid} home=${home}（目录已消失）\n`);
      if (kill(pid)) doomed.push(pid);
    } else if (removeAll) {
      process.stdout.write(`清理 pid=${pid} home=${home}（临时 home；目录仍在，确认无用后自行删除）\n`);
      if (kill(pid)) doomed.push(pid);
    } else {
      process.stdout.write(`保留 pid=${pid} home=${home}（仍在，但不是当前/默认 home；bun run prune all 可清理）\n`);
      kept += 1;
    }
  }

  // Kill only requests termination: the single-instance lock is released when
  // the process is really gone, so wait for that before reporting success.
  let stuck = 0;
  for (const pid of doomed) {
    for (let i = 0; i < 50; i += 1) {
      if (!alive(pid)) break;
      Bun.sleepSync(100);
    }
    if (alive(pid)) {
      process.stdout.write(`警告：pid=${pid} 仍未退出（可能卡在 handler 里）\n`);
      stuck += 1;
    }
  }
  process.stdout.write(`已停止 ${doomed.length - stuck} 个，保留 ${kept} 个，未退出 ${stuck} 个\n`);
  return 0;
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    process.stdout.write('  kill 失败，跳过\n');
    return false;
  }
}
