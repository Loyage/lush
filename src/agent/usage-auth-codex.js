import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Wire-format reference only: OpenAI's public Codex client. No Pi runtime or SDK dependency.
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const MAX_FILE = 512 * 1024, MAX_RESPONSE = 65536;
const flights = new Map();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\s\x00-\x1f\x7f$]/.test(value) && !value.startsWith('!');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error('Codex authentication unavailable'), { authCode: code }); };
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const valid = credential => object(credential) && credential.type === 'oauth' && token(credential.access)
  && typeof credential.expires === 'number' && Number.isFinite(credential.expires) && credential.expires > Date.now();
function accountId(credential) {
  if (typeof credential?.accountId === 'string' && credential.accountId.length > 0 && credential.accountId.length <= 1024) return credential.accountId;
  try {
    const claims = JSON.parse(Buffer.from(credential.access.split('.')[1], 'base64url').toString('utf8'));
    const id = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 && id.length <= 1024 ? id : null;
  } catch { return null; }
}
function parentState(file) {
  const dir = path.dirname(file), stat = fs.lstatSync(dir);
  // Reject aliases for writes: Pi uses lexical, not realpath, lock names. An alias could bypass its lock.
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)
    || fs.realpathSync(dir) !== dir) fail('auth_changed');
  return stat;
}
function read(file, parent) {
  let fd;
  try {
    if (!sameInode(parent, parentState(file))) fail('auth_changed');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > MAX_FILE || stat.nlink !== 1) fail('auth_changed');
    const raw = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > MAX_FILE || !sameVersion(stat, fs.fstatSync(fd))) fail('auth_changed');
    const data = JSON.parse(raw);
    if (!object(data) || !sameInode(stat, fs.lstatSync(file))) fail('auth_changed');
    return { stat, raw, data, credential: data['openai-codex'] };
  } catch (error) { if (error?.authCode) throw error; fail('auth_changed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sameCredential(a, b) { return digest(a ?? null) === digest(b ?? null); }
function compatibleAccount(expected, actual) {
  const first = accountId(expected), second = accountId(actual);
  return first && second ? first === second : sameCredential(expected, actual);
}
function lockOwned(lock, stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && sameInode(lock.stat, stat) && stat.mtimeMs === lock.stat.mtimeMs && stat.ctimeMs === lock.stat.ctimeMs;
}
function assertLock(lock) {
  if (lock.compromised || Date.now() - lock.updatedAt >= 5000) fail('auth_locked');
  let stat; try { stat = fs.lstatSync(lock.file); } catch { fail('auth_locked'); }
  if (!lockOwned(lock, stat)) { lock.compromised = true; fail('auth_locked'); }
}
function heartbeat(lock) {
  assertLock(lock);
  const now = new Date(Math.ceil(Date.now() / 1000) * 1000);
  fs.utimesSync(lock.file, now, now);
  lock.stat = fs.lstatSync(lock.file); lock.updatedAt = Date.now();
}
async function acquire(file, parent, timeout) {
  const lockPath = `${file}.lock`, deadline = Date.now() + timeout;
  for (;;) {
    if (!sameInode(parent, parentState(file))) fail('auth_changed');
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const lock = { file: lockPath, stat: fs.lstatSync(lockPath), updatedAt: Date.now(), compromised: false, timer: null };
      heartbeat(lock);
      lock.timer = setInterval(() => { try { heartbeat(lock); } catch { lock.compromised = true; } }, 1000);
      lock.timer.unref?.();
      return lock;
    } catch (error) {
      if (error?.code !== 'EEXIST') { if (error?.authCode) throw error; fail('auth_locked'); }
      // Never steal or remove an external/stale lock, even if proper-lockfile would consider it expired.
      if (Date.now() >= deadline) fail('auth_locked');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
}
function release(lock) {
  clearInterval(lock.timer);
  try { assertLock(lock); fs.rmdirSync(lock.file); } catch { /* Do not delete a replaced or compromised lock. */ }
}
async function responseJson(response) {
  if (response.status === 401 || response.status === 403) fail('unauthorized');
  if (response.status === 429) fail('rate_limited');
  if (!response.ok) fail('refresh_failed');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) fail('invalid_response');
  const reader = response.body?.getReader(); if (!reader) fail('invalid_response');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_RESPONSE) fail('invalid_response'); chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_response'); }
  } finally { await reader.cancel().catch(() => {}); }
}
async function refresh(credential, options) {
  const fetcher = options.authFetch || options.fetch || globalThis.fetch;
  const timeout = Number.isFinite(options.authTimeout ?? options.timeout) && (options.authTimeout ?? options.timeout) > 0
    ? Math.min(options.authTimeout ?? options.timeout, 8000) : 8000;
  const controller = new AbortController(); let timer;
  try {
    const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(), { authCode: 'timeout' })); }, timeout); });
    return await Promise.race([expired, (async () => {
      let response;
      try {
        response = await fetcher(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: CLIENT_ID }), redirect: 'error', signal: controller.signal });
      } catch { fail('network'); }
      const data = await responseJson(response);
      if (!token(data?.access_token) || !token(data?.refresh_token) || !Number.isFinite(data?.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000) fail('invalid_response');
      const id = accountId({ access: data.access_token });
      if (!id) fail('invalid_response');
      const previousId = accountId(credential);
      if (previousId && id !== previousId) fail('auth_changed');
      return { ...credential, access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000, accountId: id };
    })()]);
  } finally { clearTimeout(timer); controller.abort(); }
}
async function resolve(file, expected, options) {
  let lock;
  try {
    const parent = parentState(file), initial = read(file, parent);
    if (!sameCredential(expected, initial.credential)) {
      if (valid(initial.credential) && compatibleAccount(expected, initial.credential)) return { credential: initial.credential };
      fail('auth_changed');
    }
    if (valid(initial.credential)) return { credential: initial.credential };
    if (!object(initial.credential) || initial.credential.type !== 'oauth' || !token(initial.credential.access)
      || !Number.isFinite(initial.credential.expires) || initial.credential.expires <= 0 || !token(initial.credential.refresh)) fail('expired');
    if (options.refreshCodex === false) fail('expired');
    const lockTimeout = Number.isFinite(options.authLockTimeout) && options.authLockTimeout >= 0 ? Math.min(options.authLockTimeout, 2000) : 2000;
    lock = await acquire(file, parent, lockTimeout);
    const snapshot = read(file, parent);
    if (!sameCredential(expected, snapshot.credential)) {
      if (valid(snapshot.credential) && compatibleAccount(expected, snapshot.credential)) return { credential: snapshot.credential };
      fail('auth_changed');
    }
    if (valid(snapshot.credential)) return { credential: snapshot.credential };
    assertLock(lock);
    const credential = await refresh(snapshot.credential, options);
    assertLock(lock);
    const latest = read(file, parent);
    if (!sameVersion(snapshot.stat, latest.stat) || snapshot.raw !== latest.raw) fail('auth_changed');
    const payload = JSON.stringify({ ...latest.data, 'openai-codex': credential }, null, 2) + '\n';
    if (Buffer.byteLength(payload) > MAX_FILE) fail('invalid_response');
    const temporary = path.join(path.dirname(file), `.auth-usage-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, payload); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      assertLock(lock);
      const before = read(file, parent);
      if (!sameVersion(snapshot.stat, before.stat) || snapshot.raw !== before.raw) fail('auth_changed');
      fs.renameSync(temporary, file);
      // Rename is synchronous: no asynchronous work remains that could write after shutdown.
      return { credential };
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
  } catch (error) {
    const allowed = ['expired','auth_locked','auth_changed','refresh_failed','unauthorized','rate_limited','network','timeout','invalid_response'];
    return { error_code: allowed.includes(error?.authCode) ? error.authCode : 'refresh_failed' };
  } finally { if (lock) release(lock); }
}

/** Internal secret-bearing result; the caller must project only safe account fields into RPC. */
export function resolveCodexUsageCredential(authFile, expected, options = {}) {
  const file = path.resolve(authFile), key = digest([file, expected, options.refreshCodex !== false]);
  if (flights.has(key)) return flights.get(key);
  const pending = resolve(file, expected, options).finally(() => { if (flights.get(key) === pending) flights.delete(key); });
  flights.set(key, pending); return pending;
}
