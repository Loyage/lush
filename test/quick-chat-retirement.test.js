import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { retireChatHistory as retireDeviceQuickChats } from '../src/core/retired-chat.js';
import { seedChat } from './retired-chat-fixture.js';

const SECRET = 'obsolete-response-SENTINEL';
const PROMPT = 'obsolete-prompt-SENTINEL';
function fixture({ running = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-chat-retirement-'));
  const home = path.join(root, 'shared'), file = seedChat(home, { running });
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'outside-never-delete', { mode: 0o600 });
  return { root, home, file, turnId: 1, outside,
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const safeFailure = action => {
  let caught; try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error); expect(caught.message).toContain('无法安全清除');
  expect(caught.message).not.toContain(SECRET); expect(caught.message).not.toContain(PROMPT);
  return caught;
};

test('retirement of missing device roots/files is non-initializing and leaves unrelated resources intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-chat-missing-'));
  try {
    const missing = path.join(root, 'missing');
    expect(retireDeviceQuickChats(missing)).toEqual({ retired: false, already_retired: false });
    expect(fs.readdirSync(root)).toEqual([]);
    fs.mkdirSync(missing, { mode: 0o700 });
    fs.writeFileSync(path.join(missing, 'settings.json'), 'settings', { mode: 0o600 });
    expect(retireDeviceQuickChats(missing)).toEqual({ retired: false, already_retired: false });
    expect(fs.readdirSync(missing)).toEqual(['settings.json']);
    safeFailure(() => retireDeviceQuickChats('relative'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retirement securely deletes all old responses/Prompts and leaves an idempotent tombstone that blocks legacy writers', () => {
  const f = fixture();
  let waitingWriter;
  try {
    const projectHome = path.join(f.root, 'project', '.lush', 'quick-chat'), projectFile = seedChat(projectHome);
    const projectBytes = fs.readFileSync(projectFile);
    fs.writeFileSync(path.join(f.home, 'settings.json'), 'device-settings-retained', { mode: 0o600 });
    waitingWriter = new Database(f.file);
    expect(waitingWriter.query('PRAGMA user_version').get().user_version).toBe(1);
    expect(retireDeviceQuickChats(f.home)).toEqual({ retired: true, already_retired: false });
    const db = new Database(f.file, { readonly: true });
    try {
      expect(db.query('PRAGMA user_version').get().user_version).toBe(2);
      expect(db.query('SELECT * FROM conversations').all()).toEqual([]);
      expect(db.query('SELECT * FROM turns').all()).toEqual([]);
      expect(db.query('SELECT * FROM meta').all()).toEqual([{ key: 'retired', value: 'project-quick-chat' }]);
    } finally { db.close(); }
    expect(fs.readFileSync(f.file).includes(Buffer.from(SECRET))).toBe(false);
    expect(fs.readFileSync(f.file).includes(Buffer.from(PROMPT))).toBe(false);
    expect(fs.readFileSync(f.file).includes(Buffer.from('obsolete-content-SENTINEL'))).toBe(false);
    expect(() => waitingWriter.transaction(() => waitingWriter.query("INSERT INTO meta(key,value) VALUES ('prompts',?)").run(PROMPT)).immediate()).toThrow('retired');
    for (const sql of ['INSERT INTO conversations DEFAULT VALUES', 'INSERT INTO turns DEFAULT VALUES',
      "UPDATE meta SET value='changed' WHERE key='retired'", "DELETE FROM meta WHERE key='retired'"])
      expect(() => waitingWriter.exec(sql)).toThrow('retired');
    expect(retireDeviceQuickChats(f.home)).toEqual({ retired: true, already_retired: true });
    expect(fs.readFileSync(projectFile)).toEqual(projectBytes);
    expect(fs.readFileSync(path.join(f.home, 'settings.json'), 'utf8')).toBe('device-settings-retained');
    expect(fs.readFileSync(f.outside, 'utf8')).toBe('outside-never-delete');
  } finally { waitingWriter?.close(); f.close(); }
});

test('live local or foreign owners and unknown owner metadata refuse retirement without touching history', () => {
  for (const kind of ['local', 'foreign', 'invalid_pid', 'invalid_id']) {
    const f = fixture({ running: true });
    try {
      if (kind !== 'local') {
        const db = new Database(f.file);
        db.query('UPDATE turns SET owner_pid=?,owner_id=? WHERE id=?').run(kind === 'invalid_pid' ? 0 : process.ppid,
          kind === 'invalid_id' ? '' : 'foreign-live-owner', f.turnId);
        db.close();
      }
      const before = fs.readFileSync(f.file); safeFailure(() => retireDeviceQuickChats(f.home));
      expect(fs.readFileSync(f.file)).toEqual(before);
    } finally { f.close(); }
  }
});

test('dead owner claims are erased, not replayed or exposed as recoverable conversations', () => {
  const f = fixture({ running: true });
  try {
    const dead = new Database(f.file); dead.exec('UPDATE turns SET owner_pid=2147483647'); dead.close();
    expect(retireDeviceQuickChats(f.home).retired).toBe(true);
    const db = new Database(f.file, { readonly: true });
    try { expect(db.query('SELECT * FROM turns').all()).toEqual([]); } finally { db.close(); }
  } finally { f.close(); }
});

test('a live foreign process claim blocks retirement until that process has really exited', async () => {
  const f = fixture({ running: true }); let child;
  try {
    const script = `import { Database } from 'bun:sqlite'; const db=new Database(process.argv[1]);
      db.query("UPDATE turns SET owner_pid=?,owner_id='foreign-host' WHERE id=?").run(process.pid,process.argv[2]); db.close();
      console.log('claimed'); await new Response(Bun.stdin.stream()).text();`;
    child = Bun.spawn(['bun', '-e', script, f.file, String(f.turnId)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader(), ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe('claimed');
    safeFailure(() => retireDeviceQuickChats(f.home));
    child.stdin.end(); expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe('');
    expect(retireDeviceQuickChats(f.home).retired).toBe(true);
  } finally {
    if (child) { child.stdin.end(); if (child.exitCode === null) child.kill(); await child.exited; }
    f.close();
  }
});

test('unsafe roots, files and sidecars are rejected without following links or removing outside data', () => {
  for (const kind of ['root_mode', 'root_symlink', 'file_symlink', 'file_hardlink', 'file_mode', 'journal_symlink', 'journal_hardlink', 'wal', 'shm']) {
    const f = fixture();
    try {
      if (kind === 'root_mode') fs.chmodSync(f.home, 0o755);
      if (kind === 'root_symlink') { fs.renameSync(f.home, `${f.home}-original`); fs.symlinkSync(`${f.home}-original`, f.home); }
      if (kind === 'file_symlink' || kind === 'file_hardlink') {
        fs.unlinkSync(f.file); if (kind === 'file_symlink') fs.symlinkSync(f.outside, f.file); else fs.linkSync(f.outside, f.file);
      }
      if (kind === 'file_mode') fs.chmodSync(f.file, 0o644);
      if (kind === 'journal_symlink') fs.symlinkSync(f.outside, `${f.file}-journal`);
      if (kind === 'journal_hardlink') fs.linkSync(f.outside, `${f.file}-journal`);
      if (kind === 'wal' || kind === 'shm') fs.writeFileSync(`${f.file}-${kind}`, '', { mode: 0o600 });
      const before = fs.readFileSync(f.file);
      const error = safeFailure(() => retireDeviceQuickChats(f.home)); expect(error.message).not.toContain(f.root);
      expect(fs.readFileSync(f.file)).toEqual(before);
      expect(fs.readFileSync(f.outside, 'utf8')).toBe('outside-never-delete');
    } finally { f.close(); }
  }
});

test('orphan journals, unknown/corrupt SQLite schema and malformed retirement markers fail closed', () => {
  for (const kind of ['orphan', 'corrupt', 'schema', 'version', 'marker']) {
    const f = fixture();
    try {
      if (kind === 'orphan') { fs.unlinkSync(f.file); fs.writeFileSync(`${f.file}-journal`, '', { mode: 0o600 }); }
      if (kind === 'corrupt') fs.writeFileSync(f.file, 'SECRET raw broken database');
      if (kind === 'schema' || kind === 'version' || kind === 'marker') {
        const db = new Database(f.file);
        db.exec(kind === 'schema' ? 'CREATE TABLE unknown_private_data(value TEXT)' : `PRAGMA user_version=${kind === 'marker' ? 2 : 99}`); db.close();
      }
      const before = fs.existsSync(f.file) ? fs.readFileSync(f.file) : null;
      safeFailure(() => retireDeviceQuickChats(f.home));
      if (before) expect(fs.readFileSync(f.file)).toEqual(before); else expect(fs.existsSync(f.file)).toBe(false);
    } finally { f.close(); }
  }
});

test('another live SQLite writer blocks retirement; the completed attempt can then safely retry explicitly', async () => {
  const f = fixture(); let child;
  try {
    const script = `import { Database } from 'bun:sqlite'; const db=new Database(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE'); console.log('locked'); await new Response(Bun.stdin.stream()).text(); db.exec('ROLLBACK'); db.close();`;
    child = Bun.spawn(['bun', '-e', script, f.file], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader(), ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe('locked');
    safeFailure(() => retireDeviceQuickChats(f.home));
    child.stdin.end(); expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe('');
    expect(retireDeviceQuickChats(f.home).retired).toBe(true);
  } finally {
    if (child) { child.stdin.end(); if (child.exitCode === null) child.kill(); await child.exited; }
    f.close();
  }
});
