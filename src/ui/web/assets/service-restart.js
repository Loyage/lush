import { api } from './api.js';
import { block, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { projectHref } from './route.js';
import { agentHelp } from './help.js';

// One foreground operation, including confirmation, across overview generations.
let restarting = false;
let paintCurrent = () => {};
const POST = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
const login = () => location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
const projectName = row => `${row.name || '未命名项目'}（${row.project || row.id}）`;
const online = row => row.running === true && !row.error;

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

/** Global overview controls. Project identities are explicit, never the current page's project. */
export function serviceRestartControls({ request = api, confirm = confirmDialog, recover = waitForHostRestart,
  reload = () => location.reload(), ownsPage = () => true, changed = async () => {} } = {}) {
  const root = block('服务重启'); root.classList.add('workbench-service-restart');
  root.append(el('p', '可先全部中断已登记的在线项目，等待调用安全退出后重启，再显式全部继续。中断与继续不自动重启服务、不启动离线项目；继续可能调用 Agent。项目后台也可在对应项目行独立重启。', 'settings-note'));
  const status = el('p', '正在读取界面服务状态…', 'settings-note');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', undefined, 'settings-runtime-actions');
  const entries = new Map();
  let host = null, projects = null;
  const pauseHelp = '暂停此 Host 已登记在线项目的新 Agent 调用，包括子 Worker；当前调用在安全点收尾，不强杀工具。维护暂停在后台重启后保留，不自动重启服务、不启动离线项目。';
  const resumeHelp = agentHelp('解除此 Host 已登记在线项目的维护暂停，只恢复本次影响的工作及待执行工作；原先单独暂停、待开始或失败的 Worker 不自动启动，父子等待关系保留。不启动离线项目。');
  const daemonHelp = '只安全重启此项目后台；存在活动 Agent、模型调用或 Git 工作时拒绝，不强杀、不取消 Worker，也不影响其他项目。';
  const hostHelp = '只重启当前界面服务，不停止任何项目后台；连接此 Host 的所有页面会短暂断开，可能需要重新登录。请先保存未发送的输入。';
  const allHelp = '重新读取并确认此 Host 已登记的在线项目，逐个安全重启后台，全部成功后才重启界面；遇到忙碌或失败立即停止并报告已完成部分。不启动离线项目，不自动重试；所有页面会短暂断开，可能需要重新登录，请先保存输入。';
  const unsupportedHelp = '当前界面宿主不支持按钮重启，请通过命令行重启 Host。';
  const wrap = (label, kind, help) => {
    const wrapper = el('span', undefined, 'help-host'); wrapper.setAttribute('data-help', help);
    const button = el('button', label, 'ghost'); button.type = 'button'; button.dataset.serviceRestart = kind;
    button.setAttribute('data-help', help); wrapper.append(button);
    return { wrapper, button };
  };
  const hostControl = wrap('重启界面服务', 'host', hostHelp);
  const allControl = wrap('全部重启', 'all', allHelp);
  const pauseControl = wrap('全部中断', 'pause', pauseHelp);
  const resumeControl = wrap('全部继续', 'resume', resumeHelp);
  resumeControl.button.className = 'agent-call';
  actions.append(pauseControl.wrapper, hostControl.wrapper, allControl.wrapper, resumeControl.wrapper); root.append(actions, status);
  const paint = () => {
    const unsupported = host?.restart_supported !== true;
    hostControl.button.disabled = allControl.button.disabled = restarting || unsupported;
    hostControl.wrapper.setAttribute('data-help', unsupported ? unsupportedHelp : hostHelp);
    allControl.wrapper.setAttribute('data-help', unsupported ? unsupportedHelp : allHelp);
    for (const [control, help] of [[pauseControl, pauseHelp], [resumeControl, resumeHelp]]) {
      const reason = restarting ? '正在处理后台控制请求，请稍候。' : !projects ? '尚未读取项目列表，请刷新项目状态后再操作。'
        : !projects.some(online) ? '没有已确认在线的项目；请显式启动或刷新状态，不会自动启动离线项目。' : null;
      control.button.disabled = Boolean(reason);
      control.wrapper.setAttribute('data-help', reason ? control === resumeControl ? agentHelp(reason) : reason : help);
      control.wrapper.tabIndex = reason ? 0 : -1;
    }
    for (const entry of entries.values()) {
      const unavailable = !entry.present || !online(entry.row);
      entry.button.disabled = restarting || unavailable;
      entry.wrapper.setAttribute('data-help', unavailable ? '此项目后台未运行、不可达或已移除；请显式启动或刷新确认状态后再重启。' : daemonHelp);
    }
  };
  paintCurrent = paint;
  const checkPage = () => { if (!ownsPage()) throw new Error('已离开后台总览；未继续执行后续操作。请回到总览核对状态。'); };
  const post = async (route, body = POST.body) => { checkPage(); return request(route, { ...POST, body, signal: AbortSignal.timeout(30000) }); };
  const run = async (target, entry = null) => {
    const maintenance = target === 'pause' || target === 'resume';
    const verb = target === 'pause' ? '中断' : '继续';
    if (!ownsPage() || restarting || (maintenance ? !projects?.some(online) : target !== 'daemon' && host?.restart_supported !== true)
      || (entry && (!entry.present || !online(entry.row)))) return;
    restarting = true; paint();
    const completed = [];
    let planned = [], current = null, hostAttempted = false;
    try {
      if (entry) planned = [{ ...entry.row }];
      else if (target === 'all' || maintenance) {
        // Read-only probe: freeze the visible, registered online scope before confirmation.
        const value = await request('/api/host/projects', { signal: AbortSignal.timeout(10000) });
        checkPage();
        if (!Array.isArray(value?.projects)) throw new Error('后台列表无效，未执行操作');
        const ids = new Set();
        planned = value.projects.filter(online).map(row => {
          projectHref(row.id); // Reject malformed identities before any mutation.
          if (ids.has(row.id)) throw new Error('后台列表包含重复项目，未执行操作');
          ids.add(row.id); return { ...row };
        });
      }
      if (maintenance && !planned.length) { status.textContent = '没有已确认在线的项目；未执行维护请求，不会启动离线项目。'; return; }
      const help = maintenance ? target === 'pause' ? pauseHelp : resumeHelp : target === 'all' ? allHelp : entry ? daemonHelp : hostHelp;
      const scope = planned.map(projectName).join('\n');
      const accepted = await confirm({ title: maintenance ? `全部${verb}？` : target === 'all' ? '全部重启？' : entry ? '重启项目后台？' : '重启界面服务？',
        message: `${help}${maintenance || target === 'all' ? ` 本次包含 ${planned.length} 个在线项目后台${maintenance ? '，不涉及界面服务' : '和当前界面服务'}；未运行或不可达的项目不在范围内，确认后新上线的项目也不加入。逐项提交，遇到失败停止后续操作，不自动重试。` : ''}`,
        detail: scope, confirmLabel: maintenance ? `全部${verb}` : '确认重启', confirmHelp: help, agent: target === 'resume' });
      if (!accepted) return;
      checkPage();
      status.className = 'settings-note';
      if (!maintenance && target !== 'daemon') {
        host = await request('/api/host', { signal: AbortSignal.timeout(4000) });
        checkPage();
        if (host.restart_supported !== true) throw new Error(unsupportedHelp);
      }
      for (const row of planned) {
        current = row;
        status.textContent = `正在${maintenance ? verb : '重启'} ${projectName(row)}…（已完成 ${completed.length}/${planned.length}）`;
        if (maintenance) await post(projectHref(row.id, '/api/action'), JSON.stringify({
          method: target === 'pause' ? 'system.interrupt_all' : 'system.resume_all', params: {},
        }));
        else await post(projectHref(row.id, '/api/service/restart'));
        completed.push(row); current = null;
      }
      if (maintenance || target === 'daemon') {
        status.textContent = maintenance ? `${completed.length} 个项目的全部${verb}请求已接受：${completed.map(projectName).join('、')}。${target === 'pause'
          ? '当前调用仍需安全收尾；可重启状态以后台检查为准，暂停在重启后保留。'
          : '只恢复本次影响的工作及待执行工作，仍按父子等待关系与安全门调度，不代表已经运行。'} 未重启任何服务。`
          : `${projectName(planned[0])} 后台已重启；其他项目与界面服务未重启。`;
        if (ownsPage()) {
          try { await changed(); }
          catch (error) { if (ownsPage()) status.textContent += ` 列表刷新失败：${error.message}；不要重复${maintenance ? '提交维护请求' : '重启'}。`; }
        }
      } else {
        status.textContent = `已完成 ${completed.length} 个项目后台重启，正在重启界面服务并等待恢复连接…`;
        hostAttempted = true;
        await post('/api/host/restart');
        if (await recover(host.pid) && ownsPage()) reload();
      }
    } catch (error) {
      // Never infer that a timed-out write did not happen; never retry a mutation.
      if (ownsPage()) {
        status.className = 'settings-error';
        const done = completed.length ? `已成功重启 ${completed.length} 个项目后台：${completed.map(projectName).join('、')}。` : '没有已确认成功的项目后台重启。';
        const failed = current ? `${projectName(current)} 重启失败或结果未确认；后续 ${planned.length - completed.length - 1} 个项目未执行，界面服务未重启。`
          : hostAttempted ? '界面服务重启或恢复失败／未确认。' : '未继续重启后续项目或界面服务。';
        status.textContent = maintenance
          ? `已接受 ${completed.length} 个项目的全部${verb}请求${completed.length ? `：${completed.map(projectName).join('、')}` : ''}。${current
            ? `${projectName(current)} 请求失败或结果未确认；后续 ${planned.length - completed.length - 1} 个项目未执行。`
            : '未继续提交后续请求。'} ${error.message} 未重启任何服务。请刷新核对状态，不自动重试或撤销已接受的请求。`
          : `${done} ${failed} ${error.message} 请核对状态后再操作，不要盲目重复重启已完成的后台。`;
      }
    } finally { restarting = false; paint(); paintCurrent(); }
  };
  hostControl.button.onclick = () => run('host'); allControl.button.onclick = () => run('all');
  pauseControl.button.onclick = () => run('pause'); resumeControl.button.onclick = () => run('resume');
  const projectControl = row => {
    projectHref(row.id);
    let entry = entries.get(row.id);
    if (!entry) {
      entry = { ...wrap('重启项目后台', 'daemon', daemonHelp), row, present: true };
      entry.button.dataset.projectId = row.id;
      entry.button.onclick = () => run('daemon', entry);
      entries.set(row.id, entry);
    }
    entry.row = row; entry.present = true; paint();
    entry.wrapper.remove(); return entry.wrapper;
  };
  const updateProjects = rows => {
    projects = rows;
    const latest = new Map(rows.map(row => [row.id, row]));
    for (const [id, entry] of entries) { entry.present = latest.has(id); if (entry.present) entry.row = latest.get(id); }
    paint();
  };
  paint();
  const ready = request('/api/host', { signal: AbortSignal.timeout(4000) }).then(value => {
    if (!ownsPage()) return;
    host = value;
    if (!restarting) status.textContent = host?.restart_supported === true ? '重启前会确认项目与界面影响范围；后台忙碌时拒绝，不强杀。' : unsupportedHelp;
    paint();
  }).catch(error => {
    if (!ownsPage()) return;
    if (!restarting) { status.className = 'settings-error'; status.textContent = `无法读取界面服务状态：${error.message}`; }
    paint();
  });
  return { root, projectControl, updateProjects, ready };
}
