import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate } from '../helpers.js';

async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const order = await f.project.order('mistyped input');
  return {...f,task:f.store.task(order.task.id),inputId:order.task.input_id};
}
async function remove(f,id=f.task.id) {
  const preview = await f.project.deleteTaskPreview(id);
  return f.project.deleteTask(id,{revision:preview.revision,confirm:true});
}

test('confirmation is mandatory; preview is read-only and reports live/owner blockers',async()=>{
  const f = await setup();
  try {
    const preview = await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(false); expect(preview.blockers.join(' ')).toContain('cancel');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    expect((await f.project.deleteTaskPreview(f.task.parent_id)).blockers.join(' ')).toContain('main/owner');
    await expect(f.project.deleteTask(f.task.id)).rejects.toThrow('confirm');
    f.project.cancel(f.task.id);
    await expect(f.project.deleteTask(f.task.id,{confirm:true})).rejects.toThrow('revision');
    expect(f.store.task(f.task.id).status).toBe('cancelled');
  } finally {await f.close();}
});

test('confirmed subtree deletion discards unmerged and dirty code, deletes input/draft and all private resources',async()=>{
  const f = await setup();
  try {
    const child = await f.project.spawn(f.task.id,'mistyped child',undefined,[], 'bad-child');
    const cwd = f.store.task(child.id).workspace;
    fs.writeFileSync(path.join(cwd,'file.txt'),'unmerged change\n');
    await git(cwd,'add','.'); await git(cwd,'commit','-m','unwanted code');
    fs.writeFileSync(path.join(cwd,'untracked.txt'),'discard me');
    const sessions = path.join(f.config.home,'sessions'); fs.mkdirSync(sessions,{recursive:true});
    const session = path.join(sessions,`2026_lush-task-${child.id}.jsonl`); fs.writeFileSync(session,'history');
    for (const name of [`task-${child.id}-input.md`,`task-${child.id}-system.md`,`task-${child.id}-context.json`,`codex-task-${child.id}.json`,`codex-task-${child.id}-result.md`,`decision-${child.id}.json`,`task-${child.id}-context.json.123.tmp`,`codex-task-${child.id}.json.456.tmp`]) fs.writeFileSync(path.join(sessions,name),'private');
    fs.writeFileSync(path.join(sessions,`keep_lush-task-${child.id+100}.jsonl`),'keep');
    const otherTemp = path.join(sessions,`task-${child.id+100}-context.json.123.tmp`);
    fs.writeFileSync(otherTemp,'keep');
    for (const [directory,name] of [['task-rules',`task-${child.id}.mjs`],['preempt',`task-${child.id}.request.json`],['preempt',`task-${child.id}.stop.json`]]) {
      const dir=path.join(f.config.home,directory); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,name),'private');
    }
    const verify = path.join(f.config.home,'verify',String(child.id)); fs.mkdirSync(verify,{recursive:true}); fs.writeFileSync(path.join(verify,'report.html'),'private');
    const commit = await git(cwd,'rev-parse','HEAD');
    f.store.run('INSERT INTO commit_contexts(commit_hash,task_id,session_path,entry_id) VALUES (?,?,?,?)',commit,child.id,session,'entry');
    const checkpoints = path.join(f.config.home,'session-checkpoints'); fs.mkdirSync(checkpoints,{recursive:true}); fs.writeFileSync(path.join(checkpoints,`${commit}.jsonl`),'history');
    const draft=f.store.run('INSERT INTO drafts(content,input_id) VALUES (?,?)','draft raw',f.inputId);
    f.store.run('INSERT INTO draft_references(draft_id,ordinal,payload) VALUES (?,0,?)',Number(draft.lastInsertRowid),'{}');
    f.store.run('INSERT INTO input_references(input_id,segment,ordinal,payload) VALUES (?,0,0,?)',f.inputId,'{}');
    const run=f.store.startRun(f.store.task(child.id)); f.store.finishRun(run.id,'cancelled',{error:'private failure'});
    f.store.addArtifact({task_id:child.id,run_id:run.id,input_id:f.inputId,kind:'private',payload:{text:'private'}});
    f.store.run("INSERT INTO introductions(task_id,quote,location,status,result) VALUES (?,?,?,'completed',?)",child.id,'private','worker','private result');
    f.store.message(f.task.id,'private parent message',child.id); f.store.event(child.id,'private',{text:'private'});
    f.project.cancel(f.task.id);
    const preview = await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(true);
    expect(preview.workers.map(row=>row.id)).toEqual([f.task.id,child.id]);
    expect(preview.resources.worktrees).toContain(cwd); expect(preview.resources.files).toContain(session);
    const result = await f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision});
    expect(result.deleted.ids).toEqual([f.task.id,child.id]);
    expect(f.store.get('SELECT * FROM inputs WHERE id=?',f.inputId)).toBeNull();
    expect(f.store.get('SELECT * FROM drafts WHERE input_id=?',f.inputId)).toBeNull();
    for (const table of ['messages','events','notices','agent_runs','artifacts','commit_contexts','introductions'])
      expect(f.store.get(`SELECT count(*) AS count FROM ${table} WHERE task_id IN (?,?)`,f.task.id,child.id).count).toBe(0);
    for (const file of [...preview.resources.worktrees,...preview.resources.files]) expect(fs.existsSync(file)).toBe(false);
    for (const branch of preview.resources.branches) expect(await git(f.root,'branch','--list',branch)).toBe('');
    expect(fs.existsSync(path.join(sessions,`keep_lush-task-${child.id+100}.jsonl`))).toBe(true);
    expect(fs.existsSync(otherTemp)).toBe(true);
    expect(fs.existsSync(path.join(sessions,`task-${child.id}-context.json.123.tmp`))).toBe(false);
    expect(fs.existsSync(path.join(sessions,`codex-task-${child.id}.json.456.tmp`))).toBe(false);
    expect(await git(f.root,'show','main:file.txt')).toBe('base');
    expect(f.store.nextTaskId()).toBeGreaterThan(child.id); expect(f.store.nextInputId()).toBeGreaterThan(f.inputId);
  } finally {await f.close();}
});

