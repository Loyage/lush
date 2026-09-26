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

test('空的 .git 目录不是项目边界，发现会继续到真正的仓库根', async () => {
  const outer = temp();
  try {
    await repo(outer);
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });   // 空目录，不是仓库
    fs.mkdirSync(path.join(inner, 'nested'));
    expect(discoverProject(path.join(inner, 'nested'))).toBe(outer);
  } finally { fs.rmSync(outer, { recursive: true, force: true }); }
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

test('project state and database cannot be rebound', () => {
  const a = temp(), b = temp();
  try {
    const config = Config.fromEnv(env(),a); config.prepare();
    const store = new Store(path.join(config.home,'project.db'),a); store.close();
    expect(() => new Store(path.join(config.home,'project.db'),b)).toThrow('another project');
    fs.writeFileSync(path.join(config.home,'project.json'),JSON.stringify({version:2,path:b}));
    expect(() => config.prepare()).toThrow('another project');
  } finally { fs.rmSync(a,{recursive:true,force:true}); fs.rmSync(b,{recursive:true,force:true}); }
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

test('the spec queue stores seq, deps and batch membership', () => {
  const root = temp();
  try {
    const config = Config.fromEnv(env(),root); config.prepare();
    const file = path.join(config.home,'project.db');
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
