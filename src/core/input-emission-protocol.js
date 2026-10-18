import { check, id, isPlainObject } from './types.js';
import { INPUT_OPTION_KEYS } from './input-option-keys.js';
import references from './project/references.js';
import { normalizeAgentProfile, AGENT_BACKENDS, THINKING_LEVELS } from '../agent/settings.js';

// Node-safe, read-only protocol: no Store, Project, Provider or device configuration reads.
// JSON Schema keywords drive the runtime checks below. x-lush-validator delegates to
// existing protocols rather than maintaining a second reference/profile normalizer.
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const positiveId = { anyOf: [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  { type: 'string', pattern: '^[1-9]\\d*$', 'x-lush-validator': 'id' }],
  description: 'Positive safe integer internal ID; decimal strings remain accepted. W/O/display numbers are not IDs.' };
const condition = {
  oneOf: [
    ...['worker_settled', 'worker_merged'].map(kind => ({ type: 'object', required: ['kind', 'worker_id'], additionalProperties: false,
      properties: { kind: { const: kind }, worker_id: positiveId } })),
    { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'parent_quiet' } } },
  ],
  description: 'All conditions must hold. worker_settled checks this round safe delivery; worker_merged checks this round to main (not merely to its direct parent); parent_quiet checks the target tree. Worker existence/kind and fresh proofs are checked by runtime.',
};
const profileFields = {
  agent: { enum: AGENT_BACKENDS, description: 'Required backend; an explicit profile is complete, not a partial inherited override.' },
  config_mode: { description: 'String <=16 UTF-8 bytes, trimmed: empty/lush (managed, default) or pi (Pi only). pi mode deliberately ignores all other known settings.' },
  model: { description: 'Optional/null string <=256 UTF-8 bytes, default empty, trimmed. Managed connections require provider/physical-model.' },
  thinking: { description: 'Optional/null string <=32 UTF-8 bytes, trimmed, default empty.', 'x-enum-by-agent': THINKING_LEVELS },
  connection_id: { description: 'Optional/null string <=128 UTF-8 bytes, trimmed, default empty. Non-empty must be an existing available connection UUID for Pi, with qualified model; no account names or credentials.' },
  prompt: { description: 'Legacy append_prompt alias; optional/null string <=32768 UTF-8 bytes.' },
  default_prompt: { description: 'Optional/null string <=32768 UTF-8 bytes, trimmed, default empty.' },
  append_prompt: { description: 'Optional/null string <=32768 UTF-8 bytes, trimmed, default prompt or empty.' },
  extensions: { description: 'Optional/null array, <=64 strings of <=4096 UTF-8 bytes each; trimmed, empty/duplicates removed; default [].' },
  skills: { description: 'Same shape and defaults as extensions.' },
  soft_budget: { description: 'Optional/null object, only responses/tokens; positive integers <=10000/1000000000 respectively, null/omitted entries ignored. Non-empty budgets require Pi.' },
  env: { description: 'Optional/null object, <=512 variables. Names /^[A-Za-z_][A-Za-z0-9_]*$/, no LUSH_ prefix; string values without NUL. Default {}.' },
};
const byteText = max => ({ type: 'string', 'x-maxBytes': max });
const resourceList = nullable({ type: 'array', maxItems: 64, items: byteText(4096) });
const managedProfileFields = {
  model: nullable(byteText(256)), thinking: nullable(byteText(32)), connection_id: nullable(byteText(128)),
  default_prompt: nullable(byteText(32768)), append_prompt: nullable(byteText(32768)),
  extensions: resourceList, skills: resourceList,
  soft_budget: nullable({ type: 'object', additionalProperties: false, properties: {
    responses: nullable({ type: 'integer', minimum: 1, maximum: 10000 }),
    tokens: nullable({ type: 'integer', minimum: 1, maximum: 1000000000 }),
  } }),
  env: nullable({ type: 'object', maxProperties: 512, propertyNames: { type: 'string', pattern: '^(?!LUSH_)[A-Za-z_][A-Za-z0-9_]*$' },
    additionalProperties: { type: 'string', pattern: '^[^\\x00]*$' } }),
};
const profile = { type: 'object', required: ['agent'], additionalProperties: false, properties: {
  ...profileFields, config_mode: { ...profileFields.config_mode, ...nullable(byteText(16)) },
},
  allOf: [{ if: { required: ['config_mode'], properties: { config_mode: { type: 'string', pattern: '^\\s*pi\\s*$' } } }, then: {},
    else: { properties: managedProfileFields, allOf: [{ if: { properties: { append_prompt: { type: 'null' } } },
      then: { properties: { prompt: nullable(byteText(32768)) } } }] } }],
  'x-lush-validator': 'agentProfile',
  description: 'Canonical runtime profile protocol: normalizeAgentProfile(value,"roles.agent") in src/agent/settings.js (including Pi-default compatibility); this is NOT a profile name/ID. No file, network or device access occurs during shape validation. Connection availability and invocation permission remain later checks.' };
