import { exact, option } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'say' || command === 'intent') {
    // 意图：lush intent '…' 提交一条；lush intent list 看每条意图的 planner/scheduler 进度。
    if (command === 'intent' && ['list','ls'].includes(args[0])) { exact(args.slice(1), 0); value = await client.request('input.list'); }
    else {
      if (['submit','add'].includes(args[0])) args.shift();
      const branch = option(args, '--branch');
      exact(args, 1); value = await client.request('input.submit', { content: args[0], ...(branch ? { branch } : {}) });
    }
  } else if (command === 'input') {
    const verb = args.shift();
    if (verb === 'list') { exact(args, 0); value = await client.request('input.list'); }
    else throw new Error('unknown input command; use list');
  }
  return value;
}
