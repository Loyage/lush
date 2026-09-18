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

test('non-git projects bind via manifest and can accept research tasks', () => {
  const root = temp();
  try {
    const config = Config.fromEnv(env(),root); config.prepare();
    fs.mkdirSync(path.join(root,'nested'));
    expect(discoverProject(path.join(root,'nested'))).toBe(root);
    expect(fs.statSync(config.home).mode & 0o777).toBe(0o700);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
