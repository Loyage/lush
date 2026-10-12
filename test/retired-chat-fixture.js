import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

// Historical schema fixture remains test-only: no production history writer or model caller.
export function seedChat(home, { running = false, pid = process.pid } = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'quick-chat.sqlite');
  fs.writeFileSync(file, '', { mode: 0o600 });
  const db = new Database(file);
  db.exec(`
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
`);
  db.query("INSERT INTO meta VALUES ('prompts',?)").run('obsolete-prompt-SENTINEL');
  db.exec("INSERT INTO conversations VALUES (1,'obsolete-content-SENTINEL','[]','{}','{}','{}','model','then','then')");
  db.query('INSERT INTO turns VALUES (1,1,?,?,?,NULL,0,?,?,?,?)').run('old turn', running ? null : 'obsolete-response-SENTINEL'.repeat(5000),
    running ? 'running' : 'completed', pid, 'old-owner', 'then', 'then');
  db.close();
  return file;
}
export function seedProfile(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'quick-explanation.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, connection_id: 'source', model: 'obsolete-model', prompt: 'obsolete-prompt-SENTINEL' }), { mode: 0o600 });
  return file;
}