const referenceTarget = { type: 'object', additionalProperties: false, properties: Object.fromEntries([
  ...['task_id', 'input_id', 'spec_id', 'notice_id', 'message_id', 'event_id', 'verification_id', 'seq'].map(key => [key, positiveId]),
  ...['target_branch', 'section', 'file'].map(key => [key, { type: 'string', maxLength: 500 }]),
]) };
const referenceSchema = { type: 'object', required: ['kind', 'label', 'quote'], properties: {
  version: { const: 1, default: 1 },
  kind: { enum: ['task', 'task_subtree', 'delivery_branch', 'intent', 'spec', 'notice', 'diff', 'message', 'result', 'transcript_step', 'history_event', 'verification', 'text'] },
  label: { type: 'string', maxLength: 200, pattern: '\\S' }, quote: { type: 'string', maxLength: 8192, pattern: '\\S' },
  target: referenceTarget,
  location: { type: 'object', additionalProperties: false, properties: Object.fromEntries([
    ...['task_id', 'input_id', 'spec_id', 'notice_id'].map(key => [key, positiveId]),
    ...['view', 'section', 'path'].map(key => [key, { type: 'string', maxLength: 500 }]),
  ]) },
  captured_at: { description: 'String <=64 characters retained; otherwise defaults to current ISO time.' },
}, description: 'Target requirements and normalized total bytes are enforced by the canonical references validator; unknown top-level fields remain ignored.' };
const directKeys = ['content', 'references', 'branch', ...INPUT_OPTION_KEYS];

