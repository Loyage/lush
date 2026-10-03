import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture,repo,git } from '../helpers.js';
async function setup(){
  const f=fixture(); f.project.stopping=true; await repo(f.root);
  const order=await f.project.order('unwanted work'); const task=f.store.task(order.task.id); f.project.cancel(task.id);
  return {...f,task};
}
async function remove(f){const preview=await f.project.deleteTaskPreview(f.task.id); return f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision});}

test('discovers actual moved Git worktrees despite missing Worker/branch paths',async()=>{
  const f=await setup();
  try {
    const moved=path.join(f.config.home,'worktrees','moved-but-owned');
    await git(f.root,'worktree','move',f.task.workspace,moved);
    f.store.update(f.task.id,{workspace:null}); f.store.run('UPDATE branches SET worktree=NULL WHERE branch=?',f.task.branch);
    const preview=await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(true); expect(preview.resources.worktrees).toContain(moved);
    await remove(f); expect(fs.existsSync(moved)).toBe(false);
    expect((await git(f.root,'worktree','list','--porcelain')).includes(moved)).toBe(false);
  } finally{await f.close();}
});

test('reclaims deterministic orphan directory without a Git marker and refuses unknown repositories',async()=>{
  const f=await setup();
  try {
    await git(f.root,'worktree','remove',f.task.workspace);
    fs.mkdirSync(f.task.workspace); fs.writeFileSync(path.join(f.task.workspace,'orphan.txt'),'discard');
    expect((await f.project.deleteTaskPreview(f.task.id)).can_delete).toBe(true);
    await git(f.task.workspace,'init');
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('unknown ownership');
    fs.rmSync(path.join(f.task.workspace,'.git'),{recursive:true,force:true});
    await remove(f); expect(fs.existsSync(f.task.workspace)).toBe(false);
  }finally{await f.close();}
});

test('missing worktree directory still has its Git registration removed',async()=>{
  const f=await setup();
  try {
    fs.rmSync(f.task.workspace,{recursive:true,force:true});
    const preview=await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(true); expect(preview.resources.worktrees).toContain(f.task.workspace);
    await remove(f);
    expect((await git(f.root,'worktree','list','--porcelain')).includes(f.task.workspace)).toBe(false);
  } finally {await f.close();}
});

test('external/canonical checkouts and root symlinks are refused without any deletion',async()=>{
  const f=await setup();
  try {
    const external=path.join(f.root,'outside-worktree');
    await git(f.root,'worktree','move',f.task.workspace,external);
    f.store.update(f.task.id,{workspace:external});
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('outside project home');
    expect(fs.existsSync(external)).toBe(true);
    await git(f.root,'worktree','move',external,f.task.workspace);
    f.store.update(f.task.id,{workspace:f.root});
    expect((await f.project.deleteTaskPreview(f.task.id)).can_delete).toBe(false);
    f.store.update(f.task.id,{workspace:f.task.workspace});
    await git(f.root,'worktree','remove',f.task.workspace);
    fs.symlinkSync(f.root,f.task.workspace,'dir');
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('symlink');
    expect(fs.existsSync(path.join(f.root,'file.txt'))).toBe(true);
  }finally{await f.close();}
});

test('corrupt worktree metadata cannot delete project settings, sessions or an unowned directory',async()=>{
  const f=await setup();
  try {
    const sessions=path.join(f.config.home,'sessions'); fs.mkdirSync(sessions);
    const shared=path.join(sessions,'keep_lush-task-999.jsonl'); fs.writeFileSync(shared,'keep');
    const unowned=path.join(f.config.home,'worktrees','unowned-backup'); fs.mkdirSync(unowned);
    const backup=path.join(unowned,'important.txt'); fs.writeFileSync(backup,'keep');
    for (const dir of [sessions,path.join(f.config.home,'worktrees'),unowned]) {
      f.store.update(f.task.id,{workspace:dir});
      const preview=await f.project.deleteTaskPreview(f.task.id);
      expect(preview.can_delete).toBe(false);
      await expect(f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision})).rejects.toThrow();
      expect(fs.readFileSync(shared,'utf8')).toBe('keep');
      expect(fs.readFileSync(backup,'utf8')).toBe('keep');
      expect(fs.existsSync(f.task.workspace)).toBe(true);
    }
  }finally{await f.close();}
});

