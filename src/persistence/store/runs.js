import { check, id } from '../../core/types.js';

/** Durable invocation attempts and structured artifacts. */
export const runs = {
  startRun(task, agent = {}) {
    const row = this.run(`INSERT INTO agent_runs(task_id,attempt,role,provider,model,thinking) VALUES (?,?,?,?,?,?)`,
      task.id, task.calls + 1, task.role, agent.agent || null, agent.model || null, agent.thinking || null);
    return this.get('SELECT * FROM agent_runs WHERE id=?', Number(row.lastInsertRowid));
  },
  finishRun(runId, status, { result = null, error = null } = {}) {
    check(['completed','failed','cancelled'].includes(status), 'invalid run status');
    this.run(`UPDATE agent_runs SET status=?,result=?,error=?,ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      status, result, error, id(runId));
    return this.get('SELECT * FROM agent_runs WHERE id=?', id(runId));
  },
  runsForTask(taskId) { return this.all('SELECT * FROM agent_runs WHERE task_id=? ORDER BY id', id(taskId)); },
  addArtifact({ task_id, run_id = null, input_id = null, kind, payload, metadata = {} }) {
    check(typeof kind === 'string' && kind.length > 0 && kind.length <= 64, 'artifact kind must be non-empty text');
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    check(Buffer.byteLength(body) <= 512000, 'artifact payload exceeds 512000 bytes');
    const row = this.run(`INSERT INTO artifacts(task_id,run_id,input_id,kind,payload,metadata) VALUES (?,?,?,?,?,?)`,
      id(task_id), run_id === null ? null : id(run_id), input_id, kind, body, JSON.stringify(metadata ?? {}));
    return this.artifact(Number(row.lastInsertRowid));
  },
  artifact(artifactId) {
    const row = this.get('SELECT * FROM artifacts WHERE id=?', id(artifactId));
    check(row, `artifact ${artifactId} not found`);
    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { /* preserve malformed historical metadata as empty */ }
    return { ...row, metadata };
  },
  artifactsForTask(taskId) { return this.all('SELECT id FROM artifacts WHERE task_id=? ORDER BY id', id(taskId)).map(row => this.artifact(row.id)); },
  artifactsForInput(inputId) { return this.all('SELECT id FROM artifacts WHERE input_id=? ORDER BY id', id(inputId)).map(row => this.artifact(row.id)); },
};
