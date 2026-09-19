import { id } from '../../core/types.js';
import { option, exact } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'plan') {
    const verb = args.shift();
    if (verb === 'propose') {
      // planner 专用：这轮拆解需要用户先拍板时才提（影响面大 / 与现状冲突 / 没把握读懂意图）。
      const body = option(args, '--body', ''); exact(args, 1);
      value = await client.request('plan.propose', { title: args[0], body });
    } else if (verb === 'approve') { exact(args, 1); value = await client.request('plan.approve', { id: id(args[0]) }); }
    else if (verb === 'reject') { exact(args, 2); value = await client.request('plan.reject', { id: id(args[0]), reason: args[1] }); }
    else throw new Error('unknown plan command; use propose, approve or reject');
  }
  return value;
}
