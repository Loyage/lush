import { check } from '../../core/types.js';
import { exact, option, isOptionIndex } from '../args.js';
import { resolveWorkerId } from '../worker-number.js';
import { questionsFromJSON } from './question.js';
import { run as progress } from './progress.js';

function take(args, name, fallback = null) {
  check(args.filter((value, index) => isOptionIndex(args, index) && value === name).length <= 1, `duplicate CLI option: ${name}`);
  return option(args, name, fallback);
}
function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
    && Number(value) >= min && Number(value) <= max, 'CLI option must be an integer in the documented range');
  return Number(value);
}

/** Valet-specific transactions; generic W/V operations remain under worker. */
export async function run(command, args, ctx) {
  const { client } = ctx;
  check(command === 'valet', 'unknown Valet command');
  check(!client.token || client.management, 'Valet management requires user or trusted management identity');
  const verb = args.shift();
  if (verb === 'receipt') {
    check(args.shift() === 'show', 'valet receipt requires show');
    const after = take(args, '--after'), limit = take(args, '--limit'); exact(args, 1);
    return client.request('management.receipt', { receipt_id: integer(args[0], 1),
      ...(after === null ? {} : { after: integer(after, 0) }), ...(limit === null ? {} : { limit: integer(limit, 1, 100) }) });
  }
  // These are bound to the actual management invocation, never a user-selected ID.
  check(client.management && client.token, 'valet context/self requires the fixed management invocation bridge');
  if (verb === 'context') {
    const action = args.shift();
    if (action === 'show') {
      check(args.length <= 1, 'valet context show accepts an optional Worker');
      return client.request('manager.query', args.length ? { id: await resolveWorkerId(client, args[0]) } : {});
    }
    check(action === 'history', 'valet context requires show|history');
    const worker = take(args, '--worker'), before = take(args, '--before'), limit = take(args, '--limit'); exact(args, 0);
    const pagination = { ...(before === null ? {} : { before: integer(before, 1) }),
      ...(limit === null ? {} : { limit: integer(limit, 1, 100) }) };
    return client.request('manager.history', { ...pagination, ...(worker === null ? {} : { id: await resolveWorkerId(client, worker) }) });
  }
  check(verb === 'self', 'unknown valet command; run lush help valet');
  const action = args.shift();
  if (action === 'title') { exact(args, 1); return client.request('worker.auto_title', { title: args[0] }); }
  if (action === 'progress') return progress('progress', args, ctx);
  check(action === 'notice', 'valet self requires title|progress|notice');
  const notice = args.shift();
  check(['ask','notify'].includes(notice), 'valet self notice requires ask|notify');
  const body = take(args, '--body', ''), source = notice === 'ask' ? take(args, '--questions-json') : null; exact(args, 1);
  if (source !== null) {
    check(Buffer.byteLength(source) <= 40000, 'inline questionnaire exceeds budget');
    const value = JSON.parse(source);
    check(value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every(key => key === 'questions'), 'questions JSON must contain only {questions:[...]}');
  }
  return client.request('notice.post', { title: args[0], body, kind: notice === 'ask' ? 'question' : 'info',
    ...(source === null ? {} : { questions: questionsFromJSON(source, body) }) });
}
