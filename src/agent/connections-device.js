// Codex device wire protocol adapted from Pi AI 0.99.1 (MIT); no SDK loaded.
// Fixed source and licence: docs/third-party/agent-connections.md.
import { randomUUID } from 'node:crypto';
import { check } from '../core/types.js';
import { digest, fail, object, secret, validId } from './connections-utils.js';
import { CODEX_CLIENT_ID, DEVICE_REDIRECT_URI, exchange } from './connections-oauth.js';

const USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
const LIFETIME = 15 * 60000, COMPLETED_LIFETIME = 60000;
const jsonPost = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });

/** Ephemeral, project-owned sessions. Polling is one explicit request, not a timer. */
export class ConnectionDeviceLogins {
  constructor(manager, view) { this.manager = manager; this.view = view; this.sessions = new Map(); }
  discard(loginId, session) {
    if (this.sessions.get(loginId) === session) this.sessions.delete(loginId);
    session.controller.abort();
    delete session.deviceAuthId; delete session.userCode;
  }
  cancelFor(id) { for (const [key, session] of this.sessions) if (session.id === id) this.discard(key, session); }
  purge() { for (const [key, session] of this.sessions) if (session.expires <= this.manager.now()) this.discard(key, session); }
  stop() { for (const [key, session] of this.sessions) this.discard(key, session); }
  current(loginId, session) {
    const m = this.manager; m._alive();
    if (this.sessions.get(loginId) !== session || session.controller.signal.aborted) fail('login_expired');
    if (session.expires <= m.now()) { this.discard(loginId, session); fail('login_expired'); }
    if (digest(m._row(session.id)) !== session.revision) { this.discard(loginId, session); fail('auth_changed'); }
  }
  request(session, url, init, options = {}) {
    return this.manager._request(url, init, { ...options, signal: session.controller.signal });
  }
  start(id) {
    return this.manager._track(async () => {
      const m = this.manager, row = m._row(id);
      check(row.auth_type === 'oauth' && row.provider === 'openai-codex', 'connection does not support device login');
      this.purge(); m._cancelLogins(id);
      const loginId = randomUUID(), session = { id, revision: digest(row), expires: m.now() + LIFETIME,
        status: 'starting', controller: new AbortController() };
      this.sessions.set(loginId, session);
      try {
        const data = await this.request(session, USER_CODE_URL, jsonPost({ client_id: CODEX_CLIENT_ID }), { deviceAuthStart: true });
        this.current(loginId, session);
        const interval = typeof data?.interval === 'string' && data.interval.trim() ? Number(data.interval) : data?.interval;
        if (!object(data) || !secret(data.device_auth_id) || typeof data.user_code !== 'string'
          || !/^[A-Za-z0-9-]{1,64}$/.test(data.user_code) || !Number.isFinite(interval) || interval < 0 || interval > 300) fail('invalid_response');
        session.deviceAuthId = data.device_auth_id; session.userCode = data.user_code;
        session.interval = Math.max(1, interval); session.nextPoll = m.now() + session.interval * 1000; session.status = 'pending';
        return { id, login_id: loginId, verification_uri: DEVICE_VERIFICATION_URI, user_code: session.userCode,
          expires_at: new Date(session.expires).toISOString(), interval_seconds: session.interval };
      } catch (error) { this.discard(loginId, session); throw error; }
    });
  }
  pending(loginId, session) {
    return { id: session.id, login_id: loginId, status: 'pending', interval_seconds: session.interval,
      expires_at: new Date(session.expires).toISOString() };
  }
  poll(id, loginId) {
    check(validId(id) && validId(loginId), 'invalid device login');
    this.manager._alive(); this.purge();
    const session = this.sessions.get(loginId);
    if (!session || session.id !== id || session.status === 'starting') fail('login_expired');
    this.current(loginId, session);
    if (session.status === 'complete') return Promise.resolve({ id, login_id: loginId, status: 'complete', connection: session.connection });
    if (session.flight) return session.flight;
    if (this.manager.now() < session.nextPoll) return Promise.resolve(this.pending(loginId, session));
    const pending = this.manager._track(async () => {
      try {
        this.current(loginId, session);
        const response = await this.request(session, DEVICE_TOKEN_URL,
          jsonPost({ device_auth_id: session.deviceAuthId, user_code: session.userCode }), { deviceAuthPoll: true });
        this.current(loginId, session);
        const data = response.data;
        if (response.status >= 200 && response.status < 300) {
          if (!object(data) || !secret(data.authorization_code) || !secret(data.code_verifier)) fail('invalid_response');
          // The session remains guarded throughout exchange, so cancel/new-login
          // can invalidate even a fetch implementation that ignores AbortSignal.
          const credential = await exchange(data.authorization_code, data.code_verifier,
            (url, init) => this.request(session, url, init), this.manager.now, DEVICE_REDIRECT_URI);
          this.current(loginId, session);
          const row = this.manager._publish(id, session.revision, credential);
          session.connection = this.view(row, this.manager.now()); session.revision = digest(row);
          session.status = 'complete'; session.expires = this.manager.now() + COMPLETED_LIFETIME;
          delete session.deviceAuthId; delete session.userCode;
          return { id, login_id: loginId, status: 'complete', connection: session.connection };
        }
        const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
        if (![403,404].includes(response.status)) {
          if (code === 'slow_down') session.interval = Math.min(300, session.interval + 5);
          else if (!['deviceauth_authorization_pending','authorization_pending'].includes(code))
            fail(['expired_token','deviceauth_expired'].includes(code) ? 'login_expired' : response.status === 429 ? 'rate_limited' : 'unauthorized');
        }
        session.nextPoll = this.manager.now() + session.interval * 1000;
        return this.pending(loginId, session);
      } catch (error) { this.discard(loginId, session); throw error; }
      finally { session.flight = null; }
    });
    session.flight = pending; return pending;
  }
  cancel(id, loginId) {
    this.manager._alive(); check(validId(id) && validId(loginId), 'invalid device login');
    const session = this.sessions.get(loginId);
    if (session && session.id !== id) fail('auth_changed');
    if (session) this.discard(loginId, session);
    return { id, login_id: loginId, status: 'cancelled' };
  }
}
