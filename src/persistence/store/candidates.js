import { check, id } from '../../core/types.js';

export const CANDIDATE_STATUSES = new Set([
  'pending','preparing','ready','accepted','changes_requested','superseded','rejected','integrated','failed',
]);

const TRANSITIONS = Object.freeze({
  pending: new Set(['preparing','changes_requested','superseded','rejected']),
  preparing: new Set(['preparing','ready','failed','changes_requested','superseded','rejected']),
  ready: new Set(['accepted','changes_requested','superseded','rejected']),
  accepted: new Set(['accepted','ready','integrated','changes_requested','superseded','rejected']),
  failed: new Set(['preparing','rejected']),
  changes_requested: new Set(['rejected']),
  superseded: new Set(), rejected: new Set(), integrated: new Set(),
});

const ACTIONS = Object.freeze({
  verification_requested: { from: new Set(['pending','preparing','failed']), to: 'preparing' },
  supersede: { from: new Set(['pending','preparing','ready','accepted']), to: 'superseded' },
  accept: { from: new Set(['ready','accepted']), to: 'accepted' },
  integration_succeeded: { from: new Set(['accepted']), to: 'integrated' },
  integration_failed: { from: new Set(['accepted']), to: 'ready' },
  request_changes: { from: new Set(['pending','preparing','ready','accepted']), to: 'changes_requested' },
  reject: { from: new Set(['pending','preparing','ready','accepted','failed','changes_requested']), to: 'rejected' },
});

function patchKeys(patch) {
  const allowed = ['summary','feedback','report_task_id'];
  check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid candidate patch');
}
function assertTransition(from, to) {
  check(CANDIDATE_STATUSES.has(to), 'invalid candidate status');
  check(TRANSITIONS[from]?.has(to), `invalid candidate transition ${from} -> ${to}`);
}

/** Frozen, user-reviewable intent results backed by an integration branch commit. */
export const candidates = {
  candidate(candidateId) {
    const row = this.get('SELECT * FROM review_candidates WHERE id=?', id(candidateId));
    check(row, `review candidate ${candidateId} not found`);
    return row;
  },
  candidates(inputId = null) {
    return inputId === null
      ? this.all('SELECT * FROM review_candidates ORDER BY id DESC')
      : this.all('SELECT * FROM review_candidates WHERE input_id=? ORDER BY version DESC', id(inputId));
  },
  latestCandidate(inputId) {
    return this.get('SELECT * FROM review_candidates WHERE input_id=? ORDER BY version DESC LIMIT 1', id(inputId)) ?? null;
  },
  createCandidate({ input_id, branch, commit, baseline_branch, baseline_commit, summary = null }) {
    const input = id(input_id);
    const version = this.get('SELECT COALESCE(MAX(version),0)+1 AS value FROM review_candidates WHERE input_id=?', input).value;
    // 候选只冻结待审阅的两个 commit；验收任务必须由用户另行显式启动。
    // 显式写 status，兼容已有数据库仍保留 preparing 默认值的 schema。
    const row = this.run(`INSERT INTO review_candidates(input_id,version,branch,commit_hash,baseline_branch,baseline_commit,status,summary)
      VALUES (?,?,?,?,?,?,'pending',?)`, input, version, branch, commit, baseline_branch, baseline_commit, summary);
    return this.candidate(Number(row.lastInsertRowid));
  },

  /**
   * Compatibility patch entry. Status writes are still checked by the same centralized transition graph;
   * new orchestration code should use transitionCandidate(action) so actor intent is explicit.
   */
  updateCandidate(candidateId, patch) {
    check(Object.keys(patch).length > 0, 'invalid candidate patch');
    const candidate = this.candidate(candidateId);
    const status = patch.status;
    const rest = { ...patch }; delete rest.status;
    patchKeys(rest);
    if (status !== undefined) assertTransition(candidate.status, status);
    this.run(`UPDATE review_candidates SET ${Object.keys(patch).map(key => `${key}=?`).join(',')},
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(patch), candidate.id);
    return this.candidate(candidate.id);
  },

  /**
   * Candidate state-machine entry used by every user action and asynchronous Git outcome.
   * This SQL transaction cannot cover later Git work; accept first records `accepted`, then the serialized Git
   * boundary reports integration_succeeded/integration_failed through this same contract.
   * @param {number|string} candidateId
   * @param {'verification_requested'|'supersede'|'accept'|'integration_succeeded'|'integration_failed'|'request_changes'|'reject'} action
   * @param {{summary?: string, feedback?: string, report_task_id?: number}} [patch]
   * @returns {object}
   */
  transitionCandidate(candidateId, action, patch = {}) {
    const rule = ACTIONS[action];
    check(rule, `unknown candidate transition action ${action}`);
    patchKeys(patch);
    const candidate = this.candidate(candidateId);
    check(rule.from.has(candidate.status), `candidate #${candidate.id} is ${candidate.status}; cannot ${action}`);
    assertTransition(candidate.status, rule.to);
    const update = { ...patch, status: rule.to };
    this.run(`UPDATE review_candidates SET ${Object.keys(update).map(key => `${key}=?`).join(',')},
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(update), candidate.id);
    return this.candidate(candidate.id);
  },

  /** 只有当前 preparing Candidate 自己登记的 verifier 才能结算；检查与写入由一条 SQL 原子完成。 */
  settleCandidateVerification(candidateId, reportTaskId, status) {
    const candidate = id(candidateId);
    const verifier = id(reportTaskId);
    check(status === 'ready' || status === 'failed', 'candidate verification must settle as ready or failed');
    assertTransition('preparing', status);
    const result = this.run(`UPDATE review_candidates SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='preparing' AND report_task_id=?`, status, candidate, verifier);
    // SQLite wrappers may include AFTER-trigger maintenance writes in `changes`; the guarded
    // candidate row contributes at least one change, while a stale verifier still contributes zero.
    return { applied: Number(result.changes) >= 1, candidate: this.candidate(candidate) };
  },
};
