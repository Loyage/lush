import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { check, id } from './types.js';

export const CLI_HISTORY_LIMITS = Object.freeze({ retained: 100, page: 20, response_bytes: 900000 });
const MAX_FILE = 64 * 1024 * 1024;
const safe = (stat, directory = false) => check((directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
  && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe Worker CLI history storage');
function locations(project) {
  const home = path.resolve(project.config.home);
  check(fs.realpathSync(home) === home, 'symlink Worker CLI history home');
  const directory = path.join(home, 'worker-cli-history');
  try { safe(fs.lstatSync(directory), true); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  check(fs.realpathSync(directory) === directory, 'symlink Worker CLI history directory');
  return { directory, keyFile: path.join(home, 'worker-cli-history.key') };
}
function readFile(file, max = MAX_FILE) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd); safe(stat); check(stat.size <= max, 'Worker CLI history file too large');
    return fs.readFileSync(fd);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function keyFor(locations, create) {
  let key = readFile(locations.keyFile, 32);
  if (key) { check(key.length === 32, 'invalid Worker CLI history key'); return key; }
  check(!fs.readdirSync(locations.directory).length, 'Worker CLI history key is missing; history preserved');
  if (!create) return null;
  key = randomBytes(32);
  const fd = fs.openSync(locations.keyFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(locations.keyFile));
  return key;
}
function binding(project, taskId) { return Buffer.from(JSON.stringify(['lush-worker-cli-history', 1, fs.realpathSync(project.config.project), taskId])); }
function open(project, taskId, create = false) {
  taskId = id(taskId);
  const task = project.store.task(taskId);
  check(['order','child'].includes(task.task_kind), 'CLI history requires an order/child Worker');
  check(!project.workerDeleteIds?.has(taskId), 'Worker deletion is in progress; CLI history is unavailable');
  const locations_ = locations(project), key = keyFor(locations_, create), file = path.join(locations_.directory, `${taskId}.json`);
  const bytes = readFile(file);
  let state = { version: 1, next: 1, entries: [] };
  if (bytes) {
    check(key, 'Worker CLI history key is missing; history preserved');
    try {
      const envelope = JSON.parse(bytes.toString('utf8'));
      check(envelope.version === 1, 'unsupported history');
      const nonce = Buffer.from(envelope.nonce, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      check(nonce.length === 12 && tag.length === 16, 'invalid history');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(binding(project, taskId)); decipher.setAuthTag(tag);
      state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      check(state.version === 1 && Number.isSafeInteger(state.next) && state.next > 0
        && Array.isArray(state.entries) && state.entries.length <= CLI_HISTORY_LIMITS.retained, 'invalid history');
      let previous = 0;
      for (const entry of state.entries) {
        check(Number.isSafeInteger(entry.id) && entry.id > previous && entry.id < state.next
          && typeof entry.created_at === 'string' && typeof entry.command === 'string' && typeof entry.workspace === 'string'
          && typeof entry.stdout === 'string' && typeof entry.stderr === 'string'
          && ['succeeded','failed','unknown'].includes(entry.status), 'invalid history entry');
        previous = entry.id;
      }
    } catch { throw new Error('Worker CLI history is damaged or cannot be authenticated; history preserved'); }
  }
  return { ...locations_, file, key, state, taskId };
}
function save(project, record) {
  const { file, key, state, taskId, directory } = record;
  check(key, 'Worker CLI history key is missing');
  // Synchronous read/modify/atomic-publish operations are serialized by this project's single daemon.
  // Recheck paths immediately before publication; never follow links or overwrite unsafe files.
  safe(fs.lstatSync(directory), true); readFile(file);
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(binding(project, taskId));
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  const body = JSON.stringify({ version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  check(Buffer.byteLength(body) <= MAX_FILE, 'Worker CLI history file too large');
  const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file); syncDirectory(directory);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
}
export function beginCLIHistory(project, taskId, command, workspace) {
  const record = open(project, taskId, true);
  check(record.state.next < Number.MAX_SAFE_INTEGER, 'Worker CLI history sequence exhausted');
  const entry = { id: record.state.next++, created_at: new Date().toISOString(), command, workspace,
    stdout: '', stderr: '', exit_code: null, signal: null, timed_out: false, truncated: false, duration_ms: 0, status: 'unknown' };
  record.state.entries.push(entry); record.state.entries = record.state.entries.slice(-CLI_HISTORY_LIMITS.retained);
  save(project, record); return { history_id: entry.id, created_at: entry.created_at };
}
export function finishCLIHistory(project, taskId, historyId, result) {
  const record = open(project, taskId), entry = record.state.entries.find(entry => entry.id === historyId);
  check(entry, 'Worker CLI history placeholder is missing');
  Object.assign(entry, result); save(project, record);
}
export function workerCLIHistory(project, params) {
  check(Number.isSafeInteger(params.id) && params.id > 0, 'invalid Worker CLI history id');
  check(params.before === undefined || Number.isSafeInteger(params.before) && params.before > 0, 'invalid Worker CLI history before');
  const limit = params.limit ?? 10;
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= CLI_HISTORY_LIMITS.page, 'Worker CLI history limit must be 1..20');
  const rows = open(project, params.id).state.entries.filter(entry => params.before === undefined || entry.id < params.before).reverse();
  const page = { entries: [], before: null, has_more: rows.length > 0 };
  for (const entry of rows.slice(0, limit)) {
    const candidate = { entries: [entry, ...page.entries], before: entry.id, has_more: rows.length > page.entries.length + 1 };
    if (Buffer.byteLength(JSON.stringify(candidate)) >= CLI_HISTORY_LIMITS.response_bytes) break;
    Object.assign(page, candidate);
  }
  check(!rows.length || page.entries.length, 'Worker CLI history entry exceeds response budget');
  return page;
}
export function clearWorkerCLIHistory(project, params) {
  check(Number.isSafeInteger(params.id) && params.id > 0, 'invalid Worker CLI history id');
  check(![...(project.cliRunning?.values() ?? [])].some(lease => lease.taskId === params.id), 'Worker CLI execution is in progress; history cannot be cleared');
  const record = open(project, params.id);
  if (record.key) { record.state.entries = []; save(project, record); }
  return { cleared: true };
}
