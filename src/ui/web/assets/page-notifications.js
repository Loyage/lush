import { notificationWorker } from './push-subscriptions.js';
import { safePushUrl } from '../../../shared/web-push-protocol.js';

/** Use the mobile-compatible persistent API when possible, without asking for permission.
 * Desktop fallback retains its existing click handler if a worker cannot be registered. */
export async function showPageNotification(title, { body, tag, url, onClick, enabled = () => true }) {
  if (!enabled() || !globalThis.Notification || globalThis.isSecureContext === false || Notification.permission !== 'granted') return false;
  if (globalThis.navigator?.serviceWorker?.register) {
    try {
      const registration = await notificationWorker();
      if (!enabled()) return false;
      await registration.showNotification(title, { body, tag, icon: '/pwa/icon-192.png', data: { url: safePushUrl(url) } });
      return true;
    } catch { /* Existing desktop browsers may still support non-persistent notifications. */ }
  }
  if (!enabled()) return false;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => { onClick?.(); notification.close(); };
    return true;
  } catch { throw new Error('系统提醒未确认，请检查浏览器权限及通知服务。'); }
}

export function sourceNotificationTag(projectId, notice, fallback) {
  return /^[a-f0-9]{16}$/.test(projectId || '') && /^[a-f0-9]{32}$/.test(notice?.sync_epoch || '')
    && /^[a-f0-9]{32}$/.test(notice?.sync_identity || '')
    ? `lush.push:${projectId}:${notice.sync_epoch}:${notice.sync_identity}` : fallback;
}
