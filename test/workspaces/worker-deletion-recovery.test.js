import { test,expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture,repo,git } from '../helpers.js';
async function setup(){const f=fixture();f.project.stopping=true;await repo(f.root);const task=(await f.project.say('discard input')).task;f.project.cancel(task.id);return {...f,task:f.store.task(task.id)};}
async function remove(f){const preview=await f.project.deleteTaskPreview(f.task.id);return f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision});}

test('detached baseline checkout is discovered and removed with its Worker',async()=>{
  const f=await setup();
  try{
    const baseline=path.join(f.config.home,'worktrees',`task-${f.task.id}-base`);
    await git(f.root,'worktree','add','--detach',baseline,f.task.base_commit);
    f.store.update(f.task.id,{baseline_workspace:baseline,baseline_commit:f.task.base_commit});
    const preview=await f.project.deleteTaskPreview(f.task.id);expect(preview.resources.worktrees).toContain(baseline);
    await remove(f);expect(fs.existsSync(baseline)).toBe(false);expect((await git(f.root,'worktree','list','--porcelain')).includes(baseline)).toBe(false);
  }finally{await f.close();}
});

test('new private session file during final asynchronous Git recheck prevents false-success deletion',async()=>{
  const f=await setup();
  try{
    const preview=await f.project.deleteTaskPreview(f.task.id),original=f.project.workspaces.workerDeletionResourcesUnsafe;
    const sessions=path.join(f.config.home,'sessions');fs.mkdirSync(sessions,{recursive:true});
    f.project.workspaces.workerDeletionResourcesUnsafe=async function(...args){
      const result=await original.apply(this,args);
      if(!fs.existsSync(f.task.workspace)) fs.writeFileSync(path.join(sessions,`late_lush-task-${f.task.id}.jsonl`),'late history');
      return result;
    };
    await expect(f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision})).rejects.toThrow('reappeared');
    expect(f.store.task(f.task.id).status).toBe('cancelled');
    f.project.workspaces.workerDeletionResourcesUnsafe=original;
    await remove(f);expect(fs.readdirSync(sessions)).toEqual([]);
  }finally{await f.close();}
});

test('shared branch/anchor paths block even when no surviving Worker row names the resource',async()=>{
  const f=await setup();
  try{
    f.store.recordBranch({branch:'external-history',parent:'main',created_from_commit:f.task.base_commit,worktree:f.task.workspace});
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('shared with branch');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
  }finally{await f.close();}
});
