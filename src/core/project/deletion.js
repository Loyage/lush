import fs from 'node:fs';
import path from 'node:path';
import { check, id, TERMINAL } from '../types.js';
import { deletionHash, deletionFingerprint, deletionPath, present, workerFiles } from '../deletion-resources.js';

const warnings = ['删除不可撤销；确认即授权丢弃所列工作区中的未提交改动和未合并代码。',
  '已合并代码与 Git 提交历史不撤销；其他记录中的引用快照不改写。'];
const inMarks = ids => ids.map(() => '?').join(',');
function boundedSubtree(project, rootId) {
  const tasks = [], seen = new Set(), queue = [project.store.task(rootId)];
  while (queue.length) {
    const task = queue.pop();
    check(!seen.has(task.id), 'Worker subtree has a cycle'); seen.add(task.id); tasks.push(task);
    check(tasks.length <= 200, 'Worker subtree is too large to safely preview (maximum 200); delete smaller subtrees first');
    queue.push(...project.store.children(task.id));
  }
  return tasks.sort((a,b) => a.id-b.id);
}

/** Collect exact rows, including historical adjuncts; never delete another Worker's dependency edge silently. */
function databasePlan(project, rootId) {
  const store = project.store, tasks = boundedSubtree(project,rootId);
  check(tasks.length <= 200, 'Worker subtree is too large to safely preview (maximum 200); delete smaller subtrees first');
  const ids = tasks.map(task => task.id), chosen = new Set(ids), marks = inMarks(ids), blockers = [];
  const select = (table, where, args = ids) => store.all(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`, ...args);
  const inputs = store.all(`SELECT * FROM inputs WHERE (id IN (SELECT input_id FROM tasks WHERE id IN (${marks}))
    OR task_id IN (${marks})) AND NOT EXISTS (SELECT 1 FROM tasks remaining WHERE remaining.input_id=inputs.id
    AND remaining.id NOT IN (${marks})) ORDER BY id`, ...ids, ...ids, ...ids);
  const inputIds = inputs.map(input => input.id), inputMarks = inMarks(inputIds);
  const contexts = select('commit_contexts', `task_id IN (${marks})`);
  const branchNames = new Set(tasks.map(task => task.branch).filter(Boolean));
  for (const input of inputs) if (input.anchor_branch) branchNames.add(input.anchor_branch);
  const records = store.branches().filter(record => chosen.has(record.task_id) || branchNames.has(record.branch));
  for (const record of records) branchNames.add(record.branch);
  for (const task of tasks) {
    if (['main','owner'].includes(task.task_kind) || task.branch === 'main') blockers.push(`#${task.id}: main/owner Worker cannot be deleted`);
    if (!TERMINAL.has(task.status)) blockers.push(`#${task.id}: Worker is ${task.status}; cancel it or finish/accept it before deletion`);
    if (project.running.has(task.id)) blockers.push(`#${task.id}: invocation is still exiting; wait before deletion`);
    if (project.workspaces.busy.has(task.id)) blockers.push(`#${task.id}: worktree cleanup is in progress`);
    if (project.taskSyncBusy?.has(task.id)) blockers.push(`#${task.id}: parent synchronization is in progress`);
    if (project.workerDeleteIds?.has(task.id) && project.deletionRoot !== rootId) blockers.push(`#${task.id}: deletion is in progress`);
    if (project.introRunning) {
      const introductions = store.all('SELECT id FROM introductions WHERE task_id=?', task.id);
      if (introductions.some(row => project.introRunning.has(row.id)))
        blockers.push(`#${task.id}: a historical introduction request is still running`);
      else if (introductions.some(row => store.followupList(row.id).some(item => project.introRunning.has(`followup:${item.id}`))))
        blockers.push(`#${task.id}: a historical explanation follow-up is still running`);
    }
    if (task.reservation) {
      try { const booking = JSON.parse(task.reservation);
        if (!['pending','integrated','withdrawn','completed','failed','cancelled','suspended'].includes(booking.status))
          blockers.push(`#${task.id}: an outstanding delivery is still ${booking.status}`);
      } catch { blockers.push(`#${task.id}: unknown delivery metadata`); }
    }
    if ((task.role === 'showcase' || task.task_kind === 'showcase') && task.showcase)
      blockers.push(`#${task.id}: legacy showcase ownership must be inspected manually`);
  }
  for (const task of store.tasks().filter(task => !chosen.has(task.id))) {
    if (chosen.has(task.verifies_task_id) || chosen.has(task.resolves_task_id)) blockers.push(`referenced by Worker #${task.id}`);
    if (branchNames.has(task.branch) || branchNames.has(task.target_branch)) blockers.push(`branch is used by Worker #${task.id}`);
  }
  for (const row of store.all(`SELECT id FROM drafts WHERE input_id IS NULL AND parent_id IN (${marks})`,...ids))
    blockers.push(`unsubmitted draft #${row.id} still selects this Worker as its parent`);
  for (const row of store.all(`SELECT * FROM task_deps WHERE depends_on IN (${marks}) AND task_id NOT IN (${marks})`, ...ids, ...ids))
    blockers.push(`required by dependent Worker #${row.task_id}`);
  for (const row of store.all(`SELECT * FROM task_specs WHERE (task_id IN (${marks}) OR batch_id IN (${marks}))
    AND planner_task_id NOT IN (${marks})`, ...ids, ...ids, ...ids)) blockers.push(`referenced by external historical spec #${row.id}`);
  const candidates = store.all(`SELECT * FROM review_candidates WHERE report_task_id IN (${marks}) ORDER BY id`, ...ids);
  for (const row of candidates) if (!inputIds.includes(row.input_id)) blockers.push(`referenced by external candidate #${row.id}`);
  for (const record of store.branches()) {
    if (!branchNames.has(record.branch) && branchNames.has(record.parent)) blockers.push(`branch genealogy still has external child ${record.branch}`);
    if (branchNames.has(record.branch) && record.task_id !== null && !chosen.has(record.task_id))
      blockers.push(`branch ${record.branch} has another owner #${record.task_id}`);
  }
  for (const name of branchNames) { const frozen = project.branchFreeze(name); if (frozen) blockers.push(`branch ${name} is frozen: ${frozen.reason}`); }
  const data = { tasks, inputs, branches: records, contexts,
    artifacts: select('artifacts', `task_id IN (${marks})`), runs: select('agent_runs', `task_id IN (${marks})`),
    messages: select('messages', `task_id IN (${marks}) OR sender_id IN (${marks})`, [...ids,...ids]),
    notices: select('notices', `task_id IN (${marks})`), events: select('events', `task_id IN (${marks})`),
    deps: select('task_deps', `task_id IN (${marks}) OR depends_on IN (${marks})`, [...ids,...ids]),
    specs: select('task_specs', `planner_task_id IN (${marks})`),
    introductions: select('introductions', `task_id IN (${marks})`), candidates,
    drafts: inputIds.length ? select('drafts', `input_id IN (${inputMarks})`, inputIds) : [],
    inputReferences: inputIds.length ? select('input_references', `input_id IN (${inputMarks})`, inputIds) : [],
  };
  const draftIds = data.drafts.map(row => row.id);
  data.draftReferences = draftIds.length ? select('draft_references', `draft_id IN (${inMarks(draftIds)})`, draftIds) : [];
  // Inputs with no remaining Worker may still be shared by historical artifacts/candidates/specs.
  if (inputIds.length) {
    for (const [table, owner] of [['artifacts','task_id'],['task_specs','planner_task_id']])
      for (const row of store.all(`SELECT id FROM ${table} WHERE input_id IN (${inputMarks}) AND ${owner} NOT IN (${marks})`, ...inputIds,...ids))
        blockers.push(`input is used by external ${table} #${row.id}`);
    const allCandidates = select('review_candidates', `input_id IN (${inputMarks})`, inputIds);
    for (const row of allCandidates) if (row.report_task_id !== null && !chosen.has(row.report_task_id))
      blockers.push(`input is used by external candidate Worker #${row.report_task_id}`);
    data.candidates = [...new Map([...candidates,...allCandidates].map(row => [row.id,row])).values()].sort((a,b)=>a.id-b.id);
  }
  const candidateIds = new Set(data.candidates.map(row=>row.id));
  for (const task of store.tasks().filter(task=>!chosen.has(task.id)))
    if (candidateIds.has(task.review_candidate_id)) blockers.push(`candidate is still referenced by Worker #${task.id}`);
  for (const spec of data.specs) {
    if (spec.task_id && !chosen.has(spec.task_id) && store.get('SELECT id FROM tasks WHERE id=?',spec.task_id))
      blockers.push(`historical spec #${spec.id} owns external Worker #${spec.task_id}`);
    if (spec.batch_id && !chosen.has(spec.batch_id) && store.get('SELECT id FROM tasks WHERE id=?',spec.batch_id))
      blockers.push(`historical spec #${spec.id} belongs to external batch Worker #${spec.batch_id}`);
  }
  return { ids, inputIds, tasks, inputs, records, contexts, blockers, data };
}

