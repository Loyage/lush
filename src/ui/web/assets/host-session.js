import { api } from './api.js';
import { ui } from './state.js';

/** One Host read per UI session; never cache credentials or browser-persist the account name. */
export function loadHostSession() {
  const session = ui.hostSession;
  if (session.pending) return session.pending;
  if (session.status !== 'unread') return Promise.resolve(session);
  session.status = 'loading';
  session.pending = api('/api/host/session').then(value => {
    if (ui.hostSession !== session) return session;
    if (typeof value?.username !== 'string' || !value.username.trim()) throw new Error('账号名称未知');
    session.username = value.username;
    session.status = 'ready';
    return session;
  }).catch(() => {
    if (ui.hostSession === session) { session.username = null; session.status = 'unknown'; }
    return session;
  }).finally(() => { session.pending = null; });
  return session.pending;
}

export function usernameInitial(username) {
  if (!username) return '?';
  // A grapheme handles emoji ZWJ sequences and combining marks as well as surrogate pairs.
  if (typeof Intl.Segmenter === 'function') return new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(username)[Symbol.iterator]().next().value?.segment || '?';
  return Array.from(username)[0] || '?';
}
