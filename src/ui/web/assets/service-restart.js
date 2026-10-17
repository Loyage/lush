import { api } from './api.js';
import { block, el } from './dom.js';
import { confirmDialog } from './dialog.js';
import { projectHref } from './route.js';
import { agentHelp } from './help.js';
import { readPref } from './prefs.js';
import { safeRestartFlow, safeRestartHelp } from './safe-restart-flow.js';
import { QUICK_ACTIONS, DEFAULT_QUICK_ACTION_BUTTONS, normalizeQuickActionButtons } from '../../../shared/dashboard-quick-actions.js';

// One foreground operation, including confirmation, across overview generations.
let restarting = false;
const painters = new Set();
const paintAll = () => { for (const paint of painters) paint(); };
const POST = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
const login = () => location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
const projectName = row => `${row.name || '未命名项目'}（${row.project || row.id}）`;
const online = row => row.running === true && !row.error;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const validBatch = value => value && typeof value.paused === 'boolean' && typeof value.ready_to_restart === 'boolean'
  && ['running', 'pausing', 'paused'].includes(value.phase) && uuid(value.batch_id)
  && ['pending', 'completed', 'cancelled', 'unknown'].includes(value.completion_state)
  && (value.notify_completion === undefined || typeof value.notify_completion === 'boolean')
  && (value.completion_state === 'completed'
    ? value.notify_completion === false ? value.completion_notice_id === null : positiveId(value.completion_notice_id)
    : value.completion_notice_id === null);

// ACKs identify accepted batches only. Readiness always comes from a fresh source observation.
function sourceRows(planned, rows) {
  if (!Array.isArray(rows)) throw new Error('项目状态读面无效');
  const latest = new Map();
  for (const row of rows) {
    if (latest.has(row.id)) throw new Error('项目状态包含重复身份');
    latest.set(row.id, row);
  }
  for (const row of planned) {
    const source = latest.get(row.id);
    if (!source || typeof row.project !== 'string' || !row.project || source.project !== row.project || !online(source)) {
      throw new Error(`${projectName(row)} 已移除、路径变化或不可达`);
    }
  }
  return latest;
}
function observeBatch(batch, rows) {
  const latest = sourceRows(batch.planned, rows);
  let ready = 0;
  for (const { row, ack } of batch.accepted) {
    const maintenance = latest.get(row.id).summary?.maintenance;
    if (!validBatch(maintenance)) throw new Error(`${projectName(row)} 缺少有效批次字段（旧后台或状态未知）`);
    if (!maintenance.paused || maintenance.batch_id !== ack.batch_id
      || ['cancelled', 'unknown'].includes(maintenance.completion_state)) throw new Error(`${projectName(row)} 批次已变化、撤销或结果未知`);
    if (maintenance.completion_state === 'completed' && maintenance.ready_to_restart) ready++;
  }
  return ready;
}

// Host probes are deliberately unprefixed, and every request as well as the entire recovery is bounded.
export async function waitForHostRestart(pid, { fetchHost = () => fetch('/api/host', { signal: AbortSignal.timeout(2000) }),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, loginRequired = login, timeout = 45000, signal } = {}) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    signal?.throwIfAborted();
    await sleep(500);
    signal?.throwIfAborted();
    try {
      const response = await fetchHost();
      signal?.throwIfAborted();
      if (response.status === 401) { loginRequired(); return false; }
      if (!response.ok) continue;
      const host = await response.json();
      if (host.pid && host.pid !== pid) return true;
    } catch { /* Expected while the old listener exits and its replacement starts. */ }
  }
  throw new Error('界面服务尚未恢复。请稍后刷新；若仍无法连接，请检查 Host 日志。');
}

