import { button, el } from './dom.js';
import { onPrefChange, readPref, setPref } from './prefs.js';

const desktop = () => globalThis.window?.lushDesktop;
let failure = '';
onPrefChange('noticeNotifications', enabled => {
  // Includes “restore defaults”; the desktop preference must not resurrect on restart.
  if (desktop()?.notificationSettings) void desktop().notificationSettings(enabled).catch(error => { failure = error.message; });
  for (const root of globalThis.document?.querySelectorAll?.('.notice-notification-control') || []) paintControl(root);
});

export async function initNoticeNotifications() {
  failure = '';
  if (desktop()?.notificationSettings) {
    try { setPref('noticeNotifications', (await desktop().notificationSettings()).enabled); }
    catch { failure = '无法读取桌面提醒设置'; }
  }
}

export function notificationStatus() {
  if (failure) return failure;
  if (desktop()?.notifyNotice) return readPref('noticeNotifications') ? '已开启系统提醒' : '系统提醒已关闭';
  if (!globalThis.Notification || globalThis.isSecureContext === false) return '此环境不支持系统通知，请使用 HTTPS 或 localhost';
  if (Notification.permission === 'denied') return '通知权限被拒绝，请在浏览器站点设置中允许';
  if (!readPref('noticeNotifications')) return '系统提醒已关闭';
  return Notification.permission === 'granted' ? '已开启系统提醒' : '需要重新开启并授权通知';
}

/** Only call from a user gesture; polling never requests permission. */
export async function setNoticeNotifications(enabled) {
  failure = '';
  try {
    if (desktop()?.notificationSettings) {
      const settings = await desktop().notificationSettings(Boolean(enabled));
      if (enabled && !settings.enabled) throw new Error('系统不支持通知');
    } else if (enabled) {
      if (!globalThis.Notification || globalThis.isSecureContext === false) throw new Error('此环境不支持系统通知，请使用 HTTPS 或 localhost');
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('通知未获授权，可在浏览器站点设置中允许后重试');
    }
    setPref('noticeNotifications', Boolean(enabled));
  } catch (error) { failure = error.message; setPref('noticeNotifications', false); }
  return readPref('noticeNotifications');
}

export function notificationControl() {
  const root = el('div', undefined, 'notice-notification-control');
  const status = el('span', undefined, 'hint'); status.setAttribute('role', 'status');
  const toggle = button('', async () => {
    toggle.disabled = true;
    await setNoticeNotifications(!readPref('noticeNotifications'));
    paintControl(root); toggle.disabled = false;
  }, 'ghost');
  toggle.dataset.pref = 'noticeNotifications';
  toggle.setAttribute('data-help', '开启后新的待你处理问题会发系统通知；关闭后只保留页面内提醒');
  root.append(toggle, status); paintControl(root); return root;
}
function paintControl(root) {
  const toggle = root.querySelector('button');
  const on = readPref('noticeNotifications');
  toggle.textContent = on ? '关闭系统提醒' : '开启系统提醒';
  toggle.setAttribute('aria-label', on ? '关闭系统提醒' : '开启系统提醒');
  toggle.setAttribute('aria-pressed', String(on));
  root.querySelector('span').textContent = notificationStatus();
}

/** Per-page baseline: no historical burst on first load, refresh or project switch. */
export function createNoticeNotifier({ send, enabled = () => readPref('noticeNotifications') } = {}) {
  let project = null, high = null, started = 0, seen = new Set();
  const identity = row => `${row.id}:${row.task_id}:${row.created_at}`;
  return data => {
    const current = data.status?.project;
    const rows = data.notices || [];
    const nextHigh = Math.max(0, ...rows.map(row => row.id));
    if (project !== current || high === null) {
      project = current; high = nextHigh; started = Date.now(); seen = new Set(rows.map(identity)); return;
    }
    // Explicit task deletion/clear can reuse SQLite notice IDs. Identity + creation time
    // still recognizes those new questions, while old records resurfacing after paging stay silent.
    const fresh = rows.filter(row => !seen.has(identity(row)) && (row.id > high || Date.parse(row.created_at) >= started)
      && row.status === 'open' && ['question','questionnaire','plan'].includes(row.kind));
    for (const row of rows) seen.add(identity(row));
    high = Math.max(high, nextHigh);
    if (!enabled()) return;
    for (const notice of fresh) Promise.resolve().then(() => send(notice, current)).catch(error => { failure = `系统提醒发送失败：${error.message}`; });
  };
}

async function deliver(notice, project) {
  if (!readPref('noticeNotifications')) return;
  const key = `lush.notice-delivered:${project}:${notice.id}:${notice.created_at}`;
  const run = async () => {
    try { if (localStorage.getItem(key)) return; } catch { /* private browsing */ }
    const title = `Lush · ${project.split('/').filter(Boolean).at(-1) || project}`;
    const body = notice.title.slice(0, 500);
    if (desktop()?.notifyNotice) {
      if (!await desktop().notifyNotice({ title, body, tag: key })) return;
    } else {
      if (!globalThis.Notification || Notification.permission !== 'granted') return;
      const notification = new Notification(title, { body, tag: key });
      notification.onclick = () => { globalThis.window?.focus?.(); location.hash = '#notices'; notification.close(); };
    }
    try { localStorage.setItem(key, '1'); } catch { /* session baseline still deduplicates */ }
  };
  // Serialize across same-origin tabs when available; tag also replaces duplicate OS banners.
  if (globalThis.navigator?.locks?.request) await navigator.locks.request(key, run);
  else await run();
}
let observer = createNoticeNotifier({ send: deliver });
export function resetNoticeNotifier() { observer = createNoticeNotifier({ send: deliver }); }
export function observeNotices(data) { observer(data); }
