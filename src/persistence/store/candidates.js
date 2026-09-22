import { check, id } from '../../core/types.js';

const STATUSES = new Set(['pending','preparing','ready','accepted','changes_requested','superseded','rejected','integrated','failed']);

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
  updateCandidate(candidateId, patch) {
    const allowed = ['status','summary','feedback','report_task_id'];
    check(Object.keys(patch).length > 0 && Object.keys(patch).every(key => allowed.includes(key)), 'invalid candidate patch');
    if (patch.status !== undefined) check(STATUSES.has(patch.status), 'invalid candidate status');
    this.run(`UPDATE review_candidates SET ${Object.keys(patch).map(key => `${key}=?`).join(',')},
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...Object.values(patch), id(candidateId));
    return this.candidate(candidateId);
  },
  /** 只有仍处于 preparing 且仍绑定本 verifier 的候选能接收结算；用户决定与后续验收不会被迟到结果覆盖。 */
  settleCandidateVerification(candidateId, taskId, status) {
    check(status === 'ready' || status === 'failed', 'invalid candidate verification status');
    const candidate = id(candidateId), task = id(taskId);
    const result = this.run(`UPDATE review_candidates SET status=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='preparing' AND report_task_id=?`, status, candidate, task);
    return { candidate: this.candidate(candidate), applied: result.changes === 1 };
  },
};
