import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { check } from './types.js';
import { ensureConfigurationDirectory, validateConfigurationDirectory } from './device-config.js';
import { chatFields, normalizeChatPrompt, normalizeChatReferences, chatContent } from './quick-chat-validation.js';

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
// Only this fixed replacement is public-safe; never tag the original SQLite/OS/JSON exception.
const storageError = () => Object.assign(new Error('快速对话私有历史无法安全读写，请检查权限或损坏数据；不要重复发送未确认的请求。'), { quickChatSafe: true });
const fileExists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function privateFile(file, required = false) {
  const published = fileExists(file);
  if (!published) { check(!required, 'private history missing'); return null; }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && !published.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600
      && stat.nlink === 1 && same(stat, published) && same(stat, fs.lstatSync(file)), 'unsafe private history');
    return stat;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
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
const activeOwners = new Set();
const alive = ({ owner_pid: pid, owner_id: owner }) => {
  if (pid === process.pid) return activeOwners.has(owner);
  // PID reuse or permission uncertainty is conservative: never fail another potentially active request.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const libraryModel = prompts => ({ version: 1, revision: createHash('sha256').update(JSON.stringify(prompts)).digest('hex'), prompts });
function library(db, defaultPrompt) {
  const stored = db?.query("SELECT value FROM meta WHERE key='prompts'").get();
  if (!stored) return libraryModel([{ id: 'explain', name: '快速解释', prompt: defaultPrompt, context_menu: true, builtin: true }]);
  const data = JSON.parse(stored.value); chatFields(data, ['version', 'prompts'], ['version', 'prompts']);
  check(data.version === 1 && Array.isArray(data.prompts) && data.prompts.length >= 1 && data.prompts.length <= 50, 'invalid prompt library');
  const prompts = data.prompts.map(value => normalizeChatPrompt(value, true));
  check(prompts.filter(value => value.id === 'explain').length === 1 && new Set(prompts.map(value => value.id)).size === prompts.length, 'invalid prompt identities');
  return libraryModel(prompts);
}
function latestStatus(db, conversationId) {
  return db.query('SELECT status FROM turns WHERE conversation_id=? ORDER BY id DESC LIMIT 1').get(conversationId)?.status;
}

/** Private device attachment, not the project Store. Open only for each bounded synchronous operation. */
export class QuickChatStore {
  constructor(home) {
    this.config = { home }; this.file = path.join(home, 'quick-chat.sqlite');
  }
  access(write, fn) {
    let db;
    try {
      if (write) ensureConfigurationDirectory(this.config);
      else if (!validateConfigurationDirectory(this.config)) return fn(null);
      const root = fs.lstatSync(this.config.home);
      let original = privateFile(this.file);
      if (!original && !write) return fn(null);
      if (!original) {
        let fd;
        try { fd = fs.openSync(this.file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
        original = privateFile(this.file, true);
      }
      // SQLite rollback journals share the protected root. WAL from an unknown format is rejected;
      // do not follow or silently remove an attacker-controlled journal/sidecar.
      let recoverJournal = false;
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const stat = privateFile(`${this.file}${suffix}`);
        check(!stat || suffix === '-journal', 'unexpected history sidecar');
        if (suffix === '-journal' && stat) recoverJournal = true;
      }
      // A private existing hot journal needs SQLite's rollback recovery, not model replay.
      // No absent resource is created on reads. SQLite's own locks distinguish hot from live journals.
      db = new Database(this.file, { readonly: !write && !recoverJournal, strict: true });
      db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      check(same(original, privateFile(this.file, true)) && same(root, fs.lstatSync(this.config.home)), 'history identity changed');
      const version = db.query('PRAGMA user_version').get().user_version;
      if (write && version === 0) {
        db.transaction(() => {
          // Another writer may have initialized while we waited for its SQLite lock.
          if (db.query('PRAGMA user_version').get().user_version === 1) return;
          check(db.query("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n === 0, 'unknown history schema');
          db.exec(SCHEMA);
        }).immediate();
      } else check(version === 1, 'unknown history version');
      if (write) check(db.query('PRAGMA journal_mode').get().journal_mode === 'delete', 'unexpected history journal mode');
      const run = () => {
        if (write) this.recover(db);
        const value = fn(db);
        check(same(original, privateFile(this.file, true)) && same(root, fs.lstatSync(this.config.home)), 'history identity changed');
        validateConfigurationDirectory(this.config, 'project', true);
        return value;
      };
      return write ? db.transaction(run).immediate() : run();
    } catch (error) {
      // Intentional safe validation errors are allowed; SQLite/OS/JSON errors contain private paths/data.
      if (error?.name === 'LushError') throw error;
      throw storageError();
    } finally { db?.close(); }
  }
  registerOwner(ownerId) { activeOwners.add(ownerId); }
  unregisterOwner(ownerId) { activeOwners.delete(ownerId); }
  recoverInterrupted() {
    const dead = this.access(false, db => db?.query("SELECT DISTINCT owner_pid,owner_id FROM turns WHERE status='running'").all()
      .some(row => Number.isSafeInteger(row.owner_pid) && row.owner_pid > 0 && !alive(row)) ?? false);
    if (dead) this.access(true, () => {});
  }
  recover(db) {
    const pending = db.query("SELECT DISTINCT owner_pid,owner_id FROM turns WHERE status='running'").all();
    const at = new Date().toISOString();
    for (const row of pending) if (Number.isSafeInteger(row.owner_pid) && row.owner_pid > 0 && !alive(row)) {
      db.query(`UPDATE conversations SET updated_at=? WHERE id IN
        (SELECT conversation_id FROM turns WHERE status='running' AND owner_pid=? AND owner_id=?)`).run(at, row.owner_pid, row.owner_id);
      db.query("UPDATE turns SET status='failed',error=?,updated_at=? WHERE status='running' AND owner_pid=? AND owner_id=?")
        .run('上次快速对话调用已中断，未自动重试。', at, row.owner_pid, row.owner_id);
    }
  }
  readLibrary(defaultPrompt) { return this.access(false, db => library(db, defaultPrompt)); }
  savePrompt(prompt, expected, defaultPrompt) {
    const next = normalizeChatPrompt(prompt), selected = next.id;
    return this.access(true, db => {
      const current = library(db, defaultPrompt);
      check(current.revision === expected, 'Prompt 库版本已变化，请保留编辑并重新读取');
      if (selected) check(current.prompts.some(row => row.id === selected), 'Prompt 不存在');
      else check(current.prompts.length < 50, '最多保存 50 个 Prompt');
      const value = { ...next, id: selected || randomUUID(), builtin: selected === 'explain' };
      const prompts = selected ? current.prompts.map(row => row.id === selected ? value : row) : [...current.prompts, value];
      db.query("INSERT INTO meta(key,value) VALUES ('prompts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ version: 1, prompts }));
      return libraryModel(prompts);
    });
  }
  removePrompt(promptId, expected, defaultPrompt) {
    return this.access(true, db => {
      const current = library(db, defaultPrompt);
      check(current.revision === expected, 'Prompt 库版本已变化，请保留编辑并重新读取');
      check(promptId !== 'explain', '内置快速解释不能删除，可以关闭右键注册');
      check(current.prompts.some(row => row.id === promptId), 'Prompt 不存在');
      const prompts = current.prompts.filter(row => row.id !== promptId);
      db.query("INSERT INTO meta(key,value) VALUES ('prompts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ version: 1, prompts }));
      return libraryModel(prompts);
    });
  }
  create(snapshot, defaultPrompt, ownerId) {
    return this.access(true, db => {
      const selected = library(db, defaultPrompt).prompts.find(row => row.id === snapshot.prompt.id);
      // Preparing a snapshot and claiming the request are separate steps. Recheck the same Prompt
      // so a concurrent edit cannot make a click run a different, unconfirmed instruction.
      check(selected && JSON.stringify(selected) === JSON.stringify(snapshot.prompt), 'Prompt 已变化，请重新读取后发送');
      this.capacity(db);
      const at = new Date().toISOString();
      const result = db.query(`INSERT INTO conversations(content,references_json,prompt_json,source_json,binding_json,model,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(snapshot.content, JSON.stringify(snapshot.references), JSON.stringify(snapshot.prompt),
          JSON.stringify(snapshot.source), JSON.stringify(snapshot.binding), snapshot.model, at, at);
      const id = Number(result.lastInsertRowid);
      check(Number.isSafeInteger(id), '对话编号已超出支持范围');
      const turn = this.addTurn(db, id, snapshot.content, false, ownerId, at);
      return { id, turnId: turn };
    });
  }
  capacity(db) { check(db.query("SELECT count(*) AS n FROM turns WHERE status='running'").get().n < 4, '最多同时进行 4 次快速对话，请稍后再试'); }
  addTurn(db, id, content, truncated, ownerId, at) {
    const result = db.query(`INSERT INTO turns(conversation_id,content,status,truncated,owner_pid,owner_id,created_at,updated_at)
      VALUES (?,?,'running',?,?,?,?,?)`).run(id, content, Number(truncated), process.pid, ownerId, at, at);
    const turnId = Number(result.lastInsertRowid); check(Number.isSafeInteger(turnId), '对话轮次已超出支持范围'); return turnId;
  }
  append(id, content, truncated, ownerId, expectedTurnId) {
    return this.access(true, db => {
      check(db.query('SELECT id FROM conversations WHERE id=?').get(id), '对话不存在');
      const current = db.query('SELECT id,status FROM turns WHERE conversation_id=? ORDER BY id DESC LIMIT 1').get(id);
      check(current?.status !== 'running', '这段对话正在调用模型，请等待本轮结束');
      check(current?.id === expectedTurnId, '对话已增加新轮次，请重新读取后发送');
      this.capacity(db);
      const at = new Date().toISOString(), turnId = this.addTurn(db, id, content, truncated, ownerId, at);
      db.query('UPDATE conversations SET updated_at=? WHERE id=?').run(at, id); return turnId;
    });
  }
  finish(turnId, ownerId, result, error = null) {
    return this.access(true, db => {
      const row = db.query("SELECT conversation_id FROM turns WHERE id=? AND owner_id=? AND status='running'").get(turnId, ownerId);
      if (!row) return false;
      const at = new Date().toISOString();
      db.query("UPDATE turns SET status=?,result=?,error=?,updated_at=? WHERE id=? AND owner_id=? AND status='running'")
        .run(error ? 'failed' : 'completed', result, error, at, turnId, ownerId);
      db.query('UPDATE conversations SET updated_at=? WHERE id=?').run(at, row.conversation_id); return true;
    });
  }
  raw(id) {
    return this.access(false, db => {
      const row = db?.query('SELECT * FROM conversations WHERE id=?').get(id);
      check(row, '对话不存在');
      try {
        const references = JSON.parse(row.references_json), prompt = JSON.parse(row.prompt_json), source = JSON.parse(row.source_json),
          binding = JSON.parse(row.binding_json), turns = db.query('SELECT * FROM turns WHERE conversation_id=? ORDER BY id').all(id);
        chatContent(row.content, true); normalizeChatReferences(references); normalizeChatPrompt(prompt, true);
        check(row.content.trim() || references.length > 0, 'invalid stored conversation input');
        chatFields(source, ['connection_id', 'label', 'provider', 'endpoint'], ['connection_id', 'label', 'provider', 'endpoint']);
        check(Object.values(source).every(value => typeof value === 'string' && value.length > 0 && value.length <= 8192), 'invalid stored source');
        const endpoint = new URL(source.endpoint);
        check(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'invalid stored endpoint');
        chatFields(binding, ['account_key', 'source_key', 'revision'], ['account_key', 'source_key', 'revision']);
        check(Object.values(binding).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'invalid stored binding');
        check(typeof row.model === 'string' && row.model.length > 0 && row.model.length <= 256 && turns.length > 0, 'invalid stored conversation');
        for (const turn of turns) {
          chatContent(turn.content, turn.id === turns[0].id);
          check(['running', 'completed', 'failed'].includes(turn.status) && (turn.result === null || typeof turn.result === 'string'
            && Buffer.byteLength(turn.result) <= 256 * 1024) && (turn.error === null || typeof turn.error === 'string' && turn.error.length <= 1000), 'invalid stored turn');
          check(turn.status === 'running' ? turn.result === null && turn.error === null
            : turn.status === 'completed' ? typeof turn.result === 'string' && turn.result.trim() && turn.error === null
              : turn.result === null && typeof turn.error === 'string' && turn.error.length > 0, 'inconsistent stored turn');
        }
        return { ...row, references, prompt, source, binding, turns };
      } catch { throw storageError(); }
    });
  }
  list(before, limit) {
    return this.access(false, db => {
      if (!db) return { conversations: [], has_more: false, next: null };
      const rows = db.query(`SELECT c.id,c.content,c.prompt_json,c.model,c.created_at,c.updated_at,
        (SELECT count(*) FROM turns t WHERE t.conversation_id=c.id) AS turn_count,
        (SELECT status FROM turns t WHERE t.conversation_id=c.id ORDER BY t.id DESC LIMIT 1) AS status
        FROM conversations c WHERE (? IS NULL OR c.id<?) ORDER BY c.id DESC LIMIT ?`).all(before, before, limit + 1);
      const page = rows.slice(0, limit);
      return { conversations: page.map(row => ({ id: row.id, number: `C${row.id}`, status: row.status,
        content: row.content.length > 180 ? `${row.content.slice(0, 180)}…` : row.content,
        prompt_name: normalizeChatPrompt(JSON.parse(row.prompt_json), true).name, model: row.model, created_at: row.created_at, updated_at: row.updated_at, turn_count: row.turn_count })),
      has_more: rows.length > limit, next: page.at(-1)?.id ?? null };
    });
  }
  delete(id) {
    return this.access(true, db => {
      check(db.query('SELECT id FROM conversations WHERE id=?').get(id), '对话不存在');
      check(latestStatus(db, id) !== 'running', '正在进行的对话不能删除，请等调用结束后再试');
      db.query('DELETE FROM conversations WHERE id=?').run(id); return { removed: id };
    });
  }
}
