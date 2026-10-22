import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, isPlainObject } from '../core/types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from '../core/device-config.js';
import { createVapidKeys, normalizePushSubscription, validateVapidKeys } from './web-push-transport.js';
import { NOTICE_CATEGORIES } from '../ui/web/assets/notice-channels.js';

export const PUSH_LIMITS = Object.freeze({ subscriptions: 16, sources: 64, seen: 1000, queue: 128, bytes: 8 * 1024 * 1024 });
const HEX = /^[a-f0-9]{64}$/;
const RECORD = /^[a-f0-9]{32}$/;
const PROJECT = /^[a-f0-9]{16}$/;
const NOTICE_TYPES = new Set(NOTICE_CATEGORIES.map(category => category.id));
const time = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
export function pushOrigin(value) {
  check(typeof value === 'string' && value.length < 512, 'invalid Web Push origin');
  let url; try { url = new URL(value); } catch { throw new Error('invalid Web Push origin'); }
  check(value === url.origin && !url.username && !url.password && (url.protocol === 'https:'
    || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))), 'Web Push requires HTTPS');
  return value;
}
function validate(data) {
  check(isPlainObject(data) && data.version === 1 && Array.isArray(data.subscriptions)
    && data.subscriptions.length <= PUSH_LIMITS.subscriptions && isPlainObject(data.sources)
    && Object.keys(data.sources).length <= PUSH_LIMITS.sources && Array.isArray(data.queue)
    && data.queue.length <= PUSH_LIMITS.queue && [null, true, false].includes(data.enabled)
    && time(data.enabled_since) && isPlainObject(data.channel_since), 'invalid Web Push storage');
  validateVapidKeys(data.keys);
  const ids = new Set();
  for (const row of data.subscriptions) {
    check(isPlainObject(row) && HEX.test(row.id) && !ids.has(row.id) && time(row.created_at)
      && time(row.last_test), 'invalid Web Push client');
    ids.add(row.id); pushOrigin(row.origin); normalizePushSubscription(row.subscription);
  }
  for (const [id, source] of Object.entries(data.sources)) {
    check(PROJECT.test(id) && isPlainObject(source) && typeof source.project === 'string' && path.isAbsolute(source.project)
      && (source.epoch === null || RECORD.test(source.epoch)) && (source.cursor === null
        || (typeof source.cursor === 'string' && source.cursor.length <= 1024))
      && typeof source.ready === 'boolean' && time(source.since) && time(source.floor)
      && Array.isArray(source.seen) && source.seen.length <= PUSH_LIMITS.seen, 'invalid Web Push source');
    for (const row of source.seen) check(Array.isArray(row) && row.length === 2 && RECORD.test(row[0]) && time(row[1]), 'invalid Web Push source identity');
  }
  for (const [category, since] of Object.entries(data.channel_since)) {
    check(NOTICE_TYPES.has(category) && time(since), 'invalid Web Push category');
  }
  const jobs = new Set();
  for (const job of data.queue) {
    check(isPlainObject(job) && HEX.test(job.id) && !jobs.has(job.id) && HEX.test(job.subscription_id)
      && PROJECT.test(job.project_id) && RECORD.test(job.identity) && RECORD.test(job.epoch)
      && Number.isSafeInteger(job.notice_id) && job.notice_id > 0
      && ['question', 'questionnaire', 'plan', 'info'].includes(job.kind)
      && (job.lifecycle_type === null || NOTICE_TYPES.has(job.lifecycle_type))
      && time(job.created_at) && time(job.next_attempt) && time(job.expires_at) && time(job.lease_until)
      && Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 3, 'invalid Web Push delivery');
    jobs.add(job.id);
  }
  return data;
}

/** All modifications are short synchronous transactions under the shared settings-write lock.
 * Separate credential namespaces prevent a newly authenticated Host from reusing old subscriptions.
 */
export class WebPushStore {
  constructor(config, authScope) {
    check(HEX.test(authScope), 'Web Push authentication binding required');
    this.config = { home: path.resolve(config.deviceHome || config.home) };
    this.file = path.join(this.config.home, `web-push-${authScope}.json`);
  }
  read() {
    let fd;
    try {
      if (!validateConfigurationDirectory(this.config)) return null;
      const root = fs.lstatSync(this.config.home);
      let before;
      try { before = fs.lstatSync(this.file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      check(before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid()
        && (before.mode & 0o777) === 0o600 && before.nlink === 1 && before.size <= PUSH_LIMITS.bytes, 'unsafe Web Push storage');
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd); check(same(before, opened), 'Web Push storage changed');
      const source = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
      check(Buffer.byteLength(source) <= PUSH_LIMITS.bytes && same(opened, after) && after.size === opened.size
        && after.mtimeMs === opened.mtimeMs && same(opened, fs.lstatSync(this.file))
        && same(root, fs.lstatSync(this.config.home)), 'Web Push storage changed');
      validateConfigurationDirectory(this.config, 'project', true);
      return validate(JSON.parse(source));
    } catch { throw new Error('Web Push private storage cannot be safely read'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  update(fn, { create = false } = {}) {
    try {
      return withConfigurationWriteLock(this.config, 'project', lock => {
        let data = this.read();
        if (!data && !create) return null;
        const original = data ? JSON.stringify(data) : null;
        data ||= { version: 1, keys: createVapidKeys(), subscriptions: [], sources: {}, queue: [],
          enabled: null, enabled_since: 0, channel_since: {} };
        const before = JSON.stringify(data), result = fn(data);
        validate(data);
        const serialized = JSON.stringify(data);
        check(Buffer.byteLength(serialized) <= PUSH_LIMITS.bytes, 'Web Push storage limit reached');
        if (serialized === before && fs.existsSync(this.file)) return result;
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        let fd;
        try {
          fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
          lock.assert();
          const current = this.read();
          check((current ? JSON.stringify(current) : null) === original, 'Web Push storage changed before publication');
          lock.assert(); fs.renameSync(temporary, this.file);
        } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
        return result;
      });
    } catch { throw new Error('Web Push private storage update was not confirmed'); }
  }
}
