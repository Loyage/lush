import http from 'node:http';
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

/** Wait for deterministic Plan compilation and return work items belonging to the planner's Intent. */
export async function workOf(client, plannerTaskId, minimum = 1) {
  const planner = await client.request('task.inspect', { id: plannerTaskId });
  for (let i=0;i<200;i++) {
    const tasks = await client.request('task.list');
    const work = tasks.filter(task => task.input_id === planner.input_id && task.role !== 'verifier');
    if (work.length >= minimum) return work;
    await Bun.sleep(30);
  }
  return [];
}

/* ---------- Web 是后台服务：命令立刻返回，进程的生死只能靠端口与 pid 判断 ---------- */

/** 先占一个端口拿到内核挑的号，再放掉；这点竞态窗口对本地测试足够小。 */
export function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/** 用 node:http 而不是全局 fetch：它不会跟着机器上的代理跑偏。 */
export function httpStatus(port) {
  return new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${port}/`, { method: 'GET' }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

/** 等这个端口答一个 200（Web 起来了）或彻底不答（Web 走了）。 */
export async function waitForWeb(port, expected = true, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const status = await httpStatus(port).catch(() => null);
    if (expected ? status === 200 : status === null) return status;
    await Bun.sleep(30);
  }
  throw new Error(`web on port ${port} did not ${expected ? 'answer' : 'go away'} in ${timeout}ms`);
}
