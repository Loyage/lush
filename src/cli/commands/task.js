import { normalizeMergeConditions } from '../../core/merge-conditions.js';
import { check } from '../../core/types.js';
import { resolveWorkerId } from '../worker-number.js';
import { option, exact } from '../args.js';
import { runWorkerHook, runWorkerCompletion } from './hooks.js';
import { printTree, printTranscript } from '../print.js';
import { takeOptions } from '../command-options.js';
import { takeConfigurationScope, scopedSettingsClient } from '../settings-scope.js';

function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1); check(!args.includes(name), `duplicate ${name}`); return true;
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum, `invalid ${label}`);
  return Number(value);
}
function revision(args) {
  const value = option(args, '--revision');
  check(typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\x00-\x1f\x7f]/.test(value), 'read worker merge show ID, then provide --revision REV');
  return value;
}
function listCursor(view, scope, brief, source, cursor) {
  return Buffer.from(JSON.stringify({ version: 1, command: 'worker.list', view, scope, brief, source, cursor })).toString('base64url');
}
function readListCursor(raw, view, scope, brief) {
  let value;
  try { check(typeof raw === 'string' && raw.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(raw), 'invalid cursor'); value = JSON.parse(Buffer.from(raw, 'base64url').toString()); }
  catch { check(false, 'invalid worker list cursor'); }
  check(value && Object.keys(value).sort().join(',') === 'brief,command,cursor,scope,source,version,view'
    && value.version === 1 && value.command === 'worker.list' && value.view === view && value.scope === scope && value.brief === brief
    && value.source === (view === 'all' ? 'worker.list' : 'worker.page')
    && Number.isSafeInteger(value.cursor) && value.cursor > 0, 'worker list cursor does not match view, scope or filters');
  return value;
}
async function list(args, client) {
  const view = option(args, '--view', 'recent'), scopeOption = option(args, '--scope');
  const brief = flag(args, '--brief'), rawLimit = option(args, '--limit');
  const rawCursor = option(args, '--cursor'), after = option(args, '--after'), before = option(args, '--before');
  exact(args, 0);
  check(['recent','all','history'].includes(view), 'worker list --view expects recent|all|history');
  check(view === 'all' ? scopeOption === null : scopeOption === null || ['work','all'].includes(scopeOption), '--scope work|all is only available for recent/history');
  check(view === 'all' || !brief, '--brief is only available for --view all');
  check(view === 'all' ? before === null : after === null, '--after is only available for all; --before is only available for history');
  check(view !== 'recent' || before === null, 'recent continues only with --cursor');
  check(rawCursor === null || after === null && before === null, '--cursor cannot be combined with --after/--before');
  const scope = view === 'all' ? null : scopeOption ?? 'work';
  const requestedLimit = rawLimit === null ? (view === 'all' ? brief ? 30 : 200 : 50)
    : integer(rawLimit, 'limit', 1, view === 'all' && !brief ? 1000 : 200);
  const limit = requestedLimit;
  const cursor = rawCursor === null ? null : readListCursor(rawCursor, view, scope, brief);
  if (view === 'all') {
    const start = cursor?.cursor ?? (after === null ? 0 : integer(after, 'after'));
    // The fixed parent adds paged=true under the same worker.list permission.
    // Its page reflects actual row/byte budgets, unlike legacy array length.
    const result = await client.request('worker.list', { after: start, limit, paged: true });
    // A confirmation/unknown receipt is not a list and must remain untouched.
    if (!result || !Array.isArray(result.tasks) || typeof result.page?.has_more !== 'boolean') return result;
    const tasks = brief ? result.tasks.map(({ id, worker_number, parent_id, role, status, integration, display_title, auto_title, goal }) => ({
      id, worker_number: worker_number ?? null, parent_id, role, status, integration, display_title: display_title ?? null,
      auto_title: auto_title ?? null, goal: goal.replace(/\s+/g, ' ').slice(0, 160), goal_truncated: goal.length >= 160,
    })) : result.tasks;
    const next = result.page.has_more ? listCursor(view, scope, brief, 'worker.list', result.page.next_cursor) : null;
    return { ...result, tasks, page: { ...result.page, source_next_cursor: result.page.next_cursor, next_cursor: next },
      ...(brief ? { summary_coverage: 'brief_worker_summaries', note: '完整目标与结果用 lush worker show ID。' } : {}) };
  }
  const history = view === 'history' || cursor !== null;
  const result = await client.request(history ? 'worker.page' : 'worker.activity', history
    ? { before: cursor?.cursor ?? (before === null ? null : integer(before, 'before', 1)), limit, scope }
    : { limit, scope });
  if (!result || !Array.isArray(result.tasks)) return result;
  const source = history ? result : result.page;
  const next = source?.has_more && source.cursor !== null ? listCursor(view, scope, brief, 'worker.page', source.cursor) : null;
  return { ...result, page: { ...(result.page ?? {}), limit: source.limit, has_more: source.has_more, next_cursor: next } };
}

