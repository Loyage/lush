import { check, id, isPlainObject } from './types.js';

export const MERGE_CONDITION_KINDS = Object.freeze(['worker_settled', 'worker_merged']);
export const MERGE_CONDITION_LIMIT = 16;
export const MERGE_CONDITION_PARAMETERS = Object.freeze({
  'worker.merge_conditions': ['id'],
  'worker.merge_after': ['id', 'conditions', 'expected_revision'],
});
const conditionSchema = { type: 'object', additionalProperties: false, required: ['kind', 'worker_id'], properties: {
  kind: { type: 'string', enum: [...MERGE_CONDITION_KINDS] }, worker_id: { type: 'integer', minimum: 1 },
} };
export const MERGE_CONDITION_CAPABILITIES = Object.freeze({
  'worker.merge_conditions': { schema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
    examples: [{ id: 7 }] },
  'worker.merge_after': { schema: { type: 'object', additionalProperties: false, required: ['id', 'conditions', 'expected_revision'], properties: {
    id: { type: 'integer', minimum: 1 }, conditions: { type: 'array', minItems: 1, maxItems: MERGE_CONDITION_LIMIT, items: conditionSchema },
    expected_revision: { type: 'string', minLength: 1 },
  } }, examples: [{ id: 7, conditions: [{ kind: 'worker_settled', worker_id: 8 }, { kind: 'worker_merged', worker_id: 9 }], expected_revision: 'REV' }] },
});
export function normalizeMergeConditions(raw) {
  check(Array.isArray(raw) && raw.length > 0 && raw.length <= MERGE_CONDITION_LIMIT, 'merge conditions require 1..16 items (AND)');
  const seen = new Set();
  return raw.map(value => {
    check(isPlainObject(value) && Object.keys(value).length === 2 && MERGE_CONDITION_KINDS.includes(value.kind)
      && Number.isSafeInteger(value.worker_id), 'invalid merge condition');
    const worker_id = id(value.worker_id), key = `${value.kind}:${worker_id}`;
    check(!seen.has(key), 'duplicate merge condition'); seen.add(key);
    return { kind: value.kind, worker_id };
  });
}
export function validateMergeConditionCall(method, params) {
  if (!Object.hasOwn(MERGE_CONDITION_PARAMETERS, method)) return;
  check(isPlainObject(params) && Object.keys(params).every(key => MERGE_CONDITION_PARAMETERS[method].includes(key)), 'unknown merge condition parameter');
  check(Number.isSafeInteger(params.id), 'merge condition id must be an integer'); id(params.id);
  if (method === 'worker.merge_after') {
    normalizeMergeConditions(params.conditions);
    check(typeof params.expected_revision === 'string' && params.expected_revision.length > 0, 'merge conditions revision is required');
  }
}
