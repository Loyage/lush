import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { check, isPlainObject } from './types.js';
import { validateConfigurationDirectory, withConfigurationWriteLock } from './device-config.js';

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const failure = (resource, reason) => new Error(`快速对话退役：${resource}无法安全清除（${reason}）；停止旧服务并检查私有文件后，显式重新启动/绑定项目重试。未确认完成，不自动重放。`);
function privateFile(file, required = false) {
  const published = exists(file);
  if (!published) { check(!required, 'private file missing'); return null; }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && !published.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600
      && stat.nlink === 1 && same(stat, published) && same(stat, fs.lstatSync(file)), 'unsafe private file');
    return stat;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Exact former schema, not a new callable history store. Guards stop writers admitted before retirement.
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL, references_json TEXT NOT NULL, prompt_json TEXT NOT NULL,
  source_json TEXT NOT NULL, binding_json TEXT NOT NULL, model TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL, result TEXT, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  error TEXT, truncated INTEGER NOT NULL, owner_pid INTEGER NOT NULL, owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_running_turn ON turns(conversation_id) WHERE status='running';
CREATE INDEX conversation_turns ON turns(conversation_id,id);
PRAGMA user_version=1;
`;
const GUARDS = ['meta', 'conversations', 'turns'].flatMap(table =>
  ['INSERT', 'UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER retired_${table}_${operation.toLowerCase()}
    BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'quick chat history retired'); END;`)).join('\n');
