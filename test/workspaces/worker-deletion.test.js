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
