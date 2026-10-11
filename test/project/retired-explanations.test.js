import { test, expect } from 'bun:test';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture } from '../helpers.js';
import { install, connection } from './agent-connection-fixture.js';
import { Store } from '../../src/persistence/store.js';
import { retireExplanationHistory } from '../../src/persistence/store/schema.js';
import { Dispatcher, HANDLERS } from '../../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';

const removed = ['quick_explain.start', 'quick_explain.followup', 'quick_explain.get', 'quick_explain.list', 'quick_explain.delete',
  'intro.start', 'intro.get', 'intro.list', 'intro.config', 'intro.configure', 'explanation.start', 'explanation.get', 'explanation.list'];
const legacyTables = `
CREATE TABLE introductions(id INTEGER PRIMARY KEY, task_id INTEGER, quote TEXT NOT NULL, location TEXT NOT NULL,
  status TEXT, result TEXT, error TEXT, base_url TEXT, model TEXT);
CREATE INDEX introductions_task ON introductions(task_id,id);
CREATE TABLE explanation_followups(id INTEGER PRIMARY KEY, introduction_id INTEGER NOT NULL REFERENCES introductions(id),
  question TEXT, answer TEXT, status TEXT, error TEXT, context_truncated INTEGER DEFAULT 0);
CREATE INDEX explanation_followups_intro ON explanation_followups(introduction_id,id);
`;
function seed(db, taskId = null) {
  db.exec(legacyTables);
  for (const [index, status] of ['running', 'completed', 'failed'].entries()) {
    db.query('INSERT INTO introductions VALUES (?,?,?,?,?,?,?,?,?)').run(index + 1, taskId, `private quote ${status}`, '{}', status,
      status === 'completed' ? 'private result' : null, status === 'failed' ? 'private error' : null, 'https://old.invalid', 'old-model');
    db.query('INSERT INTO explanation_followups(id,introduction_id,question,answer,status,error) VALUES (?,?,?,?,?,?)')
      .run(index + 1, index + 1, 'private question', status === 'completed' ? 'private answer' : null, status, status === 'failed' ? 'private error' : null);
  }
}
const absent = db => expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('introductions','introductions_task','explanation_followups','explanation_followups_intro')").all()).toEqual([]);

test('old explanation RPC and direct runtime/store entry points are gone before actor lookup', async () => {
  const f = fixture();
  try {
    let lookup = 0; const actor = f.project.actor;
    f.project.actor = () => { lookup++; throw new Error('must not authenticate removed methods'); };
    const dispatcher = new Dispatcher(f.project);
    for (const method of removed) {
      expect(PARAMS[method]).toBeUndefined(); expect(HANDLERS[method]).toBeUndefined(); expect(USER_ONLY.has(method)).toBe(false);
      await expect(dispatcher.dispatch(method, { _token: 'expired-secret', id: 1, quote: 'text' })).rejects.toThrow(`unknown method: ${method}`);
    }
    expect(lookup).toBe(0); f.project.actor = actor;
    for (const method of ['startExplanation', 'checkExplanationInput', 'checkExplanationProvider', 'explanationContext', 'explanation', 'explanations',
      'startIntro', 'runIntro', 'introInvoke', 'introduction', 'introductions', 'introConfig', 'configureIntro',
      'startQuickExplanation', 'followUpQuickExplanation', 'runQuickExplanation', 'runQuickExplanationFollowup', 'quickExplanation', 'quickExplanations', 'deleteExplanation'])
      expect(f.project[method]).toBeUndefined();
    for (const method of ['intro', 'introCreate', 'introFinish', 'introList', 'quickExplanationCreate', 'quickExplanationList',
      'quickExplanationFailRunning', 'deleteIntroduction', 'followup', 'followupCreate', 'followupList', 'followupFinish', 'followupFailRunning', 'deleteFollowups'])
      expect(f.store[method]).toBeUndefined();
    for (const property of ['introRunning', 'quickIntro', 'quickExplanationOptions']) expect(f.project[property]).toBeUndefined();
    expect(f.store.tasks()).toEqual([]); absent(f.store.db);
  } finally { await f.close(); }
});

test('shared chat model configuration still validates source/model, is user-only and never calls a model', async () => {
  const f = fixture(); const { manager } = install(f);
  try {
    expect(f.project.quickExplanationConfig().ready).toBe(false);
    const original = f.project.agentSettings.readStored();
    manager.connections[0].models = ['vendor/model'];
    for (const patch of [{ connection_id: 'missing' }, { connection_id: 'conn-one', model: 'wrong' }])
      expect(() => f.project.configureQuickExplanation(patch)).toThrow();
    const dispatcher = new Dispatcher(f.project);
    expect(await dispatcher.dispatch('quick_explain.configure', { config: { connection_id: 'conn-one', model: 'vendor/model', prompt: 'test prompt' } }))
      .toMatchObject({ ready: true, model: 'vendor/model', prompt: 'test prompt' });
    expect(await dispatcher.dispatch('quick_explain.config')).toMatchObject({ ready: true, configuration_scope: { selected: 'device' } });
    expect(f.project.agentSettings.readStored()).toEqual(original);
    for (const method of ['quick_explain.config', 'quick_explain.configure']) expect(() => assertAllowed(method, {}, 42)).toThrow('requires user approval');
    expect(() => f.project.quickExplanationConfig('project')).toThrow('project configuration overrides');
    manager.connections[0].enabled = false; expect(f.project.quickExplanationConfig().reason).toContain('禁用');
    manager.connections[0] = connection({ provider: 'openai-codex', auth_type: 'oauth' });
    expect(() => f.project.configureQuickExplanation({ connection_id: 'conn-one' })).toThrow('OAuth');
    manager.connections[0] = connection({ provider: 'kimi-coding' });
    expect(() => f.project.configureQuickExplanation({ connection_id: 'conn-one' })).toThrow('协议');
    expect(f.project.configureQuickExplanation({ connection_id: null, model: null, prompt: null }).ready).toBe(false);
    manager.connections[0] = connection({ credential: { status: 'unconfigured' } });
    f.project.quickExplanationSettings.save({ connection_id: 'conn-one', model: 'vendor/model' });
    expect(f.project.quickExplanationConfig().reason).toContain('API Key');
    expect(manager.calls).toBe(0); expect(f.store.tasks()).toEqual([]); absent(f.store.db);
  } finally { await f.close(); }
});

