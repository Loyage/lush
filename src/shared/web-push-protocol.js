/** Shared Host/PWA contract. Push only navigates; it never performs project actions. */
export const WEB_PUSH_VERSION = 1;
export const WEB_PUSH_PATHS = Object.freeze({
  config: '/api/host/push',
  subscribe: '/api/host/push/subscribe',
  unsubscribe: '/api/host/push/unsubscribe',
  status: '/api/host/push/status',
  test: '/api/host/push/test',
  worker: '/sw.js',
  manifest: '/manifest.webmanifest',
});

export function pushNoticeUrl(projectId, noticeId) {
  if (typeof projectId !== 'string' || !/^[a-f0-9]{16}$/.test(projectId)
    || !Number.isSafeInteger(noticeId) || noticeId <= 0) throw new Error('Invalid push Notice identity');
  return `/p/${projectId}/#notices-${noticeId}`;
}

export function safePushUrl(value) {
  return typeof value === 'string' && (/^\/p\/[a-f0-9]{16}\/#notices-[1-9]\d*$/.test(value)
    || value === '/#settings') ? value : '/#notices';
}