async function config(args, client) {
  check(!client.token || client.management, 'Worker configuration requires user or trusted management identity');
  const verb = args.shift();
  check(['set','reset'].includes(verb), 'worker config requires set|reset');
  if (verb === 'reset') {
    exact(args, 1);
    return client.request('worker.clear_override', { id: await resolveWorkerId(client, args[0]) });
  }
  const connection = option(args, '--connection'), model = option(args, '--model'), source = option(args, '--data');
  const registered = option(args, '--registered-model'), scope = takeConfigurationScope(args); exact(args, 1);
  check(scope === null || registered !== null, '--scope is only used with --registered-model');
  let update;
  if (registered !== null) {
    check(connection === null && model === null && source === null, '--registered-model cannot be combined with --connection/--model/--data');
    const selection = await scopedSettingsClient(client, scope).request('agent.registered_models.resolve', { selector: registered });
    update = { model_selection: { connection_id: selection.connection_id, model: selection.model } };
  } else if (source !== null) {
    check(connection === null && model === null, '--data cannot be combined with --connection/--model');
    check(Buffer.byteLength(source) <= 40000, 'inline JSON exceeds budget');
    const profile = JSON.parse(source);
    check(profile && typeof profile === 'object' && !Array.isArray(profile), '--data must be a profile object'); update = { profile };
  } else {
    check(connection !== null && model !== null, 'config set requires --registered-model NAME_OR_ID, --connection UUID --model PROVIDER/MODEL or --data JSON');
    update = { model_selection: { connection_id: connection, model } };
  }
  return client.request('worker.configure', { id: await resolveWorkerId(client, args[0]), ...update });
}
async function merge(args, client) {
  check(!client.token || client.management, 'merge requests require user or trusted management identity');
  const verb = args.shift();
  check(['show','request','cancel'].includes(verb), 'worker merge requires request|show|cancel');
  if (verb !== 'request') {
    exact(args, 1); return client.request(verb === 'show' ? 'worker.merge_conditions' : 'worker.unreserve', { id: await resolveWorkerId(client, args[0]) });
  }
  const unresolved = [];
  // option() respects the core's literal -- boundary; scanning raw values would
  // mistake a literal body for a condition and could select another RPC mode.
  for (const [flag, kind] of [['--after-settled','worker_settled'], ['--after-merged','worker_merged']]) {
    let worker;
    while ((worker = option(args, flag)) !== null) unresolved.push({ kind, worker });
  }
  const conditional = unresolved.length > 0;
  const expected_revision = conditional ? revision(args) : null;
  const conditions = [];
  exact(args, 1);
  for (const condition of unresolved) conditions.push({ kind: condition.kind, worker_id: await resolveWorkerId(client, condition.worker) });
  const id = await resolveWorkerId(client, args[0]);
  return conditional ? client.request('worker.merge_after', { id, conditions: normalizeMergeConditions(conditions), expected_revision })
    : client.request('worker.reserve', { id, kind: 'merge' });
}
async function automation(args, client) {
  const verb = args.shift();
  check(['show','completion','attach','enable','disable','detach'].includes(verb), 'worker automation requires show|completion|attach|enable|disable|detach');
  if (verb === 'show') { exact(args, 1); return client.request('worker.hooks', { id: await resolveWorkerId(client, args[0]) }); }
  if (verb === 'completion') return runWorkerCompletion(args, client);
  // Keep the core's argument-array literal boundary for the nested handler.
  args.splice(0, 0, verb === 'detach' ? 'remove' : verb);
  return runWorkerHook(args, client);
}