test('a directory disguised as a named private session file has unknown ownership',async()=>{
  const f=await setup();
  try {
    const file=path.join(f.config.home,'sessions',`task-${f.task.id}-context.json`);
    fs.mkdirSync(file,{recursive:true}); fs.writeFileSync(path.join(file,'unrelated.txt'),'keep');
    const preview=await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(false); expect(preview.blockers.join(' ')).toContain('unexpected type');
    expect(fs.readFileSync(path.join(file,'unrelated.txt'),'utf8')).toBe('keep');
  }finally{await f.close();}
});

test('session ancestor symlink and exact session file symlink are refused',async()=>{
  const f=await setup();
  try {
    const outside=path.join(f.root,'outside'); fs.mkdirSync(outside);
    const sessions=path.join(f.config.home,'sessions'); fs.symlinkSync(outside,sessions,'dir');
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('symlink');
    fs.unlinkSync(sessions); fs.mkdirSync(sessions);
    const target=path.join(outside,'keep.txt');fs.writeFileSync(target,'keep');
    fs.symlinkSync(target,path.join(sessions,`stamp_lush-task-${f.task.id}.jsonl`));
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('symlink');
    expect(fs.readFileSync(target,'utf8')).toBe('keep');
  }finally{await f.close();}
});

test('descendant symlinks are unlinked, never followed, when confirmed worktree contents are discarded',async()=>{
  const f=await setup();
  try {
    const target=path.join(f.root,'external-file.txt'); fs.writeFileSync(target,'keep');
    fs.symlinkSync(target,path.join(f.task.workspace,'link.txt'));
    await remove(f); expect(fs.readFileSync(target,'utf8')).toBe('keep');
  }finally{await f.close();}
});

test('locked worktree, a new checkout branch and shared paths are rejected',async()=>{
  const f=await setup();
  try {
    await git(f.root,'worktree','lock',f.task.workspace);
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('locked');
    await git(f.root,'worktree','unlock',f.task.workspace);
    await git(f.task.workspace,'checkout','-b','unexpected-ref');
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('another branch');
    await git(f.task.workspace,'checkout',f.task.branch);
    const other=(await f.project.order('keep work')).task;
    f.store.update(other.id,{baseline_workspace:f.task.workspace});
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('shared');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
  }finally{await f.close();}
});

test('partial resource removal failure leaves Worker history and a retry can finish cleanup',async()=>{
  const f=await setup();
  try {
    const preview=await f.project.deleteTaskPreview(f.task.id), original=f.project.workspaces.git;
    let failed=false;
    f.project.workspaces.git=async function(cwd,...args){
      if(!failed&&args[0]==='update-ref'&&args[1]==='-d'){failed=true;throw new Error('injected ref deletion error');}
      return original.call(this,cwd,...args);
    };
    await expect(f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision})).rejects.toThrow('injected');
    expect(fs.existsSync(f.task.workspace)).toBe(false);
    expect(f.store.task(f.task.id).status).toBe('cancelled');
    f.project.workspaces.git=original;
    await remove(f); expect(f.store.get('SELECT id FROM tasks WHERE id=?',f.task.id)).toBeNull();
  }finally{await f.close();}
});

test('does not remove another Worker session based on corrupt context pointer ownership',async()=>{
  const f=await setup();
  try {
    const sessions=path.join(f.config.home,'sessions');fs.mkdirSync(sessions);
    const file=path.join(sessions,'keep_lush-task-999.jsonl');fs.writeFileSync(file,'keep');
    f.store.run('INSERT INTO commit_contexts(commit_hash,task_id,session_path,entry_id) VALUES (?,?,?,?)',f.task.base_commit,f.task.id,file,'entry');
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('ownership');
    expect(fs.readFileSync(file,'utf8')).toBe('keep');
  }finally{await f.close();}
});
