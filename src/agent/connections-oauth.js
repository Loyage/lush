// Browser authorization/refresh wire flow adapted from Pi AI 0.99.1 (MIT).
// No callback server, global auth storage, Pi runtime or device polling is loaded.
// Attribution and pinned source hashes: docs/third-party/agent-connections.md.
import { randomBytes, createHash } from 'node:crypto';
import { fail, object, secret } from './connections-utils.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const REDIRECT_URI = 'http://localhost:1455/auth/callback';
export function authorization() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('hex');
  const url = new URL('https://auth.openai.com/oauth/authorize');
  for (const [key,value] of Object.entries({ response_type: 'code', client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI, scope: 'openid profile email offline_access', code_challenge: challenge,
    code_challenge_method: 'S256', state, id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'pi' })) url.searchParams.set(key, value);
  return { verifier, state, url: url.href };
}
export function callbackCode(value, state) {
  if (typeof value !== 'string' || value.length > 8192) fail('invalid_callback');
  let url; try { url = new URL(value.trim()); } catch { fail('invalid_callback'); }
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash
    || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state
    || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) fail('invalid_callback');
  const code = url.searchParams.get('code'); if (!secret(code)) fail('invalid_callback');
  return code;
}
function accountId(access) {
  try {
    const parts = access.split('.'); if (parts.length !== 3 || parts[1].length > 16384) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const id = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : null;
  } catch { return null; }
}
function credential(data, now, expectedAccountId = null) {
  if (!object(data) || !secret(data.access_token) || !secret(data.refresh_token)
    || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000) fail('invalid_response');
  const id = accountId(data.access_token); if (!id) fail('invalid_response');
  if (expectedAccountId && id !== expectedAccountId) fail('auth_changed');
  return { type: 'oauth', access: data.access_token, refresh: data.refresh_token,
    expires: now() + data.expires_in * 1000, accountId: id };
}
const post = (request, body) => request(TOKEN_URL, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body) });
export async function exchange(code, verifier, request, now) {
  return credential(await post(request, { grant_type: 'authorization_code', client_id: CLIENT_ID,
    code, code_verifier: verifier, redirect_uri: REDIRECT_URI }), now);
}
export async function refresh(previous, request, now) {
  return credential(await post(request, { grant_type: 'refresh_token', client_id: CLIENT_ID,
    refresh_token: previous.refresh }), now, previous.accountId);
}
