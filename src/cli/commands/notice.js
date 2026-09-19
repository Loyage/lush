import { id } from '../../core/types.js';
import { option, exact } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'notice') {
    const verb = args.shift();
    if (verb === 'list') { exact(args, 0); value = await client.request('notice.list'); }
    else if (verb === 'post') {
      const task = option(args, '--task', process.env.LUSH_TASK_ID), body = option(args, '--body', ''); exact(args, 1);
      value = await client.request('notice.post', { task: id(task), title: args[0], body });
    } else if (verb === 'answer') { exact(args, 2); value = await client.request('notice.answer', { id: id(args[0]), answer: args[1] }); }
    else if (verb === 'dismiss') { exact(args, 1); value = await client.request('notice.dismiss', { id: id(args[0]) }); }
    else throw new Error('unknown notice command');
  }
  return value;
}
