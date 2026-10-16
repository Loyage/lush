import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dlopen, FFIType } from 'bun:ffi';
import { check, isPlainObject } from './types.js';
import { ensureConfigurationDirectory, validateConfigurationDirectory } from './device-config.js';

const FILE = 'runner-deployments.json', LOCK = '.runner-deployments.lock', MAX_BYTES = 4 * 1024 * 1024, MAX_ITEMS = 256;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const DEPLOYMENT_STATUSES = Object.freeze(['planned', 'blocked', 'running', 'ready', 'confirmed', 'failed', 'unknown']);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fdPath = fd => `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${fd}`;
const privateFile = stat => stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600;
const keys = (value, allowed) => isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key));
const unresolved = row => ['running', 'unknown'].includes(row.status);
const sameTarget = (a, b) => a.ssh_alias === b.ssh_alias || (typeof a.private_data?.remote?.machine_id === 'string'
  && a.private_data.remote.machine_id.length > 0 && a.private_data.remote.machine_id === b.private_data?.remote?.machine_id
  && Number.isSafeInteger(a.plan?.target?.uid) && a.plan.target.uid === b.plan?.target?.uid);
let library;
function flock(fd, flags) {
  check(process.platform === 'linux' || process.platform === 'darwin', 'Deployment locking is unsupported on this platform');
  if (!library) {
    for (const name of process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib'] : ['libc.so.6', 'libc.so']) {
      try { library = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); break; } catch { /* fixed libc candidates only */ }
    }
  }
  check(library, 'Deployment locking is unavailable');
  return library.symbols.flock(fd, flags);
}
function validate(record) {
  check(keys(record, ['id', 'revision', 'status', 'ssh_alias', 'name', 'project_id', 'node_id', 'runner_id', 'created_at', 'updated_at', 'plan', 'stages', 'private_data']), 'Invalid deployment receipt');
  check(UUID.test(record.id) && Number.isSafeInteger(record.revision) && record.revision > 0 && DEPLOYMENT_STATUSES.includes(record.status), 'Invalid deployment receipt identity');
  check(typeof record.ssh_alias === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(record.ssh_alias), 'Invalid deployment SSH alias');
  check(typeof record.name === 'string' && record.name.trim() === record.name && record.name.length > 0 && record.name.length <= 80 && !/[\x00-\x1f\x7f]/.test(record.name), 'Invalid deployment name');
  check(typeof record.project_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(record.project_id), 'Invalid deployment project');
  for (const key of ['created_at', 'updated_at']) check(typeof record[key] === 'string' && /^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(record[key]), 'Invalid deployment timestamp');
  check(record.node_id === undefined || UUID.test(record.node_id), 'Invalid deployment node');
  check(record.runner_id === undefined || typeof record.runner_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(record.runner_id), 'Invalid deployment installation');
  check(isPlainObject(record.plan) && isPlainObject(record.private_data) && Array.isArray(record.stages) && record.stages.length <= 32, 'Invalid deployment receipt body');
  return record;
}
const empty = () => ({ version: 1, items: [] });
function validateDocument(value) {
  check(keys(value, ['version', 'items']) && value.version === 1 && Array.isArray(value.items) && value.items.length <= MAX_ITEMS, 'Invalid deployment storage');
  value.items.forEach(validate);
  check(new Set(value.items.map(row => row.id)).size === value.items.length, 'Duplicate deployment receipt');
  return value;
}

/** Private device receipts. Network actions never hold this short, crash-released kernel flock.
 * The lock is independent of settings-write; closing/crashing releases its FD without guessing stale owners.
 */
