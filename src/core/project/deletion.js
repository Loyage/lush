import { reclaimRunnerWorkspaces, runnerCleanupReceipt } from './runner-reclamation.js';
import { assertRunnerIdle } from './runner-safety.js';
import fs from 'node:fs';
import path from 'node:path';
import { check, id, TERMINAL } from '../types.js';
import { workerLabel } from '../worker-number.js';
import { convergenceResourceReason } from '../convergence-resources.js';
import { managementState, managementUnsettled } from './management-data.js';
import { deletionHash, deletionFingerprint, deletionPath, present, workerFiles } from '../deletion-resources.js';

const warnings = ['删除不可撤销；确认即授权丢弃所列工作区中的未提交改动和未合并代码。',
  '已合并代码与 Git 提交历史不撤销；其他记录中的引用快照不改写。'];
const inMarks = ids => ids.map(() => '?').join(',');
const associatedWorkerLabel = (store, taskId) => workerLabel(store.get('SELECT id,worker_number FROM tasks WHERE id=?', taskId) ?? { id: taskId });
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
  const choices = select('choice_snapshots', `task_id IN (${marks})`);
  const rechoices = select('choice_rechoices', `task_id IN (${marks}) OR notice_id IN (SELECT id FROM notices WHERE task_id IN (${marks}))`, [...ids,...ids]);
  for (const row of rechoices) if (row.task_id && !chosen.has(row.task_id))
    blockers.push(`choice snapshot is used by Worker ${associatedWorkerLabel(store, row.task_id)}; delete that route first`);
  const branchNames = new Set(tasks.map(task => task.branch).filter(Boolean));
  for (const input of inputs) if (input.anchor_branch) branchNames.add(input.anchor_branch);
  const records = store.branches().filter(record => chosen.has(record.task_id) || branchNames.has(record.branch));
  for (const record of records) branchNames.add(record.branch);
  for (const task of tasks) {
    if (['main','owner'].includes(task.task_kind) || task.branch === 'main') blockers.push(`${workerLabel(task)}: main/owner Worker cannot be deleted`);
    if (task.task_kind === 'management') {
      const state = managementState(task);
      if (!state) blockers.push(`${workerLabel(task)}: unknown management authorization; inspect before deletion`);
      if (state?.enabled) blockers.push(`${workerLabel(task)}: management binding is enabled; stop or disable it before deletion`);
      if (managementUnsettled(project, task, state)) blockers.push(`${workerLabel(task)}: management occurrence, confirmation or controlled effect is unfinished/unknown; stop unstarted authorizations and wait for actual exit`);
    } else if (!TERMINAL.has(task.status)) blockers.push(`${workerLabel(task)}: Worker is ${task.status}; cancel it or finish/accept it before deletion`);
    if (store.runnerBinding(task.id)) {
      try { assertRunnerIdle(project, task.id, { allow_removed: true, allow_unprepared: true, allow_receipts: [runnerCleanupReceipt(project, task.id)?.request_id].filter(Boolean) }); }
      catch (error) { blockers.push(`${workerLabel(task)}: ${error.message}`); }
    }
    if (project.running.has(task.id)) blockers.push(`${workerLabel(task)}: invocation is still exiting; wait before deletion`);
    if (project.commandHookRunning?.has(task.id)) blockers.push(`${workerLabel(task)}: shortcut command is pending or running; wait before deletion`);
    if (project.workspaces.busy.has(task.id)) blockers.push(`${workerLabel(task)}: worktree cleanup is in progress`);
    if (project.taskSyncBusy?.has(task.id)) blockers.push(`${workerLabel(task)}: parent synchronization is in progress`);
    const convergenceReason = convergenceResourceReason(project, task);
    if (convergenceReason) blockers.push(`${workerLabel(task)}: ${convergenceReason}`);
    if (project.workerDeleteIds?.has(task.id) && project.deletionRoot !== rootId) blockers.push(`${workerLabel(task)}: deletion is in progress`);
    if (task.reservation) {
      try { const booking = JSON.parse(task.reservation);
        if (!['pending','integrated','withdrawn','completed','failed','cancelled','suspended'].includes(booking.status))
          blockers.push(`${workerLabel(task)}: an outstanding delivery is still ${booking.status}`);
      } catch { blockers.push(`${workerLabel(task)}: unknown delivery metadata`); }
    }
    if ((task.role === 'showcase' || task.task_kind === 'showcase') && task.showcase)
      blockers.push(`${workerLabel(task)}: legacy showcase ownership must be inspected manually`);
  }
  for (const task of store.tasks().filter(task => !chosen.has(task.id))) {
    if (chosen.has(task.verifies_task_id) || chosen.has(task.resolves_task_id)) blockers.push(`referenced by Worker ${workerLabel(task)}`);
    if (branchNames.has(task.branch) || branchNames.has(task.target_branch)) blockers.push(`branch is used by Worker ${workerLabel(task)}`);
  }
  if (store.deliveryHistoryBlockers) blockers.push(...store.deliveryHistoryBlockers(ids));
  for (const row of store.all(`SELECT id FROM drafts WHERE input_id IS NULL AND parent_id IN (${marks})`,...ids))
    blockers.push(`unsubmitted draft #${row.id} still selects this Worker as its parent`);
  for (const row of store.all(`SELECT * FROM task_deps WHERE depends_on IN (${marks}) AND task_id NOT IN (${marks})`, ...ids, ...ids))
    blockers.push(`required by dependent Worker ${associatedWorkerLabel(store, row.task_id)}`);
  for (const row of store.all(`SELECT * FROM task_specs WHERE (task_id IN (${marks}) OR batch_id IN (${marks}))
    AND planner_task_id NOT IN (${marks})`, ...ids, ...ids, ...ids)) blockers.push(`referenced by external historical spec #${row.id}`);
  const candidates = store.all(`SELECT * FROM review_candidates WHERE report_task_id IN (${marks}) ORDER BY id`, ...ids);
  for (const row of candidates) if (!inputIds.includes(row.input_id)) blockers.push(`referenced by external candidate #${row.id}`);
  for (const record of store.branches()) {
    if (!branchNames.has(record.branch) && branchNames.has(record.parent)) blockers.push(`branch genealogy still has external child ${record.branch}`);
    if (branchNames.has(record.branch) && record.task_id !== null && !chosen.has(record.task_id))
      blockers.push(`branch ${record.branch} has another owner ${associatedWorkerLabel(store, record.task_id)}`);
  }
  for (const name of branchNames) { const frozen = project.branchFreeze(name); if (frozen) blockers.push(`branch ${name} is frozen: ${frozen.reason}`); }
  const data = { tasks, inputs, branches: records, contexts, choices, rechoices,
    runnerBindings: select('runner_bindings', `worker_id IN (${marks})`),
    runnerRuns: select('runner_runs', `worker_id IN (${marks})`),
    runnerReceipts: select('runner_receipts', `worker_id IN (${marks})`),
    artifacts: select('artifacts', `task_id IN (${marks})`), runs: select('agent_runs', `task_id IN (${marks})`),
    messages: select('messages', `task_id IN (${marks}) OR sender_id IN (${marks})`, [...ids,...ids]),
    notices: select('notices', `task_id IN (${marks})`), events: select('events', `task_id IN (${marks})`),
    deps: select('task_deps', `task_id IN (${marks}) OR depends_on IN (${marks})`, [...ids,...ids]),
    specs: select('task_specs', `planner_task_id IN (${marks})`),
    candidates,
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
      blockers.push(`input is used by external candidate Worker ${associatedWorkerLabel(store, row.report_task_id)}`);
    data.candidates = [...new Map([...candidates,...allCandidates].map(row => [row.id,row])).values()].sort((a,b)=>a.id-b.id);
  }
  const candidateIds = new Set(data.candidates.map(row=>row.id));
  for (const task of store.tasks().filter(task=>!chosen.has(task.id)))
    if (candidateIds.has(task.review_candidate_id)) blockers.push(`candidate is still referenced by Worker ${workerLabel(task)}`);
  for (const spec of data.specs) {
    if (spec.task_id && !chosen.has(spec.task_id) && store.get('SELECT id FROM tasks WHERE id=?',spec.task_id))
      blockers.push(`historical spec #${spec.id} owns external Worker ${associatedWorkerLabel(store, spec.task_id)}`);
    if (spec.batch_id && !chosen.has(spec.batch_id) && store.get('SELECT id FROM tasks WHERE id=?',spec.batch_id))
      blockers.push(`historical spec #${spec.id} belongs to external batch Worker ${associatedWorkerLabel(store, spec.batch_id)}`);
  }
  return { ids, inputIds, tasks, inputs, records, contexts, choices, blockers, data };
}