export const INPUT_EMIT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'input.emit', type: 'object', additionalProperties: false,
  properties: {
    content: { type: 'string', minLength: 1, maxLength: 32000, pattern: '\\S', description: 'Required on the direct path; non-blank original text, preserved verbatim. Length uses JavaScript UTF-16 code units.' },
    references: { ...nullable({ type: 'array', maxItems: 12, items: referenceSchema, 'x-lush-validator': 'references' }), default: [],
      description: 'Canonical input reference protocol (src/core/project/references.js normalizeReferences): <=12 items, normalized total <=49152 UTF-8 bytes. null retains the existing [] default. Append rejects non-empty attachments.',
      'x-item-protocol': {
        required: ['kind', 'label', 'quote'],
        version: 'Omitted or integer 1.',
        kind: ['task', 'task_subtree', 'delivery_branch', 'intent', 'spec', 'notice', 'diff', 'message', 'result', 'transcript_step', 'history_event', 'verification', 'text'],
        label: 'Non-blank string <=200 UTF-16 units; trimmed.', quote: 'Non-blank string <=8192 UTF-16 units; trimmed.',
        target: 'Optional object: task_id,input_id,spec_id,notice_id,message_id,event_id,verification_id,seq are positive IDs; target_branch,section,file are strings <=500 units. No other fields.',
        location: 'Optional object: task_id,input_id,spec_id,notice_id are positive IDs; view,section,path are strings <=500 units. No other fields.',
        required_target: { 'task/task_subtree/diff/message/result/transcript_step': 'task_id', intent: 'input_id', spec: 'spec_id', notice: 'notice_id', history_event: 'event_id', verification: 'verification_id', delivery_branch: 'task_id or non-empty target_branch' },
        captured_at: 'String <=64 units retained; otherwise defaults to current ISO time. Unknown top-level reference fields are historically ignored.',
      } },
    branch: { ...nullable({ type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' }), default: 'main', description: 'Saved parent branch for order, not a new branch name. Omitted/null defaults to main; runtime rechecks binding and lifecycle. Append uses target root, not branch.' },
    mode: { enum: ['order', 'append', null], default: 'order', description: 'Omitted/null retains order mode.' },
    target_id: { ...nullable(positiveId), description: 'Required positive Worker internal ID in append mode; absent/null only in order mode. Must remain an eligible append target.' },
    conditions: { ...nullable({ type: 'array', maxItems: 16, items: condition }), default: [], description: 'Omitted/null -> []; duplicates collapse. Exclusive adds parent_quiet, still at most 16 normalized conditions.' },
    exclusive: { type: ['boolean', 'null'], default: false, description: 'Omitted/null -> false; true only for order. Implies parent_quiet, not auto-merge permission; existing release/lifecycle gates remain.' },
    profile: { ...nullable(profile), default: null, description: 'Order only: complete canonical run profile; omitted/null inherits from the saved parent. Draft-path runtime rechecks the saved mode before allowing an override.' },
    client_request_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\s\\x00-\\x1f\\x7f](?:[^\\x00-\\x1f\\x7f]*[^\\s\\x00-\\x1f\\x7f])?$(?![\\s\\S])',
      description: 'Optional exact idempotency key, <=128 UTF-16 units, no surrounding whitespace/control characters. Same key + unchanged request reuses receipt; changed request fails. Do not change omitted/default/null forms on retry. Unknown effects must not be replayed with a new key.' },
    draft_id: positiveId,
    expected_revision: { anyOf: [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: 'null' }], description: 'Required with draft_id: exact saved revision, or explicit null only for an unversioned legacy row. Never a string and never omission.' },
  },
  allOf: [
    { if: { required: ['draft_id'] }, then: { required: ['draft_id', 'expected_revision'],
      not: { anyOf: directKeys.map(key => ({ required: [key] })) },
      'x-message': 'draft_id requires expected_revision and cannot be combined with content, references, branch or input options; edit the draft first' },
    else: { required: ['content'], not: { required: ['expected_revision'] },
      'x-message': 'direct input requires content; expected_revision requires draft_id' } },
    { if: { required: ['mode'], properties: { mode: { const: 'append' } } }, then: {
      required: ['target_id'], properties: { target_id: positiveId, exclusive: { enum: [false, null] }, profile: { type: 'null' },
        references: nullable({ type: 'array', maxItems: 0 }) },
      'x-message': 'append requires target_id, no exclusive, no profile, and no references; retain the text and attachments' },
    else: { properties: { target_id: { type: 'null' } }, 'x-message': 'target_id requires append mode' } },
  ],
  'x-lush-validator': 'exclusiveConditions',
};

export const INPUT_EMIT_PARAMS = Object.freeze(Object.keys(INPUT_EMIT_SCHEMA.properties));
export const INPUT_EMIT_CAPABILITY = {
  schema: INPUT_EMIT_SCHEMA,
  examples: [
    { content: 'Implement the requested change', client_request_id: 'emit-order-1' },
    { draft_id: 17, expected_revision: 3, client_request_id: 'emit-draft-17-r3' },
    { draft_id: 18, expected_revision: null },
    { content: 'Additional requirement', mode: 'append', target_id: 42, conditions: [{ kind: 'worker_settled', worker_id: 42 }], client_request_id: 'append-42-1' },
    { content: 'Run alone after delivery', conditions: [{ kind: 'worker_merged', worker_id: 42 }, { kind: 'parent_quiet' }], exclusive: true },
    { content: 'Use the selected source', profile: { agent: 'pi', config_mode: 'lush', connection_id: '12345678-1234-1234-1234-123456789abc', model: 'openai/example-model', thinking: 'high' } },
  ],
  authorization: {
    scope: 'Current project only. User RPC or reviewed management capability; ordinary development Agent tokens do not gain input.emit permission.',
    schema: 'Shape validation only; it grants no authority and does not prove Worker/branch/connection existence, eligibility or current state.',
    permission_checks: 'Recheck latest management permissions, reviewed capability and any required exact persistent user confirmation at execution time. Discovery/schema success is not authorization; the model cannot confirm itself.',
    lifecycle: 'Draft revision, legacy ownership, target/parent lifecycle, freeze, condition proofs, exclusivity and unknown-effect protections are rechecked by the original engine.',
    acknowledgement: 'emitted:true is a persistent mount ACK, NOT Worker creation, Agent start, condition satisfaction or completion. Follow the saved draft dispatch receipt; only actual input_id/message_id proves delivery.',
    identity: 'revision and source_draft_id keep existing meanings. A successful order/first append may produce a real Input/O; ordinary append produces a Message/A, never a synthetic Input.',
  },
};

