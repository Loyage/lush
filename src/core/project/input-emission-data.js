import { check, id, isPlainObject } from '../types.js';
import { hookRevision, HOOK_LIMITS } from '../hooks.js';
import { systemRegistration } from './automation-registry.js';

import { INPUT_OPTION_KEYS } from '../input-option-keys.js';
export { INPUT_OPTION_KEYS };
export const INPUT_EMISSION_LIMIT = 500;
export const inputOptions = draft => draft.input_options ? JSON.parse(draft.input_options) : { mode: 'order', conditions: [], exclusive: false };
export const inputEmission = draft => draft.emission ? JSON.parse(draft.emission) : null;
export const saveEmission = (project, draftId, state) => project.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify(state), draftId);
export const hookData = task => task.hooks ? JSON.parse(task.hooks) : { version: 1, mounts: [], observed: {} };
export const emissionLocked = draft => Boolean(inputEmission(draft) && inputEmission(draft).state !== 'cancelled');

export function requestKey(value) {
  if (value === undefined) return null;
  check(typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim()
    && !/[\x00-\x1f\x7f]/.test(value), 'invalid client_request_id');
  return hookRevision(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const definitionHash = value => hookRevision(canonical(value));

export function normalizeInputOptions(project, options = {}, previous = null) {
  check(!isPlainObject(options) || !Object.hasOwn(options, 'runner_node_id'), 'Runner selection is retired');
  check(isPlainObject(options) && Object.keys(options).every(key => INPUT_OPTION_KEYS.includes(key)), 'invalid draft input options');
  const mode = options.mode ?? previous?.mode ?? 'order';
  check(['order','append'].includes(mode), 'input mode must be order or append');
  const exclusive = options.exclusive ?? previous?.exclusive ?? false;
  check(typeof exclusive === 'boolean' && (!exclusive || mode === 'order'), 'exclusive requires order mode');
  const conditions = options.conditions ?? previous?.conditions ?? [];
  check(Array.isArray(conditions) && conditions.length <= 16, 'input requires at most 16 conditions');
  const normalized = conditions.map(condition => {
    check(isPlainObject(condition) && ['worker_settled','worker_merged','parent_quiet'].includes(condition.kind), 'invalid input condition');
    check(Object.keys(condition).every(key => (condition.kind === 'parent_quiet' ? ['kind'] : ['kind','worker_id']).includes(key)), 'invalid input condition fields');
    if (condition.kind === 'parent_quiet') return { kind: condition.kind };
    const worker = project.store.task(id(condition.worker_id));
    check(['order','child'].includes(worker.task_kind), 'input conditions require development Workers');
    return { kind: condition.kind, worker_id: worker.id };
  });
  if (exclusive && !normalized.some(condition => condition.kind === 'parent_quiet')) normalized.push({ kind: 'parent_quiet' });
  const result = { mode, conditions: [...new Map(normalized.map(c => [JSON.stringify(c), c])).values()], exclusive };
  // Retain inert historical text on draft edits; it never participates in placement.
  if (Object.hasOwn(previous ?? {}, 'runner_node_id')) result.runner_node_id = previous.runner_node_id;
  check(result.conditions.length <= 16, 'input requires at most 16 conditions including exclusive quietness');
  if (mode === 'append') result.target_id = id(options.target_id ?? previous?.target_id);
  else check(options.target_id === undefined || options.target_id === null, 'target_id requires append mode');
  return result;
}

export function attachInputSignal(project, draftId, index, condition, snapshot, ownerId = condition.worker_id) {
  const task = project.store.task(ownerId), data = hookData(task);
  check(data.mounts.length < HOOK_LIMITS.mounts, 'too many mounted Hooks on condition Worker');
  check(task.hooks || project.store.get('SELECT count(*) AS n FROM tasks WHERE hooks IS NOT NULL').n < 500, 'too many Workers with mounted Hooks');
  const hookId = `input-${draftId}-${index}`;
  data.mounts.push({ ...systemRegistration(project, 'system:input-signal'), id: hookId, name: `条件发射 · 草稿记录 #${draftId}`, mode: 'once', enabled: true,
    trigger: condition.kind === 'parent_quiet' ? 'worker.parent_ready' : condition.kind === 'worker_merged' ? 'delivery.integrated' : 'worker.delivery_ready',
    conditions: {}, actions: [{ type: 'input_signal', draft_id: draftId, condition_index: index }],
    input_signal: { draft_id: draftId, index, snapshot }, state: 'waiting', last_execution: null,
    created_at: new Date().toISOString() });
  check(Buffer.byteLength(JSON.stringify(data)) <= HOOK_LIMITS.bytes, 'mounted Hooks exceed size limit');
  project.store.update(task.id, { hooks: JSON.stringify(data) });
  project.store.event(task.id, 'hook.attached', { hook_id: hookId, trigger: data.mounts.at(-1).trigger, draft_id: draftId, builtin: true });
  return { worker_id: task.id, hook_id: hookId };
}
export function removeInputSignals(project, draftId) {
  for (const task of project.store.all('SELECT id,hooks FROM tasks WHERE hooks IS NOT NULL')) {
    const data = hookData(task), removed = data.mounts.filter(mount => mount.input_signal?.draft_id === draftId);
    if (!removed.length) continue;
    data.mounts = data.mounts.filter(mount => mount.input_signal?.draft_id !== draftId);
    project.store.update(task.id, { hooks: data.mounts.length ? JSON.stringify(data) : null });
    for (const mount of removed) project.store.event(task.id, 'hook.removed', { hook_id: mount.id, automatic: true, draft_id: draftId });
  }
}

// Releasing an unknown lease only waives future exclusivity; it never retries its dispatch.
export const canReleaseInputExclusive = state => state?.exclusive_active === true && ['succeeded','unknown'].includes(state.state);

export function publicDispatch(state) {
  if (!state) return null;
  const result = { state: state.state, reason: state.reason ?? null,
    exclusive_active: state.exclusive_active === true, can_release_exclusive: canReleaseInputExclusive(state) };
  for (const key of ['input_id','worker_id','worker_number','message_id','append_number','exclusive_released','created_at','finished_at'])
    if (state[key] !== undefined) result[key] = state[key];
  result.conditions = state.signals.map(signal => ({ kind: signal.kind, ...(signal.worker_id ? { worker_id: signal.worker_id } : {}),
    satisfied: Boolean(signal.satisfied), ...(signal.event_id ? { event_id: signal.event_id } : {}) }));
  return result;
}
