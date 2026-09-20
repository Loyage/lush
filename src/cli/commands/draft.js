import { id } from '../../core/types.js';
import { exact, option } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'draft') {
    const verb = args.shift();
    if (verb === 'add') { exact(args, 1); value = await client.request('draft.add', { content: args[0] }); }
    else if (verb === 'list') { exact(args, 0); value = await client.request('draft.list'); }
    else if (verb === 'edit' || verb === 'update') { exact(args, 2); value = await client.request('draft.update', { id: id(args[0]), content: args[1] }); }
    else if (verb === 'rm' || verb === 'remove') { exact(args, 1); value = await client.request('draft.remove', { id: id(args[0]) }); }
    else if (verb === 'commit' || verb === 'submit') {
      const branch = option(args, '--branch');
      const ids = args.map(value => id(value));
      value = await client.request('draft.commit', { ...(ids.length ? { ids } : {}), ...(branch ? { branch } : {}) });
    }
    else throw new Error('unknown draft command; use add, list, edit, rm or commit');
  }
  return value;
}
