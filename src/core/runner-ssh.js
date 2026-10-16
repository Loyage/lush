import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { check } from './types.js';
import { posixFiles } from './workspaces/code-posix.js';

export const safeSshAlias = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
export const SSH_LIMITS = Object.freeze({ files: 32, bytes: 131072, file_bytes: 65536, aliases: 256, entries: 256, depth: 4, timeout_ms: 12000, output_bytes: 16384 });
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const owned = stat => stat.uid === process.getuid() && !(stat.mode & 0o022);
// No expansion, escapes, single quotes or continuations. Double quotes only group literal tokens.
function tokens(line) {
  if (line.length > 8192) return null;
  const result = []; let token = '', quote = '', started = false, closedQuote = false;
  for (const c of line) {
    if (!quote && c === '#') break;
    if (/[\x00-\x08\x0b-\x1f\x7f\\`$']/.test(c) || (closedQuote && !/\s/.test(c))) return null;
    if (quote) { if (c === quote) { quote = ''; closedQuote = true; } else token += c; started = true; }
    else if (c === '"') { if (started || !result.length) return null; quote = c; started = true; }
    else if (/\s/.test(c) || (c === '=' && result.length === 0)) { if (started) { result.push(token); token = ''; started = false; closedQuote = false; } }
    else { token += c; started = true; }
  }
  if (quote) return null;
  if (started) result.push(token);
  return result;
}
const pattern = value => /^!?[A-Za-z0-9*?][A-Za-z0-9_.*?!-]{0,127}$/.test(value);
const quote = value => `"${value}"`;

/** Current OS user's config only. Internal home seam is never accepted by RPC or device settings.
 * A bounded, no-follow directory-FD walk prevents Include escapes and replacement links.
 * Returns a private safe subset for the trial, never the original configuration text.
 */
export function readSshAliases({ home = os.userInfo().homedir } = {}) {
  const aliases = new Set(), lines = [], seen = new Set();
  let bytes = 0, entries = 0, files = 0, limited = false, status = 'ok', root;
  // Component-by-component openat from the verified root FD. `/proc/self/fd` path
  // traversal is Linux-only; on macOS `/dev/fd` cannot be descended into, so reuse
  // the project POSIX helper for both platforms instead of fd paths.
  function openRelative(relative, directory = false) {
    const parts = relative.split('/');
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..')) throw new Error('unsafe');
    let dir = null; // null means the borrowed root FD, which is never closed here.
    try {
      for (let i = 0; i < parts.length; i++) {
        const isDir = i < parts.length - 1 || directory;
        const next = posixFiles.openAt(dir === null ? root : dir, parts[i], isDir);
        const stat = fs.fstatSync(next);
        if (!owned(stat) || (isDir ? !stat.isDirectory() : !stat.isFile())) { fs.closeSync(next); throw new Error('unsafe'); }
        if (dir !== null) fs.closeSync(dir);
        dir = next;
      }
      const result = dir; dir = null; return result;
    } finally { if (dir !== null) fs.closeSync(dir); }
  }
  function include(value, depth) {
    let relative = value;
    const base = path.join(home, '.ssh');
    if (value.startsWith('~/.ssh/')) relative = value.slice(7);
    else if (path.isAbsolute(value) && value.startsWith(`${base}/`)) relative = value.slice(base.length + 1);
    else if (value.startsWith('~') || path.isAbsolute(value)) { limited = true; return; }
    if (!/^[A-Za-z0-9_./*?-]+$/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) { limited = true; return; }
    const slash = relative.lastIndexOf('/'), parent = slash < 0 ? '' : relative.slice(0, slash), leaf = relative.slice(slash + 1);
    // Globs in the final component only; no recursive expansion or external directories.
    if (/[*?]/.test(parent)) { limited = true; return; }
    if (!/[*?]/.test(leaf)) { read(relative, depth); return; }
    let fd;
    try {
      const directory = path.join(home, '.ssh', parent);
      fd = parent ? openRelative(parent, true) : null;
      // Node cannot readdir by FD. List the real path only when its resolved inode is
      // the directory just opened by FD; matches are re-opened via the FD walk below.
      const actual = fs.fstatSync(fd === null ? root : fd, { bigint: true }), listed = fs.statSync(directory, { bigint: true });
      if (actual.dev !== listed.dev || actual.ino !== listed.ino) { limited = true; return; }
      const names = [];
      for (const name of fs.readdirSync(directory)) {
        if (++entries > SSH_LIMITS.entries) { limited = true; break; }
        names.push(name);
      }
      const regex = new RegExp(`^${leaf.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      for (const name of names.sort()) if (regex.test(name)) read(parent ? `${parent}/${name}` : name, depth);
    } catch { limited = true; }
    finally { if (fd) fs.closeSync(fd); }
  }
  // Match blocks are never evaluated and never reach ssh. Include is expanded as text at its location.
  let inMatch = false, inHost = false;
  function read(relative, depth) {
    if (depth > SSH_LIMITS.depth || files >= SSH_LIMITS.files || seen.has(relative)) { limited = true; return; }
    seen.add(relative); files++;
    let fd;
    try {
      fd = openRelative(relative);
      const stat = fs.fstatSync(fd);
      if (stat.size > SSH_LIMITS.file_bytes || bytes + stat.size > SSH_LIMITS.bytes) { limited = true; return; }
      const buffer = Buffer.alloc(Math.min(SSH_LIMITS.file_bytes, SSH_LIMITS.bytes - bytes) + 1);
      let length = 0, count;
      while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += count;
      if (length === buffer.length) { limited = true; return; }
      bytes += length;
      const text = buffer.subarray(0, length).toString('utf8');
      if (/-----BEGIN .*PRIVATE KEY-----|\x00/.test(text)) { limited = true; return; }
      for (const line of text.split(/\r?\n/)) {
        const row = tokens(line);
        if (!row) { limited = true; inMatch = true; lines.push('Host !*'); continue; }
        if (!row.length) continue;
        const [raw, ...values] = row, key = raw.toLowerCase();
        if (key === 'match') { inMatch = true; limited = true; continue; }
        if (key === 'host') {
          inMatch = false; inHost = true;
          if (!values.length || !values.every(pattern)) { limited = true; lines.push('Host !*'); continue; }
          lines.push(`Host ${values.join(' ')}`);
          for (const value of values) if (safeSshAlias(value)) {
            if (aliases.size < SSH_LIMITS.aliases) aliases.add(value); else limited = true;
          }
          continue;
        }
        if (inMatch) continue;
        if (key === 'include') {
          // Conditional Include needs alias-specific OpenSSH evaluation; do not flatten it into a trial.
          if (inHost || !values.length) limited = true;
          for (const value of values) include(value, depth + 1);
          continue;
        }
        if (values.length !== 1) { limited = true; continue; }
        const value = values[0]; let valid = false, resolved = value;
        if (key === 'hostname') valid = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}$/.test(value);
        if (key === 'user') valid = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value);
        if (key === 'port') valid = /^[0-9]{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
        if (key === 'identitiesonly') valid = /^(yes|no)$/.test(value);
        if (key === 'identityfile') {
          resolved = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
          valid = path.isAbsolute(resolved) && resolved.startsWith(`${home}/`) && !resolved.split('/').includes('..') && /^[A-Za-z0-9_./ -]+$/.test(resolved);
        }
        if (valid) lines.push(`${key} ${quote(resolved)}`); else limited = true;
      }
    } catch (error) { if (relative === 'config') status = error.code === 'ENOENT' ? 'missing' : 'unavailable'; limited = true; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  try {
    root = fs.openSync(path.join(home, '.ssh'), flags | fs.constants.O_DIRECTORY);
    if (!owned(fs.fstatSync(root))) throw new Error('unsafe');
    read('config', 0);
  } catch (error) { status = error.code === 'ENOENT' ? 'missing' : 'unavailable'; limited = true; }
  finally { if (root !== undefined) fs.closeSync(root); }
  return { aliases: [...aliases].sort(), status, limited, configuration: lines.join('\n') + '\n' };
}

export function sshTrialArguments(ssh_alias, config) {
  check(safeSshAlias(ssh_alias), 'invalid SSH alias');
  return ['-F', config, '-T', ...['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'VerifyHostKeyDNS=no',
    'KnownHostsCommand=none', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ForwardAgent=no', 'ForwardX11=no',
    'ProxyCommand=none', 'ProxyJump=none', 'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'CanonicalizeHostname=no',
    'AddKeysToAgent=no', 'RemoteCommand=none', 'RequestTTY=no', 'SessionType=default', 'ForkAfterAuthentication=no',
    'ConnectionAttempts=1', 'ConnectTimeout=10', 'LogLevel=ERROR', 'StdinNull=yes', 'PKCS11Provider=none', 'SecurityKeyProvider=none'].flatMap(value => ['-o', value]), '--', ssh_alias, 'true'];
}

/** No stdout/stderr text escapes this boundary. No original config or system Match/exec is evaluated. */
export class RunnerSsh {
  constructor({ home, spawn_process = spawn, timeout_ms = SSH_LIMITS.timeout_ms } = {}) {
    this.options = { home }; this.spawn = spawn_process; this.timeout = timeout_ms; this.busy = false;
  }
  discover() { const { configuration, ...view } = readSshAliases(this.options); return view; }
  async test(ssh_alias) {
    check(safeSshAlias(ssh_alias), 'invalid SSH alias');
    check(!this.busy, 'SSH trial already in progress');
    this.busy = true;
    let temporary;
    try {
      const snapshot = readSshAliases(this.options);
      if (snapshot.status === 'unavailable') return { ok: false, reason: 'config_unavailable', checked_at: new Date().toISOString() };
      // A skipped clause may alter routing, authentication or inherited options for any alias.
      // Never turn an incomplete snapshot into a successful connection to a different target.
      if (snapshot.status !== 'missing' && snapshot.limited) return { ok: false, reason: 'config_unsupported', checked_at: new Date().toISOString() };
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-ssh-'));
      fs.chmodSync(temporary, 0o700);
      const config = path.join(temporary, 'config'); fs.writeFileSync(config, snapshot.configuration, { mode: 0o600, flag: 'wx' });
      const args = sshTrialArguments(ssh_alias, config);
      const env = Object.fromEntries(['PATH', 'SSH_AUTH_SOCK'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      const user = os.userInfo(); Object.assign(env, { HOME: user.homedir, USER: user.username, LOGNAME: user.username, LANG: 'C', LC_ALL: 'C' });
      return await new Promise(resolve => {
        let child, timer, reason = null, output = 0;
        const finish = (code = null) => { clearTimeout(timer); resolve({ ok: code === 0 && !reason, reason: reason || (code === 0 ? 'connected' : 'not_confirmed'), checked_at: new Date().toISOString() }); };
        try { child = this.spawn('ssh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { reason = 'not_confirmed'; finish(); return; }
        const stop = why => { reason ||= why; child.kill('SIGKILL'); };
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.length; if (output > SSH_LIMITS.output_bytes) stop('output_limit'); });
        child.once('error', () => { reason ||= 'not_confirmed'; });
        child.once('close', finish);
        timer = setTimeout(() => stop('timeout'), this.timeout);
      });
    } catch { return { ok: false, reason: 'not_confirmed', checked_at: new Date().toISOString() }; }
    finally {
      try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
      finally { this.busy = false; }
    }
  }
}