export class DeploymentStore {
  constructor(config, { before_publish = null } = {}) {
    const home = config?.deviceHome ?? (!config?.project ? config?.home : null);
    check(typeof home === 'string' && path.isAbsolute(home), 'Deployment device directory is unavailable');
    this.config = { home: path.resolve(home) }; this.before_publish = before_publish;
  }
  #read(directory) {
    let fd;
    try {
      fd = fs.openSync(`${fdPath(directory)}/${FILE}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd); check(privateFile(stat) && stat.size <= MAX_BYTES, 'Unsafe deployment receipt storage');
      const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0, count;
      while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
      const after = fs.fstatSync(fd), published = fs.lstatSync(`${fdPath(directory)}/${FILE}`);
      check(size === stat.size && size <= MAX_BYTES && same(stat, after) && same(stat, published) && stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs, 'Deployment receipt changed while reading');
      return validateDocument(JSON.parse(buffer.subarray(0, size).toString('utf8')));
    } catch (error) { if (fd === undefined && error.code === 'ENOENT') return empty(); throw new Error('Deployment receipts cannot be safely read'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  #open() {
    if (!validateConfigurationDirectory(this.config)) return null;
    const fd = fs.openSync(this.config.home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { check(same(fs.fstatSync(fd), fs.lstatSync(this.config.home)), 'Deployment directory changed'); return fd; }
    catch (error) { fs.closeSync(fd); throw error; }
  }
  list() {
    const fd = this.#open();
    if (fd === null) return empty();
    try {
      const data = structuredClone(this.#read(fd));
      validateConfigurationDirectory(this.config, 'project', true);
      check(same(fs.fstatSync(fd), fs.lstatSync(this.config.home)), 'Deployment directory changed');
      return data;
    } finally { fs.closeSync(fd); }
  }
  read(id) {
    check(typeof id === 'string' && UUID.test(id), 'Invalid deployment receipt id');
    const record = this.list().items.find(row => row.id === id); check(record, 'Deployment receipt not found'); return record;
  }
  // A long operation lease is independent of the short receipt/settings write locks. A second
  // daemon may read receipts, but cannot reconcile a live operation or send its next stage.
  #lease(id, observe) {
    check(typeof id === 'string' && UUID.test(id), 'Invalid deployment lease id');
    const dir = this.#open();
    if (dir === null) { check(observe, 'Deployment receipt not found'); return false; }
    let lock, retained = false;
    const name = `.runner-deployment-${id}.lock`;
    try {
      const parent = fs.fstatSync(dir);
      try { lock = fs.openSync(`${fdPath(dir)}/${name}`, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (observe ? 0 : fs.constants.O_CREAT), 0o600); }
      catch (error) { if (observe && error.code === 'ENOENT') return false; throw error; }
      const identity = fs.fstatSync(lock);
      const assert = () => {
        validateConfigurationDirectory(this.config, 'project', true);
        check(privateFile(fs.fstatSync(lock)) && privateFile(fs.lstatSync(`${fdPath(dir)}/${name}`)) && same(identity, fs.lstatSync(`${fdPath(dir)}/${name}`))
          && same(parent, fs.lstatSync(this.config.home)), 'Deployment operation lease identity changed');
      };
      assert();
      const held = flock(lock, 2 | 4) === 0;
      if (observe) return !held;
      check(held, 'Deployment operation is already executing; no action was sent');
      retained = true; let released = false;
      return Object.freeze({ id, assert() { check(!released, 'Deployment operation lease was released'); assert(); }, release() {
        if (released) return;
        released = true; fs.closeSync(lock); fs.closeSync(dir);
      } });
    } catch (error) {
      if (error?.name === 'LushError') throw error;
      throw new Error('Deployment operation lease cannot be safely checked');
    } finally { if (!retained) { if (lock !== undefined) fs.closeSync(lock); fs.closeSync(dir); } }
  }
  lease(id) { this.read(id); return this.#lease(id, false); }
  isActive(id) { return this.#lease(id, true); }
  #write(fn, guard = null) {
    ensureConfigurationDirectory(this.config);
    const dir = this.#open(), parent = fs.fstatSync(dir); let lock, temporary;
    try {
      lock = fs.openSync(`${fdPath(dir)}/${LOCK}`, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      const identity = fs.fstatSync(lock); check(privateFile(identity), 'Unsafe deployment lock');
      check(flock(lock, 2 | 4) === 0, 'Deployment receipts are busy; no action was sent');
      const assert = () => {
        validateConfigurationDirectory(this.config, 'project', true);
        check(same(parent, fs.lstatSync(this.config.home)) && same(identity, fs.lstatSync(`${fdPath(dir)}/${LOCK}`)), 'Deployment storage identity changed');
      };
      assert(); guard?.(); const data = this.#read(dir), before = JSON.stringify(data), result = fn(data);
      check(!(result && typeof result.then === 'function'), 'Deployment receipt mutations must be synchronous');
      validateDocument(data); const source = JSON.stringify(data) + '\n';
      check(Buffer.byteLength(source) <= MAX_BYTES, 'Deployment receipt storage limit reached');
      this.before_publish?.(); assert(); guard?.();
      check(JSON.stringify(this.#read(dir)) === before, 'Deployment receipts changed before publication');
      temporary = `.${FILE}.${randomUUID()}.tmp`;
      const file = fs.openSync(`${fdPath(dir)}/${temporary}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(file, source); fs.fsyncSync(file); } finally { fs.closeSync(file); }
      assert(); fs.renameSync(`${fdPath(dir)}/${temporary}`, `${fdPath(dir)}/${FILE}`); temporary = null; fs.fsyncSync(dir);
      return structuredClone(result);
    } catch (error) {
      // Only our own fixed validation strings may surface; never raw JSON, paths or arbitrary IO diagnostics.
      if (error?.name === 'LushError') throw error;
      throw new Error('Deployment receipt write was not confirmed; inspect receipts before any further action');
    } finally {
      if (temporary) try { fs.unlinkSync(`${fdPath(dir)}/${temporary}`); } catch { /* do not clean an unverified path */ }
      if (lock !== undefined) fs.closeSync(lock);
      fs.closeSync(dir);
    }
  }
  create(value) {
    return this.#write(data => {
      check(data.items.length < MAX_ITEMS, 'Deployment receipt count limit reached');
      check(!data.items.some(row => unresolved(row) && sameTarget(row, value)), 'An unresolved deployment already exists for this SSH alias or target');
      const now = new Date().toISOString(), record = validate({ ...structuredClone(value), id: value.id ?? randomUUID(), revision: 1, created_at: now, updated_at: now });
      check(!data.items.some(row => row.id === record.id), 'Deployment receipt already exists'); data.items.push(record); return record;
    });
  }
  change(id, expected_revision, mutate, { guard = null } = {}) {
    check(typeof id === 'string' && UUID.test(id) && Number.isSafeInteger(expected_revision) && expected_revision > 0, 'Deployment identity and revision are required');
    return this.#write(data => {
      const index = data.items.findIndex(row => row.id === id), before = data.items[index]; check(before, 'Deployment receipt not found');
      check(before.revision === expected_revision, 'Deployment revision changed; reload before any further action');
      const next = structuredClone(before), changed = mutate(next);
      check(!(changed && typeof changed.then === 'function'), 'Deployment receipt mutations must be synchronous');
      check(['id', 'ssh_alias', 'name', 'project_id', 'created_at'].every(key => next[key] === before[key]), 'Deployment fixed identity cannot change');
      check(['node_id', 'runner_id'].every(key => before[key] === undefined || next[key] === before[key]), 'Deployment installation identity cannot change');
      if (next.status === 'running' && before.status !== 'running') {
        const confirmation = next.private_data.confirmation;
        check(before.status === 'planned' || before.status === 'ready' && !before.private_data.confirmation
          && next.private_data.operation_kind === 'confirm' && confirmation?.status === 'running'
          && confirmation.operation_id === next.private_data.operation_id && confirmation.from_revision === before.revision
          && typeof before.runner_id === 'string' && confirmation.runner_id === before.runner_id
          && before.private_data.proof?.runner_id === before.runner_id && before.private_data.proof?.stop_confirmed === true
          && before.private_data.proof?.barrier_confirmed === true && before.private_data.seal?.runner_id === before.runner_id,
        'An unresolved or finished deployment cannot be replayed');
        check(!data.items.some(row => row.id !== id && unresolved(row) && sameTarget(row, next)), 'An unresolved deployment already exists for this SSH alias or target');
      }
      if (before.private_data.plan_sha256) check(next.private_data.plan_sha256 === before.private_data.plan_sha256 && JSON.stringify(next.plan) === JSON.stringify(before.plan)
        && ['remote', 'ssh_sha256', 'plan_proof'].every(key => JSON.stringify(next.private_data[key]) === JSON.stringify(before.private_data[key])), 'Deployment fixed plan cannot change');
      next.revision = before.revision + 1; next.updated_at = new Date().toISOString(); validate(next); data.items[index] = next; return next;
    }, guard);
  }
}
