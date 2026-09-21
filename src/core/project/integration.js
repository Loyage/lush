/** Automatic integration inside a private Intent branch. The target branch still requires final Candidate approval. */
export default {
  scheduleIntentIntegration(inputId) {
    if (!inputId || this.integratingIntents.has(inputId) || this.stopping) return;
    this.integratingIntents.add(inputId);
    queueMicrotask(() => this.integrateIntent(inputId)
      .catch(error => {
        const input = this.store.get('SELECT task_id FROM inputs WHERE id=?', inputId);
        this.store.event(input?.task_id ?? null, 'intent.integration_failed', { input_id: inputId, error: error.message });
        console.error(`intent ${inputId} integration: ${error.stack || error}`);
      })
      .finally(() => this.integratingIntents.delete(inputId)));
  },

  async integrateIntent(inputId) {
    const input = this.store.get('SELECT id,task_id,anchor_branch FROM inputs WHERE id=?', inputId);
    if (!input?.anchor_branch) return { input_id: inputId, status: 'no_branch', merged: [] };
    const merged = [];
    // Each pass can expose a parent after its last child lands. The bound prevents corrupt genealogy from looping forever.
    for (let pass = 0; pass < 100; pass++) {
      const records = this.store.branches().filter(row => row.status === 'active');
      const byParent = new Map();
      for (const row of records) {
        if (!byParent.has(row.parent)) byParent.set(row.parent, []);
        byParent.get(row.parent).push(row);
      }
      const descendants = [];
      const walk = (parent, depth) => {
        for (const child of byParent.get(parent) || []) { descendants.push({ ...child, depth }); walk(child.branch, depth + 1); }
      };
      walk(input.anchor_branch, 1);
      descendants.sort((a, b) => b.depth - a.depth || a.created_at.localeCompare(b.created_at));
      let progressed = false;
      for (const branch of descendants) {
        if (branch.task_id !== null) {
          const task = this.store.get('SELECT id,status FROM tasks WHERE id=?', branch.task_id);
          if (task && task.status !== 'completed') continue;
        }
        const state = await this.workspaces.branchState(branch.branch);
        if (state.blockers.length) continue;
        if (state.status === 'fast_forward') {
          const outcome = await this.approveBranchMerge(branch.branch);
          if (outcome.merged || outcome.already_integrated) {
            merged.push(branch.branch); progressed = true;
          }
        } else if (state.status === 'diverged') {
          const sync = await this.syncBranch(branch.branch);
          this.store.event(input.task_id, 'intent.integration_sync', { input_id: input.id, branch: branch.branch,
            task: sync.task?.id ?? null, status: sync.status });
          return { input_id: input.id, status: 'syncing', merged, sync };
        }
      }
      if (!progressed) {
        const remaining = [];
        for (const branch of descendants) {
          const state = await this.workspaces.branchState(branch.branch);
          if (state.status !== 'integrated') remaining.push({ branch: branch.branch, status: state.status, blockers: state.blockers });
        }
        const active = this.store.all(`SELECT id,status FROM tasks WHERE input_id=? AND layer='work' AND role!='verifier'
          AND status NOT IN ('completed','failed','cancelled') ORDER BY id`, input.id);
        for (const task of active) remaining.push({ task: task.id, status: task.status, blockers: ['active_work'] });
        for (const task of this.store.all("SELECT id,status FROM tasks WHERE input_id=? AND role='worker' AND status='failed' ORDER BY id", input.id)) {
          remaining.push({ task: task.id, status: task.status, blockers: ['failed_work'] });
        }
        const status = remaining.length ? 'blocked' : 'integrated';
        this.store.event(input.task_id, 'intent.integration', { input_id: input.id, status, merged, remaining });
        if (status === 'integrated') {
          const flow = this.store.get('SELECT flow FROM inputs WHERE id=?', input.id)?.flow;
          const commit = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${input.anchor_branch}^{commit}`);
          const latest = this.store.latestCandidate(input.id);
          if (flow !== 'explain' && (!latest || latest.commit_hash !== commit || ['changes_requested','rejected','superseded','failed'].includes(latest.status))) {
            const candidate = await this.prepareCandidate(input.id);
            return { input_id: input.id, status: 'review_preparing', merged, remaining, candidate };
          }
        }
        return { input_id: input.id, status, merged, remaining };
      }
    }
    throw new Error(`intent #${input.id} integration did not converge`);
  },
};
