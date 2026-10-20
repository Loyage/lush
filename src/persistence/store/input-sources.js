import { definitionHash, requestKey } from '../../core/project/input-emission-data.js';

const positive = value => Number.isSafeInteger(value) && value > 0;
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const unknown = () => ({ kind: 'unknown', worker_id: null, worker_number: null });
const safe = column => `CASE WHEN length(CAST(${column} AS BLOB))<=16777216 AND json_valid(${column}) THEN ${column} ELSE '{}' END`;
const sourceFields = column => {
  const json = safe(column);
  return `json_type(${json},'$.input_source') AS source_type,
    CASE WHEN json_extract(${json},'$.input_source.kind') IN ('user','valet','worker','system','unknown')
      THEN json_extract(${json},'$.input_source.kind') END AS source_kind,
    CASE WHEN json_type(${json},'$.input_source.worker_id')='integer'
      THEN json_extract(${json},'$.input_source.worker_id') END AS source_worker_id`;
};
const rowSource = row => ({ kind: row.source_kind, worker_id: row.source_worker_id });

/** Only code-owned call context / persisted evidence reaches here, never public params.
 * Numbers are always read from the real Worker, not accepted from an attachment. */
export function inputSource(store, value) {
  if (!value || !['user','valet','worker','system','unknown'].includes(value.kind)) return unknown();
  if (!['valet','worker'].includes(value.kind)) return { kind: value.kind, worker_id: null, worker_number: null };
  if (!positive(value.worker_id)) return unknown();
  const actor = store.get('SELECT worker_number FROM tasks WHERE id=?', value.worker_id);
  return { kind: value.kind, worker_id: value.worker_id, worker_number: actor?.worker_number ?? null };
}

export function actorInputSource(store, actor = null) {
  if (actor === null) return inputSource(store, { kind: 'user' });
  const task = store.task(actor);
  return inputSource(store, { kind: task.role === 'manager' && task.task_kind === 'management' ? 'valet' : 'worker', worker_id: task.id });
}

function unique(store, values) {
  if (!values.length) return unknown();
  const sources = values.map(value => inputSource(store, value));
  return sources.every(value => value.kind === sources[0].kind && value.worker_id === sources[0].worker_id) ? sources[0] : unknown();
}

/** Historical recovery is deliberately narrow: a fixed successful private receipt
 * must identify the exact result, with a start/completion Event bracketing its
 * creation/mount. Dedup returns of older authorizations cannot claim authorship.
 * No text/time/NULL sender/development-parent inference, no history writes. */
function managementSources(store, { mount = null, task = null } = {}) {
  const evidenceId = mount?.id ?? store.get("SELECT id FROM events WHERE task_id=? AND type='created' ORDER BY id LIMIT 1", task.id)?.id;
  if (!positive(evidenceId)) return [];
  const methods = mount ? ['input.emit','order.submit'] : ['order.submit','worker.spawn'];
  // Start from indexed audit Event identities, not every manager's private JSON.
  // Limit candidate receipts before reading their owner-specific attachments. A
  // budget overflow is incomplete evidence, never permission to guess an author.
  const candidates = store.all(`SELECT s.task_id AS actor_id,r.id AS receipt_id,json_extract(${safe('r.data')},'$.method') AS method
    FROM events s JOIN events r ON r.id=json_extract(${safe('s.data')},'$.receipt_id') AND r.task_id=s.task_id
    JOIN tasks t ON t.id=s.task_id AND t.role='manager' AND t.task_kind='management'
    WHERE s.type='management.capability_started' AND s.id<? AND r.id<s.id AND r.type='management.capability_requested'
      AND json_type(${safe('s.data')},'$.receipt_id')='integer' AND json_extract(${safe('r.data')},'$.method') IN (?,?)
      AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=s.task_id AND e.type='management.capability_completed'
        AND e.id>? AND json_type(${safe('e.data')},'$.receipt_id')='integer' AND json_extract(${safe('e.data')},'$.receipt_id')=r.id)
    ORDER BY s.id DESC LIMIT 101`, evidenceId, ...methods, evidenceId);
  if (candidates.length > 100) return [];
  const found = [];
  for (const candidate of candidates) {
    const calls = store.all(`SELECT c.value AS receipt FROM tasks t,json_each(${safe('t.management')},'$.control_calls') c
      WHERE t.id=? AND json_extract(${safe('c.value')},'$.receipt_id')=?
      UNION ALL SELECT c.value FROM tasks t,json_each(${safe('t.management')},'$.last_execution.control_calls') c
      WHERE t.id=? AND json_extract(${safe('c.value')},'$.receipt_id')=?`,
    candidate.actor_id, candidate.receipt_id, candidate.actor_id, candidate.receipt_id);
    for (const row of calls) {
      const call = parse(row.receipt);
      if (call?.status !== 'succeeded' || call.method !== candidate.method) continue;
      if (mount) {
        const data = parse(mount.data), params = call.authorization_mode === 'project_administrator' ? call.params?.params : call.params;
        let exact = call.result?.emitted === true && call.result.draft_id === data?.draft_id && call.result.revision === data?.revision;
        if (!exact && params) {
          if (params.draft_id === data?.draft_id && Object.hasOwn(params, 'expected_revision') && params.expected_revision === data?.revision)
            exact = data.definition_hash === definitionHash(params);
          else if (typeof params.client_request_id === 'string') {
            try { exact = data.request_key === requestKey(params.client_request_id) && data.definition_hash === definitionHash(params); } catch { /* Not proof. */ }
          }
        }
        if (!exact) continue;
      } else {
        const matches = call.method === 'worker.spawn' ? call.result?.id === task.id
          : call.result?.id === task.input_id && positive(task.input_id) && store.get('SELECT task_id FROM inputs WHERE id=?', task.input_id)?.task_id === task.id;
        if (!matches) continue;
      }
      found.push({ kind: 'valet', worker_id: candidate.actor_id });
    }
  }
  return found;
}