/** Global overview controls. Project identities are explicit, never the current page's project. */
export function serviceRestartControls({ mode = 'management', buttons = DEFAULT_QUICK_ACTION_BUTTONS, canAct = () => true, request = api, confirm = confirmDialog, recover = waitForHostRestart,
  reload = () => location.reload(), ownsPage = () => true, changed = async () => {},
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id), now = Date.now,
  observationTimeout = 15 * 60 * 1000 } = {}) {
  if (!['management', 'quick_actions'].includes(mode)) throw new TypeError('invalid restart controls mode');
  const quick = mode === 'quick_actions';
  let selected = normalizeQuickActionButtons(buttons);
  const root = quick ? el('div', undefined, 'dashboard-quick-actions-controls') : block('服务重启');
  if (!quick) {
    root.classList.add('workbench-service-restart');
    root.append(el('p', '独立重启界面或展开手动维护；一键安全重启已移至全局总览的快捷操作卡片。', 'settings-note'));
  }
  const status = el('p', '正在读取界面服务状态…', 'settings-note');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', undefined, 'settings-runtime-actions');
  const entries = new Map();
  let host = null, projects = null, disposed = false, batch = null, timer = null, probe = null, epoch = 0;
  let observing = false, reading = false, statusTouched = false, operationScope = null, observationRead = null;
  const lifetime = new AbortController();
  const active = () => !disposed && ownsPage();
  const stopObservation = () => {
    ++epoch; observing = false;
    if (timer !== null) unschedule(timer);
    timer = null; probe?.abort(); probe = null;
  };
  const dispose = () => { disposed = true; lifetime.abort(); stopObservation(); painters.delete(paint); globalThis.removeEventListener?.('pagehide', dispose); };
  globalThis.addEventListener?.('pagehide', dispose);
  const stopped = reason => {
    stopObservation();
    if (!active()) return;
    status.className = 'settings-error'; status.setAttribute('aria-live', 'polite');
    status.textContent = `本次全部中断观测已停止：${reason}。不能确认全部安全中断且可重启；已接受 ${batch?.accepted.length || 0}/${batch?.planned.length || 0} 个项目的请求仍保留，不自动重试、继续或重启。请刷新核对来源项目；页面关闭后不承诺推送，来源项目告知可留存。`;
  };
  const paintObservation = ready => {
    const complete = ready === batch.planned.length;
    // Muting reminders does not hide the operation's factual status or mutate source Notices.
    const remind = readPref('noticeChannels').idle?.banner !== false;
    status.className = complete && remind ? 'settings-note maintenance-ready' : 'settings-note';
    status.setAttribute('aria-live', remind ? 'polite' : 'off');
    // Do not announce an unchanged completion every two seconds.
    if (complete && batch.readyCount !== ready) batch.readyObservedAt = now();
    batch.readyCount = ready;
    const scope = `固定范围：${batch.planned.map(projectName).join('、')}。`;
    const message = complete
      ? `本次固定范围 ${ready} 个项目已全部安全中断，当前观测可重启。重启按钮仍会重新检查；未自动重启、继续或写入。首次就绪观测 ${new Date(batch.readyObservedAt).toLocaleTimeString()}。${scope}`
      : `本次 ${batch.accepted.length} 个项目的中断请求已接受；仍需安全收尾或等待后台工作退出，当前 ${ready}/${batch.planned.length} 个项目安全中断且可重启。未重启任何服务。${scope}`;
    if (status.textContent !== message) status.textContent = message;
  };
  const poll = async generation => {
    if (generation !== epoch) return;
    timer = null;
    if (!active()) { stopObservation(); return; }
    if (now() >= batch.deadline) { stopped('有界观测已超时，请显式刷新核对'); return; }
    // Even an aborted transport that settles late must not overlap another source probe.
    if (reading) { timer = schedule(() => poll(generation), 2000); return; }
    const controller = new AbortController(); probe = controller; reading = true;
    try {
      observationRead = request('/api/host/projects', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const value = await observationRead;
      if (generation !== epoch || !active()) return;
      if (now() >= batch.deadline) { stopped('有界观测已超时，请显式刷新核对'); return; }
      paintObservation(observeBatch(batch, value?.projects));
    } catch (error) {
      if (generation === epoch && active()) stopped(error.message);
      return;
    } finally { reading = false; observationRead = null; if (probe === controller) probe = null; }
    if (generation === epoch && active()) timer = schedule(() => poll(generation), 2000);
  };
  const startObservation = () => {
    stopObservation(); observing = true; batch.deadline = now() + observationTimeout;
    const generation = epoch;
    timer = schedule(() => poll(generation), 0);
  };
  const pauseHelp = '暂停此 Host 已登记在线项目的新 Agent 调用，包括子 Worker；当前调用在安全点收尾，不强杀工具。保存本次项目批次并只读等待就绪提醒，旧后台或部分失败不能确认全部完成。维护暂停在后台重启后保留，不自动重启服务、不启动离线项目。';
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
  let safeControl = null;
  const hostControl = quick ? null : wrap('重启界面服务', 'host', hostHelp);
  let allControl = quick ? null : wrap('全部重启', 'all', allHelp);
  let pauseControl = quick ? null : wrap('全部中断', 'pause', pauseHelp);
  let resumeControl = quick ? null : wrap('全部继续', 'resume', resumeHelp);
  const quickControls = new Map();
  if (quick) root.append(actions, status);
  else {
    resumeControl.button.className = 'agent-call'; actions.append(hostControl.wrapper);
    const manual = el('details', undefined, 'settings-runtime-manual');
    manual.append(el('summary', '手动维护'));
    const manualActions = el('div', undefined, 'settings-runtime-actions');
    manualActions.append(pauseControl.wrapper, allControl.wrapper, resumeControl.wrapper); manual.append(manualActions);
    root.append(actions, manual, status);
  }
  const paint = () => {
    const unsupported = host?.restart_supported !== true;
    const blocked = !canAct();
    for (const control of [hostControl, allControl, safeControl].filter(Boolean)) {
      control.button.disabled = restarting || unsupported || blocked;
      const reason = blocked ? '请先保存或取消编辑，再开始维护操作。' : restarting ? '正在处理后台控制请求，请稍候。' : unsupported ? unsupportedHelp : null;
      const help = control === safeControl ? safeRestartHelp : control === hostControl ? hostHelp : allHelp;
      control.wrapper.setAttribute('data-help', reason ? control === safeControl ? agentHelp(reason) : reason : help);
      control.wrapper.tabIndex = reason ? 0 : -1;
    }
    for (const [control, help] of [[pauseControl, pauseHelp], [resumeControl, resumeHelp]].filter(([control]) => control)) {
      const reason = blocked ? '请先保存或取消编辑，再开始维护操作。' : restarting ? '正在处理后台控制请求，请稍候。' : !projects ? '尚未读取项目列表，请刷新项目状态后再操作。'
        : !projects.some(online) ? '没有已确认在线的项目；请显式启动或刷新状态，不会自动启动离线项目。' : null;
      control.button.disabled = Boolean(reason);
      control.wrapper.setAttribute('data-help', reason ? control === resumeControl ? agentHelp(reason) : reason : help);
      control.wrapper.tabIndex = reason ? 0 : -1;
    }
    for (const entry of entries.values()) {
      const unavailable = !entry.present || !online(entry.row);
      entry.button.disabled = restarting || unavailable || blocked;
      entry.wrapper.setAttribute('data-help', unavailable ? '此项目后台未运行、不可达或已移除；请显式启动或刷新确认状态后再重启。' : daemonHelp);
    }
  };
  painters.add(paint);
  const checkPage = () => {
    if (!active()) throw new Error('已离开维护入口；未继续执行后续操作。已发送的请求仍可能生效，请核对来源状态。');
    if (operationScope) sourceRows(operationScope, projects);
  };
  const post = async (route, body = POST.body) => { checkPage(); return request(route, { ...POST, body, signal: AbortSignal.timeout(30000) }); };
  const run = async (target, entry = null) => {
    const maintenance = target === 'pause' || target === 'resume';
    const verb = target === 'pause' ? '中断' : '继续';
    if (quick && !QUICK_ACTIONS.some(item => selected.includes(item.id) && item.service === target)) return;
    if (!active() || !canAct() || restarting || (maintenance ? !projects?.some(online) : target !== 'daemon' && host?.restart_supported !== true)
      || (entry && (!entry.present || !online(entry.row)))) return;
    restarting = true; paintAll();
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
          if (maintenance && (typeof row.project !== 'string' || !row.project)) throw new Error('项目路径身份缺失，未执行维护操作');
          ids.add(row.id); return { ...row };
        });
        projects = value.projects; paint();
      }
      if (maintenance && !planned.length) { status.textContent = '没有已确认在线的项目；未执行维护请求，不会启动离线项目。'; return; }
      const help = maintenance ? target === 'pause' ? pauseHelp : resumeHelp : target === 'all' ? allHelp : entry ? daemonHelp : hostHelp;
      const scope = planned.map(projectName).join('\n');
      const accepted = await confirm({ title: maintenance ? `全部${verb}？` : target === 'all' ? '全部重启？' : entry ? '重启项目后台？' : '重启界面服务？',
        message: `${help}${maintenance || target === 'all' ? ` 本次包含 ${planned.length} 个在线项目后台${maintenance ? '，不涉及界面服务' : '和当前界面服务'}；未运行或不可达的项目不在范围内，确认后新上线的项目也不加入。逐项提交，遇到失败停止后续操作，不自动重试。` : ''}`,
        detail: scope, confirmLabel: maintenance ? `全部${verb}` : '确认重启', confirmHelp: help, agent: target === 'resume' });
      if (!accepted || !canAct() || quick && !QUICK_ACTIONS.some(item => selected.includes(item.id) && item.service === target)) return;
      checkPage();
      stopObservation(); statusTouched = true;
      batch = target === 'pause' ? { planned, accepted: [], deadline: null } : null;
      operationScope = maintenance ? planned : null;
      status.className = 'settings-note'; status.setAttribute('aria-live', 'polite');
      if (!maintenance && target !== 'daemon') {
        host = await request('/api/host', { signal: AbortSignal.timeout(4000) });
        checkPage();
        if (host.restart_supported !== true) throw new Error(unsupportedHelp);
      }
      for (const row of planned) {
        checkPage(); current = row;
        status.textContent = `正在${maintenance ? verb : '重启'} ${projectName(row)}…（已完成 ${completed.length}/${planned.length}）`;
        if (maintenance) {
          const ack = await post(projectHref(row.id, '/api/action'), JSON.stringify({
            method: target === 'pause' ? 'system.interrupt_all' : 'system.resume_all', params: {},
          }));
          completed.push(row); current = null;
          if (target === 'pause') {
            // Keep every accepted result, including malformed/unknown ACKs. Never retry it.
            batch.accepted.push({ row, ack: ack && typeof ack === 'object' ? { ...ack } : ack });
            if (!validBatch(ack) || !ack.paused || ['cancelled', 'unknown'].includes(ack.completion_state)) {
              throw new Error(`${projectName(row)} 已接受请求但缺少可观测批次或结果未知，停止后续提交`);
            }
          }
        } else { await post(projectHref(row.id, '/api/service/restart')); completed.push(row); current = null; }
      }
      if (maintenance || target === 'daemon') {
        status.textContent = maintenance ? `${completed.length} 个项目的全部${verb}请求已接受：${completed.map(projectName).join('、')}。${target === 'pause'
          ? '当前调用仍需安全收尾；可重启状态以后台检查为准，暂停在重启后保留。'
          : '只恢复本次影响的工作及待执行工作，仍按父子等待关系与安全门调度，不代表已经运行。'} 未重启任何服务。`
          : `${projectName(planned[0])} 后台已重启；其他项目与界面服务未重启。`;
        if (active()) {
          try { await changed(); }
          catch (error) { if (active()) status.textContent += ` 列表刷新失败：${error.message}；不要重复${maintenance ? '提交维护请求' : '重启'}。`; }
          if (target === 'pause' && active()) startObservation();
        }
      } else {
        status.textContent = `已完成 ${completed.length} 个项目后台重启，正在重启界面服务并等待恢复连接…`;
        hostAttempted = true;
        await post('/api/host/restart');
        if (await recover(host.pid) && active()) reload();
      }
    } catch (error) {
      // Never infer that a timed-out write did not happen; never retry a mutation.
      stopObservation();
      if (active()) {
        statusTouched = true; status.className = 'settings-error';
        const done = completed.length ? `已成功重启 ${completed.length} 个项目后台：${completed.map(projectName).join('、')}。` : '没有已确认成功的项目后台重启。';
        const failed = current ? `${projectName(current)} 重启失败或结果未确认；后续 ${planned.length - completed.length - 1} 个项目未执行，界面服务未重启。`
          : hostAttempted ? '界面服务重启或恢复失败／未确认。' : '未继续重启后续项目或界面服务。';
        status.textContent = maintenance
          ? `已接受 ${completed.length} 个项目的全部${verb}请求${completed.length ? `：${completed.map(projectName).join('、')}` : ''}。${current
            ? `${projectName(current)} 请求失败或结果未确认；后续 ${planned.length - completed.length - 1} 个项目未执行。`
            : `后续 ${planned.length - completed.length} 个项目未执行。`} ${error.message} 未重启任何服务。${target === 'pause' ? '不能确认全部安全中断且可重启，' : ''}请刷新核对状态，不自动重试或撤销已接受的请求。`
          : `${done} ${failed} ${error.message} 请核对状态后再操作，不要盲目重复重启已完成的后台。`;
      }
    } finally { operationScope = null; restarting = false; paintAll(); }
  };
  const runSafe = async () => {
    if (!selected.includes('safe_restart') || !active() || !canAct() || restarting || host?.restart_supported !== true) return;
    restarting = true; paintAll(); stopObservation(); statusTouched = true;
    try {
      const result = await safeRestartFlow({
        request: async (route, options) => {
          // An aborted manual observer must settle before the next source probe starts.
          if (route === '/api/host/projects' && observationRead) await observationRead.catch(() => {});
          options.signal.throwIfAborted(); checkPage();
          const value = await request(route, options);
          if (active() && !options.signal.aborted && route === '/api/host/projects' && Array.isArray(value?.projects)) projects = value.projects;
          return value;
        }, confirm: async options => {
          const accepted = await confirm(options);
          return accepted && active() && canAct() && selected.includes('safe_restart');
        }, checkPage, signal: lifetime.signal, recover, reload, now, schedule, unschedule, observationTimeout,
        onScope: rows => { operationScope = rows; },
        progress: message => { if (active()) { status.className = 'settings-note'; status.textContent = message; } },
      });
      if (active()) {
        status.className = result.error ? 'settings-error' : 'settings-note';
        status.textContent = result.cancelled ? '一键安全重启已取消，未执行本次写入；此前已接受的维护请求保留，旧观测已停止，请刷新核对来源状态。' : result.message;
      }
    } catch (error) {
      if (active()) { status.className = 'settings-error'; status.textContent = `一键安全重启失败／结果未确认：${error.message}。已发送请求仍可能生效，请核对来源状态，不自动重试或撤销。`; }
    } finally { operationScope = null; restarting = false; paintAll(); }
  };
  if (!quick) {
    hostControl.button.onclick = () => run('host'); allControl.button.onclick = () => run('all');
    pauseControl.button.onclick = () => run('pause'); resumeControl.button.onclick = () => run('resume');
  }
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
    // Explicit list refresh invalidates a stale ready banner; it never starts a new write or observation.
    if (observing && batch && active()) {
      // A newer explicit refresh supersedes an in-flight probe, even if its response arrives later.
      stopObservation();
      try {
        if (now() >= batch.deadline) throw new Error('有界观测已超时，请显式刷新核对');
        paintObservation(observeBatch(batch, rows));
        observing = true;
        const generation = epoch;
        timer = schedule(() => poll(generation), 2000);
      } catch (error) { stopped(error.message); }
    }
  };
  function setButtons(next) {
    if (!quick) return;
    selected = normalizeQuickActionButtons(next);
    for (const [id, control] of quickControls) if (!selected.includes(id)) { control.wrapper.remove(); quickControls.delete(id); }
    for (const item of QUICK_ACTIONS.filter(item => item.service && selected.includes(item.id))) {
      if (quickControls.has(item.id)) continue;
      const help = { safe: safeRestartHelp, pause: pauseHelp, resume: resumeHelp, all: allHelp }[item.service];
      const control = wrap(item.label, item.service, help);
      if (['safe', 'resume'].includes(item.service)) control.button.className = 'agent-call';
      control.button.onclick = item.service === 'safe' ? runSafe : () => run(item.service);
      control.wrapper.dataset.quickAction = item.id; quickControls.set(item.id, control);
    }
    safeControl = quickControls.get('safe_restart'); allControl = quickControls.get('restart_all');
    pauseControl = quickControls.get('interrupt_all'); resumeControl = quickControls.get('resume_all');
    actions.replaceChildren(...QUICK_ACTIONS.flatMap(item => quickControls.has(item.id) ? [quickControls.get(item.id).wrapper] : []));
    status.hidden = !quickControls.size && !statusTouched;
    paint();
  }
  if (quick) setButtons(selected);
  paint();
  const ready = request('/api/host', { signal: AbortSignal.timeout(4000) }).then(value => {
    if (!active()) return;
    host = value;
    if (!restarting && !statusTouched) status.textContent = host?.restart_supported === true ? '重启前会确认项目与界面影响范围；后台忙碌时拒绝，不强杀。' : unsupportedHelp;
    paint();
  }).catch(error => {
    if (!active()) return;
    if (!restarting && !statusTouched) { status.className = 'settings-error'; status.textContent = `无法读取界面服务状态：${error.message}`; }
    paint();
  });
  return { root, actions, status, updateProjects, ready, dispose, sync: paint, setButtons,
    ...(quick ? {} : { projectControl }) };
}