export async function run(command, args, ctx) {
  const { client, json } = ctx;
  check(command === 'worker', 'unknown Worker command');
  const verb = args.shift();
  if (verb === 'list') return list(args, client);
  if (verb === 'config') return config(args, client);
  if (verb === 'merge') return merge(args, client);
  if (verb === 'automation') return automation(args, client);
  if (verb === 'sync') {
    const action = args.shift(); check(['start','resolve'].includes(action), 'worker sync requires start|resolve'); exact(args, 1);
    return client.request(action === 'start' ? 'worker.sync_parent' : 'worker.resolve_sync', { id: await resolveWorkerId(client, args[0]) });
  }
  if (verb === 'progress' || verb === 'relations') {
    const params = takeOptions(args, verb === 'progress' ? { before: 'number', limit: 'number' } : { after: 'number', limit: 'number' }); exact(args, 1);
    return client.request(verb === 'progress' ? 'worker.progress_history' : 'worker.relations', { id: await resolveWorkerId(client, args[0]), ...params });
  }
  if (verb === 'tree') {
    check(args.length <= 1, 'tree accepts an optional ID');
    const request = args.length ? { id: await resolveWorkerId(client, args[0]) } : {};
    if (!json) {
      const [tree, status] = await Promise.all([client.request('worker.tree', request), client.request('system.status')]); printTree(tree, status); return;
    }
    return client.request('worker.tree', request);
  }
  if (verb === 'spawn') {
    const parent = option(args, '--parent'), name = option(args, '--name'); exact(args, 1);
    return client.request('worker.spawn', { parent: await resolveWorkerId(client, parent), goal: args[0], ...(name ? { name } : {}) });
  }
  if (verb === 'transcript' || verb === 'events') {
    const after = integer(option(args, '--after', '0'), 'cursor'); exact(args, 1);
    const value = await client.request(verb === 'events' ? 'worker.history' : 'worker.transcript', { id: await resolveWorkerId(client, args[0]), after });
    if (verb === 'transcript' && !json) { printTranscript(value); return; } return value;
  }
  if (verb === 'message' || verb === 'rename') {
    if (verb === 'rename') check(!client.token || client.management, 'Worker titles require user or trusted management identity');
    exact(args, 2); return client.request(`worker.${verb}`, { id: await resolveWorkerId(client, args[0]), [verb === 'message' ? 'body' : 'title']: args[1] });
  }
  if (verb === 'accept') {
    exact(args, 1);
    return client.request('worker.accept', { id: await resolveWorkerId(client, args[0]) });
  }
  if (verb === 'delete' || verb === 'delete-preview') {
    check(!client.token || client.management, 'Worker deletion requires user or trusted management identity');
    const force = flag(args, '--force'), confirm = flag(args, '--confirm'), revision = option(args, '--revision'); exact(args, 1);
    check(verb === 'delete' ? confirm && typeof revision === 'string' && revision.length > 0 : !confirm && revision === null,
      'first run worker delete-preview ID; worker delete requires --confirm --revision REV');
    return client.request(verb === 'delete' ? 'worker.delete' : 'worker.delete_preview',
      { id: await resolveWorkerId(client, args[0]), ...(confirm ? { revision, confirm: true } : {}), ...(force ? { force: true } : {}) });
  }
  check(['show','cancel','retry','pause','resume','reopen'].includes(verb), 'unknown worker command; run lush help worker'); exact(args, 1);
  return client.request(`worker.${({ show: 'inspect', pause: 'interrupt' })[verb] ?? verb}`, { id: await resolveWorkerId(client, args[0]) });
}
