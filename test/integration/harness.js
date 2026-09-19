import { ROOT } from '../../src/identity.js';
import { env } from '../helpers.js';

// 本分区共享的准备工作：每次调用都起新的 CLI / 客户端，不保留模块级可变状态。
export async function cli(root, args, extra = {}) {
  const proc = Bun.spawn([process.execPath,'run','scripts/ops.js',...args,'--project',root,'--json'], { cwd: ROOT, env: env(extra), stdout:'pipe',stderr:'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if (code) throw new Error(`${args.join(' ')}: ${stderr} ${stdout}`);
  return JSON.parse(stdout);
}

export async function done(client, taskId) {
  for (let i=0;i<100;i++) { const task = await client.request('task.inspect',{id:taskId}); if (['completed','failed'].includes(task.status)) return task; await Bun.sleep(30); }
  throw new Error('task timeout');
}

/** scheduler 属于意图层，不在 task.list 里：它的 id 与状态跟着意图行下发。 */
export async function schedulerOf(client, plannerTaskId) {
  for (let i=0;i<200;i++) {
    const row = (await client.request('input.list')).find(intent => intent.task_id === plannerTaskId);
    if (row?.scheduler_id) return { id: row.scheduler_id, status: row.scheduler_status };
    await Bun.sleep(30);
  }
  return null;
}
