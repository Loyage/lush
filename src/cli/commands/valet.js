import { check } from '../../core/types.js';
import { exact, option } from '../args.js';
import { resolveWorkerId } from '../worker-number.js';
import { questionsFromJSON } from './notice.js';
import { run as progress } from './progress.js';

/** Management-invocation-only CLI commands; no development context proxy. */
export async function run(command, args, ctx) {
  const { client } = ctx;
  check(client.management && client.token, 'valet commands require the fixed management invocation bridge');
  const verb = args.shift();
  if (verb === 'query') {
    check(args.length <= 1, 'query accepts an optional Worker');
    return client.request('manager.query', args.length ? { id: await resolveWorkerId(client, args[0]) } : {});
  }
  if (verb === 'history') {
    const worker = option(args, '--worker'), before = option(args, '--before'), limit = option(args, '--limit'); exact(args, 0);
    return client.request('manager.history', { ...(worker === null ? {} : { id: await resolveWorkerId(client, worker) }),
      ...(before === null ? {} : { before: Number(before) }), ...(limit === null ? {} : { limit: Number(limit) }) });
  }
  if (verb === 'auto-title') { exact(args, 1); return client.request('worker.auto_title', { title: args[0] }); }
  if (verb === 'progress') return progress('progress', args, ctx);
  check(verb === 'notice' && args.shift() === 'post', 'unknown valet command');
  const body = option(args, '--body', ''), kind = option(args, '--kind'), source = option(args, '--questions-json'); exact(args, 1);
  check(kind === null || ['question','info'].includes(kind), 'invalid Notice kind');
  check(kind !== 'info' || source === null, 'info cannot contain a questionnaire');
  return client.request('notice.post', { title: args[0], body, ...(kind === null ? {} : { kind }),
    ...(source === null ? {} : { questions: questionsFromJSON(source, body) }) });
}
