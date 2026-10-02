import { $, el, button } from './dom.js';
import { openNotice, readNotice } from './render-notices.js';
import { openResource } from './sidebar-ui.js';
import { unreadNotice, noticeChannelEnabled, noticeIdentity } from './notice-kind.js';
import { onPrefChange } from './prefs.js';
import { projectBase } from './route.js';
import { ui } from './state.js';
import { show } from './messages.js';

const states = new WeakMap();
const selecting = () => Boolean(globalThis.window?.getSelection?.()?.toString());
onPrefChange('noticeChannels', () => {
  const host = $('notice-banner'), state = host && states.get(host);
  if (state) renderNoticeBanner(state.data);
});

function bannerState(host) {
  if (states.has(host)) return states.get(host);
  const state = { data: null, busy: false, gesture: null, suppressUntil: 0 };
  states.set(host, state);
  // Capture on the surviving host: a swipe may replace its original button before
  // the browser dispatches a synthetic click onto the next notice's Worker link.
  host.addEventListener('click', event => {
    if (Date.now() < state.suppressUntil && event.detail !== 0) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  return state;
}

function swipe(row, state, acknowledge) {
  row.addEventListener('pointerdown', event => {
    if (state.gesture) {
      if (state.gesture.axis === 'horizontal') state.suppressUntil = Date.now() + 700;
      state.gesture = null; row.classList.remove('notice-swiping'); return;
    }
    if (event.pointerType !== 'touch' || event.isPrimary === false || state.busy || selecting()) return;
    for (let node = event.target; node && node !== row; node = node.parentNode) {
      if (node.classList?.contains('notice-banner-known')) return;
    }
    state.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null };
  });
  row.addEventListener('pointermove', event => {
    const gesture = state.gesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    if (selecting()) {
      state.suppressUntil = Date.now() + 700; gesture.axis = 'cancel'; row.classList.remove('notice-swiping'); return;
    }
    const x = Math.abs(event.clientX - gesture.x), y = Math.abs(event.clientY - gesture.y);
    if (!gesture.axis && Math.max(x, y) >= 12) gesture.axis = x > y * 1.5 ? 'horizontal' : 'vertical';
    if (gesture.axis === 'horizontal') {
      try { row.setPointerCapture?.(event.pointerId); } catch { /* pointer already cancelled */ }
      event.preventDefault(); row.classList.add('notice-swiping');
    }
  });
  const finish = (event, cancelled = false) => {
    const gesture = state.gesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    state.gesture = null; row.classList.remove('notice-swiping');
    const x = Math.abs(event.clientX - gesture.x), y = Math.abs(event.clientY - gesture.y);
    if (gesture.axis === 'horizontal') state.suppressUntil = Date.now() + 700;
    const threshold = Math.max(64, Math.min(120, (row.getBoundingClientRect?.().width || 320) * .25));
    if (!cancelled && !selecting() && gesture.axis === 'horizontal' && x >= threshold && x > y * 1.5) {
      event.preventDefault(); void acknowledge();
    } else renderNoticeBanner(state.data);
  };
  row.addEventListener('pointerup', event => finish(event));
  row.addEventListener('pointercancel', event => finish(event, true));
  row.addEventListener('lostpointercapture', event => {
    // Moving implicit touch capture from a child (title/button) to this row emits
    // a bubbling child lostpointercapture; it is not cancellation of our swipe.
    if (event.target === row) finish(event, true);
  });
}

/** Pending decisions are separate and can never be acknowledged by swipe or “known”. */
export function renderNoticeBanner(data) {
  const host = $('notice-banner');
  if (!host) return;
  const state = bannerState(host);
  const scope = `${projectBase()}:${data?.status?.project || ''}`;
  if (state.scope !== scope || state.reads !== ui.noticeReadRows) {
    state.scope = scope; state.reads = ui.noticeReadRows;
    state.busy = false; state.gesture = null; state.suppressUntil = 0; host.dataset.signature = '';
  }
  state.data = data;
  if (state.gesture) return; // Keep pointer capture intact when polling replaces the snapshot.
  const rows = (data?.notices || []).map(row => ui.noticeReadRows.get(noticeIdentity(row)) || row);
  const unread = rows.filter(unreadNotice);
  const groups = [
    { rows: rows.filter(row => row.status === 'open'), label: '条待你处理', action: '去处理 →', kind: 'decision', help: '最新待决提醒；点击打开处理页' },
    { rows: unread.filter(row => noticeChannelEnabled(row, 'banner')), label: '条未读告知', action: '查看 Worker →', kind: 'info', help: '打开对应 Worker；成功加载后自动已读，不会启动 Agent 或批准合并' },
  ].filter(group => group.rows.length);
  if (!groups.length) {
    if (host.dataset.signature !== '0') { host.dataset.signature = '0'; host.replaceChildren(); }
    host.hidden = true; return;
  }
  const newest = group => group.rows.reduce((a, b) => b.id > a.id ? b : a);
  const signature = JSON.stringify([state.busy, groups.map(group => [group.kind, group.rows.length, newest(group).id, newest(group).title])]);
  host.hidden = false;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.replaceChildren(...groups.map(group => {
    const notice = newest(group);
    const main = el('button', undefined, `notice-banner-main notice-banner-${group.kind}`);
    main.type = 'button'; main.setAttribute('data-help', group.help);
    main.append(el('span', undefined, 'notice-banner-dot'), el('span', `${group.rows.length} ${group.label}`, 'notice-banner-count'),
      el('span', notice.title, 'notice-banner-title'), el('span', group.action, 'notice-banner-go'));
    let opening = false;
    main.disabled = group.kind === 'info' && state.busy;
    main.onclick = async event => {
      if (opening || main.disabled || selecting() || (Date.now() < state.suppressUntil && event?.detail !== 0)) return;
      opening = true; main.disabled = true;
      try { if (group.kind === 'decision') openResource('notices'); await openNotice(notice.id); }
      catch (error) { show(error.message, 'error'); }
      finally { opening = false; main.disabled = false; renderNoticeBanner(state.data); }
    };
    if (group.kind === 'decision') return main;
    const row = el('div', undefined, 'notice-banner-row'); row.dataset.noticeId = notice.id;
    const rowReads = state.reads;
    const acknowledge = async () => {
      if (state.busy || state.scope !== scope || state.reads !== rowReads) return;
      const restoreFocus = globalThis.document?.activeElement === known;
      const source = state.scope, reads = state.reads;
      const owns = () => state.scope === source && state.reads === reads && ui.noticeReadRows === reads;
      state.busy = true; known.disabled = true; main.disabled = true;
      row.setAttribute('aria-busy', 'true');
      renderNoticeBanner(state.data);
      try { await readNotice(notice); }
      catch (error) { if (owns()) show(`无法标记已知：${error.message}`, 'error'); }
      finally {
        if (!owns()) return;
        state.busy = false; renderNoticeBanner(state.data);
        if (restoreFocus) (host.querySelector('.notice-banner-known') || host.querySelector('button'))?.focus();
      }
    };
    const known = button(state.busy ? '处理中…' : '已知', acknowledge, 'ghost notice-banner-known',
      { help: '仅将当前展示的这一条告知标记已读，随后展示下一条；保留历史，不打开 Worker、不调用 Agent、不验收或合并' });
    known.disabled = state.busy;
    const helpHost = el('span', undefined, 'help-host');
    helpHost.setAttribute('data-help', known.getAttribute('data-help'));
    const mainHost = el('span', undefined, 'help-host');
    mainHost.setAttribute('data-help', group.help); mainHost.append(main);
    row.append(mainHost, helpHost); helpHost.append(known);
    row.setAttribute('aria-busy', String(state.busy));
    swipe(row, state, acknowledge);
    return row;
  }));
}
