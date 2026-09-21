import { id } from '../../core/types.js';
import { option, exact } from '../args.js';

export async function run(command, args, { client }) {
  if (command !== 'candidate') return undefined;
  const verb = args.shift();
  if (verb === 'list') {
    const input = option(args, '--input'); exact(args, 0);
    return client.request('candidate.list', input === null ? {} : { input: id(input) });
  }
  if (verb === 'inspect') { exact(args, 1); return client.request('candidate.inspect', { id: id(args[0]) }); }
  if (verb === 'prepare') {
    const summary = option(args, '--summary'); exact(args, 1);
    return client.request('candidate.prepare', { input: id(args[0]), summary });
  }
  if (verb === 'verify') { exact(args, 1); return client.request('candidate.verify', { id: id(args[0]) }); }
  if (verb === 'accept') { exact(args, 1); return client.request('candidate.accept', { id: id(args[0]) }); }
  if (verb === 'changes') { exact(args, 2); return client.request('candidate.changes', { id: id(args[0]), feedback: args[1] }); }
  if (verb === 'reject') {
    const reason = option(args, '--reason'); exact(args, 1);
    return client.request('candidate.reject', { id: id(args[0]), reason });
  }
  throw new Error('unknown candidate command; use list, inspect, prepare, verify, accept, changes or reject');
}
