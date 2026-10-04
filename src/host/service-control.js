import { UIClient } from '../ui/client.js';
import { daemon } from '../cli/daemon.js';
import { isLocked } from '../daemon/locking.js';
import { check } from '../core/types.js';

// Shared by every Host in this process: start, stop and restart cannot overlap.
const controlling = new Set();
async function control(config, action) {
  check(!controlling.has(config.project), '项目后台正在启动、停止或重启，请稍后再试');
  controlling.add(config.project);
  try { return await action(); }
  finally { controlling.delete(config.project); }
}
async function waitForExit(config) {
  const deadline = Date.now() + 15000;
  while (isLocked(config.home) && Date.now() < deadline) await Bun.sleep(30);
  check(!isLocked(config.home), `项目后台尚未退出；未强制停止。请检查 ${config.home}/daemon.log`);
}

/** Explicit user open/start, never called by background reads. */
export function startProjectDaemon(config) {
  return control(config, () => daemon(config, 'start'));
}

/** Never force-stop or cancel work: admission is decided atomically by lushd. */
export function stopProjectDaemon(config) {
  return control(config, async () => {
    if (!isLocked(config.home)) return { stopped: true, already_stopped: true, project: config.project };
    const client = new UIClient(config);
    const before = await client.request('system.status');
    check(before.project === config.project, 'daemon belongs to another project');
    await client.request('system.stop_if_idle');
    await waitForExit(config);
    return { stopped: true, project: config.project };
  });
}

/** Never force-stop: idle admission is decided atomically by the project daemon. */
export function restartProjectDaemon(config) {
  return control(config, async () => {
    const client = new UIClient(config);
    const before = await client.request('system.status');
    check(before.project === config.project, 'daemon belongs to another project');
    await client.request('system.stop_if_idle');
    await waitForExit(config);
    const status = await daemon(config, 'start');
    check(status.project === config.project && status.pid !== before.pid, '项目后台没有完成重启，请检查 daemon 日志');
    return { restarted: true, project: status.project, pid: status.pid };
  });
}
