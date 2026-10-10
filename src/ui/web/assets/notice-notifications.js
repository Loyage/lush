import { button, el } from './dom.js';
import { devicePreferencesStatus, onDevicePreferences, onPrefChange, readPref, saveDevicePreference } from './prefs.js';
import { unreadNotice, noticeHash, noticeChannelEnabled } from './notice-kind.js';

let failure = '';
const paintControls = () => {
  for (const root of globalThis.document?.querySelectorAll?.('.notice-notification-control') || []) paintControl(root);
};
onPrefChange('noticeNotifications', paintControls);
onDevicePreferences(paintControls);

export function notificationStatus() {
  if (failure) return failure;
  if (!globalThis.Notification || globalThis.isSecureContext === false) return '此环境不支持系统通知，请使用 HTTPS 或 localhost';
  if (Notification.permission === 'denied') return '通知权限被拒绝，请在浏览器站点设置中允许';
  if (!readPref('noticeNotifications')) return '系统提醒已关闭';
  return Notification.permission === 'granted' ? '设备系统提醒已开启，此浏览器已授权' : '设备总开关已开启，此浏览器仍需授权';
}

/** Only call from a user gesture. Local permission never changes another browser's device switch. */
export async function requestNoticePermission() {
  failure = '';
  try {
    if (!globalThis.Notification || globalThis.isSecureContext === false) throw new Error('此浏览器不支持系统通知，请使用 HTTPS 或 localhost；设备总开关不受影响');
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('此浏览器通知未获授权，可在站点设置中允许后重试；设备总开关不受影响');
    return true;
  } catch (error) { failure = error.message; return false; }
  finally { paintControls(); }
}
export async function setNoticeNotifications(enabled) {
  failure = '';
  // Start before the first await so browser permission is still directly tied to this gesture.
  const permission = enabled ? requestNoticePermission() : Promise.resolve(false);
  try { await saveDevicePreference('noticeNotifications', Boolean(enabled)); }
  catch (error) { await permission; failure = `设备系统提醒开关未保存：${error.message}`; paintControls(); throw error; }
  await permission; paintControls(); return readPref('noticeNotifications');
}

export function notificationControl() {
  const root = el('div', undefined, 'notice-notification-control');
  const status = el('span', undefined, 'hint'); status.setAttribute('role', 'status');
  const toggle = button('', async () => {
    toggle.disabled = true;
    try { await setNoticeNotifications(!readPref('noticeNotifications')); }
    catch { /* authoritative write failure is shown by paintControl; keep the saved value */ }
    finally { paintControl(root); }
  }, 'ghost');
  toggle.dataset.pref = 'noticeNotifications';
  toggle.setAttribute('data-help', '修改设备唯一的系统提醒总开关；所有已授权浏览器共享。当前浏览器的授权只由此用户操作请求，关闭不删除项目记录。');
  const host = el('span', undefined, 'help-host'); host.tabIndex = 0; host.append(toggle);
  const permission = button('授权此浏览器', async () => { permission.disabled = true; await requestNoticePermission(); paintControl(root); }, 'ghost');
  permission.classList.add('notice-browser-permission');
  permission.setAttribute('data-help', '仅请求当前浏览器的系统通知权限，不写设备总开关，也不补发历史事项。');
  // button() restores its generic enabled state; reapply device/offline authorization after it settles.
  const clicked = toggle.onclick; toggle.onclick = async () => { await clicked(); paintControl(root); };
  root.append(host, permission, status); paintControl(root); return root;
}
function paintControl(root) {
  const toggle = root.querySelector('button');
  const on = readPref('noticeNotifications'), device = devicePreferencesStatus();
  const offline = !device.ready || Boolean(device.error);
  toggle.disabled = device.saving || offline;
  const host = toggle.parentElement || toggle.parentNode;
  host?.setAttribute('data-help', offline ? `设备偏好当前不可用，不能修改系统提醒开关。${device.error || '等待权威配置读取。'}` : device.saving ? '正在保存设备偏好，请稍候。' : '设备开关与当前浏览器授权相互独立。');
  const permission = root.querySelector('.notice-browser-permission');
  if (permission) { permission.hidden = !on || !globalThis.Notification || globalThis.isSecureContext === false || Notification.permission === 'granted'; permission.disabled = false; }
  toggle.textContent = on ? '关闭系统提醒' : '开启系统提醒';
  toggle.setAttribute('aria-label', on ? '关闭系统提醒' : '开启系统提醒');
  toggle.setAttribute('aria-pressed', String(on));
  const status = root.querySelector('[role="status"]');
  if (status) status.textContent = offline ? `设备偏好尚不可用，显示缓存值。${device.error || ''} ${notificationStatus()}` : notificationStatus();
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
      && ((row.status === 'open' && ['question','questionnaire','plan'].includes(row.kind)) || unreadNotice(row)));
    for (const row of rows) seen.add(identity(row));
    high = Math.max(high, nextHigh);
    if (!enabled()) return;
    for (const notice of fresh.filter(row => noticeChannelEnabled(row, 'system'))) Promise.resolve().then(() => {
      if (enabled() && noticeChannelEnabled(notice, 'system')) return send(notice, current);
    }).catch(error => { failure = `系统提醒发送失败：${error.message}`; });
  };
}

async function deliver(notice, project) {
  if (!readPref('noticeNotifications') || !noticeChannelEnabled(notice, 'system')) return;
  const key = `lush.notice-delivered:${project}:${notice.id}:${notice.created_at}`;
  const run = async () => {
    // A tab-lock wait must not send a notification after the user disabled its channel.
    if (!readPref('noticeNotifications') || !noticeChannelEnabled(notice, 'system')) return;
    try { if (localStorage.getItem(key)) return; } catch { /* private browsing */ }
    const title = `Lush · ${project.split('/').filter(Boolean).at(-1) || project}`;
    const body = notice.title.slice(0, 500);
    if (!globalThis.Notification || globalThis.isSecureContext === false || Notification.permission !== 'granted') return;
    const notification = new Notification(title, { body, tag: key });
    const hash = noticeHash(notice);
    const pathname = location.pathname;
    notification.onclick = () => {
      globalThis.window?.focus?.();
      if (location.pathname === pathname) location.hash = hash;
      else location.href = `${pathname}${hash}`;
      notification.close();
    };
    try { localStorage.setItem(key, '1'); } catch { /* session baseline still deduplicates */ }
  };
  // Serialize across same-origin tabs when available; tag also replaces duplicate OS banners.
  if (globalThis.navigator?.locks?.request) await navigator.locks.request(key, run);
  else await run();
}
let observer = createNoticeNotifier({ send: deliver });
export function resetNoticeNotifier() { failure = ''; observer = createNoticeNotifier({ send: deliver }); }
export function observeNotices(data) { observer(data); }
