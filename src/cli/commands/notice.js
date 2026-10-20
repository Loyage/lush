import { check } from '../../core/types.js';
import { questionsFromJSON } from './question.js';
import { takeJsonInput } from '../private-json.js';
import { resolveWorkerId } from '../worker-number.js';
import { readListCursor, listPage } from './input.js';
import { positionalArguments, cliOption, cliInteger } from './intent.js';

async function list(args, client) {
  const view = cliOption(args, '--view', 'current');
  check(['current','history'].includes(view), '--view expects current or history');
  if (view === 'current') {
    positionalArguments(args, 0);
    // The current priority window is bounded, not an exhaustive history page.
    return client.request('notice.list');
  }
  const status = cliOption(args, '--status', 'all'), before = cliOption(args, '--before');
  const cursor = cliOption(args, '--cursor'), rawLimit = cliOption(args, '--limit');
  check(['all','open','answered','dismissed','sent','unread','automatic'].includes(status), 'invalid notice status');
  check(before === null || cursor === null, '--before and --cursor are mutually exclusive');
  const limit = rawLimit === null ? 30 : cliInteger(rawLimit, 'limit', 1, 100);
  positionalArguments(args, 0);
  const binding = { method: 'notice.page', view: 'history', filters: { status } };
  const source = readListCursor(cursor, binding);
  check(source === undefined || Number.isSafeInteger(source) && source > 0, 'invalid Notice history cursor source');
  const boundary = before === null ? source : cliInteger(before, 'before');
  const value = await client.request('notice.page', { status, limit, ...(boundary === undefined ? {} : { before: boundary }) });
  return Array.isArray(value?.notices) && typeof value.has_more === 'boolean'
    ? listPage(value, binding, value.cursor, value.has_more, value.limit) : value;
}
async function events(args, client) {
  const cursor = cliOption(args, '--cursor'), rawLimit = cliOption(args, '--limit');
  const limit = rawLimit === null ? 100 : cliInteger(rawLimit, 'limit', 1, 100);
  positionalArguments(args, 0);
  const binding = { method: 'notice.sync', view: 'events', filters: {} };
  const source = readListCursor(cursor, binding);
  check(source === undefined || typeof source === 'string', 'invalid Notice event cursor source');
  const value = await client.request('notice.sync', { limit, ...(source === undefined ? {} : { cursor: source }) });
  // Even a caught-up event stream needs its opaque checkpoint for the next read.
  return Array.isArray(value?.changes) && typeof value.has_more === 'boolean'
    ? listPage(value, binding, value.cursor, value.has_more, limit, true) : value;
}
export async function run(command, args, ctx = {}) {
  check(command === 'notice', 'unknown notice command');
  const { client } = ctx, verb = args.shift();
  if (verb === 'list') return list(args, client);
  if (verb === 'events') return events(args, client);
  if (verb === 'ask' || verb === 'notify') {
    const target = cliOption(args, '--worker'), body = cliOption(args, '--body', '');
    const source = verb === 'ask' ? cliOption(args, '--questions-json') : null;
    positionalArguments(args, 1);
    check(target !== null, 'notice ask/notify requires an explicit --worker target');
    const questions = source !== null ? questionsFromJSON(source, body) : undefined;
    return client.request('notice.post', { task: await resolveWorkerId(client, target), title: args[0], body,
      kind: verb === 'ask' ? 'question' : 'info', ...(questions === undefined ? {} : { questions }) });
  }
  if (verb === 'answer') {
    const answer = args.includes('--data') ? takeJsonInput(args) : null;
    positionalArguments(args, answer === null ? 2 : 1);
    return client.request('notice.answer', { id: cliInteger(args[0], 'Notice ID'), answer: answer === null ? args[1] : answer });
  }
  check(['dismiss','mark-read'].includes(verb), 'unknown notice command');
  positionalArguments(args, 1);
  return client.request(verb === 'dismiss' ? 'notice.dismiss' : 'notice.read', { id: cliInteger(args[0], 'Notice ID') });
}
