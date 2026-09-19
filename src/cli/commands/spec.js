import { check, id } from '../../core/types.js';
import { option, exact } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'spec') {
    const verb = args.shift();
    if (verb === 'list') {
      const status = option(args, '--status');
      if (status) check(['pending','planned','dropped'].includes(status), '--status must be pending, planned or dropped');
      exact(args, 0);
      value = await client.request('spec.list');
      if (status) value = value.filter(row => row.status === status);
    } else if (verb === 'add') {
      const role = option(args, '--role');
      const name = option(args, '--name');
      const defaultKind = option(args, '--dep-kind', 'code');
      const deps = [];
      // Repeatable and comma-separated, like task spawn: --depends-on 7,9:order --depends-on 11
      for (let raw = option(args, '--depends-on'); raw !== null; raw = option(args, '--depends-on')) {
        for (const token of raw.split(',').filter(Boolean)) {
          const [specId, kind = defaultKind] = token.split(':');
          deps.push({ spec: id(specId), kind });
        }
      }
      exact(args, 1);
      value = await client.request('spec.add', { goal: args[0], role, name, deps });
    } else if (verb === 'drop') {
      const note = option(args, '--note');
      exact(args, 1);
      value = await client.request('spec.drop', { id: id(args[0]), note });
    } else throw new Error('unknown spec command; use list, add or drop');
  }
  return value;
}
