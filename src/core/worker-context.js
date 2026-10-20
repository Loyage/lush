import { check, id } from './types.js';
import { MAX_STEPS } from './transcript.js';

// One schema for registration and strict relation validation. Identity is always
// the active server-side invocation, never a caller-supplied Worker/environment ID.
export const CONTEXT_LIMITS = Object.freeze({ children: 200, notices: 100, transcript: MAX_STEPS, history: 100 });
const target = ['relation','child'];
export const CONTEXT_PARAMETERS = Object.freeze({
  'context.inspect': target,
  'context.history': [...target,'after'],
  'context.transcript': [...target,'after','limit'],
  'context.children': ['after','limit'],
  'context.spawn': ['goal','name'],
  'context.message': [...target,'body'],
  'context.accept': ['child'],
  'context.auto_title': ['title'],
  'context.notices': ['before','limit'],
  'context.notice': ['title','body','questions','kind'],
  'context.progress_plan': ['steps'],
  'context.progress_complete': ['step'],
});

const REQUIRED = {
  'context.spawn': ['goal'], 'context.message': ['relation','body'], 'context.accept': ['child'],
  'context.auto_title': ['title'], 'context.notice': ['title'],
  'context.progress_plan': ['steps'], 'context.progress_complete': ['step'],
};
export const CONTEXT_CAPABILITIES = Object.freeze(Object.fromEntries(Object.entries(CONTEXT_PARAMETERS).map(([method, keys]) => [method, {
  schema: { type: 'object', additionalProperties: false, required: REQUIRED[method] ?? [], properties: Object.fromEntries(keys.map(key => [key,
    key === 'relation' ? method === 'context.message' ? { type: 'string', enum: ['parent','child'] }
      : { type: 'string', enum: ['self','parent','child'], default: 'self' }
      : key === 'child' ? { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^W[1-9][0-9]*(?:-[1-9][0-9]*)*$' }] }
      : ['after','before','limit'].includes(key) ? { type: 'integer', minimum: key === 'after' ? 0 : 1,
        ...(key === 'limit' ? { maximum: CONTEXT_LIMITS[method.slice(8)] ?? MAX_STEPS } : {}) }
      : key === 'kind' ? { type: 'string', enum: ['question','info'], default: 'question' }
      : key === 'questions' || key === 'steps' ? { type: 'array' } : { type: 'string' }])) },
  identity: 'active_invocation',
  ...(method === 'context.children' ? { pagination: 'id ascending; after=0, limit=50 (max 200); items,total,cursor,has_more,limit' }
    : method === 'context.notices' ? { pagination: 'id descending; before omitted, limit=30 (max 100); notices,cursor,has_more,limit' }
    : method === 'context.history' ? { pagination: 'id ascending; after=0, at most 100; events,next,has_more,coverage=event_metadata_only' }
    : method === 'context.transcript' ? { pagination: 'step seq ascending; after=0, limit=100; existing transcript result and byte limits' } : {}),
}])));

export function validateContextCall(method, params) {
  const capability = CONTEXT_CAPABILITIES[method];
  if (!capability) return;
  for (const key of capability.schema.required) check(Object.hasOwn(params, key), `context requires ${key}`);
  for (const [key, value] of Object.entries(params)) {
    if (key === '_token') continue;
    const schema = capability.schema.properties[key];
    check(Boolean(schema), 'unknown parameter');
    if (schema.type === 'integer') check(Number.isSafeInteger(value) && value >= schema.minimum
      && (schema.maximum === undefined || value <= schema.maximum), `invalid context ${key}`);
    else if (schema.type === 'string') check(typeof value === 'string'
      && (!schema.enum || schema.enum.includes(value)), `invalid context ${key}`);
    else if (schema.type === 'array') check(Array.isArray(value), `invalid context ${key}`);
    else if (key === 'child') check(Number.isSafeInteger(value) && value > 0
      || typeof value === 'string' && /^W[1-9]\d*(?:-[1-9]\d*)*$/.test(value), 'invalid context child');
  }
}

export function contextTarget(project, actor, params, relations = ['self','parent','child']) {
  check(Number.isSafeInteger(actor) && actor > 0, 'Worker context requires an active invocation');
  const self = project.store.task(actor), relation = params.relation ?? 'self';
  check(relations.includes(relation), 'invalid Worker context relation');
  check(relation === 'child' ? params.child !== undefined : params.child === undefined,
    'child is required only for the child relation');
  if (relation === 'self') return self;
  if (relation === 'parent') {
    check(self.parent_id !== null, 'Worker has no parent');
    return project.store.task(self.parent_id);
  }
  const childId = typeof params.child === 'string' && /^W/.test(params.child)
    ? project.store.lookupWorker(params.child).id : id(params.child);
  const child = project.store.task(childId);
  check(child.parent_id === actor, 'Worker context permits only direct children');
  return child;
}

/** The integration exception is bound to validated durable fixed membership,
 * not to role, arbitrary requested IDs, or the target's entire subtree. */
export function assertWorkerRead(project, actor, taskId) {
  if (actor === null) return;
  const self = project.store.task(actor), requested = id(taskId);
  if (requested === actor || requested === self.parent_id) return;
  if (self.task_kind === 'integration') {
    const fixed = project.convergenceIntegrationContext(self);
    check(fixed.members.some(member => member.task_id === requested), 'Worker is outside fixed integration membership');
    return;
  }
  check(project.store.task(requested).parent_id === actor, 'Worker reads permit only self, parent and direct children');
}

// Do not return inspect's embedded children/deps/merge diagnostics: a parent's
// full inspect otherwise reveals siblings and a child's reveals grandchildren.
const DETAIL_FIELDS = ['id','worker_number','parent_id','input_id','role','task_kind','name','goal',
  'display_title','auto_title','status','result','error','calls','agent_wakes','agent_last_seen_at',
  'workspace','branch','base_commit','head_commit','integration','target_branch','integration_error',
  'created_at','updated_at','interrupt_state','progress','progress_history','model_selection','agent','goal_input_source'];
export function contextDetail(project, taskId) {
  const value = project.inspect(taskId);
  let reservation; try { reservation = JSON.parse(value.reservation); } catch { reservation = null; }
  return { ...Object.fromEntries(DETAIL_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])),
    reservation: reservation ? Object.fromEntries(['version','kind','status','auto_merge'].filter(key => Object.hasOwn(reservation, key))
      .map(key => [key, reservation[key]])) : null,
    input_queue: { buffered: value.input_queue?.buffered ?? 0, reason: value.input_queue?.reason ?? null },
    coverage: 'worker_context', omitted: ['embedded_relations','merge_diagnostics','inbox','artifacts','raw_runs','notices'] };
}

export function contextHistory(rows) {
  // Event payloads can embed arbitrary sibling/subtree snapshots. History keeps
  // its actual cursor/event identity without exposing those project read models.
  return rows.map(({ id, task_id, type, created_at }) => ({ id, task_id, type, created_at }));
}
