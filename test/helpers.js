import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { Store } from '../src/persistence/store.js';
import { Project } from '../src/core/project.js';
export function temp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-test-'))); }
export function env(extra = {}) { const out = { ...process.env }; for (const key of Object.keys(out)) if (key.startsWith('LUSH_')) delete out[key]; return { ...out, LUSH_PROVIDER: 'mock', ...extra }; }
export function fixture(provider, extra = {}) {
  const root = temp(); const config = new Config({ project: root, env: env(extra) }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root);
  const project = new Project(config, store, provider);
  return { root, config, store, project, async close() { await project.shutdown(); store.close(); fs.rmSync(root, { recursive:true, force:true }); } };
}
export async function until(fn, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = fn(); if (result) return result; await Bun.sleep(5); }
  throw new Error('condition timed out');
}
export function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export async function git(root, ...args) {
  const proc = Bun.spawn(['git','-C',root,...args], { stdout:'pipe',stderr:'pipe' });
  const [out,err,code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new Error(err); return out.trim();
}
export async function repo(root) {
  await git(root,'init','-b','main'); await git(root,'config','user.name','Lush Test'); await git(root,'config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(root,'.gitignore'), '.lush/\n'); fs.writeFileSync(path.join(root,'file.txt'),'base\n');
  await git(root,'add','.'); await git(root,'commit','-m','initial');
}
