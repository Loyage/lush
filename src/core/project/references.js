import { bounded, check, id, isPlainObject } from '../types.js';

export const MAX_REFERENCES = 12;
export const MAX_REFERENCE_QUOTE = 8192;
export const MAX_REFERENCE_BYTES = 48 * 1024;
const MAX_RESOLVED_ITEM_BYTES = 64 * 1024;
const MAX_RESOLVED_TOTAL_BYTES = 256 * 1024;
const KINDS = new Set(['task','task_subtree','delivery_branch','intent','spec','notice','diff','message','result','transcript_step','history_event','verification','text']);
const TARGET_FIELDS = new Set(['task_id','input_id','spec_id','notice_id','message_id','event_id','verification_id','seq','target_branch','section','file']);
const LOCATION_FIELDS = new Set(['view','section','task_id','input_id','spec_id','notice_id','path']);

function compactObject(value, fields, name) {
  check(value === undefined || isPlainObject(value), `${name} must be an object`);
  const out = {};
  for (const [key, raw] of Object.entries(value || {})) {
    check(fields.has(key), `unknown ${name} field: ${key}`);
    if (key.endsWith('_id') || key === 'seq') out[key] = id(raw);
    else {
      check(typeof raw === 'string' && raw.length <= 500, `${name}.${key} must be text (max 500 characters)`);
      out[key] = raw;
    }
  }
  return out;
}
function need(target, field, kind) { check(target[field] !== undefined, `${kind} reference requires ${field}`); }
function snippet(value, limit) {
  if (value === null || value === undefined) return value;
  const text = String(value); return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}
function boundResolved(value, limit) {
  if (value === null || value === undefined) return { value, bytes: 0, truncated: false };
  const encoded = JSON.stringify(value);
  const bytes = Buffer.byteLength(encoded);
  if (bytes <= limit) return { value, bytes, truncated: false };
  if (limit <= 512) return { value: { omitted: '引用当前状态超过本轮上下文总上限' }, bytes: Math.max(0, limit), truncated: true };
  const preview = Buffer.from(encoded).subarray(0, limit - 256).toString('utf8');
  const bounded = { truncated: true, json_preview: preview };
  return { value: bounded, bytes: Buffer.byteLength(JSON.stringify(bounded)), truncated: true };
}
function safeTask(task, full = false) {
  if (!task) return null;
  const value = { id: task.id, parent_id: task.parent_id, input_id: task.input_id, role: task.role, goal: task.goal,
    status: task.status, integration: task.integration, target_branch: task.target_branch, branch: task.branch,
    updated_at: task.updated_at, verifies_task_id: task.verifies_task_id, resolves_task_id: task.resolves_task_id };
  if (full) Object.assign(value, { result: snippet(task.result, 8000), error: snippet(task.error, 3000), integration_error: snippet(task.integration_error, 3000) });
  return value;
}