const schemaRows = db => db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
function validateSchema(db, retired) {
  const expected = new Database(':memory:');
  try {
    expected.exec(SCHEMA); if (retired) expected.exec(GUARDS);
    check(JSON.stringify(schemaRows(db)) === JSON.stringify(schemaRows(expected)), 'unknown schema');
  } finally { expected.close(); }
  check(db.query('PRAGMA quick_check').all().every(row => Object.values(row)[0] === 'ok')
    && db.query('PRAGMA foreign_key_check').all().length === 0, 'corrupt history');
}
function deadOwner(row) {
  if (!Number.isSafeInteger(row.owner_pid) || row.owner_pid <= 0 || typeof row.owner_id !== 'string' || !row.owner_id.length) return false;
  // No in-memory registry can prove that an old module in this process has stopped.
  try { process.kill(row.owner_pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

/** Erase only known DELETE-mode history. WAL/SHM are never checkpointed, unlinked or followed:
 * another connection may still own them. Reject even private sidecars, preserving recovery evidence.
 * Absent resources stay absent; a committed empty v2 tombstone is the recovery/old-writer barrier.
 */
export function retireChatHistory(home) {
  let db, reason = '权限、链接或文件身份不可信';
  try {
    check(typeof home === 'string' && path.isAbsolute(home), 'invalid history root');
    const config = { home };
    if (!validateConfigurationDirectory(config)) return { retired: false, already_retired: false };
    const root = fs.lstatSync(home), file = path.join(home, 'quick-chat.sqlite'), original = privateFile(file);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const stat = privateFile(`${file}${suffix}`);
      reason = '存在 WAL/SHM 或孤立 journal，未触碰并发资源';
      check(!stat || Boolean(original) && suffix === '-journal', 'unexpected history sidecar');
    }
    if (!original) return { retired: false, already_retired: false };
    reason = 'SQLite 锁、损坏数据或未知 schema';
    db = new Database(file, { strict: true });
    db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    const identity = () => {
      check(same(original, privateFile(file, true)) && same(root, fs.lstatSync(home)), 'identity changed');
      validateConfigurationDirectory(config, 'project', true);
      for (const suffix of ['-wal', '-shm']) check(!exists(`${file}${suffix}`), 'concurrent WAL sidecar');
      privateFile(`${file}-journal`);
    };
    identity();
    check(db.query('PRAGMA journal_mode').get().journal_mode === 'delete', 'unexpected journal mode');
    db.exec('PRAGMA secure_delete=ON;');
    return db.transaction(() => {
      identity();
      const version = db.query('PRAGMA user_version').get().user_version;
      check(version === 1 || version === 2, 'unknown version');
      const retired = version === 2;
      validateSchema(db, retired);
      if (retired) {
        check(db.query('SELECT count(*) AS n FROM conversations').get().n === 0
          && db.query('SELECT count(*) AS n FROM turns').get().n === 0
          && JSON.stringify(db.query('SELECT key,value FROM meta').all()) === JSON.stringify([{ key: 'retired', value: 'project-quick-chat' }]), 'invalid marker');
      } else {
        reason = '存在活跃或未知调用 owner';
        check(db.query("SELECT owner_pid,owner_id FROM turns WHERE status='running'").all().every(deadOwner), 'active owner');
        reason = 'SQLite 锁、文件身份改变或清理事务失败';
        db.exec('DELETE FROM turns; DELETE FROM conversations; DELETE FROM meta; DELETE FROM sqlite_sequence;');
        db.query("INSERT INTO meta(key,value) VALUES ('retired','project-quick-chat')").run();
        db.exec(`${GUARDS}\nPRAGMA user_version=2;`);
      }
      identity();
      return { retired: true, already_retired: retired };
    }).exclusive();
  } catch { throw failure('历史/Prompt 库', reason); }
  finally { db?.close(); }
}

const PROFILE_MARKER = { version: 2, retired: 'quick-chat' };
/** Use the same write lock as old settings writers. The v2 marker makes their read-before-save
 * fail closed; atomic publication is restart-recoverable and never copies user content to a backup.
 */
export function retireChatProfile(home) {
  let temporary, fd;
  try {
    check(typeof home === 'string' && path.isAbsolute(home), 'invalid profile root');
    const file = path.join(home, 'quick-explanation.json');
    if (!exists(file)) return { retired: false };
    validateConfigurationDirectory({ home }, 'project', true);
    privateFile(file, true);
    return withConfigurationWriteLock({ home }, 'project', lock => {
      const root = fs.lstatSync(home), original = privateFile(file, true);
      check(original.size <= 65536, 'oversized profile');
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      check(same(original, fs.fstatSync(fd)), 'identity changed');
      const text = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd);
      fs.closeSync(fd); fd = undefined;
      check(same(original, after) && original.size === after.size && original.mtimeMs === after.mtimeMs, 'profile changed');
      const data = JSON.parse(text);
      if (JSON.stringify(data) === JSON.stringify(PROFILE_MARKER)) return { retired: true, already_retired: true };
      check(isPlainObject(data) && data.version === 1 && Object.keys(data).every(key => ['version','connection_id','model','prompt'].includes(key))
        && (data.connection_id == null || typeof data.connection_id === 'string' && data.connection_id.length <= 160)
        && (data.model == null || typeof data.model === 'string' && data.model.length <= 256)
        && (data.prompt == null || typeof data.prompt === 'string' && data.prompt.length <= 8192), 'unknown profile schema');
      temporary = path.join(home, `.retired-chat-${randomUUID()}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify(PROFILE_MARKER) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      lock.assert(); check(same(original, privateFile(file, true)) && same(root, fs.lstatSync(home)), 'identity changed');
      fs.renameSync(temporary, file); temporary = null;
      const dir = fs.openSync(home, fs.constants.O_RDONLY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return { retired: true, already_retired: false };
    });
  } catch { throw failure('专用模型配置', '权限、链接、schema 或设置写锁不可信'); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
}

/** Called only at actual daemon startup or Host binding of one verified project, never registry
 * enumeration. Verify canonical ownership before touching attachments/device shared history.
 */
export function retireProjectChat(config) {
  try {
    check(config?.project && config.home === path.join(config.project, '.lush') && fs.realpathSync(config.project) === config.project, 'invalid project');
    const root = exists(config.home);
    if (!root) return { absent: true };
    check(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid() && fs.realpathSync(config.home) === config.home, 'unsafe project root');
    const bindingFile = path.join(config.home, 'project.json'), stat = privateFile(bindingFile);
    if (!stat) {
      check(!exists(path.join(config.home, 'quick-chat')) && !exists(path.join(config.home, 'quick-explanation.json')), 'unbound attachments');
      return { unbound: true }; // Web auth alone is not authorization to clean device data.
    }
    check(stat.size <= 65536, 'oversized binding');
    const fd = fs.openSync(bindingFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let binding;
    try {
      check(same(stat, fs.fstatSync(fd)), 'binding identity changed');
      binding = JSON.parse(fs.readFileSync(fd, 'utf8'));
      const after = fs.fstatSync(fd);
      check(stat.size === after.size && stat.mtimeMs === after.mtimeMs, 'binding changed');
    } finally { fs.closeSync(fd); }
    check(binding.version === 2 && binding.path === config.project && same(stat, privateFile(bindingFile, true)), 'project binding mismatch');
    // Project state roots may historically be less strict; attachments/profile roots still must
    // satisfy their original 0700 private-storage contract. Never repair permissions silently.
    const results = [retireChatHistory(path.join(config.home, 'quick-chat')), retireChatProfile(config.home)];
    if (config.deviceHome) results.push(retireChatHistory(config.deviceHome), retireChatProfile(config.deviceHome));
    return { resources: results };
  } catch (error) {
    if (error.message.startsWith('快速对话退役：')) throw error;
    throw failure('项目附属资源', 'canonical 项目归属、绑定或权限未核验');
  }
}
