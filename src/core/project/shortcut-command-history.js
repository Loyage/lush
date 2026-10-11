import { check } from '../types.js';

const finalTypes = ['shortcut.command_succeeded', 'shortcut.command_failed', 'shortcut.command_unknown'];
const roots = ['shortcut.command_pending', 'shortcut.command_started'];
// One bounded marker per stable root, rather than a growing JSON list or an evicting cache.
// Markers must not expire: eviction would resurrect removed history. Original Events stay intact.
const REMOVED_KEY = 'shortcut_command_history_removed:';
export const commandExecutionUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const statuses = new Set(['pending', 'running', 'succeeded', 'failed', 'unknown']);
const reasons = new Set(['exit', 'spawn', 'timeout', 'output_limit', 'admission', 'interrupted']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGQUIT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGPIPE', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGALRM']);

/** Never spread executor results or historical JSON into a public read or an audit event. */
export function safeCommandResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    status: statuses.has(result.status) ? result.status : 'unknown',
    exit_code: Number.isSafeInteger(result.exit_code) && result.exit_code >= 0 && result.exit_code <= 255 ? result.exit_code : null,
    signal: signals.has(result.signal) ? result.signal : null,
    reason: reasons.has(result.reason) ? result.reason : null,
    output_bytes: Number.isSafeInteger(result.output_bytes) && result.output_bytes >= 0 ? result.output_bytes : 0,
    output_truncated: result.output_truncated === true,
  };
}
export function executionSnapshot(project, item, workerId, executionId, source, status, createdAt = new Date().toISOString()) {
  return { id: executionId, command_id: item.id, command_name: item.name, command_version: item.version,
    worker_id: workerId, worker_number: project.store.get('SELECT worker_number FROM tasks WHERE id=?', workerId)?.worker_number ?? null,
    source, status, created_at: createdAt, finished_at: null };
}
function parsed(row) {
  try { const value = JSON.parse(row?.data ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function timestamp(value, fallback = null) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : fallback; }
const placeholders = items => items.map(() => '?').join(',');

/** First claim/start is a stable cursor identity, independent of later completion or directory edits. */
function rootRows(project, { before = null, limit = 30, execution_id = null, includeRemoved = false } = {}) {
  const where = ["e.type IN ('shortcut.command_pending','shortcut.command_started')",
    "json_type(e.data,'$.execution_id')='text'",
    `NOT EXISTS (SELECT 1 FROM events prior WHERE prior.id<e.id AND prior.type IN ('shortcut.command_pending','shortcut.command_started')
      AND json_extract(prior.data,'$.execution_id')=json_extract(e.data,'$.execution_id'))`];
  const params = [];
  if (!includeRemoved) { where.push('NOT EXISTS (SELECT 1 FROM meta hidden WHERE hidden.key=? || e.id)'); params.push(REMOVED_KEY); }
  if (before !== null) { where.push('e.id<?'); params.push(before); }
  if (execution_id !== null) { where.push("json_extract(e.data,'$.execution_id')=?"); params.push(execution_id); }
  return project.store.all(`SELECT e.id,e.task_id,e.type,e.data,e.created_at FROM events e WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`, ...params, limit + 1);
}
function views(project, rows) {
  if (!rows.length) return [];
  const ids = rows.map(row => parsed(row).execution_id);
  const transitions = project.store.all(`SELECT type,data,created_at,id FROM events WHERE type IN (${placeholders([...roots, ...finalTypes])})
    AND json_extract(data,'$.execution_id') IN (${placeholders(ids)}) ORDER BY id`, ...roots, ...finalTypes, ...ids);
  const latest = new Map();
  for (const row of transitions) latest.set(parsed(row).execution_id, row);
  const workerIds = [...new Set(rows.map(row => row.task_id).filter(positive))];
  const numbers = new Map(workerIds.length ? project.store.all(`SELECT id,worker_number FROM tasks WHERE id IN (${placeholders(workerIds)})`, ...workerIds).map(row => [row.id, row.worker_number]) : []);
  return rows.map(row => {
    const data = parsed(row), tail = latest.get(data.execution_id) ?? row, result = safeCommandResult(parsed(tail).command_result);
    const status = tail.type === 'shortcut.command_started' ? 'running' : tail.type.slice('shortcut.command_'.length);
    return { event_id: row.id, id: data.execution_id, command_id: commandExecutionUUID(data.command_id) ? data.command_id : null,
      command_name: typeof data.command_name === 'string' && data.command_name.length <= 120 ? data.command_name : null,
      command_version: positive(data.command_version ?? data.version) ? data.command_version ?? data.version : null,
      worker_id: positive(row.task_id) ? row.task_id : null,
      worker_number: typeof data.worker_number === 'string' && /^W\d+(?:-\d+)*$/.test(data.worker_number) ? data.worker_number : numbers.get(row.task_id) ?? null,
      source: ['manual','hook'].includes(data.source) ? data.source : 'unknown',
      status: statuses.has(status) ? status : 'unknown', created_at: timestamp(data.created_at, row.created_at),
      finished_at: finalTypes.includes(tail.type) ? timestamp(parsed(tail).finished_at, tail.created_at) : null,
      ...(result ? { command_result: result } : {}) };
  });
}
export function commandHistory(project, options = {}) {
  check(options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(key => ['before','limit','execution_id'].includes(key)), 'invalid command history options');
  const { before = null, limit = 30, execution_id = null } = options;
  check(before === null || positive(before), 'before must be a positive event cursor');
  check(positive(limit) && limit <= 100, 'command history limit must be 1..100');
  check(execution_id === null || commandExecutionUUID(execution_id), 'invalid command execution id');
  check(execution_id === null || before === null, 'execution lookup does not accept before');
  const rows = rootRows(project, { before, limit, execution_id }), hasMore = rows.length > limit;
  const items = views(project, rows.slice(0, limit));
  return { version: 1, items, has_more: hasMore, next_before: hasMore ? items.at(-1).event_id : null };
}

/** Safe projection only: never rewrite the private execution slot or its authorization revision. */
export function commandHistoryRemoved(project, executionId) {
  if (!commandExecutionUUID(executionId)) return false;
  const row = rootRows(project, { execution_id: executionId, limit: 1, includeRemoved: true })[0];
  return Boolean(row && project.store.get('SELECT key FROM meta WHERE key=?', REMOVED_KEY + row.id));
}

export function removeCommandHistory(project, options = {}) {
  check(options && typeof options === 'object' && !Array.isArray(options), 'invalid command history removal options');
  const keys = Object.keys(options);
  check(keys.length === 1 && (keys[0] === 'execution_id' && commandExecutionUUID(options.execution_id)
    || keys[0] === 'clear' && options.clear === true), 'provide execution_id or clear:true');
  let removed = 0;
  project.store.transaction(() => {
    let before = null;
    for (;;) {
      const rows = rootRows(project, { before, limit: 100, execution_id: options.execution_id ?? null }).slice(0, 100);
      if (!rows.length) break;
      for (const execution of views(project, rows)) {
        const removable = ['succeeded','failed'].includes(execution.status);
        if (options.execution_id) check(removable, 'pending, running or unknown command history cannot be removed');
        if (!removable) continue;
        project.store.run('INSERT INTO meta(key,value) VALUES (?,?)', REMOVED_KEY + execution.event_id, '1');
        removed++;
      }
      if (options.execution_id) break;
      before = rows.at(-1).id;
    }
    if (removed) project.store.event(null, 'shortcut.command_history_removed',
      { removed_count: removed, ...(options.execution_id ? { execution_id: options.execution_id } : { clear: true }) });
  });
  return { removed_count: removed };
}

/** Startup only: scan bounded pages, including claims whose command was edited/deleted while in flight. */
export function recoverCommandHistory(project, finish) {
  let before = null;
  for (;;) {
    const rows = rootRows(project, { before, limit: 100, includeRemoved: true }).slice(0, 100);
    if (!rows.length) return;
    for (const execution of views(project, rows)) if (['pending','running'].includes(execution.status))
      finish(execution.command_id, execution.id, execution.worker_id, 'unknown', { status: 'unknown', reason: 'interrupted' });
    before = rows.at(-1).id;
  }
}
