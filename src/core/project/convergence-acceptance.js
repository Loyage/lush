import { check } from '../types.js';
import { convergenceHelperContext } from '../convergence-resources.js';
import { convergenceJSON } from '../convergence-contract.js';

function accepted(project, taskId, planned, run = null) {
  if (planned.has(taskId)) return true;
  const task = project.store.get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!task) return Boolean(convergenceJSON(run?.data, {}).source_acceptances?.[taskId]);
  if (task.status !== 'completed' || project.running.has(taskId)) return false;
  const receipt = project.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.accepted' ORDER BY id DESC LIMIT 1", taskId);
  const delivery = project.store.get("SELECT max(id) AS id FROM events WHERE task_id=? AND type IN ('task.merge_integrated','task.delivered')", taskId)?.id ?? 0;
  return receipt && receipt.id > delivery && convergenceJSON(receipt.data)?.head_commit === task.head_commit;
}
function closedForAcceptance(project, helper, planned) {
  const context = convergenceHelperContext(project.store, helper), run = context && project.store.deliveryRun(context.run_id);
  return helper.status === 'awaiting_acceptance' && run?.state === 'integrated'
    && project.store.deliveryMembers(run.id, true).length === 0
    && project.store.deliveryMembers(run.id).every(member => accepted(project, member.task_id, planned, run));
}

/** Infrastructure closure follows all related source acceptances, never accepts another independent order. */
export default {
  convergenceAcceptanceHelpers(subtree, acceptingIds) {
    return subtree.filter(task => task.task_kind === 'integration' && closedForAcceptance(this, task, acceptingIds));
  },

  /** Caller holds Git gate. Failure retains the helper scene and is explicitly resumable via worker.accept. */
  async reclaimConvergenceAfterAcceptanceUnsafe(acceptedIds) {
    if (!acceptedIds.length) return;
    const rows = this.store.all(`SELECT DISTINCT r.id FROM delivery_runs r JOIN all_delivery_members m ON m.run_id=r.id
      WHERE m.task_id IN (${acceptedIds.map(() => '?').join(',')}) AND r.state='integrated'
      AND EXISTS (SELECT 1 FROM delivery_nodes n WHERE n.run_id=r.id AND n.helper_id IS NOT NULL) ORDER BY r.id`, ...acceptedIds);
    for (const row of rows) {
      // Preserve safe source acceptance when that independent Worker is subsequently explicitly deleted.
      const run = this.store.deliveryRun(row.id), data = convergenceJSON(run.data, {}), receipts = { ...data.source_acceptances };
      for (const member of this.store.deliveryMembers(row.id)) if (acceptedIds.includes(member.task_id)
        && accepted(this, member.task_id, new Set(), run)) {
        const event = this.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.accepted' ORDER BY id DESC LIMIT 1", member.task_id);
        receipts[member.task_id] = { event_id: event.id, head_commit: convergenceJSON(event.data).head_commit };
      }
      if (JSON.stringify(receipts) !== JSON.stringify(data.source_acceptances ?? {}))
        this.store.updateDeliveryRun(row.id, { data: { ...data, source_acceptances: receipts } }, run.generation);
    }
    for (const row of rows) for (const helper of this.convergenceHelpers(row.id)) {
      if (!closedForAcceptance(this, helper, new Set())) continue;
      try {
        check(this.workspaces.convergenceHelperIdle(helper.id, row.id), 'integration resource is still exiting');
        check(!this.store.unread(helper.id).length && !this.questionPending(helper.id), 'integration input or decision remains');
        const result = await this.workspaces.release(helper);
        check(result.branch === 'removed' && ['removed','absent'].includes(result.worktree), 'integration resource reclamation incomplete');
        this.store.transaction(() => {
          this.store.update(helper.id, { status: 'completed', error: null });
          this.store.armAgent(helper.id, null);
          this.store.event(helper.id, 'convergence.helper_reclaimed', { run_id: row.id, reason: 'all related source Workers safely accepted' });
        });
      } catch {
        this.store.event(helper.id, 'convergence.helper_cleanup_failed', { run_id: row.id,
          reason: 'Private helper scene retained; explicitly retry the source acceptance after inspection.' });
        check(false, '关联整合资源未完全回收；来源验收事实保留，请检查现场后显式续办 worker.accept');
      }
    }
  },
};
