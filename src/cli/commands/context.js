import { check } from '../../core/types.js';
import { workerNumber } from '../../core/worker-number.js';
import { CONTEXT_LIMITS } from '../../core/worker-context.js';
import { printTranscript } from '../print.js';
import { questionFromFile } from './question.js';
import { run as runProgress } from './progress.js';
import { positionalArguments, cliOption, cliInteger } from './intent.js';

function childSelector(value) {
  if (typeof value === 'string' && value.startsWith('W')) { workerNumber(value); return value; }
  return cliInteger(value, 'direct child ID');
}
export async function run(command, args, ctx) {
  const { client } = ctx, verb = args.shift();
  check(Boolean(client.token || ctx.userContext), 'lushw data commands require an active Worker invocation');
  if (command === 'self' && verb === 'progress') {
    check(!args.some(arg => arg.startsWith('--') && args.indexOf(arg) !== -1), 'unknown progress option');
    return runProgress('progress', args, { ...ctx, client: { token: client.token, request: (method, params) => client.request(
      method === 'progress.plan' ? 'context.progress_plan' : 'context.progress_complete', params) } });
  }
  if (command === 'self' && verb === 'title') {
    positionalArguments(args, 1); return client.request('context.auto_title', { title: args[0] });
  }
  if (command === 'self' && verb === 'notice') {
    const action = args.shift();
    if (action === 'list') {
      const before = cliOption(args, '--before'), limit = cliOption(args, '--limit'); positionalArguments(args, 0);
      return client.request('context.notices', { ...(before === null ? {} : { before: cliInteger(before, 'before') }),
        ...(limit === null ? {} : { limit: cliInteger(limit, 'limit', 1, CONTEXT_LIMITS.notices) }) });
    }
    if (action === 'ask') {
      const file = cliOption(args, '--question-file'); positionalArguments(args, 0);
      check(file !== null, 'self notice ask requires a question create output file via --question-file');
      const { title, body, questions } = questionFromFile(file);
      return client.request('context.notice', { title, body, questions, kind: 'question' });
    }
    check(action === 'notify', 'unknown self notice command; use list, ask or notify');
    const body = cliOption(args, '--body', ''); positionalArguments(args, 1);
    return client.request('context.notice', { title: args[0], body, kind: 'info' });
  }
  if (command === 'children' && verb === 'list') {
    const after = cliOption(args, '--after'), limit = cliOption(args, '--limit'); positionalArguments(args, 0);
    return client.request('context.children', { ...(after === null ? {} : { after: cliInteger(after, 'after', 0) }),
      ...(limit === null ? {} : { limit: cliInteger(limit, 'limit', 1, CONTEXT_LIMITS.children) }) });
  }
  if (command === 'children' && verb === 'spawn') {
    const name = cliOption(args, '--name'); positionalArguments(args, 1);
    return client.request('context.spawn', { goal: args[0], ...(name === null ? {} : { name }) });
  }
  const relation = command === 'children' ? 'child' : command;
  check(['self','parent','child'].includes(relation), 'unknown Worker relation');
  check(relation !== 'parent' || ['show','message'].includes(verb), 'unknown parent command');
  check(['show','events','transcript','message','accept'].includes(verb), 'unknown Worker context command');
  check(verb !== 'message' || relation !== 'self', 'self message is not a CLI command');
  check(verb !== 'accept' || relation === 'child', 'accept is limited to a direct child');
  const after = ['events','transcript'].includes(verb) ? cliOption(args, '--after') : null;
  const limit = verb === 'transcript' ? cliOption(args, '--limit') : null;
  positionalArguments(args, (relation === 'child' ? 1 : 0) + (verb === 'message' ? 1 : 0));
  const child = relation === 'child' ? childSelector(args.shift()) : undefined;
  const params = { relation, ...(child === undefined ? {} : { child }),
    ...(after === null ? {} : { after: cliInteger(after, 'after', 0) }),
    ...(limit === null ? {} : { limit: cliInteger(limit, 'limit', 1, CONTEXT_LIMITS.transcript) }) };
  if (verb === 'message') return client.request('context.message', { ...params, body: args[0] });
  if (verb === 'accept') return client.request('context.accept', { child });
  const value = await client.request(`context.${{ show: 'inspect', events: 'history', transcript: 'transcript' }[verb]}`, params);
  if (verb === 'transcript' && !ctx.json) { printTranscript(value); return; }
  return value;
}
