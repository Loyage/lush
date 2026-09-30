import { UIClient } from '../ui/client.js';
import { daemon } from '../cli/daemon.js';
import { isLocked } from '../daemon/locking.js';
import { check } from '../core/types.js';

const restarting = new Set();
/** Never force-stop: idle admission is decided atomically by the project daemon. */
export async function restartProjectDaemon(config) {
  check(!restarting.has(config.project), '项目后台已经在重启，请稍后再试');
  restarting.add(config.project);
  try {
    const client = new UIClient(config);
    const before = await client.request('system.status');
    check(before.project === config.project, 'daemon belongs to another project');
    await client.request('system.stop_if_idle');
    const deadline = Date.now() + 15000;
    while (isLocked(config.home) && Date.now() < deadline) await Bun.sleep(30);
    check(!isLocked(config.home), `项目后台尚未退出；未强制停止。请检查 ${config.home}/daemon.log`);
    const status = await daemon(config, 'start');
    check(status.project === config.project && status.pid !== before.pid, '项目后台没有完成重启，请检查 daemon 日志');
    return { restarted: true, project: status.project, pid: status.pid };
  } finally { restarting.delete(config.project); }
}
