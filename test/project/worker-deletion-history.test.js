import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {fixture,repo} from '../helpers.js';
async function setup(){const f=fixture();f.project.stopping=true;await repo(f.root);const task=(await f.project.say('unneeded original')).task;f.project.cancel(task.id);return {...f,task:f.store.task(task.id)};}

test('external historical Input artifacts prevent deleting their still-used Input',async()=>{
  const f=await setup();
  try{
    const other=(await f.project.say('keep')).task;
    f.store.addArtifact({task_id:other.id,input_id:f.task.input_id,kind:'historical',payload:'keep'});
    const preview=await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(false);expect(preview.blockers.join(' ')).toContain('external artifacts');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
  }finally{await f.close();}
});

test('another Worker candidate pointer blocks deletion of a historical candidate',async()=>{
  const f=await setup();
  try{
    const other=(await f.project.say('keep')).task;
    const result=f.store.run("INSERT INTO review_candidates(input_id,version,branch,commit_hash,baseline_branch,baseline_commit,status) VALUES (?,1,?,?,?,?,'failed')",f.task.input_id,f.task.branch,f.task.base_commit,'main',f.task.base_commit);
    f.store.run('UPDATE tasks SET review_candidate_id=? WHERE id=?',Number(result.lastInsertRowid),other.id);
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('candidate is still referenced');
    f.store.run('UPDATE tasks SET review_candidate_id=NULL WHERE id=?',other.id);
    const preview=await f.project.deleteTaskPreview(f.task.id);
    await f.project.deleteTask(f.task.id,{confirm:true,revision:preview.revision});
    expect(f.store.get('SELECT id FROM review_candidates WHERE id=?',Number(result.lastInsertRowid))).toBeNull();
  }finally{await f.close();}
});

test('a planner spec owning an external Worker is not silently forgotten',async()=>{
  const f=await setup();
  try{
    const other=(await f.project.say('keep')).task;
    f.store.run("INSERT INTO task_specs(input_id,planner_task_id,seq,goal,task_id) VALUES (?,?,1,'historical spec',?)",f.task.input_id,f.task.id,other.id);
    expect((await f.project.deleteTaskPreview(f.task.id)).blockers.join(' ')).toContain('owns external Worker');
    expect(f.store.task(other.id).id).toBe(other.id);
  }finally{await f.close();}
});

test('oversized subtree refuses rather than presenting a silently incomplete deletion scope',async()=>{
  const f=await setup();
  try{
    f.store.transaction(()=>{
      for(let i=0;i<200;i++) f.store.create({parent_id:f.task.id,role:'agent',task_kind:'child',goal:'child',status:'cancelled'});
    });
    await expect(f.project.deleteTaskPreview(f.task.id)).rejects.toThrow('too large');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
  }finally{await f.close();}
});