test('preview revision detects resource changes and database changes before any removal',async()=>{
  const f=await setup();
  try {
    f.project.cancel(f.task.id);
    const preview=await f.project.deleteTaskPreview(f.task.id);
    fs.writeFileSync(path.join(f.task.workspace,'late.txt'),'new text');
    await expect(f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision})).rejects.toThrow('changed');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    const next=await f.project.deleteTaskPreview(f.task.id);
    f.store.event(f.task.id,'late.history',{text:'changed'});
    await expect(f.project.deleteTask(f.task.id,{confirm:true,revision:next.revision})).rejects.toThrow('changed');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    await remove(f);
  } finally {await f.close();}
});

test('ref changes invalidate preview; invocation exit, sync, cleanup, and outstanding delivery block deletion',async()=>{
  const f=await setup();
  try {
    f.project.cancel(f.task.id); const preview=await f.project.deleteTaskPreview(f.task.id);
    const cwd=f.task.workspace; fs.writeFileSync(path.join(cwd,'file.txt'),'late commit'); await git(cwd,'add','.'); await git(cwd,'commit','-m','late');
    await expect(f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision})).rejects.toThrow('changed');
    f.project.running.set(f.task.id,{});
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('invocation');
    f.project.running.delete(f.task.id); f.project.taskSyncBusy=new Set([f.task.id]);
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('synchronization');
    f.project.taskSyncBusy.clear(); f.project.workspaces.busy.add(f.task.id);
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('cleanup');
    f.project.workspaces.busy.clear(); f.store.update(f.task.id,{reservation:JSON.stringify({version:2,kind:'merge',status:'requested',parent_id:f.task.parent_id})});
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('outstanding');
  } finally {f.project.running.clear(); await f.close();}
});

test('external dependents, resolver references, genealogy and unsubmitted drafts refuse deletion',async()=>{
  const f=await setup();
  try {
    const other=(await f.project.order('keep this input')).task;
    f.project.cancel(f.task.id);
    f.store.addDep(other.id,f.task.id,'order');
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('dependent');
    f.store.run('DELETE FROM task_deps WHERE task_id=?',other.id);
    f.store.run('UPDATE tasks SET resolves_task_id=? WHERE id=?',f.task.id,other.id);
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('referenced');
    f.store.run('UPDATE tasks SET resolves_task_id=NULL WHERE id=?',other.id);
    f.store.recordBranch({branch:'external-history',parent:f.task.branch,created_from_commit:f.task.base_commit});
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('genealogy');
    f.store.run('DELETE FROM branches WHERE branch=?','external-history');
    f.store.run('INSERT INTO drafts(content,parent_id) VALUES (?,?)','future idea',f.task.id);
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('draft');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
  } finally {await f.close();}
});

test('deleting a child preserves the shared original Input and sibling resources',async()=>{
  const f=await setup();
  try {
    const child=await f.project.spawn(f.task.id,'child',undefined,[],'bad-child');
    f.project.cancel(child.id);
    await remove(f,child.id);
    expect(f.store.get('SELECT id FROM inputs WHERE id=?',f.inputId).id).toBe(f.inputId);
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    expect(f.store.task(f.task.id).status).not.toBe('cancelled');
  } finally {await f.close();}
});

test('during cleanup new writes/retry/reopen are rejected; failed cleanup retains rows for a fresh retry',async()=>{
  const f=await setup();
  try {
    f.project.cancel(f.task.id); const preview=await f.project.deleteTaskPreview(f.task.id);
    const entered=gate(),release=gate(); const original=f.project.workspaces.deleteWorkerResourcesUnsafe;
    f.project.workspaces.deleteWorkerResourcesUnsafe=async function(){entered.resolve(); await release.promise; throw new Error('injected cleanup failure');};
    const deleting=f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision});
    await entered.promise;
    expect(()=>f.project.retry(f.task.id)).toThrow('deletion');
    await expect(f.project.order('do not create')).rejects.toThrow('deletion');
    expect(()=>f.project.reopenTask(f.task.id)).toThrow('deletion');
    release.resolve(); await expect(deleting).rejects.toThrow('injected');
    expect(f.store.task(f.task.id).status).toBe('cancelled');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    f.project.workspaces.deleteWorkerResourcesUnsafe=original; await remove(f);
  } finally {await f.close();}
});