test('retained model settings still obey clear, deletion and shutdown write gates', async () => {
  const f = fixture(); install(f);
  try {
    f.project.clearing = true;
    expect(() => f.project.configureQuickExplanation({ prompt: 'new' })).toThrow('clear');
    f.project.clearing = false; f.project.workerDeleteIds = new Set([1]);
    expect(() => f.project.configureQuickExplanation({ prompt: 'new' })).toThrow('deletion');
    f.project.workerDeleteIds.clear(); f.project.stopping = true;
    expect(() => f.project.configureQuickExplanation({ prompt: 'new' })).toThrow('stopping');
    absent(f.store.db);
  } finally { f.project.clearing = false; f.project.workerDeleteIds?.clear(); await f.close(); }
});

test('upgrade removes every old explanation and follow-up but preserves development and historical no-tools records', async () => {
  const f = fixture(); let upgraded;
  try {
    f.project.kick = () => {};
    const inputId = Number(f.store.run('INSERT INTO inputs(content) VALUES (?)', 'original input').lastInsertRowid);
    const worker = f.store.create({ role: 'explainer', input_id: inputId, name: 'historical-explanation', goal: 'historical task' });
    f.store.update(worker.id, { status: 'completed', result: 'original Worker result' });
    const snapshot = { version: 1, task_id: worker.id, seq: 4, quote: 'original event snapshot', captured_at: 'then', step: { text: 'original execution' } };
    f.store.event(worker.id, 'explanation.requested', snapshot);
    const run = f.store.startRun(f.store.task(worker.id)); f.store.finishRun(run.id, 'completed', { result: 'original run' });
    f.store.addArtifact({ task_id: worker.id, run_id: run.id, input_id: inputId, kind: 'original', payload: { text: 'original artifact' } });
    f.store.run('INSERT INTO input_references(input_id,segment,ordinal,payload) VALUES (?,0,0,?)', inputId, JSON.stringify(snapshot));
    const tables = ['tasks', 'inputs', 'events', 'agent_runs', 'artifacts', 'input_references'];
    const before = tables.map(table => f.store.all(`SELECT * FROM ${table} ORDER BY rowid`));
    seed(f.store.db, worker.id);
    upgraded = new Store(path.join(f.config.home, 'project.db'), f.root);
    absent(upgraded.db);
    expect(tables.map(table => upgraded.all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
    expect(await f.project.invocationContext(f.store.task(worker.id), { recordId: run.id })).toEqual({ explanation: snapshot });
    f.project.recover();
    // Recovery can append device-policy audit events, but every original row must remain byte-for-byte unchanged.
    const recovered = tables.map(table => upgraded.all(`SELECT * FROM ${table} ORDER BY rowid`));
    expect(recovered.map((rows, index) => rows.slice(0, before[index].length))).toEqual(before);
    upgraded.close(); upgraded = new Store(path.join(f.config.home, 'project.db'), f.root);
    absent(upgraded.db); expect(tables.map(table => upgraded.all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(recovered);
  } finally { upgraded?.close(); await f.close(); }
});

test('retirement is atomic, idempotent and tolerates either missing legacy table', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=OFF;'); seed(db);
    // An unknown external FK must block retirement rather than partially dropping the follow-up table.
    db.exec('CREATE TABLE external_usage(id INTEGER REFERENCES introductions(id)); INSERT INTO external_usage VALUES (1);');
    expect(() => retireExplanationHistory(db)).toThrow();
    expect(db.query('SELECT count(*) AS n FROM introductions').get().n).toBe(3);
    expect(db.query('SELECT count(*) AS n FROM explanation_followups').get().n).toBe(3);
    expect(db.query('PRAGMA secure_delete').get().secure_delete).toBe(0);
    db.exec('DROP TABLE external_usage;'); retireExplanationHistory(db); absent(db);
    expect(db.query('PRAGMA secure_delete').get().secure_delete).toBe(0);
    retireExplanationHistory(db); absent(db);
    for (const table of ['introductions', 'explanation_followups']) {
      db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,private_text TEXT); INSERT INTO ${table} VALUES (1,'private');`);
      retireExplanationHistory(db); absent(db);
    }
  } finally { db.close(); }
});

test('another project binding is rejected before destructive retirement', async () => {
  const f = fixture();
  try {
    seed(f.store.db);
    expect(() => new Store(path.join(f.config.home, 'project.db'), f.root + '-other')).toThrow('database belongs to another project');
    expect(f.store.get('SELECT count(*) AS n FROM introductions').n).toBe(3);
    expect(f.store.get('SELECT count(*) AS n FROM explanation_followups').n).toBe(3);
    expect(f.store.get("SELECT value FROM meta WHERE key='project'").value).toBe(f.root);
  } finally { await f.close(); }
});
