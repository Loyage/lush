import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { launcherStateDir } from '../host/registry.js';
import { check, isPlainObject } from '../core/types.js';

export function administratorHome(env = process.env) { return path.join(launcherStateDir(env), 'shared', 'administrator'); }
export function administratorDelegationPaths(home) { return { privateKey: path.join(home, 'delegation-private.pem'), publicKey: path.join(home, 'delegation-public.pem') }; }
function privateDirectory(home) {
  const stat = fs.lstatSync(home);
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) && fs.realpathSync(home) === home, 'unsafe administrator delegation directory');
}
function readKey(file, home) {
  privateDirectory(home);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.nlink === 1 && stat.size <= 8192, 'unsafe administrator delegation key');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
/** Only trusted service startup/executor calls this, never the model bridge. No key enters a result. */
export function ensureAdministratorDelegation(home) {
  privateDirectory(home);
  const files = administratorDelegationPaths(home);
  if (!fs.existsSync(files.privateKey) && !fs.existsSync(files.publicKey)) {
    const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    // Exclusive publication: partial keys after a crash fail closed instead of silently changing identity.
    fs.writeFileSync(files.privateKey, keys.privateKey, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(files.publicKey, keys.publicKey, { mode: 0o600, flag: 'wx' });
  }
  const privateKey = readKey(files.privateKey, home), publicKey = readKey(files.publicKey, home);
  const probe = Buffer.from('lush-administrator-delegation-v1');
  check(verify(null, probe, publicKey, sign(null, probe, privateKey)), 'administrator delegation key pair mismatch');
  return { privateKey, publicKey };
}
export function canonicalAdministratorValue(value, depth = 0) {
  check(depth < 32, 'administrator request nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonicalAdministratorValue(item, depth + 1));
  check(isPlainObject(value), 'administrator request must be JSON');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalAdministratorValue(value[key], depth + 1)]));
}
export function administratorRequestText(value) { return JSON.stringify(canonicalAdministratorValue(value)); }
export function administratorRequestHash(value) { return createHash('sha256').update(administratorRequestText(value)).digest('hex'); }
function identifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
export function signAdministratorRequest(home, { project, method, params, identity }, now = Date.now()) {
  check(isPlainObject(identity) && ['service_id','worker_id','instruction_id','call_id'].every(key => identifier(String(identity[key] ?? ''))), 'trusted administrator call identity required');
  const request = { version: 1, project, method, params, identity: Object.fromEntries(['service_id','worker_id','instruction_id','call_id'].map(key => [key, String(identity[key])])), issued_at: now, expires_at: now + 60000 };
  const { privateKey } = ensureAdministratorDelegation(home);
  return { request, signature: sign(null, Buffer.from(administratorRequestText(request)), privateKey).toString('base64url') };
}
export function verifyAdministratorRequest(config, request, signature, now = Date.now()) {
  check(isPlainObject(request) && Object.keys(request).sort().join(',') === 'expires_at,identity,issued_at,method,params,project,version', 'invalid administrator delegation');
  check(request.version === 1 && request.project === config.project && typeof request.method === 'string' && isPlainObject(request.params), 'administrator target binding mismatch');
  check(isPlainObject(request.identity) && Object.keys(request.identity).sort().join(',') === 'call_id,instruction_id,service_id,worker_id'
    && Object.values(request.identity).every(identifier), 'invalid administrator call identity');
  check(Number.isSafeInteger(request.issued_at) && Number.isSafeInteger(request.expires_at) && request.issued_at <= now + 5000
    && request.issued_at >= now - 60000 && request.expires_at > now && request.expires_at <= request.issued_at + 60000, 'administrator delegation expired');
  check(typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature), 'invalid administrator signature');
  const home = config.deviceHome ? path.join(config.deviceHome, 'administrator') : administratorHome(config.env);
  const publicKey = readKey(administratorDelegationPaths(home).publicKey, home);
  check(verify(null, Buffer.from(administratorRequestText(request)), publicKey, Buffer.from(signature, 'base64url')), 'administrator delegation signature rejected');
  return request.identity;
}

const PRIVATE_KEY = /(?:^|[_-])(?:token|secret|password|credential|private[_-]key|api[_-]?key|authorization|cookie|env|prompt)(?:$|[_-])/i;
export function administratorSafeText(value) {
  return String(value).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/=.\-]{8,}/gi, '[redacted authorization]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted credential]')
    .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|client[_-]?secret|agent[_-]?token|private[_-]?prompt|system[_-]?prompt|default[_-]?prompt|append[_-]?prompt)(?:["']?)\s*[:=]\s*)(["'])([\s\S]*?)\2/gi, '$1"[redacted]"');
}
/** This is deliberately not the ordinary Valet metadata projection. Source/errors remain useful, secrets do not. */
export function safeAdministratorValue(value, depth = 0) {
  if (depth > 32) return '[depth limit]';
  if (typeof value === 'string') return administratorSafeText(value).slice(0, 256000);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => safeAdministratorValue(item, depth + 1));
  if (!isPlainObject(value)) return null;
  if (['system','developer'].includes(value.role) || ['system_prompt','private_prompt'].includes(value.kind)
    || value.kind === 'meta' && /(?:system|private)[_-]?prompt|^消息 (?:system|developer)$/.test(value.title ?? '')
    || /^(?:system_prompt|private_prompt|systemPrompt)$/.test(value.type ?? '')) return { redacted: 'private prompt' };
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key) && !/^(?:systemPrompt|accessToken|refreshToken|apiKey|privatePrompt|agentToken|agent_token_hash|retry_profile)$/i.test(key))
    .map(([key, item]) => [key, safeAdministratorValue(item, depth + 1)]));
}
