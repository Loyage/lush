import { api } from './api.js';
import { block, el } from './dom.js';
import { confirmDialog } from './dialog.js';

let restarting = false;
const POST = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
const login = () => location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);

// Host probes are deliberately unprefixed, and every request as well as the entire recovery is bounded.
export async function waitForHostRestart(pid, { fetchHost = () => fetch('/api/host', { signal: AbortSignal.timeout(2000) }),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, loginRequired = login, timeout = 45000 } = {}) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    await sleep(500);
    try {
      const response = await fetchHost();
      if (response.status === 401) { loginRequired(); return false; }
      if (!response.ok) continue;
      const host = await response.json();
      if (host.pid && host.pid !== pid) return true;
    } catch { /* Expected while the old listener exits and its replacement starts. */ }
  }
  throw new Error('界面服务尚未恢复。请稍后刷新；若仍无法连接，请检查 Host 日志。');
}

export function serviceRestartControls({ request = api, confirm = confirmDialog, recover = waitForHostRestart,
  reload = () => location.reload() } = {}) {
  const section = block('服务重启');
  section.append(el('p', '项目后台与界面服务独立运行。重启不会调用 Agent；界面服务重启会断开连接它的所有页面，但不会停止项目后台。', 'settings-note'));
  const status = el('p', '正在读取界面服务状态…', 'settings-note');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', undefined, 'settings-runtime-actions');
  let host = null;
  let busy = false;
  const daemonHelp = '只重启当前项目后台；存在活动 Agent、模型调用或 Git 工作时拒绝重启，请先结束相关 Worker。';
  const hostHelp = '重启当前 Web/桌面界面服务，所有连接它的页面会短暂断开；不停止任何项目后台，登录会话可能失效。';
  const daemonWrap = el('span', undefined, 'help-host'); daemonWrap.setAttribute('data-help', daemonHelp);
  const hostWrap = el('span', undefined, 'help-host'); hostWrap.setAttribute('data-help', hostHelp);
  const paint = () => {
    daemonButton.disabled = busy || restarting;
    hostButton.disabled = busy || restarting || host?.restart_supported !== true;
  };
  const run = async target => {
    if (busy || restarting || (target === 'host' && host?.restart_supported !== true)) return;
    busy = true; paint();
    try {
      const isHost = target === 'host';
      const accepted = await confirm({ title: isHost ? '重启界面服务？' : '重启当前项目后台？',
        message: isHost ? hostHelp : `${daemonHelp} 静息 Worker、代码和历史记录保留。`,
        confirmLabel: '确认重启', confirmHelp: isHost ? hostHelp : daemonHelp });
      if (!accepted) return;
      restarting = true; paint();
      status.className = 'settings-note';
      status.textContent = isHost ? '正在重启界面服务，等待恢复连接…' : '正在重启当前项目后台…';
      // Read the current worker identity just before issuing its restart; never rely on a stale settings snapshot.
      if (isHost) host = await request('/api/host', { signal: AbortSignal.timeout(4000) });
      await request(isHost ? '/api/host/restart' : '/api/service/restart', { ...POST, signal: AbortSignal.timeout(30000) });
      if (!isHost || await recover(host.pid)) reload();
    } catch (error) {
      status.className = 'settings-error'; status.textContent = error.message;
    } finally { busy = false; restarting = false; paint(); }
  };
  const daemonButton = el('button', '重启项目后台', 'ghost'); daemonButton.type = 'button';
  daemonButton.onclick = () => run('daemon'); daemonButton.setAttribute('data-help', daemonHelp);
  daemonButton.dataset.serviceRestart = 'daemon';
  const hostButton = el('button', '重启界面服务', 'ghost'); hostButton.type = 'button';
  hostButton.onclick = () => run('host'); hostButton.setAttribute('data-help', hostHelp);
  hostButton.dataset.serviceRestart = 'host';
  daemonWrap.append(daemonButton); hostWrap.append(hostButton);
  actions.append(daemonWrap, hostWrap); section.append(actions, status); paint();
  request('/api/host', { signal: AbortSignal.timeout(4000) }).then(value => {
    host = value;
    if (host.restart_supported !== true) hostWrap.setAttribute('data-help', '当前界面宿主不支持按钮重启，请通过命令行重启 Host。');
    if (!busy) status.textContent = host.restart_supported === true ? '重启前会再次确认操作范围。' : '当前界面宿主不支持按钮重启，请通过命令行重启 Host。';
    paint();
  }).catch(error => {
    if (!busy) { status.className = 'settings-error'; status.textContent = `无法读取界面服务状态：${error.message}`; }
    paint();
  });
  return section;
}
