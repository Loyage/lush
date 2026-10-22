import { WEB_PUSH_VERSION, safePushUrl } from '../../shared/web-push-protocol.js';

// Serialized into a classic, root-scoped worker. No fetch handler or persistent data cache:
// all authenticated pages, API responses and code remain on the normal online HTTP path.
function installPushWorker(scope, options, safeUrl) {
  scope.addEventListener('push', event => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    if (!payload || payload.version !== options.version
      || !['title', 'body', 'tag', 'url'].every(key => typeof payload[key] === 'string')) return;
    const text = (value, limit) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
    event.waitUntil(scope.registration.showNotification(text(payload.title, 120) || 'Lush', {
      body: text(payload.body, 240), tag: text(payload.tag, 180) || 'lush-notice',
      icon: options.icon, badge: options.badge,
      data: { url: safeUrl(payload.url) },
    }));
  });
  scope.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
      // Validate again: notification data can outlive the worker that created it.
      const relative = safeUrl(event.notification.data?.url);
      const target = new URL(relative, scope.location.origin);
      const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        let current;
        try { current = new URL(client.url); } catch { continue; }
        if (current.origin !== target.origin || current.href !== target.href) continue;
        try { await client.focus(); return; } catch { /* A closed/stale client cannot receive focus. */ }
      }
      // Do not navigate an unrelated tab: it may contain unsent user input.
      // Keep the hash inside next: HTTP requests cannot otherwise carry a Notice
      // fragment through an expired login session. Authenticated login also honors next.
      const entry = new URL('/login', scope.location.origin);
      entry.searchParams.set('next', relative);
      await scope.clients.openWindow(entry.href);
    })());
  });
}

export function pwaWorkerSource() {
  return `'use strict';\n(${installPushWorker.toString()})(self, ${JSON.stringify({
    version: WEB_PUSH_VERSION, icon: '/pwa/icon-192.png', badge: '/pwa/icon-192.png',
  })}, ${safePushUrl.toString()});\n`;
}
