import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, object, fields, normalizeConnection, normalizeSampling, secret, validId } from './connections-utils.js';
import { withConfigurationWriteLock } from '../core/device-config.js';

const MAX_BYTES = 1024 * 1024;
export const emptyConnections = () => ({ version: 1,
  sampling: { enabled: false, interval_minutes: 5, retention_days: 90 }, connections: [] });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owner = stat => process.getuid === undefined || stat.uid === process.getuid();
const privateMode = (stat, mode) => (stat.mode & 0o777) === mode;

function validateCredential(value, authType) {
  if (value === null) return null;
  if (!object(value)) fail('auth_changed');
  if (authType === 'api_key') {
    fields(value, ['type','key'], 'stored credential');
    if (value.type !== 'api_key' || !secret(value.key)) fail('auth_changed');
    return { type: 'api_key', key: value.key };
  }
  fields(value, ['type','access','refresh','expires','accountId'], 'stored credential');
  if (value.type !== 'oauth' || !secret(value.access) || !secret(value.refresh)
    || !Number.isFinite(value.expires) || value.expires <= 0 || value.expires > 8640000000000000
    || typeof value.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.accountId)) fail('auth_changed');
  return { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires, accountId: value.accountId };
}
function validate(data) {
  try {
    fields(data, ['version','sampling','connections'], 'stored connections');
    if (data.version !== 1 || !Array.isArray(data.connections) || data.connections.length > 50) fail('auth_changed');
    const ids = new Set();
    const connections = data.connections.map(row => {
      fields(row, ['id','label','provider','endpoint','auth_type','enabled','models','default_model','default_thinking','notify_reset','revision','credential'], 'stored connection');
      if (!validId(row.id) || ids.has(row.id) || !validId(row.revision)) fail('auth_changed'); ids.add(row.id);
      const { revision, credential, ...config } = row;
      return { ...normalizeConnection(config, row.id), revision, credential: validateCredential(credential, row.auth_type) };
    });
    return { version: 1, sampling: normalizeSampling(data.sampling), connections };
  } catch { fail('auth_changed'); }
}

/** Project-owned file only. Never reads external Pi/Codex credentials. */
export class ConnectionFile {
  constructor(home, { privateRoot = false, migrationRead = false } = {}) {
    this.privateRoot = privateRoot;
    // Only the trusted migration module may bypass an interrupted handoff guard.
    this.migrationRead = migrationRead === true;
    this.home = path.resolve(home); this.dir = path.join(this.home, 'credentials');
    this.file = path.join(this.dir, 'agent-connections.json');
  }
  directory(create = false) {
    // POSIX mode bits do not enforce Windows ACLs. Never silently downgrade secret storage.
    if (process.platform === 'win32') fail('unsupported_platform');
    try {
      if (!fs.existsSync(this.home)) {
        if (!create) return null;
        fs.mkdirSync(this.home, { mode: 0o700 });
      }
      const home = fs.lstatSync(this.home);
      if (!home.isDirectory() || home.isSymbolicLink() || !owner(home)
        || process.platform !== 'win32' && home.mode & 0o022 || this.privateRoot && !privateMode(home, 0o700)
        || fs.realpathSync(this.home) !== this.home) fail('auth_changed');
      try { fs.lstatSync(this.dir); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        fs.mkdirSync(this.dir, { mode: 0o700 });
      }
      const dir = fs.lstatSync(this.dir);
      if (!dir.isDirectory() || dir.isSymbolicLink() || !owner(dir) || !privateMode(dir, 0o700)
        || fs.realpathSync(this.dir) !== this.dir) fail('auth_changed');
      return dir;
    } catch { fail('auth_changed'); }
  }
  read() {
    const parent = this.directory(); if (!parent) return emptyConnections();
    if (!this.migrationRead) {
      // Handoff starts before device publication. Interrupted retirement must not leave
      // two independent OAuth refresh owners, even after all advisory locks are released.
      const marker = path.join(this.dir, 'device-migration-active.json');
      try { fs.lstatSync(marker); }
      catch (error) { if (error.code === 'ENOENT') return this._read(parent); fail('auth_locked'); }
      fail('auth_locked'); // Any marker (including an unsafe alias or bad mode) fails closed.
    }
    return this._read(parent);
  }
  _read(parent) {
    let fd;
    try {
      try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
      catch (error) { if (error.code === 'ENOENT') return emptyConnections(); throw error; }
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || !owner(stat) || !privateMode(stat, 0o600) || stat.nlink !== 1 || stat.size > MAX_BYTES) fail('auth_changed');
      const raw = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
      if (Buffer.byteLength(raw) > MAX_BYTES || !same(stat, after) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
        || !same(stat, fs.lstatSync(this.file)) || !same(parent, this.directory())) fail('auth_changed');
      return validate(JSON.parse(raw));
    } catch { fail('auth_changed'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  lock(name) {
    const parent = this.directory(true), file = path.join(this.dir, name);
    try { fs.mkdirSync(file, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('auth_locked'); fail('auth_changed'); }
    const stat = fs.lstatSync(file);
    const assert = () => {
      let current; try { current = fs.lstatSync(file); } catch { fail('auth_locked'); }
      if (!current.isDirectory() || current.isSymbolicLink() || !owner(current) || !same(stat, current)
        || !same(parent, this.directory())) fail('auth_locked');
    };
    return { assert, release: () => { try { assert(); fs.rmdirSync(file); } catch { /* Never delete a replaced lock. */ } } };
  }
  transaction(fn) {
    // This root-level gate also coordinates explicit migrations and non-credential settings writers.
    try { return withConfigurationWriteLock({ home: this.home }, 'project', () => this._transaction(fn)); }
    catch (error) {
      if (error?.connectionCode) throw error;
      if (String(error?.message).includes('busy')) fail('auth_locked');
      fail('auth_changed');
    }
  }
  _transaction(fn) {
    const lock = this.lock('agent-connections.lock'); let temporary, fd;
    try {
      lock.assert(); const data = this.read(), result = fn(data);
      const body = JSON.stringify(validate(data), null, 2) + '\n';
      if (Buffer.byteLength(body) > MAX_BYTES) fail('invalid_response');
      temporary = path.join(this.dir, `.connections-${randomUUID()}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert();
      // Recheck the destination before publication; reads reject unsafe aliases/permissions.
      this.read(); fs.renameSync(temporary, this.file); temporary = null;
      return result;
    } catch (error) {
      if (error?.connectionCode || error?.name === 'LushError') throw error;
      fail('auth_changed');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
      lock.release();
    }
  }
  async refreshLock(id, signal, timeout = 2000) {
    if (!validId(id)) fail('auth_changed');
    const expires = Date.now() + Math.max(0, Math.min(timeout, 2000));
    for (;;) {
      if (signal?.aborted) fail('stopped');
      try { return this.lock(`refresh-${id}.lock`); }
      catch (error) {
        if (error.connectionCode !== 'auth_locked' || Date.now() >= expires) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
}