function mountsForDispatch(store, field, value, taskId) {
  if (!positive(value)) return [];
  const rows = store.all(`SELECT id,data FROM events WHERE type='input.dispatch_succeeded'
    AND json_type(${safe('data')},'$.${field}')='integer' AND json_extract(${safe('data')},'$.${field}')=?
    AND json_type(${safe('data')},'$.worker_id')='integer' AND json_extract(${safe('data')},'$.worker_id')=?`, value, taskId);
  return rows.flatMap(row => {
    const dispatch = parse(row.data);
    if (!positive(dispatch?.draft_id) || typeof dispatch.dispatch_id !== 'string') return [];
    const started = store.get(`SELECT id FROM events WHERE type='input.dispatch_started' AND id<?
      AND json_extract(${safe('data')},'$.draft_id')=? AND json_extract(${safe('data')},'$.dispatch_id')=? ORDER BY id DESC LIMIT 1`, row.id, dispatch.draft_id, dispatch.dispatch_id);
    if (!started) return [];
    const mount = store.get(`SELECT id,data FROM events WHERE type='input.emitted' AND id<?
      AND json_extract(${safe('data')},'$.draft_id')=? ORDER BY id DESC LIMIT 1`, started.id, dispatch.draft_id);
    return mount ? [mount] : [];
  });
}

function mountSource(store, mount) {
  const data = parse(mount.data);
  return Object.hasOwn(data ?? {}, 'input_source') ? inputSource(store, data.input_source) : unique(store, managementSources(store, { mount }));
}

export function emissionInputSource(store, draft) {
  const state = parse(draft.emission);
  if (Object.hasOwn(state ?? {}, 'input_source')) return inputSource(store, state.input_source);
  const mount = store.get(`SELECT id,data FROM events WHERE type='input.emitted'
    AND json_extract(${safe('data')},'$.draft_id')=? AND json_extract(${safe('data')},'$.revision') IS ? ORDER BY id DESC LIMIT 1`, draft.id, state?.revision ?? null);
  return mount ? mountSource(store, mount) : unknown();
}

export function goalInputSource(store, task) {
  const rows = store.all(`SELECT ${sourceFields('data')} FROM events WHERE task_id=? AND type IN ('input.anchor','task.first_input','created')
    AND json_type(${safe('data')},'$.input_source') IS NOT NULL`, task.id);
  if (rows.length) return unique(store, rows.map(rowSource));
  const mounts = mountsForDispatch(store, 'input_id', task.input_id, task.id);
  if (mounts.length) return unique(store, mounts.map(mount => mountSource(store, mount)));
  const proven = managementSources(store, { task });
  return proven.length ? unique(store, proven) : unknown();
}

export function messageInputSource(store, message) {
  const json = safe('data');
  const evidence = store.all(`SELECT ${sourceFields('data')},json_type(${json},'$.user_append') AS user_append_type,
      json_type(${json},'$.append_number') AS append_type
    FROM events WHERE task_id=? AND type='message'
    AND json_type(${json},'$.message_id')='integer' AND json_extract(${json},'$.message_id')=?
    AND json_type(${json},'$.sender') IN ('null','integer') AND json_extract(${json},'$.sender') IS ?`, message.task_id, message.id, message.sender_id);
  const explicit = evidence.filter(row => row.source_type !== null);
  if (explicit.length) return unique(store, explicit.map(rowSource));
  if (positive(message.sender_id)) return store.get('SELECT id FROM tasks WHERE id=?', message.sender_id)
    ? actorInputSource(store, message.sender_id) : unknown();
  // Mounted historical appends used the user route too. Their author must be
  // proven by the authorization, never by the old A number or user_append flag.
  const mounts = mountsForDispatch(store, 'message_id', message.id, message.task_id);
  if (mounts.length) return unique(store, mounts.map(mount => mountSource(store, mount)));
  if (message.signal_type || evidence.some(row => row.user_append_type === 'false')) return inputSource(store, { kind: 'system' });
  if (typeof message.append_number === 'string' || evidence.some(row => row.user_append_type === 'true' || row.append_type === 'text')) return inputSource(store, { kind: 'user' });
  return unknown();
}
