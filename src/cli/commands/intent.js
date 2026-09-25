import { exact, option } from '../args.js';
import { id } from '../../core/types.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'say' || command === 'intent') {
    // 意图：lush intent '…' 提交一条；lush intent list 看每条意图的 planner/scheduler 进度。
    if (command === 'intent' && ['list','ls'].includes(args[0])) { exact(args.slice(1), 0); value = await client.request('input.list'); }
    else {
      if (['submit','add'].includes(args[0])) args.shift();
      const branch = option(args, '--branch');
      const draft = option(args, '--draft');
      if (draft !== null) {
        exact(args, 0);
        value = await client.request('say.submit', { draft_id: id(draft), ...(branch ? { branch } : {}) });
      } else {
        exact(args, 1);
        value = await client.request('say.submit', { content: args[0], ...(branch ? { branch } : {}) });
      }
    }
  } else if (command === 'input') {
    const verb = args.shift();
    if (verb === 'list') { exact(args, 0); value = await client.request('input.list'); }
    else throw new Error('unknown input command; use list');
  }
  return value;
}