async function deletionPlan(project, rootId) {
  const db = databasePlan(project, rootId), blockers = db.blockers;
  const git = await project.workspaces.workerDeletionResourcesUnsafe(db.tasks, db.inputs, db.records, blockers);
  let files = [];
  try { files = workerFiles(project.config, db.tasks, db.contexts); } catch (error) { blockers.push(error.message); }
  const outside = project.store.tasks().filter(task => !db.ids.includes(task.id));
  const paths = [...git.worktrees.map(tree => tree.path), ...files];
  const overlaps = (a,b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  for (const task of outside) for (const file of [task.workspace,task.baseline_workspace].filter(Boolean))
    if (paths.some(candidate => overlaps(path.resolve(candidate),path.resolve(file)))) blockers.push(`resource is shared with Worker #${task.id}: ${file}`);
  for (const record of project.store.branches()) if (!db.records.some(owned=>owned.branch===record.branch) && record.worktree)
    if (paths.some(candidate=>overlaps(path.resolve(candidate),path.resolve(record.worktree)))) blockers.push(`resource is shared with branch ${record.branch}`);
  for (const input of project.store.all('SELECT id,anchor_workspace FROM inputs WHERE anchor_workspace IS NOT NULL')) if (!db.inputIds.includes(input.id))
    if (paths.some(candidate=>overlaps(path.resolve(candidate),path.resolve(input.anchor_workspace)))) blockers.push(`resource is shared with Input #${input.id}`);
  for (const row of project.store.all('SELECT * FROM commit_contexts')) if (!db.ids.includes(row.task_id))
    if (files.some(file => path.resolve(row.session_path) === path.resolve(file) || path.basename(file) === `${row.commit_hash}.jsonl`))
      blockers.push(`session/checkpoint is shared with Worker #${row.task_id}`);
  // Inferred resource names can have a registered owner even after task metadata was lost.
  const resourceBranches = new Set(git.branches.map(entry => entry.branch));
  for (const record of project.store.branches()) {
    if (resourceBranches.has(record.branch) && record.task_id !== null && !db.ids.includes(record.task_id)) blockers.push(`branch is owned by Worker #${record.task_id}: ${record.branch}`);
    if (!resourceBranches.has(record.branch) && resourceBranches.has(record.parent)) blockers.push(`branch has external genealogy child: ${record.branch}`);
  }
  for (const task of outside) if (resourceBranches.has(task.branch) || resourceBranches.has(task.target_branch)) blockers.push(`branch is shared with Worker #${task.id}`);
  const filePlan = [];
  for (const file of files) try { filePlan.push({ path:file, fingerprint:deletionFingerprint(project.config,file) }); } catch (error) { blockers.push(error.message); }
  const uniqueBlockers = [...new Set(blockers)];
  const snapshot = { data: db.data, git, files:filePlan };
  const preview = { id:rootId, revision:deletionHash(snapshot), can_delete:uniqueBlockers.length === 0, blockers:uniqueBlockers,
    workers:db.tasks.map(task => ({ id:task.id, worker_number:task.worker_number, goal:task.goal.slice(0,400), status:task.status })),
    inputs:db.inputs.map(input => ({id:input.id})), resources:{ worktrees:git.worktrees.map(tree => tree.path),
      branches:git.branches.map(entry => entry.branch), files:filePlan.map(file => file.path) }, warnings };
  check(Buffer.byteLength(JSON.stringify(preview)) < 192000, 'deletion preview is too large; delete smaller subtrees first');
  return { db, git, files:filePlan, preview };
}

export default {
  deleteTaskPreview(taskId) {
    const rootId = id(taskId);
    return this.workspaces.exclusive(async () => (await deletionPlan(this,rootId)).preview);
  },

  /** Mandatory explicit confirmation + fixed preview. Failures retain identity and ownership metadata for retry. */
  async deleteTask(taskId, {revision, confirm} = {}) {
    const rootId = id(taskId);
    check(confirm === true && typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision),
      'deletion requires confirm=true and the revision from worker.delete_preview');
    this.assertWritable('delete a Worker');
    check(!this.deletionRoot, 'Worker deletion is already in progress');
    const tasks = boundedSubtree(this,rootId), ids = tasks.map(task => task.id);
    this.deletionRoot = rootId; this.workerDeleteIds = new Set(ids);
    try {
      await this.drainWrites();
      return await this.workspaces.exclusive(async () => {
        const plan = await deletionPlan(this,rootId);
        check(plan.preview.can_delete, plan.preview.blockers.join('; '));
        check(plan.preview.revision === revision, 'deletion scope or resources changed; preview and confirm again');
        const dbRevision = deletionHash(plan.db.data);
        const guard = () => {
          const live = databasePlan(this,rootId);
          check(live.blockers.length === 0, live.blockers.join('; '));
          check(deletionHash(live.data) === dbRevision, 'Worker history changed during deletion; preview again');
        };
        await this.workspaces.deleteWorkerResourcesUnsafe(plan.git,guard);
        guard();
        for (const file of plan.files) {
          deletionPath(this.config,file.path);
          check(deletionFingerprint(this.config,file.path) === file.fingerprint, `resource changed; preview again: ${file.path}`);
          fs.rmSync(file.path,{recursive:true,force:true});
        }
        // No await from final ownership check through commit. Remaining disk resources fail closed.
        guard();
        for (const file of [...plan.git.worktrees.map(tree=>tree.path),...plan.files.map(file=>file.path)])
          check(!present(file), `resource remains after cleanup: ${file}`);
        const remaining = await this.workspaces.workerDeletionResourcesUnsafe(plan.db.tasks,plan.db.inputs,plan.db.records,[]);
        check(!remaining.worktrees.length && !remaining.branches.some(entry=>entry.tip), 'Git resources remain after cleanup; preview again');
        guard();
        for (const file of plan.git.worktrees.map(tree=>tree.path)) {
          deletionPath(this.config,file); check(!present(file), `resource reappeared during cleanup: ${file}`);
        }
        check(workerFiles(this.config,plan.db.tasks,plan.db.contexts).length===0, 'Worker files reappeared during cleanup; preview again');
        const counts = this.store.hardDeleteTasks(plan.db.ids,plan.db.inputIds,plan.git.branches.map(entry=>entry.branch));
        for (const task of plan.db.tasks) this.ancestry.delete(task.id);
        return {deleted:{root:rootId,ids:plan.db.ids,...counts},reclaimed:{worktrees:plan.git.worktrees.length,
          branches:plan.git.branches.filter(entry=>entry.tip).length,files:plan.files.length},next_task_id:this.store.taskIdHigh()+1};
      });
    } finally { this.deletionRoot = null; this.workerDeleteIds = null; this.kick(); }
  },
};