const validators = {
  id,
  agentProfile: value => normalizeAgentProfile(value, 'roles.agent'),
  references: value => references.normalizeReferences(value),
  exclusiveConditions(value) {
    if (!value.exclusive || value.draft_id !== undefined) return;
    const conditions = [...new Set((value.conditions ?? []).map(c => JSON.stringify(c.kind === 'parent_quiet' ? { kind: c.kind } : { kind: c.kind, worker_id: id(c.worker_id) })))];
    check(conditions.length + (conditions.includes('{"kind":"parent_quiet"}') ? 0 : 1) <= 16, 'input requires at most 16 conditions including exclusive quietness');
  },
};

// Deliberately small JSON Schema evaluator, private to this protocol. No coercion,
// default insertion or normalization: the exact original request still drives hashes.
function validate(schema, value, path = 'input.emit') {
  const matches = candidate => { try { validate(candidate, value, path); return true; } catch { return false; } };
  if (schema.anyOf) check(schema.anyOf.some(matches), `${path} has an invalid shape`);
  if (schema.oneOf) check(schema.oneOf.filter(matches).length === 1, `${path} must match exactly one supported shape`);
  if (schema.not) check(!matches(schema.not), schema['x-message'] ?? `${path} has incompatible fields`);
  if (schema.if) validate(matches(schema.if) ? schema.then ?? {} : schema.else ?? {}, value, path);
  for (const item of schema.allOf ?? []) validate(item, value, path);
  if (Object.hasOwn(schema, 'const')) check(value === schema.const, `${path} must be ${schema.const}`);
  if (schema.enum) check(schema.enum.includes(value), `${path} has an invalid value`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    check(types.some(type => type === 'null' ? value === null : type === 'object' ? isPlainObject(value)
      : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type), `${path} must be ${types.join(' or ')}`);
  }
  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) check(Object.hasOwn(value, key) && value[key] !== undefined, schema['x-message'] ?? `${path}.${key} is required`);
    if (schema.additionalProperties === false) check(Object.keys(value).every(key => Object.hasOwn(schema.properties ?? {}, key)), `${path} has unknown fields`);
    if (schema.maxProperties !== undefined) check(Object.keys(value).length <= schema.maxProperties, `${path} has too many fields`);
    for (const key of Object.keys(value)) {
      if (schema.propertyNames) validate(schema.propertyNames, key, `${path} key`);
      if (isPlainObject(schema.additionalProperties) && !Object.hasOwn(schema.properties ?? {}, key)) validate(schema.additionalProperties, value[key], `${path}.${key}`);
    }
    for (const [key, rule] of Object.entries(schema.properties ?? {})) if (value[key] !== undefined) validate(rule, value[key], `${path}.${key}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined) check(value.length <= schema.maxItems, `${path} allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) check(value.length >= schema.minLength, `${path} must be non-empty`);
    if (schema.maxLength !== undefined) check(value.length <= schema.maxLength, `${path} exceeds ${schema.maxLength} characters`);
    if (schema.pattern) check(new RegExp(schema.pattern).test(value), `${path} has invalid text`);
    if (schema['x-maxBytes'] !== undefined) check(Buffer.byteLength(value) <= schema['x-maxBytes'], `${path} is too long`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) check(value >= schema.minimum, `${path} is below ${schema.minimum}`);
    if (schema.maximum !== undefined) check(value <= schema.maximum, `${path} exceeds ${schema.maximum}`);
  }
  if (schema['x-lush-validator']) validators[schema['x-lush-validator']](value);
}

/** Throws LushError(-32602), or returns the unchanged request (no side effects). */
export function validateInputEmissionRequest(params) {
  check(!isPlainObject(params) || !Object.hasOwn(params, 'runner_node_id'), 'Runner selection is retired');
  validate(INPUT_EMIT_SCHEMA, params);
  return params;
}
