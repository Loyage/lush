import { check } from '../types.js';
import { CONVERGENCE_LIMITS, convergenceJSON, convergenceBooking, convergenceVerificationMode } from '../convergence-contract.js';
import { convergenceTopology } from '../convergence-plan.js';

const now = () => new Date().toISOString();
const nodeData = node => convergenceJSON(node.data, {});
const nodeResult = node => convergenceJSON(node.result);

/** Fixed binary objects and isolated validation; no parent logical writer is acquired here. */
export default {
  async refreshConvergenceBaseline(runId, generation, explicit = false) {
    return this.workspaces.exclusive(async () => {
      const { run, parent, members } = this.assertConvergenceRun(runId, generation);
      check(!run.landing_receipt, 'landing effects must be reconciled before changing the baseline');
      check(!run.integration_worker_id || !this.running.has(run.integration_worker_id), 'integration invocation is still exiting');
      const data = convergenceJSON(run.data, {});
      const mode = convergenceVerificationMode(data.verification_mode, run.validation);
      check(explicit || (data.baseline_attempts ?? 0) < CONVERGENCE_LIMITS.baseline_attempts, 'convergence baseline retry bound reached');
      const baseline = await this.workspaces.git(this.config.project, 'rev-parse', '--verify', `refs/heads/${parent.branch}^{commit}`);
      for (const member of members) {
        await this.workspaces.assertCleanBranches([member.source_branch]);
        check(await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${member.source_branch}`) === member.source_commit,
          'fixed source moved during convergence refresh');
      }
      this.assertConvergenceRun(runId, generation);
      return this.store.transaction(() => {
        const nextGeneration = generation + 1;
        // Baseline-only invalidation combines the already-fixed output with the new parent.
        // Rebuilding raw leaves here would silently discard paid content/validation repairs.
        const oldRoot = this.store.deliveryNodes(runId, generation).find(node => node.node_key === data.plan?.root);
        const fixedOutput = oldRoot?.state === 'ready' ? nodeResult(oldRoot) : null;
        const refreshPlan = !explicit && fixedOutput?.commit && fixedOutput.tree ? {
          version: 1, variant: 'baseline_refresh', root: `refresh:${nextGeneration}`,
          nodes: [{ key: `refresh:${nextGeneration}`, kind: 'refresh', member_ids: members.map(member => member.task_id),
            inputs: [], base: run.baseline, left: baseline, right: fixedOutput.commit,
            repair_attempts: nodeData(oldRoot).repair_attempts ?? 0 }],
        } : null;
        const next = this.store.updateDeliveryRun(runId, { generation: nextGeneration, baseline,
          state: 'preparing', candidate_commit: null, candidate_tree: null, validation_result: null,
          integration_worker_id: null, error: null, data: JSON.stringify({ ...data, wait_reason: null,
            prepared_receipt: null, root_commit: null,
            ...(refreshPlan ? { plan: refreshPlan, previous_root: { node_id: oldRoot.id, generation, commit: fixedOutput.commit } }
              : explicit ? { plan: convergenceTopology(members), previous_root: null } : {}),
            baseline_attempts: explicit ? 0 : (data.baseline_attempts ?? 0) + 1,
            ...(explicit ? { repair_attempts: 0,
              ...(mode === 'command' ? { authorization_id: this.convergenceAuthorizationStamp(convergenceJSON(run.validation)) } : {}) } : {}) }) }, generation);
        for (const member of members) {
          const task = this.store.task(member.task_id), booking = convergenceBooking(task);
          this.store.update(task.id, { integration_error: null,
            reservation: JSON.stringify({ ...booking, generation: nextGeneration, status: 'requested' }) });
        }
        this.store.event(parent.id, 'convergence.baseline_refixed', { run_id: runId, generation: nextGeneration, baseline, explicit });
        return next;
      });
    });
  },

  convergenceIntegrationCapacity() {
    // W210/D492 removes Worker quotas, including private integration identities.
    // Keep this recovery seam so previously persisted integration_slot waits can resume.
    return true;
  },

  wakeConvergenceAfterIntegration(parentId) {
    this.drainConvergenceWithdrawals?.(parentId);
    this.scheduleConvergence(parentId);
    if (this.convergenceIntegrationCapacity())
      for (const pending of this.convergenceIntegrationWaitParents ?? []) this.scheduleConvergence(pending);
  },

  forkConvergenceRepairGeneration(runId, generation, nodeId, reason) {
    const result = this.store.transaction(() => {
      const { run, members } = this.assertConvergenceRun(runId, generation, ['preparing']);
      check(!run.landing_receipt && (!run.integration_worker_id || !this.running.has(run.integration_worker_id)),
        'previous integration invocation is still exiting');
      const oldNodes = this.store.deliveryNodes(runId, generation);
      const target = oldNodes.find(node => node.id === nodeId), output = nodeResult(target);
      check(target && output?.commit && output.tree, 'fixed repair output is missing');
      const nextGeneration = generation + 1, data = convergenceJSON(run.data, {});
      this.store.updateDeliveryRun(runId, { generation: nextGeneration, state: 'preparing', candidate_commit: null,
        candidate_tree: null, validation_result: null, integration_worker_id: null, error: null,
        data: JSON.stringify({ ...data, prepared_receipt: null, root_commit: null, wait_reason: null,
          previous_validation: convergenceJSON(run.validation_result), repair_from_generation: generation }) }, generation);
      let repairNode = null;
      for (const node of oldNodes) {
        const isTarget = node.id === nodeId;
        check(!['computing', 'resolving', 'awaiting'].includes(node.state), 'another fixed node is still running');
        const nextData = { ...nodeData(node), reused_from: { node_id: node.id, generation },
          ...(isTarget ? { seed_commit: output.commit, reason } : {}) };
        const copy = this.store.createDeliveryNode({ run_id: runId, generation: nextGeneration, node_key: node.node_key,
          state: isTarget ? 'conflict' : node.state, data: nextData, result: nodeResult(node),
          helper_id: isTarget ? null : node.helper_id });
        if (isTarget) repairNode = copy;
      }
      for (const member of members) {
        const task = this.store.task(member.task_id), booking = convergenceBooking(task);
        this.store.update(task.id, { reservation: JSON.stringify({ ...booking, generation: nextGeneration, status: 'requested' }) });
      }
      this.store.event(run.parent_id, 'convergence.repair_attempt_fixed', { run_id: runId, generation: nextGeneration,
        previous_generation: generation, node_id: repairNode.id, seed_commit: output.commit, reason });
      return { run: this.store.deliveryRun(runId), node: repairNode };
    });
    const job = this.convergenceJobs?.get(runId);
    if (job?.generation === generation) job.generation = result.run.generation;
    return result;
  },

  async requestConvergenceRepair(runId, generation, nodeId, reason) {
    let { run } = this.assertConvergenceRun(runId, generation);
    let node = this.store.deliveryNode(nodeId), data = nodeData(node);
    check(node?.run_id === runId && node.generation === generation, 'integration node changed');
    if ((data.repair_attempts ?? 0) >= CONVERGENCE_LIMITS.repair_attempts) {
      this.setConvergenceState(runId, generation, 'failed', { error: '此归并节点已达到整合尝试上限，请检查后显式重试。' });
      return false;
    }
    // A finished helper or previously tested output is a NEW fixed attempt, never a rewritten seed/context.
    if (node.helper_id !== null || (reason === 'validation_failed' && data.reason !== reason)
      || (data.seed_commit && nodeResult(node)?.commit && data.seed_commit !== nodeResult(node).commit)) {
      ({ run, node } = this.forkConvergenceRepairGeneration(runId, generation, nodeId, reason));
      generation = run.generation; nodeId = node.id; data = nodeData(node);
    }
    this.store.updateDeliveryNode(nodeId, { state: 'conflict', data: { ...data, reason,
      seed_commit: nodeResult(node)?.commit ?? data.seed_commit } }, generation);
    // Allocation failures preserve the fixed node and spend no unstarted-model budget.
    await this.createConvergenceIntegration(runId, nodeId);
    const currentNode = this.store.deliveryNode(nodeId), currentData = convergenceJSON(this.store.deliveryRun(runId).data, {});
    this.store.updateDeliveryNode(nodeId, { data: { ...nodeData(currentNode), repair_attempts: (data.repair_attempts ?? 0) + 1 } }, generation);
    this.store.updateDeliveryRun(runId, { data: { ...currentData, wait_reason: null,
      repair_attempts: (currentData.repair_attempts ?? 0) + 1 } }, generation);
    return true;
  },

  async prepareConvergenceRun(runId, generation, signal) {
    let { run, parent, members } = this.assertConvergenceRun(runId, generation, ['preparing']);
    if (run.integration_worker_id && this.running.has(run.integration_worker_id)) return;
    this.assertConvergenceAuthorization(run);
    const currentParent = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${parent.branch}`);
    this.assertConvergenceRun(runId, generation, ['preparing']);
    if (currentParent !== run.baseline) { await this.refreshConvergenceBaseline(runId, generation); return; }
    const plan = convergenceJSON(run.data, {}).plan;
    const refresh = plan?.variant === 'baseline_refresh';
    check(plan?.version === 1 && Array.isArray(plan.nodes)
      && (refresh ? plan.nodes.length === 1 && plan.nodes[0].kind === 'refresh' : plan.nodes.length === 2 * members.length - 1),
    'fixed topology is missing');
    const nodes = new Map(this.store.deliveryNodes(runId, generation).map(node => [node.node_key, node]));
    // First persist every node, including unresolved topology, then perform any object calculation.
    for (const item of plan.nodes) if (!nodes.has(item.key)) {
      const member = item.kind === 'leaf' ? members.find(row => row.delivery_id === item.delivery_id) : null;
      check(item.kind !== 'leaf' || member, 'fixed topology member changed');
      const node = this.store.createDeliveryNode({ run_id: runId, generation, node_key: item.key, data: JSON.stringify({
        member_ids: item.member_ids, inputs: item.inputs, kind: item.kind,
        base: refresh ? item.base : member ? member.base_commit ?? null : run.baseline,
        left: refresh ? item.left : member ? run.baseline : null,
        right: refresh ? item.right : member?.source_commit ?? null, seed_commit: null,
        ...(refresh ? { repair_attempts: item.repair_attempts } : {}),
      }) });
      nodes.set(item.key, node);
    }
    for (const item of plan.nodes) {
      check(!signal?.aborted, 'convergence preparation interrupted');
      this.assertConvergenceRun(runId, generation, ['preparing']);
      let node = this.store.deliveryNode(nodes.get(item.key).id);
      if (node.state === 'ready' && nodeResult(node)?.commit) continue;
      if (['resolving', 'awaiting'].includes(node.state)) return;
      if (node.state === 'conflict') { await this.requestConvergenceRepair(runId, generation, node.id, nodeData(node).reason ?? 'content_conflict'); return; }
      let data = nodeData(node);
      if (item.kind === 'pair') {
        const inputs = item.inputs.map(key => this.store.deliveryNode(nodes.get(key).id));
        check(inputs.every(row => row.state === 'ready' && nodeResult(row)?.commit), 'pair input is not fixed and ready');
        data = { ...data, base: run.baseline, left: nodeResult(inputs[0]).commit, right: nodeResult(inputs[1]).commit };
        this.store.updateDeliveryNode(node.id, { data: JSON.stringify(data) }, generation);
      } else if (item.kind === 'leaf' && !members.find(member => member.delivery_id === item.delivery_id).base_commit) data = { ...data, base: null };
      const result = await this.workspaces.mergeConvergenceObjects({ base: data.base, left: data.left, right: data.right,
        message: `Convergence ${runId}/${generation} ${item.key}` });
      this.assertConvergenceRun(runId, generation, ['preparing']);
      this.store.updateDeliveryNode(node.id, { state: result.conflict ? 'conflict' : 'ready',
        data: JSON.stringify({ ...data, resolved_base: result.base, seed_commit: result.commit }),
        result: JSON.stringify({ tree: result.tree, commit: result.commit, via: 'objects' }) }, generation);
      if (result.conflict) { await this.requestConvergenceRepair(runId, generation, node.id, 'content_conflict'); return; }
    }
    ({ run, parent, members } = this.assertConvergenceRun(runId, generation, ['preparing']));
    const root = this.store.deliveryNode(nodes.get(plan.root).id), output = nodeResult(root);
    check(root.state === 'ready' && output?.tree && output.commit, 'convergence root is not ready');
    const receipt = await this.workspaces.exclusive(async () => {
      this.assertConvergenceRun(runId, generation, ['preparing']);
      // Publication is single-parent; its private keeper retains every original source and the computed topology.
      const evidenceRef = `refs/lush/convergence-evidence/${runId}/${generation}`;
      const evidenceKey = `convergence_evidence:${runId}:${generation}`;
      const registered = convergenceJSON(this.store.get('SELECT value FROM meta WHERE key=?', evidenceKey)?.value);
      const memberIds = members.map(member => member.task_id);
      if (registered) check(registered.version === 1 && registered.run_id === runId && registered.generation === generation
        && registered.ref === evidenceRef && registered.tree === output.tree && registered.root_commit === output.commit
        && JSON.stringify(registered.member_ids) === JSON.stringify(memberIds), 'fixed evidence registration changed');
      const evidenceCommit = registered?.commit ?? await this.workspaces.git(this.config.project,
        '-c', 'user.name=Lush', '-c', 'user.email=lush@localhost', 'commit-tree', output.tree,
        ...[...new Set([output.commit, run.baseline, ...members.map(member => member.source_commit)])]
          .flatMap(commit => ['-p', commit]), '-m', `Convergence evidence ${runId}/${generation}`);
      const evidence = { ref: evidenceRef, commit: evidenceCommit };
      this.assertConvergenceRun(runId, generation, ['preparing']);
      if (!registered) this.store.run('INSERT INTO meta(key,value) VALUES (?,?)', evidenceKey,
        JSON.stringify({ version: 1, run_id: runId, generation, ...evidence, tree: output.tree,
          root_commit: output.commit, member_ids: memberIds, state: 'prepared' }));
      const value = await this.workspaces.prepareConvergencePublishUnsafe({ parent: parent.branch, baseline: run.baseline,
        tree: output.tree, evidence, members: members.map(member => ({ task_id: member.task_id, branch: member.source_branch,
          source: member.source_commit, delivery_id: member.delivery_id })),
        message: `Convergence batch ${runId}/${generation}`, run_id: runId, generation });
      this.assertConvergenceRun(runId, generation, ['preparing']); return value;
    });
    // The exact single-parent publication object is what the authorized command tests.
    this.store.updateDeliveryRun(runId, { candidate_commit: receipt.commit, candidate_tree: receipt.tree,
      data: JSON.stringify({ ...convergenceJSON(run.data, {}), prepared_receipt: receipt, root_commit: output.commit }) }, generation);
    if (convergenceVerificationMode(convergenceJSON(run.data, {}).verification_mode, run.validation) === 'agent') {
      check(!signal?.aborted, 'convergence preparation interrupted');
      this.assertConvergenceRun(runId, generation, ['preparing']);
      this.assertConvergenceAuthorization(this.store.deliveryRun(runId));
      // Ready means safely prepared for publication, not tested/passed by runtime.
      this.setConvergenceState(runId, generation, 'ready', { error: null });
      await this.publishConvergence(runId);
      return;
    }
    let checkout = null;
    try {
      checkout = await this.workspaces.exclusive(() => this.workspaces.createConvergenceValidationUnsafe({
        id: runId, generation, commit: receipt.commit }));
      this.assertConvergenceRun(runId, generation, ['preparing']);
      const command = this.assertConvergenceAuthorization(this.store.deliveryRun(runId));
      const startedAt = now();
      this.setConvergenceState(runId, generation, 'validating', { validation_result: JSON.stringify({ state: 'running', started_at: startedAt,
        command_name: command.name, tested_commit: receipt.commit, tested_tree: receipt.tree }) });
      const result = await this.workspaces.runConvergenceValidation(checkout, command.command, () => {
        this.assertConvergenceRun(runId, generation, ['validating']);
        this.assertConvergenceAuthorization(this.store.deliveryRun(runId)); return true;
      }, { ...this.convergenceValidationOptions, signal });
      this.assertConvergenceRun(runId, generation, ['validating']);
      this.assertConvergenceAuthorization(this.store.deliveryRun(runId));
      const passed = result.status === 'succeeded' || result.state === 'succeeded';
      // Only safe runner scalars are persisted; never command body, env, stdout/stderr or exceptions.
      const evidence = { state: passed ? 'passed' : 'failed', command_name: command.name, started_at: startedAt,
        finished_at: now(), tested_commit: receipt.commit, tested_tree: receipt.tree,
        exit_code: Number.isInteger(result.exit_code) ? result.exit_code : null,
        reason: ['timeout', 'output_limit', 'exit', 'spawn', 'aborted', 'identity', 'dirty'].includes(result.reason) ? result.reason : null,
        error: passed ? null : '最终验证未通过；未发布到真实父分支。' };
      this.store.updateDeliveryRun(runId, { validation_result: JSON.stringify(evidence) }, generation);
      if (!passed) {
        this.setConvergenceState(runId, generation, 'preparing');
        await this.requestConvergenceRepair(runId, generation, root.id, 'validation_failed'); return;
      }
      this.setConvergenceState(runId, generation, 'ready', { error: null });
    } finally {
      if (checkout) await this.workspaces.exclusive(() => this.workspaces.removeConvergenceValidationUnsafe(checkout));
    }
    await this.publishConvergence(runId);
  },
};