/** Input / Draft 引用的校验、持久化与 invocation 时实时解析。 */
export default {
  normalizeReferences(references = []) {
    check(Array.isArray(references), 'references must be an array');
    check(references.length <= MAX_REFERENCES, `at most ${MAX_REFERENCES} references are allowed`);
    const normalized = references.map((raw, index) => {
      check(isPlainObject(raw), `reference ${index + 1} must be an object`);
      check(raw.version === undefined || raw.version === 1, 'reference version must be 1');
      check(typeof raw.kind === 'string' && KINDS.has(raw.kind), `unsupported reference kind: ${raw.kind}`);
      check(typeof raw.label === 'string' && raw.label.trim() && raw.label.length <= 200, 'reference label must be non-empty text (max 200 characters)');
      check(typeof raw.quote === 'string' && raw.quote.trim() && raw.quote.length <= MAX_REFERENCE_QUOTE,
        `reference quote must be non-empty text (max ${MAX_REFERENCE_QUOTE} characters)`);
      const target = compactObject(raw.target, TARGET_FIELDS, 'reference target');
      const location = compactObject(raw.location, LOCATION_FIELDS, 'reference location');
      if (['task','task_subtree','diff','message','result','transcript_step'].includes(raw.kind)) need(target, 'task_id', raw.kind);
      if (raw.kind === 'intent') need(target, 'input_id', raw.kind);
      if (raw.kind === 'spec') need(target, 'spec_id', raw.kind);
      if (raw.kind === 'notice') need(target, 'notice_id', raw.kind);
      if (raw.kind === 'history_event') need(target, 'event_id', raw.kind);
      if (raw.kind === 'verification') need(target, 'verification_id', raw.kind);
      if (raw.kind === 'delivery_branch') check(target.task_id !== undefined || target.target_branch, 'delivery_branch reference requires task_id or target_branch');
      return { version: 1, kind: raw.kind, target, label: raw.label.trim(), quote: raw.quote.trim(), location,
        captured_at: typeof raw.captured_at === 'string' && raw.captured_at.length <= 64 ? raw.captured_at : new Date().toISOString() };
    });
    check(Buffer.byteLength(JSON.stringify(normalized)) <= MAX_REFERENCE_BYTES,
      `references exceed ${MAX_REFERENCE_BYTES} bytes in total`);
    return normalized;
  },

  referencesForInput(inputId) { return this.store.inputReferences(inputId); },

  async resolveInputReferences(inputId) {
    const references = this.store.inputReferences(inputId);
    const summaries = this.store.summaries();
    const children = new Map();
    for (const task of summaries) {
      if (!children.has(task.parent_id)) children.set(task.parent_id, []);
      children.get(task.parent_id).push(task);
    }
    const resolve = async reference => {
      const target = reference.target || {};
      switch (reference.kind) {
        case 'task': case 'result': {
          const task = this.store.get('SELECT * FROM tasks WHERE id=?', target.task_id);
          return task ? safeTask(task, true) : null;
        }
        case 'message': {
          const task = this.store.get('SELECT * FROM tasks WHERE id=?', target.task_id);
          if (!task) return null;
          const message = target.message_id ? this.store.get('SELECT * FROM messages WHERE id=? AND task_id=?', target.message_id, target.task_id) : null;
          return { task: safeTask(task), message };
        }
        case 'transcript_step': {
          const task = this.store.get('SELECT * FROM tasks WHERE id=?', target.task_id);
          if (!task) return null;
          const page = target.seq ? this.transcript(task.id, target.seq - 1, 1) : null;
          return { task: safeTask(task), step: page?.steps?.find(step => step.seq === target.seq) || null };
        }
        case 'task_subtree': {
          const root = this.store.get('SELECT * FROM tasks WHERE id=?', target.task_id);
          if (!root) return null;
          const descendants = []; const pending = [root.id];
          while (pending.length && descendants.length < 100) {
            const parent = pending.shift();
            for (const child of children.get(parent) || []) { descendants.push(safeTask(child)); pending.push(child.id); if (descendants.length >= 100) break; }
          }
          return { root: safeTask(root, true), descendants, truncated: pending.length > 0 };
        }
        case 'delivery_branch': {
          const ladder = await this.ladder();
          const groups = (ladder.groups || []).filter(group => target.target_branch ? group.target_branch === target.target_branch
            : (group.items || []).some(item => item.id === target.task_id || item.source_task_id === target.task_id));
          return groups.length ? { current_branch: ladder.current_branch, groups: bounded(groups, 100000) } : null;
        }
        case 'intent': return this.inputs().find(input => input.id === target.input_id) || null;
        case 'spec': {
          const spec = this.store.get('SELECT * FROM task_specs WHERE id=?', target.spec_id);
          return spec ? { ...spec, deps: JSON.parse(spec.deps) } : null;
        }
        case 'notice': return this.store.get('SELECT * FROM notices WHERE id=?', target.notice_id) || null;
        case 'history_event': {
          const event = this.store.get('SELECT * FROM events WHERE id=?', target.event_id);
          return event ? { ...event, data: JSON.parse(event.data) } : null;
        }
        case 'verification': {
          const task = this.store.get('SELECT * FROM tasks WHERE id=?', target.verification_id);
          return task ? safeTask(task, true) : null;
        }
        case 'diff': {
          const task = this.store.get('SELECT * FROM tasks WHERE id=?', target.task_id);
          return task ? { task: safeTask(task), diff: await this.workspaces.diff(task) } : null;
        }
        case 'text': return null;
        default: return null;
      }
    };
    const output = [];
    let resolvedBytes = 0;
    for (const reference of references) {
      try {
        const current = await resolve(reference);
        const remaining = Math.max(0, MAX_RESOLVED_TOTAL_BYTES - resolvedBytes);
        const boundedCurrent = boundResolved(current, Math.min(MAX_RESOLVED_ITEM_BYTES, remaining));
        resolvedBytes += boundedCurrent.bytes;
        const { segment, ...snapshot } = reference;
        output.push({ segment, reference: snapshot, current: boundedCurrent.value, stale: current === null && reference.kind !== 'text',
          truncated: boundedCurrent.truncated });
      } catch (error) {
        const { segment, ...snapshot } = reference;
        output.push({ segment, reference: snapshot, current: null, stale: true, resolution_error: error.message });
      }
    }
    return output;
  },
};
