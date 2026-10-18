import { check } from '../../core/types.js';
import { exact, option } from '../args.js';
import { printTranscript } from '../print.js';
import { questionsFromFile } from './notice.js';
import { run as runProgress } from './progress.js';

export async function run(command, args, ctx) {
  const { client } = ctx, verb = args.shift();
  check(Boolean(client.token), 'lushw data commands require an active Worker invocation');
  if (command === 'self' && verb === 'progress') {
    return runProgress('progress', args, { ...ctx, client: { token: client.token, request: (method, params) => client.request(
      method === 'progress.plan' ? 'context.progress_plan' : 'context.progress_complete', params) } });
  }
  if (command === 'self' && verb === 'auto-title') {
    exact(args, 1); return client.request('context.auto_title', { title: args[0] });
  }
  if (command === 'self' && verb === 'notice') {
    const action = args.shift();
    if (action === 'list') {
      const before = option(args, '--before'), limit = option(args, '--limit'); exact(args, 0);
      return client.request('context.notices', { ...(before === null ? {} : { before: Number(before) }),
        ...(limit === null ? {} : { limit: Number(limit) }) });
    }
    check(action === 'post', 'unknown self notice command');
    const body = option(args, '--body', ''), kind = option(args, '--kind'), file = option(args, '--questions-file');
    exact(args, 1);
    check(kind === null || ['question','info'].includes(kind), 'notice kind must be question or info');
    check(kind !== 'info' || file === null, 'an info notice cannot contain a questionnaire');
    return client.request('context.notice', { title: args[0], body, ...(kind === null ? {} : { kind }),
      ...(file === null ? {} : { questions: questionsFromFile(file, body) }) });
  }
  if (command === 'children' && verb === 'list') {
    const after = option(args, '--after'), limit = option(args, '--limit'); exact(args, 0);
    return client.request('context.children', { ...(after === null ? {} : { after: Number(after) }),
      ...(limit === null ? {} : { limit: Number(limit) }) });
  }
  if (command === 'children' && verb === 'spawn') {
    const name = option(args, '--name'); exact(args, 1);
    return client.request('context.spawn', { goal: args[0], ...(name === null ? {} : { name }) });
  }
  const relation = command === 'children' ? 'child' : command;
  const after = ['history','transcript'].includes(verb) ? option(args, '--after') : null;
  const limit = verb === 'transcript' ? option(args, '--limit') : null;
  const childArg = relation === 'child' ? args.shift() : undefined;
  check(relation !== 'child' || childArg !== undefined, 'a direct child ID or Worker number is required');
  const child = typeof childArg === 'string' && /^[1-9]\d*$/.test(childArg) ? Number(childArg) : childArg;
  const params = { relation, ...(child === undefined ? {} : { child }),
    ...(after === null ? {} : { after: Number(after) }), ...(limit === null ? {} : { limit: Number(limit) }) };
  if (verb === 'message') {
    exact(args, 1); return client.request('context.message', { ...params, body: args[0] });
  }
  if (verb === 'accept') {
    exact(args, 0); return client.request('context.accept', { child });
  }
  check(['inspect','history','transcript'].includes(verb), 'unknown Worker context command');
  exact(args, 0);
  const value = await client.request(`context.${verb}`, params);
  if (verb === 'transcript' && !ctx.json) { printTranscript(value); return; }
  return value;
}
