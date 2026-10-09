import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, object } from './connections-utils.js';
import { withConfigurationWriteLock } from '../core/device-config.js';
import { normalizeConnectionObservation } from '../persistence/store/agent-connections.js';

const MAX_BYTES = 2 * 1024 * 1024, MAX_ENTRIES = 60;
const keyValid = key => /^[a-f0-9]{64}$/.test(key);
const owner = stat => process.getuid === undefined || stat.uid === process.getuid();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const successful = observation => ['available', 'partial'].includes(observation.status);
function normalize(value) {
  if (!object(value) || !object(value.observation) || !Number.isFinite(Date.parse(value.observation.checked_at))
    || value.last_success && (!object(value.last_success.observation) || !Number.isFinite(Date.parse(value.last_success.observation.checked_at)))) fail('auth_changed');
  const observation = normalizeConnectionObservation(value.observation);
  const last = value.last_success ? normalizeConnectionObservation(value.last_success.observation) : null;
  return { observation, last_success: last && successful(last) ? { checked_at: last.checked_at, observation: last } : null };
}

/** Latest sanitized observations only, never project history, consumers or credentials. */
export class ConnectionObservationFile {
  constructor(connections) {
    this.connections = connections;
    this.file = path.join(connections.dir, 'agent-connection-observations.json');
  }
  read() {
    const parent = this.connections.directory();
    if (!parent) return {};
    let fd;
    try {
      try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
      catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || !owner(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > MAX_BYTES) fail('auth_changed');
      const raw = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
      if (Buffer.byteLength(raw) > MAX_BYTES || !same(stat, after) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
        || !same(stat, fs.lstatSync(this.file)) || !same(parent, this.connections.directory())) fail('auth_changed');
      const data = JSON.parse(raw);
      if (!object(data) || data.version !== 1 || !object(data.entries) || Object.keys(data.entries).length > MAX_ENTRIES) fail('auth_changed');
      const entries = {};
      for (const [key, entry] of Object.entries(data.entries)) {
        if (!keyValid(key)) fail('auth_changed');
        entries[key] = normalize(entry);
      }
      return entries;
    } catch { fail('auth_changed'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  get(key) { return this.read()[key] ?? null; }
  async put(key, value) {
    const observation = normalizeConnectionObservation(value), deadline = Date.now() + 2000;
    for (;;) {
      try {
        return withConfigurationWriteLock({ home: this.connections.home }, 'project', () => this.putLocked(key, observation));
      } catch (error) {
        const busy = error?.connectionCode === 'auth_locked' || String(error?.message).includes('busy');
        if (!busy || Date.now() >= deadline) {
          if (error?.connectionCode) throw error;
          fail(busy ? 'auth_locked' : 'auth_changed');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  putLocked(key, observation) {
    if (!keyValid(key)) fail('auth_changed');
    this.connections.directory(true);
    const lock = this.connections.lock('agent-connection-observations.lock');
    let temporary, fd;
    try {
      lock.assert();
      const entries = this.read(), old = entries[key];
      // Completion order need not match query start / passive response time.
      const latest = !old || observation.checked_at >= old.observation.checked_at ? observation : old.observation;
      const last = successful(observation) && (!old?.last_success || observation.checked_at >= old.last_success.checked_at)
        ? { checked_at: observation.checked_at, observation } : old?.last_success ?? null;
      entries[key] = { observation: latest, last_success: last };
      const keys = Object.keys(entries).sort((a, b) => entries[a].observation.checked_at.localeCompare(entries[b].observation.checked_at));
      while (keys.length > MAX_ENTRIES) delete entries[keys.shift()];
      let body = JSON.stringify({ version: 1, entries }) + '\n';
      while (Buffer.byteLength(body) > MAX_BYTES && keys.length > 1) {
        delete entries[keys.shift()]; body = JSON.stringify({ version: 1, entries }) + '\n';
      }
      if (Buffer.byteLength(body) > MAX_BYTES) fail('invalid_response');
      temporary = path.join(this.connections.dir, `.observations-${randomUUID()}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert(); this.read();
      fs.renameSync(temporary, this.file); temporary = null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Never remove a replaced temporary. */ } }
      lock.release();
    }
  }
}
