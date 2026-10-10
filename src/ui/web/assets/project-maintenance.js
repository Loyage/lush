import { $, el } from './dom.js';
import { action } from './api.js';
import { confirmDialog } from './dialog.js';
import { agentHelp } from './help.js';
import { show } from './messages.js';
import { refresh } from './navigate.js';
import { projectRoute } from './route.js';

const states = new WeakMap();
const PAUSE_HELP = '只中断当前项目：包括子 Worker，在安全点收尾，不强杀工具；维护暂停在后台重启后保留，直到点击全部继续。';
const RESUME_HELP = agentHelp('解除当前项目维护暂停，只恢复本次影响的工作；原先单独暂停、待开始或失败的 Worker 不自动启动。等待子 Worker 的父级仍按原关系等待。');
const count = value => Number.isSafeInteger(value) && value >= 0;
export function validMaintenance(value) {
  return value?.version === 1 && typeof value.paused === 'boolean'
    && ['running', 'pausing', 'paused'].includes(value.phase)
    && typeof value.ready_to_restart === 'boolean'
    && ['active_calls', 'pending_operations', 'affected_count'].every(key => count(value[key]))
    && Array.isArray(value.blockers) && value.blockers.every(reason => typeof reason === 'string');
}
function owns(host, state) {
  return $('project-maintenance') === host && states.get(host) === state && projectRoute() === state.project;
}
function stateFor(host) {
  let state = states.get(host);
  if (state?.project === projectRoute()) return state;
  state = { project: projectRoute(), model: null, offline: false, busy: false, pending: null };
  states.set(host, state);
  const copy = el('div', undefined, 'project-maintenance-copy');
  copy.setAttribute('role', 'status'); copy.setAttribute('aria-live', 'polite');
  state.title = el('strong'); state.note = el('p'); copy.append(state.title, state.note);
  const controls = el('div', undefined, 'project-maintenance-actions');
  for (const [key, label, help] of [['pause', '全部中断', PAUSE_HELP], ['resume', '全部继续', RESUME_HELP]]) {
    const control = el('button', label, key === 'resume' ? 'agent-call' : 'ghost'); control.type = 'button';
    control.setAttribute('data-help', help);
    control.onclick = () => change(host, state, key);
    const wrapper = el('span', undefined, 'help-host'); wrapper.append(control); controls.append(wrapper);
    state[key] = control; state[`${key}Host`] = wrapper;
  }
  host.replaceChildren(copy, controls);
  return state;
}
function paint(host, state) {
  host.hidden = !state.project;
  if (host.hidden) return;
  const model = state.model;
  const unavailable = state.offline ? '当前项目后台不可达，维护状态未确认；不能据旧状态判断可重启。'
    : !model ? '尚未读取到维护状态，或当前后台版本不支持；请刷新或更新后台后再操作。' : null;
  if (unavailable) {
    state.title.textContent = state.offline ? '当前项目离线 · 维护状态未确认' : '当前项目维护控制暂不可用';
    state.note.textContent = unavailable;
  } else {
    state.title.textContent = !model.paused ? '当前项目运行开放'
      : model.phase === 'pausing' ? '全部中断请求中 · 等待安全退出' : '当前项目维护暂停';
    const readiness = model.ready_to_restart ? '当前可重启（后台仍会重新检查）' : '尚不可重启';
    const counts = `活动调用 ${model.active_calls} · 后台操作 ${model.pending_operations}`;
    const reasons = model.blockers.length ? ` · ${model.blockers.join('；')}` : '';
    state.note.textContent = `${readiness} · ${counts}${reasons}${model.paused ? '。重启后仍保持暂停；全部继续保留父子等待关系。' : ''}`;
  }
  host.dataset.phase = unavailable ? 'unknown' : model.phase;
  host.setAttribute('aria-busy', String(state.busy));
  for (const key of ['pause', 'resume']) {
    const reason = state.busy ? '正在处理维护请求，请稍候。' : unavailable
      || (key === 'pause' && model.paused ? '当前项目已经处于维护暂停；现有调用仍会安全收尾。'
        : key === 'resume' && !model.paused ? '当前项目没有维护暂停；不会启动原先单独暂停的 Worker。' : null);
    state[key].disabled = Boolean(reason);
    const wrapper = state[`${key}Host`]; wrapper.tabIndex = reason ? 0 : -1;
    if (reason) wrapper.setAttribute('data-help', key === 'resume' ? agentHelp(reason) : reason);
    else wrapper.removeAttribute('data-help');
  }
}
/** Reuse only this small shell region; polling must not replace editor or composer nodes. */
export function renderProjectMaintenance(model, { offline = false } = {}) {
  const host = $('project-maintenance'); if (!host) return;
  const state = stateFor(host);
  state.offline = offline;
  const next = validMaintenance(model) ? model : null;
  if (state.busy) state.pending = { model: next, offline };
  else state.model = next;
  paint(host, state);
}
/** boot owns the generation: a response from an old boot cannot mutate the new shell. */
export function resetProjectMaintenance() {
  const host = $('project-maintenance'); if (!host) return;
  states.delete(host); renderProjectMaintenance(null);
}
async function change(host, state, key) {
  if (!state.project || !owns(host, state) || state.busy || state[key].disabled) return;
  state.busy = true; state.pending = null; paint(host, state);
  let acknowledged = false, attempted = false;
  try {
    if (key === 'pause') {
      const accepted = await confirmDialog({ title: '全部中断当前项目？',
        message: '暂停当前项目的新 Agent 调用，包括子 Worker 和管理 Agent；当前调用在安全点收尾，不强杀工具，不影响其他项目。',
        detail: 'Pi 等本轮工具结束，其他后端等当前调用自然结束。\n消息与工作现场保留；父子 Worker 的等待关系不改变。\n后台重启后仍保持维护暂停，需显式点击“全部继续”。\n只有实际调用和后台操作都退出后才能重启；此按钮不会自动重启后台或界面。',
        confirmLabel: '全部中断', cancelLabel: '取消', confirmHelp: PAUSE_HELP });
      if (!accepted || !owns(host, state) || state.offline || !state.model || (state.pending && !state.pending.model)) return;
    }
    attempted = true;
    const result = await action(key === 'pause' ? 'system.interrupt_all' : 'system.resume_all', {}, { refresh: false });
    if (!owns(host, state)) return;
    acknowledged = true;
    state.model = validMaintenance(result) ? result : null;
    // Pre-ACK polling responses must not replace the newly acknowledged state.
    state.pending = null; paint(host, state);
    show(key === 'pause' ? '全部中断请求已接受；当前调用仍需安全收尾，可重启状态以后台检查为准。'
      : '全部继续请求已接受；只恢复本次影响的工作，仍按父子等待关系与安全门调度，不代表已经运行。');
  } catch (error) {
    if (owns(host, state)) show(`维护请求未确认：${error.message}；请读取当前状态后再操作。`, 'error');
  } finally {
    if (owns(host, state)) {
      // Read failures never resend a confirmed mutation. Force-refresh queues behind older polling reads.
      if (attempted) {
        try { await refresh(); }
        catch (error) { if (owns(host, state)) {
          state.pending = null; state.offline = true;
          show(`${acknowledged ? '维护请求已接受，但' : '维护请求未确认，且'}状态刷新失败：${error.message}；不会自动重发请求。`, 'error');
        } }
      }
      state.busy = false;
      if (owns(host, state)) {
        if (state.pending) { state.model = state.pending.model; state.offline = state.pending.offline; state.pending = null; }
        paint(host, state);
      }
    }
  }
}
