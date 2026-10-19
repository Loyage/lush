import { check } from '../../core/types.js';
import { validateInputEmissionRequest } from '../../core/input-emission-protocol.js';
import { inputOptions, resolveInputOptions, readProfile, positionalArguments, cliOption, cliInteger } from './intent.js';

function draftRevision(value) {
  return value === 'null' ? null : cliInteger(value, 'draft revision');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
/** A continuation carries the unchanged backend cursor, not an authorization claim. */
export function readListCursor(value, binding) {
  if (value === null) return undefined;
  check(typeof value === 'string' && value.length > 0 && value.length <= 32768 && /^[A-Za-z0-9_-]+$/.test(value), 'invalid CLI list cursor');
  let cursor; try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { check(false, 'invalid CLI list cursor'); }
  check(cursor?.version === 1 && JSON.stringify(canonical(cursor.binding)) === JSON.stringify(canonical(binding))
    && (typeof cursor.source === 'string' && cursor.source.length > 0 || Number.isSafeInteger(cursor.source) && cursor.source > 0),
  'CLI cursor belongs to another view or filter; start a new query');
  return cursor.source;
}
export function listPage(result, binding, source, hasMore, limit, checkpoint = false) {
  const next = (hasMore || checkpoint) && source !== null && source !== undefined
    ? Buffer.from(JSON.stringify({ version: 1, binding, source })).toString('base64url') : null;
  return { ...result, page: { next_cursor: next, has_more: hasMore, limit } };
}

async function list(args, client, drafts) {
  const cursor = cliOption(args, '--cursor'), rawLimit = cliOption(args, '--limit');
  const params = {};
  for (const name of ['q','status','integration','modes', ...(drafts ? ['conditional'] : [])]) {
    const value = cliOption(args, `--${name}`);
    if (value !== null) params[name] = name === 'modes' ? JSON.parse(value) : value;
  }
  const limit = rawLimit === null ? 50 : cliInteger(rawLimit, 'limit', 1, 100);
  check(params.q === undefined || params.q.length <= 1000, '--q allows at most 1000 characters');
  check(params.conditional === undefined || ['configured','mounted'].includes(params.conditional), '--conditional expects configured or mounted');
  const modes = ['order','append','management'];
  check(params.modes === undefined || Array.isArray(params.modes) && params.modes.every(mode => modes.includes(mode))
    && new Set(params.modes).size === params.modes.length, '--modes must be an array of unique order, append or management values');
  positionalArguments(args, 0);
  const binding = { method: 'input.history', view: params.conditional ? `conditional:${params.conditional}` : drafts ? 'drafts' : 'history',
    filters: { q: params.q ?? '', status: params.status ?? null, integration: params.integration ?? null,
      modes: modes.filter(mode => params.modes === undefined || params.modes.includes(mode)) } };
  const source = readListCursor(cursor, binding);
  check(source === undefined || typeof source === 'string', 'invalid input list cursor source');
  const value = await client.request('input.history', { ...params, limit,
    ...(params.conditional ? {} : { view: drafts ? 'drafts' : 'history' }), ...(source === undefined ? {} : { cursor: source }) });
  // Preserve all original fields, including a receipt/unknown response from a trusted bridge.
  return Array.isArray(value?.items) && Object.hasOwn(value, 'next_cursor')
    ? listPage(value, binding, value.next_cursor, value.next_cursor !== null, limit) : value;
}

/** Persisted Input/Message bodies stay immutable; a draft is saved intent, not execution. */
export async function run(command, args, { client }) {
  check(command === 'input', 'unknown input command');
  const verb = args.shift();
  if (verb === 'targets') { positionalArguments(args, 0); return client.request('input.parents'); }
  if (verb === 'list') return list(args, client, false);
  if (verb === 'show') {
    positionalArguments(args, 2);
    check(['input','message','management'].includes(args[0]), 'input show expects input, message or management; drafts use input draft show');
    return client.request('input.get', { kind: args[0], id: cliInteger(args[1], 'input record ID') });
  }
  check(verb === 'draft', 'unknown input command');
  const action = args.shift();
  if (action === 'list') return list(args, client, true);
  if (action === 'show') {
    positionalArguments(args, 1); return client.request('input.get', { kind: 'draft', id: cliInteger(args[0], 'draft ID') });
  }
  if (action === 'create' || action === 'update') {
    const revision = action === 'update' ? draftRevision(cliOption(args, '--revision')) : undefined;
    const parsed = inputOptions(args, { update: action === 'update', append: true });
    positionalArguments(args, action === 'update' ? 2 : 1);
    const recordId = action === 'update' ? cliInteger(args[0], 'draft ID') : undefined;
    const content = args[action === 'update' ? 1 : 0];
    // Validate original text before identity lookups; never consume an invalid request.
    check(typeof content === 'string' && content.length <= 32000 && content.trim().length > 0, 'draft content must be non-blank text of at most 32000 characters');
    const params = await resolveInputOptions(parsed, client);
    return client.request(action === 'create' ? 'draft.add' : 'draft.update', { content, ...params,
      ...(action === 'update' ? { id: recordId, expected_revision: revision } : {}) });
  }
  check(['remove','submit','cancel','release'].includes(action), 'unknown input draft command');
  const revision = draftRevision(cliOption(args, '--revision'));
  const profileFile = action === 'submit' ? cliOption(args, '--profile-file') : null;
  positionalArguments(args, 1);
  const recordId = cliInteger(args[0], 'draft ID');
  check(!client.management || profileFile === null, 'the management bridge cannot read local profile files');
  if (action === 'remove') return client.request('draft.remove', { id: recordId, expected_revision: revision });
  const params = { draft_id: recordId, expected_revision: revision,
    ...(profileFile === null ? {} : { profile: readProfile(profileFile) }) };
  if (action === 'submit') validateInputEmissionRequest(params);
  return client.request({ submit: 'input.emit', cancel: 'input.emission_cancel', release: 'input.exclusive_release' }[action], params);
}
