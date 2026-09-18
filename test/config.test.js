import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config, discoverProject } from '../src/config.js';
import { Store } from '../src/persistence/store.js';
import { temp, env, repo, git } from './helpers.js';

test('project discovery finds git root and canonicalizes symlinks', async () => {
  const root = temp();
  try {
    await repo(root); fs.mkdirSync(path.join(root,'a','b'),{recursive:true});
    expect(discoverProject(path.join(root,'a','b'))).toBe(root);
    fs.symlinkSync(root,path.join(root,'alias'));
    expect(Config.fromEnv(env(),path.join(root,'alias')).project).toBe(root);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('git worktrees are independent project boundaries', async () => {
  const root = temp(), other = temp();
  try {
    await repo(root); await git(root,'worktree','add','-b','other',other);
    const a = Config.fromEnv(env(),root), b = Config.fromEnv(env(),other);
    expect(a.project).not.toBe(b.project); expect(a.socket).not.toBe(b.socket); expect(a.home).not.toBe(b.home);
  } finally { fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(other,{recursive:true,force:true}); }
});

test('explicit project binding overrides cwd and inherited global home is rejected', () => {
  const a = temp(), b = temp();
  try {
    expect(Config.fromEnv(env({LUSH_PROJECT:a}),b).project).toBe(a);
    expect(() => Config.fromEnv(env({LUSH_HOME:path.join(a,'wrong')}),a)).toThrow('LUSH_HOME');
    expect(() => Config.fromEnv(env({LUSH_CONCURRENCY:'2x'}),a)).toThrow('integer');
  } finally { fs.rmSync(a,{recursive:true,force:true}); fs.rmSync(b,{recursive:true,force:true}); }
});

test('project state and database cannot be rebound; legacy data is never silently read', () => {
  const a = temp(), b = temp();
  try {
    const config = Config.fromEnv(env(),a); config.prepare();
    const store = new Store(path.join(config.home,'project.db'),a); store.close();
    expect(() => new Store(path.join(config.home,'project.db'),b)).toThrow('another project');
    fs.writeFileSync(path.join(config.home,'project.json'),JSON.stringify({version:2,path:b}));
    expect(() => config.prepare()).toThrow('another project');
    fs.mkdirSync(path.join(b,'.lush')); fs.writeFileSync(path.join(b,'.lush','lush.db'),'legacy');
    expect(() => Config.fromEnv(env(),b).prepare()).toThrow('legacy');
    expect(fs.readFileSync(path.join(b,'.lush','lush.db'),'utf8')).toBe('legacy');
  } finally { fs.rmSync(a,{recursive:true,force:true}); fs.rmSync(b,{recursive:true,force:true}); }
});

test('agent identity columns are added to a database written by an earlier build', () => {
  const root = temp();
  try {
    const config = Config.fromEnv(env(),root); config.prepare();
    const file = path.join(config.home,'project.db');
    const store = new Store(file,root);
    const task = store.create({ input_id: null, role: 'planner', goal: 'before the upgrade' });
    store.run('DROP INDEX IF EXISTS tasks_agent_token');
    for (const column of ['agent_wakes','agent_token_hash','agent_last_seen_at']) store.run(`ALTER TABLE tasks DROP COLUMN ${column}`);
    store.close();
    const reopened = new Store(file,root);
    expect(reopened.tasks().map(row => row.agent_wakes)).toEqual([0]);
    expect(reopened.agentByToken('deadbeef')).toBeNull();
    reopened.armAgent(task.id,'deadbeef');
    expect(reopened.agentByToken('deadbeef').id).toBe(task.id);
    reopened.touchAgent(task.id);
    expect(reopened.task(task.id).agent_last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    reopened.close();
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('the input flow column is added to a database written by an earlier build', () => {
  const root = temp();
  try {
    const config = Config.fromEnv(env(),root); config.prepare();
    const file = path.join(config.home,'project.db');
    const store = new Store(file,root);
    store.run('ALTER TABLE inputs DROP COLUMN flow');
    expect(store.all('PRAGMA table_info(inputs)').map(row => row.name)).not.toContain('flow');
    store.close();
    const reopened = new Store(file,root);
    expect(reopened.all('PRAGMA table_info(inputs)').map(row => row.name)).toContain('flow');
    reopened.run('INSERT INTO inputs(content) VALUES (?)','after upgrade');
    expect(reopened.get('SELECT flow FROM inputs').flow).toBeNull();
    reopened.close();
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('non-git projects bind via manifest and can accept research tasks', () => {
  const root = temp();
  try {
    const config = Config.fromEnv(env(),root); config.prepare();
    fs.mkdirSync(path.join(root,'nested'));
    expect(discoverProject(path.join(root,'nested'))).toBe(root);
    expect(fs.statSync(config.home).mode & 0o777).toBe(0o700);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('the spec queue table is added to a database written by an earlier build', () => {
  const root = temp();
  try {
    const config = Config.fromEnv(env(),root); config.prepare();
    const file = path.join(config.home,'project.db');
    const store = new Store(file,root);
    store.run('DROP TABLE task_specs');
    expect(store.get("SELECT name FROM sqlite_master WHERE name='task_specs'")).toBeNull();
    store.close();
    const reopened = new Store(file,root);
    expect(reopened.get("SELECT name FROM sqlite_master WHERE name='task_specs'")).toBeTruthy();
    const planner = reopened.create({ input_id: null, role: 'planner', goal: 'plan' });
    const first = reopened.addSpec({ input_id: null, planner_task_id: planner.id, goal: 'first', role: 'research', name: 'first', deps: [] });
    const second = reopened.addSpec({ input_id: null, planner_task_id: planner.id, goal: 'second', role: 'worker', name: 'second', deps: [{ spec: first.id, kind: 'code' }] });
    expect(second).toMatchObject({ seq: 2, status: 'pending' });
    expect(second.deps).toEqual([{ spec: first.id, kind: 'code' }]);
    expect(reopened.pendingSpecs().map(row => row.id)).toEqual([first.id, second.id]);
    expect(reopened.specStats()).toEqual({ pending: 2, planned: 0, dropped: 0 });
    const batch = reopened.create({ input_id: null, role: 'scheduler', goal: 'batch' });
    expect(reopened.takeSpecs(batch.id, 50).map(row => row.id)).toEqual([first.id, second.id]);
    expect(reopened.specsForBatch(batch.id).map(row => row.status)).toEqual(['pending','pending']);
    reopened.dropSpec(first.id, 'nope');
    expect(reopened.spec(first.id)).toMatchObject({ status: 'dropped', note: 'nope' });
    reopened.releaseBatch(batch.id, 'back to queue');
    expect(reopened.spec(second.id)).toMatchObject({ status: 'pending', batch_id: null, note: 'back to queue' });
    reopened.close();
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
