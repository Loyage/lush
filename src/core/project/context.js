const SUMMARY_LIMIT = 50;
// Fetch one extra character to detect clipping without loading entire result blobs.
const SUMMARY_COLUMNS = `t.id,t.parent_id,t.role,t.status,t.integration,t.branch,t.head_commit,
  substr(t.goal,1,501) AS goal,substr(t.result,1,1501) AS result,substr(t.error,1,1001) AS error`;
const summary = (row, includeResult = false) => {
  const { id, parent_id, role, status, integration, branch, head_commit, goal, result, error } = row;
  return { id, parent_id, role, status, integration, branch, head_commit,
    goal: goal?.slice(0, 500), ...(includeResult ? { result: result?.slice(0, 1500) } : {}), error: error?.slice(0, 1000),
    truncated: (goal?.length > 500) || (includeResult && result?.length > 1500) || (error?.length > 1000) };
};

/** Only causal neighbours enter the prompt; global history stays on demand. */
export default {
  async invocationContext(task, run) {
    if (task.role === 'explainer') return { explanation: this.explanationContext(task.id) };
    const children = this.store.all(`SELECT ${SUMMARY_COLUMNS} FROM tasks t WHERE parent_id=? ORDER BY id LIMIT ?`, task.id, SUMMARY_LIMIT + 1);
    const dependencies = this.store.all(`SELECT ${SUMMARY_COLUMNS}, d.kind FROM task_deps d JOIN tasks t ON t.id=d.depends_on
      WHERE d.task_id=? ORDER BY t.id`, task.id);
    const referenced = task.input_id !== null && task.input_id !== undefined
      ? await this.resolveInputReferences(task.input_id) : [];
    return {
      invocation: { run_id: run.recordId, task_id: task.id, role: task.role },
      parent: task.parent_id ? summary(this.store.get(`SELECT ${SUMMARY_COLUMNS} FROM tasks t WHERE id=?`, task.parent_id)) : null,
      children: children.slice(0, SUMMARY_LIMIT).map(row => summary(row)),
      children_truncated: children.length > SUMMARY_LIMIT,
      dependencies: dependencies.map(row => ({ ...summary(row, true), kind: row.kind })),
      referenced_context: referenced,
      open_notices: this.store.all("SELECT * FROM notices WHERE task_id=? AND status='open'", task.id),
      ...(task.role === 'planner' ? { queued_specs: this.store.specs({ planner_task_id: task.id, status: 'pending', limit: 50 }) } : {}),
      ...(task.role === 'verifier' ? { verification: this.verificationContext(task) } : {}),
      ...(task.role === 'showcase' ? { showcase: this.showcaseContext(task) } : {}),
      ...(task.resolves_task_id ? { merge_conflict: this.mergeConflictContext(task) } : {}),
      ...(task.role === 'merger' && !task.resolves_task_id ? { branch_sync: (() => {
        const row = this.store.get("SELECT data FROM events WHERE task_id=? AND type='branch.sync.requested' ORDER BY id DESC LIMIT 1", task.id);
        return row ? JSON.parse(row.data) : undefined;
      })() } : {}),
    };
  },
};
