import { $, el, button } from './dom.js';
import { api } from './api.js';
import { resource, refresh } from './navigate.js';
import { projectBase } from './route.js';
import { ui } from './state.js';
import { show } from './messages.js';

const states = new WeakMap();
const valid = model => typeof model?.enabled === 'boolean' && typeof model.revision === 'string' && model.revision.trim();

function stateFor(host) {
  const source = projectBase(), reads = ui.noticeReadRows;
  let state = states.get(host);
  if (state?.source === source && state.reads === reads) return state;
  state = { source, reads, model: null, superseded: new Set(), busy: false, offline: false };
  states.set(host, state);
  const copy = el('div', undefined, 'auto-select-copy');
  state.title = el('strong');
  copy.append(state.title, el('p', '单选选第一项；多选和文字问题交给 Agent 判断。离开页面后仍会自动答复，可能产生调用费用。'));
  const actions = el('div', undefined, 'auto-select-actions');
  const view = button('查看自动问答', () => {
    if (!owns(host, state)) return;
    ui.selectNoticeFilter?.('automatic');
    resource('notices');
  }, 'ghost', { help: '打开“待我处理”的自动选择记录，只读查看原问题与答案，不调用 Agent。' });
  // This surviving control owns its lock; button()'s generic finally-unlock
  // would re-enable it on a duplicate click or a poll during the save.
  state.control = el('button', '关闭自动选择', 'ghost'); state.control.type = 'button';
  state.control.setAttribute('data-help', '关闭当前项目之后的自动答复；不撤回已有答案，也不停止已开始的调用。');
  state.control.onclick = () => disable(host, state);
  state.controlHost = el('span', undefined, 'help-host');
  state.controlHost.append(state.control);
  actions.append(view, state.controlHost);
  host.replaceChildren(copy, actions);
  return state;
}
function owns(host, state) {
  return globalThis.document?.getElementById?.('auto-select-banner') === host && states.get(host) === state
    && state.source === projectBase() && state.reads === ui.noticeReadRows;
}
function paint(host, state) {
  host.hidden = state.model?.enabled !== true;
  if (host.hidden) return;
  state.title.textContent = state.offline ? '自动选择最近确认为开启 · 当前离线' : '自动选择已开启';
  state.control.textContent = state.busy ? '正在关闭…' : '关闭自动选择';
  const reason = state.busy ? '正在保存，请稍候。' : state.offline ? '当前离线，无法确认或关闭后台状态；恢复连接后再试。'
    : state.model.editable === false ? '后台暂不允许更改，请稍后再试。' : null;
  state.control.disabled = Boolean(reason);
  if (reason) state.controlHost.setAttribute('data-help', reason);
  else state.controlHost.removeAttribute('data-help');
  host.setAttribute('aria-busy', String(state.busy));
}

/** Persistent project authorization, not a dismissible/unread Notice. */
export function renderAutoSelectBanner(model, { offline = false } = {}) {
  const host = $('auto-select-banner');
  if (!host) return;
  const state = stateFor(host);
  state.offline = offline;
  if (valid(model) && !state.superseded.has(model.revision)) state.model = { ...model };
  paint(host, state);
}

/** Apply a confirmed user mutation immediately, ignoring pre-ACK polls. */
export function applyAutoSelectCatalogue(catalogue, previousRevision = null) {
  const model = catalogue?.daemon_hooks;
  const mount = model?.mounts?.find(item => item.id === 'auto-select');
  const next = mount && { enabled: mount.enabled, revision: model.revision, editable: mount.editable };
  if (!valid(next)) throw new Error('自动选择状态确认失败，请刷新读取后台状态');
  const host = $('auto-select-banner');
  if (!host) return;
  const state = stateFor(host);
  // Only invalidate the revision used by this write, never a newer setting
  // observed from another tab while this ACK was in flight.
  if (previousRevision && previousRevision !== next.revision) state.superseded.add(previousRevision);
  // Only protect a bounded window of in-flight, older authorization mirrors.
  if (state.superseded.size > 32) state.superseded.delete(state.superseded.values().next().value);
  state.model = next; state.offline = false;
  if (ui.lastSnapshot?.status) ui.lastSnapshot.status.auto_select = next;
  paint(host, state);
}

async function disable(host, state) {
  if (!owns(host, state) || state.busy || state.offline || !state.model?.enabled || state.model.editable === false) return;
  const revision = state.model.revision;
  state.busy = true; paint(host, state);
  try {
    const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'hooks.auto_select', params: { enabled: false, expected_revision: revision } }) });
    if (!owns(host, state)) return;
    applyAutoSelectCatalogue(result, revision);
    if (state.model.enabled) throw new Error('后台尚未确认关闭');
    show('自动选择已关闭；已有答案保留，已开始的调用不会停止。');
  } catch (error) {
    if (owns(host, state)) show(`关闭未确认：${error.message}；请读取后台最新状态后重试。`, 'error');
  } finally {
    state.busy = false;
    if (owns(host, state)) {
      paint(host, state);
      // The write ACK must not depend on a subsequent global read succeeding.
      void Promise.resolve().then(() => owns(host, state) ? refresh() : null)
        .catch(error => { if (owns(host, state)) show(`自动选择状态刷新失败：${error.message}`, 'error'); });
    }
  }
}
