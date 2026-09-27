import { check, id, isPlainObject } from '../../core/types.js';

const VERIFICATION_STATUSES = new Set(['pass','fail','partial','unverified']);
const LIST_FIELDS = ['failures','unverified','baseline_failures','residual_risks'];

function shortText(value, name, limit = 32000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= limit,
    `${name} must be non-empty text (max ${limit} characters)`);
  return value;
}
function stringList(value, name) {
  check(Array.isArray(value) && value.length <= 100, `${name} must be an array (max 100 items)`);
  return value.map((item, index) => shortText(item, `${name}[${index}]`, 4000));
}
function exitCode(value, name) {
  check(Number.isInteger(value) && value >= -1 && value <= 65535, `${name} must be an integer between -1 and 65535`);
  return value;
}

/**
 * Validate the versioned run.result payload at the persistence boundary.
 * Invocation completion and verification conclusions deliberately use different fields.
 * @param {object} payload
 * @returns {object}
 */
export function validateRunResultPayload(payload) {
  check(isPlainObject(payload) && payload.schema_version === 2, 'run.result payload schema_version must be 2');
  check(isPlainObject(payload.invocation) && payload.invocation.status === 'completed',
    'run.result invocation status must be completed');
  shortText(payload.summary, 'run.result summary', 256000);
  check(isPlainObject(payload.verification), 'run.result verification must be an object');
  const verification = payload.verification;
  check(VERIFICATION_STATUSES.has(verification.status),
    'verification status must be pass, fail, partial or unverified');
  for (const field of ['tested_commit','baseline_commit']) {
    check(verification[field] === null || (typeof verification[field] === 'string' && /^[0-9a-f]{40,64}$/i.test(verification[field])),
      `verification ${field} must be a commit hash or null`);
  }
  shortText(verification.summary, 'verification summary', 32000);
  check(Array.isArray(verification.commands) && verification.commands.length <= 100,
    'verification commands must be an array (max 100 items)');
  verification.commands.forEach((command, index) => {
    check(isPlainObject(command), `verification commands[${index}] must be an object`);
    shortText(command.command, `verification commands[${index}].command`, 4000);
    exitCode(command.exit_code, `verification commands[${index}].exit_code`);
    if (command.baseline_exit_code !== null && command.baseline_exit_code !== undefined) {
      exitCode(command.baseline_exit_code, `verification commands[${index}].baseline_exit_code`);
    }
    shortText(command.summary, `verification commands[${index}].summary`, 4000);
  });
  for (const field of LIST_FIELDS) stringList(verification[field], `verification ${field}`);
  if (verification.status !== 'unverified') check(verification.commands.length > 0,
    `${verification.status} verification must include at least one command`);
  if (verification.status === 'pass') {
    check(verification.commands.every(command => command.exit_code === 0),
      'pass verification cannot contain a failing tested exit code');
    check(verification.failures.length === 0, 'pass verification cannot contain failures');
    check(verification.unverified.length === 0, 'pass verification cannot contain unverified items');
    // A passing candidate may still record failures on the frozen baseline and acknowledged residual risks.
  }
  if (verification.status === 'fail') check(verification.failures.length > 0,
    'fail verification must describe at least one failure');
  if (verification.status === 'partial') check(
    verification.failures.length + verification.unverified.length + verification.residual_risks.length > 0,
    'partial verification must describe incomplete coverage or risk');
  if (verification.status === 'unverified') check(verification.unverified.length > 0,
    'unverified verification must describe what was not verified');
  check(isPlainObject(verification.report)
    && Number.isSafeInteger(verification.report.task_id) && verification.report.task_id > 0
    && typeof verification.report.path === 'string' && verification.report.path.length > 0
    && typeof verification.report.available === 'boolean', 'verification report reference is invalid');
  return payload;
}

function unknownVerification() {
  return { status: 'unknown', tested_commit: null, baseline_commit: null, commands: [],
    summary: 'This historical artifact has no structured verification evidence.', report: null,
    failures: [], unverified: [], baseline_failures: [], residual_risks: [] };
}

/**
 * Parse the Artifact payload for callers without rewriting historical rows.
 * @param {string} kind
 * @param {string|object} source
 * @returns {object}
 */
export function artifactPayload(kind, source) {
  let value = source;
  if (typeof source === 'string') {
    try { value = JSON.parse(source); } catch { value = { summary: source }; }
  }
  if (!isPlainObject(value)) value = { summary: String(value ?? '') };
  if (kind !== 'run.result') return value;
  if (value.schema_version === 2) {
    try { return validateRunResultPayload(value); } catch { /* malformed historical rows remain readable below */ }
  }
  return { ...value, schema_version: value.schema_version ?? 1,
    invocation: isPlainObject(value.invocation) ? value.invocation
      : { status: value.outcome === 'success' ? 'completed' : 'unknown' },
    // Only a fully validated version 2 envelope can carry a trusted conclusion. Historical or malformed
    // payloads remain readable, but cannot accidentally promote a Candidate.
    verification: unknownVerification() };
}

/** Durable invocation attempts and structured artifacts. */
export const runs = {
  startRun(task, agent = {}) {
    const row = this.run(`INSERT INTO agent_runs(task_id,attempt,role,provider,model,thinking) VALUES (?,?,?,?,?,?)`,
      task.id, task.calls + 1, task.role, agent.agent || null, agent.model || null, agent.thinking || null);
    return this.get('SELECT * FROM agent_runs WHERE id=?', Number(row.lastInsertRowid));
  },
  finishRun(runId, status, { result = null, error = null } = {}) {
    check(['completed','failed','cancelled','preempted'].includes(status), 'invalid run status');
    this.run(`UPDATE agent_runs SET status=?,result=?,error=?,ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      status, result, error, id(runId));
    return this.get('SELECT * FROM agent_runs WHERE id=?', id(runId));
  },
  runsForTask(taskId) { return this.all('SELECT * FROM agent_runs WHERE task_id=? ORDER BY id', id(taskId)); },
  /** 批量取回每轮的起止，供任务读模型一次性把「工作用时 / 等待」投影出来；分块避免 IN 列表过长。 */
  runsForTasks(taskIds) {
    const ids = [...new Set(taskIds.filter(value => value !== null && value !== undefined))];
    const byTask = new Map();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      for (const row of this.all(`SELECT task_id, started_at, ended_at FROM agent_runs
        WHERE task_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`, ...chunk)) {
        if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
        byTask.get(row.task_id).push(row);
      }
    }
    return byTask;
  },
  addArtifact({ task_id, run_id = null, input_id = null, kind, payload, metadata = {} }) {
    check(typeof kind === 'string' && kind.length > 0 && kind.length <= 64, 'artifact kind must be non-empty text');
    if (kind === 'run.result') validateRunResultPayload(payload);
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
    return { ...row, payload: artifactPayload(row.kind, row.payload), metadata };
  },
  artifactsForTask(taskId) { return this.all('SELECT id FROM artifacts WHERE task_id=? ORDER BY id', id(taskId)).map(row => this.artifact(row.id)); },
  artifactsForInput(inputId) { return this.all('SELECT id FROM artifacts WHERE input_id=? ORDER BY id', id(inputId)).map(row => this.artifact(row.id)); },
};
