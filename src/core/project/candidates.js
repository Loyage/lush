import { check, id, text, bounded } from '../types.js';

/**
 * 接受失败不是静默状态：候选回到 ready 继续可审阅，这次失败留在事件里；
 * 分支已经漂移的候选下次仍会在校验阶段被拒，用户需要重新 freeze 一版。
 */
function recordAcceptFailure(project, candidate, reason) {
  project.store.transaction(() => {
    project.store.updateCandidate(candidate.id, { status: 'ready' });
    const input = project.store.get('SELECT task_id FROM inputs WHERE id=?', candidate.input_id);
    project.store.event(input?.task_id ?? null, 'candidate.accept_failed', { candidate: candidate.id,
      commit: candidate.commit_hash, target: candidate.baseline_branch, error: reason });
  });
  return project.store.candidate(candidate.id);
}

/** Intent-first delivery: freeze an integration commit and attach preview/evidence before final approval. */
export default {
  async prepareCandidate(inputId, summary = null) {
    const input = this.store.get('SELECT * FROM inputs WHERE id=?', id(inputId));
    check(input, `input ${inputId} not found`);
    check(input.anchor_branch && input.anchor_commit && input.anchor_target_branch,
      `input #${input.id} has no integration branch`);
    if (summary !== null && summary !== undefined) text(summary, 'summary');
    const active = this.store.all(`SELECT id,status,role FROM tasks WHERE input_id=? AND layer='work'
      AND role NOT IN ('verifier') AND status NOT IN ('completed','failed','cancelled') ORDER BY id`, input.id);
    check(active.length === 0, `input #${input.id} still has active work: ${active.map(task => `#${task.id}`).join(', ')}`);
    const state = await this.workspaces.branchState(input.anchor_branch);
    check(state.status !== 'missing', `input integration branch ${input.anchor_branch} is missing`);
    check(state.blockers.length === 0,
      `review is blocked by work not integrated into ${input.anchor_branch}: ${state.blockers.join(', ')}`);
    const commit = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${input.anchor_branch}^{commit}`);
    const baseline = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${input.anchor_target_branch}^{commit}`);
    const previous = this.store.latestCandidate(input.id);
    const candidate = this.store.transaction(() => {
      if (previous && ['pending','preparing','ready','accepted'].includes(previous.status)) this.store.updateCandidate(previous.id, { status: 'superseded' });
      const created = this.store.createCandidate({ input_id: input.id, branch: input.anchor_branch, commit,
        baseline_branch: input.anchor_target_branch, baseline_commit: baseline, summary: summary ?? input.content.split('\n')[0].trim() });
      this.store.event(input.task_id, 'candidate.created', { candidate: created.id, version: created.version,
        branch: created.branch, commit: created.commit_hash, baseline: created.baseline_commit });
      return created;
    });
    // 冻结候选不等于启动验收。verifier 会消耗执行槽并暂时阻止输入分支收口，
    // 只能由用户通过 candidate.verify 显式启动。
    return this.store.candidate(candidate.id);
  },

  verifyCandidate(candidateId) {
    const candidate = this.store.candidate(candidateId);
    // pending 是新候选等待用户显式验收；preparing 兼容旧数据里尚未真正派 verifier 的候选。
    check(['pending','preparing','failed'].includes(candidate.status), `candidate #${candidate.id} is ${candidate.status}; it cannot be verified`);
    const active = this.store.get(`SELECT id FROM tasks WHERE review_candidate_id=?
      AND status NOT IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT 1`, candidate.id);
    check(!active, `candidate verification #${active?.id} is still running`);
    const input = this.store.get('SELECT content FROM inputs WHERE id=?', candidate.input_id);
    const goal = `验收候选 #${candidate.id} v${candidate.version}：对照 ${candidate.baseline_branch}，验证固定提交 ${candidate.commit_hash} 是否满足用户意图。\n\n原始意图：${input?.content ?? ''}`;
    const task = this.store.transaction(() => {
      const created = this.store.create({ parent_id: null, input_id: candidate.input_id, role: 'verifier', goal,
        name: `candidate-${candidate.id}`, review_candidate_id: candidate.id });
      this.store.updateCandidate(candidate.id, { status: 'preparing', report_task_id: created.id });
      this.store.event(created.id, 'candidate.verify_requested', { candidate: candidate.id, commit: candidate.commit_hash });
      return created;
    });
    this.kick();
    return task;
  },

  candidateContext(task) {
    const candidate = this.store.candidate(task.review_candidate_id);
    const input = this.store.get('SELECT content,anchor_workspace FROM inputs WHERE id=?', candidate.input_id);
    return {
      candidate: { id: candidate.id, version: candidate.version, summary: candidate.summary,
        intent: input?.content ?? '', commit: candidate.commit_hash, baseline_commit: candidate.baseline_commit },
      branch: candidate.branch, target_branch: candidate.baseline_branch,
      workspace: input?.anchor_workspace, baseline_workspace: task.baseline_workspace,
      baseline_commit: candidate.baseline_commit, report_path: this.reportPath(task.id),
    };
  },

  candidates(inputId = null) {
    return bounded(this.store.candidates(inputId).map(candidate => ({ ...candidate,
      has_report: Boolean(candidate.report_task_id && this.hasReport(candidate.report_task_id)) })), 500000);
  },

  candidate(candidateId) {
    const candidate = this.store.candidate(candidateId);
    return { ...candidate,
      has_report: Boolean(candidate.report_task_id && this.hasReport(candidate.report_task_id)),
      artifacts: bounded(this.store.artifactsForInput(candidate.input_id), 300000) };
  },

  /**
   * 用户接受：交付的必须是候选冻结的那个 commit，而不是接受那一刻的分支 tip。
   * 校验一（tip 是否还等于冻结提交）发生在写操作前，给同步调用者快速失败；
   * 校验二在 Git 串行区间内完成（见 workspaces.mergeBranch 的 expected），
   * 所以「校验通过 → 分支被别的操作推走 → 合并」这个交错只会落地固定提交，不会扩大交付范围。
   */
  async acceptCandidate(candidateId) {
    const candidate = this.store.candidate(candidateId);
    check(['ready','accepted'].includes(candidate.status), `candidate #${candidate.id} is ${candidate.status}; review it before accepting`);
    const tip = await this.workspaces.git(this.config.project, 'rev-parse', `refs/heads/${candidate.branch}^{commit}`);
    check(tip === candidate.commit_hash,
      `candidate #${candidate.id} pins ${candidate.commit_hash.slice(0,12)}, but ${candidate.branch} moved to ${tip.slice(0,12)}; prepare a new candidate`);
    this.store.updateCandidate(candidate.id, { status: 'accepted' });
    let outcome;
    try {
      outcome = await this.approveBranchMerge(candidate.branch, candidate.commit_hash);
    } catch (error) {
      recordAcceptFailure(this, candidate, error.message);
      throw error;
    }
    if (outcome.merged || outcome.already_integrated) {
      this.store.updateCandidate(candidate.id, { status: 'integrated' });
      const input = this.store.get('SELECT task_id FROM inputs WHERE id=?', candidate.input_id);
      this.store.event(input?.task_id ?? null, 'candidate.integrated', { candidate: candidate.id,
        commit: outcome.landed ?? candidate.commit_hash, target: candidate.baseline_branch });
    } else {
      // 没有落地也没有抛错（例如父分支已分歧）：把这次接受明确记为失败，候选回到 ready。
      recordAcceptFailure(this, candidate,
        `candidate #${candidate.id} was not integrated: ${candidate.branch} is ${outcome.status} with respect to ${candidate.baseline_branch}`);
    }
    return { candidate: this.store.candidate(candidate.id), integration: outcome };
  },

  requestCandidateChanges(candidateId, feedback) {
    const candidate = this.store.candidate(candidateId);
    check(['pending','preparing','ready','accepted'].includes(candidate.status), `candidate #${candidate.id} is ${candidate.status}`);
    text(feedback, 'feedback');
    const input = this.store.get('SELECT * FROM inputs WHERE id=?', candidate.input_id);
    return this.store.transaction(() => {
      this.store.updateCandidate(candidate.id, { status: 'changes_requested', feedback });
      const planner = this.store.create({ input_id: input.id, role: 'planner',
        goal: `${input.content}\n\n候选 v${candidate.version} 的验收反馈：\n${feedback}` });
      this.store.run('UPDATE inputs SET task_id=? WHERE id=?', planner.id, input.id);
      this.store.message(planner.id, JSON.stringify({ candidate: candidate.id, feedback }));
      this.store.event(planner.id, 'candidate.changes_requested', { candidate: candidate.id, feedback });
      this.kick();
      return { candidate: this.store.candidate(candidate.id), planner };
    });
  },

  rejectCandidate(candidateId, reason = '用户放弃这版结果') {
    const candidate = this.store.candidate(candidateId);
    check(!['integrated','rejected','superseded'].includes(candidate.status), `candidate #${candidate.id} is ${candidate.status}`);
    if (reason !== null && reason !== undefined) text(reason, 'reason');
    return this.store.updateCandidate(candidate.id, { status: 'rejected', feedback: reason });
  },
};
