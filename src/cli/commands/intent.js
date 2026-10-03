import { exact, option } from '../args.js';

export async function run(command, args, ctx) {
  const { client } = ctx;
  let value;
  if (command === 'order') {
    const branch = option(args, '--branch');
    exact(args, 1);
    value = await client.request('order.submit', { content: args[0], ...(branch ? { branch } : {}) });
  }
  return value;
}
