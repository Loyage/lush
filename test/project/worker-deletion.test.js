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
    expect(f.store.get("SELECT name FROM sqlite_master WHERE name='introductions'")).toBeNull();
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
    for (const table of ['messages','events','notices','agent_runs','artifacts','commit_contexts'])
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