async function deletionPlan(project, rootId, force = false) {
  const db = databasePlan(project, rootId), blockers = db.blockers;
  const git = await project.workspaces.workerDeletionResourcesUnsafe(db.tasks, db.inputs, db.records, blockers, { force });
  const choiceRefs = [];
  for (const choice of db.choices) {
    const ref = `refs/lush/choice-snapshots/${choice.notice_id}`;
    const tip = await project.workspaces.git(project.config.project, 'rev-parse', '--verify', ref).catch(() => null);
    if (tip && !/^[0-9a-f]{40,64}$/.test(tip)) blockers.push('choice snapshot ref is invalid');
    choiceRefs.push({ ref, tip });
  }
  let files = [];
  try { files = workerFiles(project.config, db.tasks, db.contexts, db.choices); } catch (error) { blockers.push(error.message); }
  const outside = project.store.tasks().filter(task => !db.ids.includes(task.id));
  const paths = [...git.worktrees.map(tree => tree.path), ...files];
  const overlaps = (a,b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  for (const task of outside) for (const file of [task.workspace,task.baseline_workspace].filter(Boolean))
    if (paths.some(candidate => overlaps(path.resolve(candidate),path.resolve(file)))) blockers.push(`resource is shared with Worker ${workerLabel(task)}: ${file}`);
  for (const record of project.store.branches()) if (!db.records.some(owned=>owned.branch===record.branch) && record.worktree)
    if (paths.some(candidate=>overlaps(path.resolve(candidate),path.resolve(record.worktree)))) blockers.push(`resource is shared with branch ${record.branch}`);
  for (const input of project.store.all('SELECT id,anchor_workspace FROM inputs WHERE anchor_workspace IS NOT NULL')) if (!db.inputIds.includes(input.id))
    if (paths.some(candidate=>overlaps(path.resolve(candidate),path.resolve(input.anchor_workspace)))) blockers.push(`resource is shared with Input O${input.id}`);
  for (const row of project.store.all('SELECT * FROM commit_contexts')) if (!db.ids.includes(row.task_id))
    if (files.some(file => path.resolve(row.session_path) === path.resolve(file) || path.basename(file) === `${row.commit_hash}.jsonl`))
      blockers.push(`session/checkpoint is shared with Worker ${associatedWorkerLabel(project.store, row.task_id)}`);
  // Inferred resource names can have a registered owner even after task metadata was lost.
  const resourceBranches = new Set(git.branches.map(entry => entry.branch));
  for (const record of project.store.branches()) {
    if (resourceBranches.has(record.branch) && record.task_id !== null && !db.ids.includes(record.task_id)) blockers.push(`branch is owned by Worker ${associatedWorkerLabel(project.store, record.task_id)}: ${record.branch}`);
    if (!resourceBranches.has(record.branch) && resourceBranches.has(record.parent)) blockers.push(`branch has external genealogy child: ${record.branch}`);
  }
  for (const task of outside) if (resourceBranches.has(task.branch) || resourceBranches.has(task.target_branch)) blockers.push(`branch is shared with Worker ${workerLabel(task)}`);
  const filePlan = [];
  for (const file of files) try { filePlan.push({ path:file, fingerprint:deletionFingerprint(project.config,file) }); } catch (error) { blockers.push(error.message); }
  const uniqueBlockers = [...new Set(blockers)];
  const snapshot = { data: db.data, git, choiceRefs, files:filePlan, force };
  const preview = { id:rootId, revision:deletionHash(snapshot), can_delete:uniqueBlockers.length === 0, blockers:uniqueBlockers,
    workers:db.tasks.map(task => ({ id:task.id, worker_number:task.worker_number, goal:task.goal.slice(0,400), status:task.status })),
    inputs:db.inputs.map(input => ({id:input.id})), resources:{ runners: db.data.runnerBindings.map(({ worker_id, node_id, runner_id, workspace_id, generation, head_commit, state }) =>
      ({ worker_id, node_id, runner_id, workspace_id, generation, head_commit, state })), worktrees:git.worktrees.map(tree => tree.path),
      branches:[...git.branches.map(entry => entry.branch), ...choiceRefs.filter(entry => entry.tip).map(entry => entry.ref)], files:filePlan.map(file => file.path) }, warnings: force
        ? [...warnings, ...git.forceCandidates.map(file => `强制删除未登记检出目录（不确认其 Git 归属，全部残留代码会丢弃）：${file}`)] : warnings,
    ...(force ? { force: true } : {}) };
  if (!force && git.forceCandidates.length) {
    const forced = await deletionPlan(project, rootId, true);
    preview.force_available = forced.preview.can_delete;
  }
  check(Buffer.byteLength(JSON.stringify(preview)) < 192000, 'deletion preview is too large; delete smaller subtrees first');
  return { db, git, choiceRefs, files:filePlan, preview };
}

export default {
  async deleteTaskPreview(taskId, { force = false } = {}) {
    check(typeof force === 'boolean', 'force must be a boolean');
    const rootId = id(taskId);
    check(boundedSubtree(this, rootId).every(task => !this.commandHookRunning?.has(task.id)),
      'Worker shortcut command is pending or running; wait before deletion preview');
    const plan = await this.workspaces.exclusive(() => deletionPlan(this,rootId,force));
    if (plan.preview.can_delete && plan.db.data.runnerBindings.length) {
      try {
        await reclaimRunnerWorkspaces(this, plan.db.tasks, () => {
          check(deletionHash(databasePlan(this, rootId).data) === deletionHash(plan.db.data), 'Worker changed during deletion preview');
        }, { preflight_only: true, allow_unprepared: true });
      } catch (error) {
        plan.preview.can_delete = false; plan.preview.blockers.push(error.message);
      }
    }
    return plan.preview;
  },

  /** Mandatory explicit confirmation + fixed preview. Failures retain identity and ownership metadata for retry. */
  async deleteTask(taskId, {revision, confirm, force = false} = {}) {
    check(typeof force === 'boolean', 'force must be a boolean');
    const rootId = id(taskId);
    check(confirm === true && typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision),
      'deletion requires confirm=true and the revision from worker.delete_preview');
    this.assertWritable('delete a Worker');
    check(!this.deletionRoot, 'Worker deletion is already in progress');
    const tasks = boundedSubtree(this,rootId), ids = tasks.map(task => task.id);
    check(ids.every(taskId => !this.commandHookRunning?.has(taskId)),
      'Worker shortcut command is pending or running; wait before deletion');
    this.deletionRoot = rootId; this.workerDeleteIds = new Set(ids);
    try {
      await this.drainWrites();
      const prepared = await this.workspaces.exclusive(async () => {
        const plan = await deletionPlan(this,rootId,force);
        check(plan.preview.can_delete, plan.preview.blockers.join('; '));
        check(plan.preview.revision === revision, 'deletion scope or resources changed; preview and confirm again');
        // Only this operation's Runner cleanup bookkeeping may advance while resources are removed.
        // Immutable binding/HEAD is separately checked by the remote resource owner.
        const historyRevision = data => deletionHash({ ...data, runnerBindings: undefined, runnerReceipts: undefined,
          events: data.events.filter(event => event.type !== 'runner.cleanup_attempt') });
        const dbRevision = historyRevision(plan.db.data);
        const guard = () => {
          const live = databasePlan(this,rootId);
          check(live.blockers.length === 0, live.blockers.join('; '));
          check(historyRevision(live.data) === dbRevision, 'Worker history changed during deletion; preview again');
        };
        return { plan, guard };
      });
      const { plan, guard } = prepared;
      await reclaimRunnerWorkspaces(this, plan.db.tasks, guard, { allow_unprepared: true });
      return await this.workspaces.exclusive(async () => {
        guard();
        await this.workspaces.deleteWorkerResourcesUnsafe(plan.git,guard);
        for (const entry of plan.choiceRefs) {
          guard();
          const tip = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', entry.ref).catch(() => null);
          check(tip === entry.tip, 'choice snapshot ref changed; preview again');
          if (tip) await this.workspaces.git(this.config.project, 'update-ref', '-d', entry.ref, tip);
        }
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
        const remaining = await this.workspaces.workerDeletionResourcesUnsafe(plan.db.tasks,plan.db.inputs,plan.db.records,[],{force});
        check(!remaining.worktrees.length && !remaining.branches.some(entry=>entry.tip), 'Git resources remain after cleanup; preview again');
        guard();
        for (const file of plan.git.worktrees.map(tree=>tree.path)) {
          deletionPath(this.config,file); check(!present(file), `resource reappeared during cleanup: ${file}`);
        }
        check(workerFiles(this.config,plan.db.tasks,plan.db.contexts,plan.db.choices).length===0, 'Worker files reappeared during cleanup; preview again');
        const counts = this.store.hardDeleteTasks(plan.db.ids,plan.db.inputIds,plan.git.branches.map(entry=>entry.branch));
        for (const task of plan.db.tasks) this.ancestry.delete(task.id);
        return {deleted:{root:rootId,ids:plan.db.ids,...counts},reclaimed:{worktrees:plan.git.worktrees.length,
          branches:plan.git.branches.filter(entry=>entry.tip).length,files:plan.files.length},next_task_id:this.store.taskIdHigh()+1};
      });
    } finally { this.deletionRoot = null; this.workerDeleteIds = null; this.kick(); }
  },
};
