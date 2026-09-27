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
  async invocationContext(ap, run) {
    if (ap.role === 'butler') return { butler: this.butlerContext(ap.id), invocation: { run_id: run.recordId, ap_id: ap.id, role: ap.role } };
    if (ap.role === 'explainer') return { explanation: this.explanationContext(ap.id) };
    const children = this.store.all(`SELECT ${SUMMARY_COLUMNS} FROM aps t WHERE parent_id=? ORDER BY id LIMIT ?`, ap.id, SUMMARY_LIMIT + 1);
    const dependencies = this.store.all(`SELECT ${SUMMARY_COLUMNS}, d.kind FROM ap_deps d JOIN aps t ON t.id=d.depends_on
      WHERE d.ap_id=? ORDER BY t.id`, ap.id);
    const referenced = ap.input_id !== null && ap.input_id !== undefined
      ? await this.resolveInputReferences(ap.input_id) : [];
    return {
      invocation: { run_id: run.recordId, ap_id: ap.id, role: ap.role },
      parent: ap.parent_id ? summary(this.store.get(`SELECT ${SUMMARY_COLUMNS} FROM aps t WHERE id=?`, ap.parent_id)) : null,
      children: children.slice(0, SUMMARY_LIMIT).map(row => summary(row)),
      children_truncated: children.length > SUMMARY_LIMIT,
      dependencies: dependencies.map(row => ({ ...summary(row, true), kind: row.kind })),
      referenced_context: referenced,
      open_notices: this.store.all("SELECT * FROM notices WHERE ap_id=? AND status='open'", ap.id),
      ...(ap.role === 'planner' ? { queued_specs: this.store.specs({ planner_ap_id: ap.id, status: 'pending', limit: 50 }) } : {}),
      ...(ap.role === 'verifier' ? { verification: this.verificationContext(ap) } : {}),
      ...(ap.role === 'showcase' ? { showcase: this.showcaseContext(ap) } : {}),
      ...(ap.resolves_ap_id ? { merge_conflict: this.mergeConflictContext(ap) } : {}),
      ...(ap.role === 'merger' && !ap.resolves_ap_id ? { branch_sync: (() => {
        const row = this.store.get("SELECT data FROM events WHERE ap_id=? AND type='branch.sync.requested' ORDER BY id DESC LIMIT 1", ap.id);
        return row ? JSON.parse(row.data) : undefined;
      })() } : {}),
    };
  },
};
