import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/identity.js';
import { temp, env, until, repo } from './helpers.js';
import { Config } from '../src/config.js';
import { UIClient } from '../src/ui/client.js';

async function cli(root, args, extra = {}) {
  const proc = Bun.spawn([process.execPath,'run','scripts/ops.js',...args,'--project',root,'--json'], { cwd: ROOT, env: env(extra), stdout:'pipe',stderr:'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if (code) throw new Error(`${args.join(' ')}: ${stderr} ${stdout}`);
  return JSON.parse(stdout);
}
async function done(client, taskId) {
  for (let i=0;i<100;i++) { const task = await client.request('task.inspect',{id:taskId}); if (['completed','failed'].includes(task.status)) return task; await Bun.sleep(30); }
  throw new Error('task timeout');
}

test('real daemons: project isolation, duplicate start, immediate input, restart persistence', async () => {
  const a = temp(), b = temp();
  try {
    const sa = await cli(a,['start']), sb = await cli(b,['start']);
    expect(sa.project).toBe(a); expect(sb.project).toBe(b); expect(sa.pid).not.toBe(sb.pid);
    expect((await cli(a,['start'])).already_running).toBe(true);
    const input = await cli(a,['say','original input']);
    const ca = new UIClient(Config.fromEnv(env(),a)), cb = new UIClient(Config.fromEnv(env(),b));
    expect((await done(ca,input.task.id)).status).toBe('completed');
    expect(await cb.request('input.list')).toEqual([]);
    const before = await ca.request('task.tree');
    const restarted = await cli(a,['daemon-restart']); expect(restarted.pid).not.toBe(sa.pid);
    expect(await ca.request('task.tree')).toEqual(before);
    expect((await cb.request('system.status')).pid).toBe(sb.pid);
    await expect(ca.request('service.list')).rejects.toThrow('unknown method');
  } finally {
    await cli(a,['stop']).catch(() => {}); await cli(b,['stop']).catch(() => {});
    fs.rmSync(a,{recursive:true,force:true}); fs.rmSync(b,{recursive:true,force:true});
  }
}, 30000);

test('pi subprocess receives project/task capability, pinned CLI, persistent session path and performs delegation', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const file = path.join(process.env.LUSH_HOME,'sessions','task-'+process.env.LUSH_TASK_ID+'-input.md');
const context = JSON.parse(fs.readFileSync(file,'utf8'));
fs.appendFileSync(path.join(process.env.LUSH_HOME,'seen.jsonl'),JSON.stringify({args, cwd:process.cwd(), project:process.env.LUSH_PROJECT, token:!!process.env.LUSH_AGENT_TOKEN, task:context.task})+'\\n');
if(context.task.role === 'planner' && context.task.calls === 1) {
 const proc = Bun.spawn(['lush','spec','add','delegated via pinned CLI','--role','research','--name','delegated-research','--json'],{stdout:'pipe',stderr:'pipe'});
 const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
 if(await proc.exited) throw new Error(err); console.log(out);
}
if(context.task.role === 'scheduler') {
 for(const spec of context.specs.filter(s => s.status === 'pending')) {
  const proc = Bun.spawn(['lush','task','spawn',spec.goal,'--role',spec.role,'--name',spec.name,'--spec',String(spec.id),'--json'],{stdout:'pipe',stderr:'pipe'});
  const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
  if(await proc.exited) throw new Error(err); console.log(out);
 }
}
console.log('fake pi completed');
`, { mode:0o755 });
  try {
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','run']);
    const client = new UIClient(Config.fromEnv(env(),root));
    const result = await done(client,input.task.id);
    expect(result.status).toBe('completed');
    expect(result.agent).toMatchObject({ id: `planner#${input.task.id}`, role: 'planner', active: false, pid: null });
    expect(result.agent.wakes).toBeGreaterThan(0);
    expect(result.agent.last_seen_at).toBeTruthy();
    // 等 scheduler 把 spec 编成任务并收尾
    let scheduler;
    for (let i=0;i<100 && !scheduler;i++) { scheduler = (await client.request('task.list',{})).find(task => task.role === 'scheduler'); if (!scheduler) await Bun.sleep(30); }
    expect(scheduler).toBeTruthy();
    expect((await done(client, scheduler.id)).status).toBe('completed');
    const research = (await client.request('task.list',{})).find(task => task.role === 'research');
    expect(research.goal).toBe('delegated via pinned CLI');
    expect(research.parent_id).toBe(scheduler.id);
    expect((await done(client, research.id)).status).toBe('completed');
    const seen = fs.readFileSync(path.join(root,'.lush','seen.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every(row => row.project === root && row.token)).toBe(true);
    const sessions = seen.filter(row => row.task.id === input.task.id).map(row => row.args[row.args.indexOf('--session-id')+1]);
    expect(new Set(sessions).size).toBe(1);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 30000);

test('shutdown kills pi process group, preserves task as failed, and restart does not replay it', async () => {
  const root = temp(), fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
fs.writeFileSync(process.env.LUSH_HOME+'/child.pid', String(process.pid));
const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {stdout:'ignore',stderr:'ignore'});
fs.writeFileSync(process.env.LUSH_HOME+'/grandchild.pid', String(child.pid));
setInterval(() => {}, 1000);
`, {mode:0o755});
  try {
    await cli(root,['start'],{LUSH_PROVIDER:'pi',LUSH_PI_COMMAND:fake});
    const input = await cli(root,['say','long']);
    await until(() => fs.existsSync(path.join(root,'.lush','grandchild.pid')));
    const pid = Number(fs.readFileSync(path.join(root,'.lush','child.pid'),'utf8'));
    const grandchild = Number(fs.readFileSync(path.join(root,'.lush','grandchild.pid'),'utf8'));
    await cli(root,['stop']);
    expect(() => process.kill(pid,0)).toThrow();
    await until(() => { try { process.kill(grandchild,0); return false; } catch { return true; } });
    await cli(root,['start']);
    const task = await cli(root,['inspect',String(input.task.id)]);
    expect(task.status).toBe('failed'); expect(task.error).toContain('daemon stopped');
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 30000);

// A fake pi that plans two workers: the second one stacks on the first with a code dependency.
const STACKED_PI = `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.LUSH_HOME,'sessions','task-'+process.env.LUSH_TASK_ID+'-input.md');
const context = JSON.parse(fs.readFileSync(file,'utf8'));
const git = (...args) => { const proc = Bun.spawnSync(['git',...args]); if (proc.exitCode) throw new Error(proc.stderr.toString()); };
const lush = async (...args) => {
  const proc = Bun.spawn(['lush',...args,'--json'],{stdout:'pipe',stderr:'pipe'});
  const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
  if (await proc.exited) throw new Error(err);
  return JSON.parse(out);
};
if (context.task.role === 'planner') {
  if (context.task.calls === 1) {
    const upstream = await lush('spec','add','upstream change','--role','worker','--name','stacked-upstream');
    await lush('spec','add','downstream change','--role','worker','--name','stacked-downstream','--depends-on',String(upstream.id));
  }
} else if (context.task.role === 'scheduler') {
  for (const spec of context.specs.filter(s => s.status === 'pending')) {
    await lush('task','spawn',spec.goal,'--role',spec.role,'--name',spec.name,'--spec',String(spec.id));
  }
} else if (context.task.goal === 'upstream change') {
  fs.writeFileSync('file.txt','upstream\\n');
  git('add','file.txt'); git('commit','-qm','upstream work');
} else {
  fs.writeFileSync('saw.txt', fs.readFileSync('file.txt','utf8').trim());
  fs.writeFileSync('other.txt','downstream\\n');
  git('add','saw.txt','other.txt'); git('commit','-qm','downstream work');
}
console.log('fake pi completed');
`;

test('drafts become one planner, and a code dependency stacks worktrees with an ordered merge', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, STACKED_PI, { mode:0o755 });
  await repo(root);
  const settle = async id => { for (let i=0;i<200;i++) { const task = await (new UIClient(Config.fromEnv(env(),root))).request('task.inspect',{id}); if (['completed','failed'].includes(task.status)) return task; await Bun.sleep(50); } throw new Error('task timeout'); };
  try {
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    await cli(root,['draft','add','实现搜索键盘导航']);
    await cli(root,['draft','add','把筛选器抽成组件']);
    const batch = await cli(root,['draft','commit']);
    expect(batch.content).toContain('用户在一次提交中给了 2 条');
    expect(batch.content).toContain('1) 实现搜索键盘导航');
    expect(batch.content).toContain('2) 把筛选器抽成组件');
    const client = new UIClient(Config.fromEnv(env(),root));
    expect((await settle(batch.task.id)).status).toBe('completed');
    // planner 写 spec，scheduler 串行把它们编成任务并在子任务全部终态后收尾（每条 spec 可能各自成批）
    let workers = [];
    for (let i=0;i<200 && workers.length<2;i++) {
      workers = (await client.request('task.list',{})).filter(task => task.role === 'worker').sort((a,b) => a.id - b.id);
      if (workers.length < 2) await Bun.sleep(30);
    }
    expect(workers).toHaveLength(2);
    const [upstream, downstream] = workers;
    expect((await settle(upstream.id)).status).toBe('completed');
    expect((await settle(downstream.id)).status).toBe('completed');
    let schedulers = [];
    for (let i=0;i<200;i++) {
      schedulers = (await client.request('task.list',{})).filter(task => task.role === 'scheduler');
      if (schedulers.length && schedulers.every(task => ['completed','failed'].includes(task.status))) break;
      await Bun.sleep(30);
    }
    expect(schedulers.length).toBeGreaterThanOrEqual(1);
    expect(schedulers.every(task => task.status === 'completed')).toBe(true);
    const [fullUpstream, fullDownstream] = [await client.request('task.inspect',{id:upstream.id}), await client.request('task.inspect',{id:downstream.id})];
    expect(downstream.deps).toEqual([{ id: upstream.id, kind:'code', status:'completed' }]);
    expect(upstream.blocked).toBe(false);
    expect(fullDownstream.base_commit).toBe(fullUpstream.head_commit);
    // 主工作树没有上游的改动，但下游的 worktree 是从上游分支拉出来的
    expect(fs.readFileSync(path.join(root,'file.txt'),'utf8')).toBe('base\n');
    expect(fs.readFileSync(path.join(root,'.lush','worktrees',`${downstream.id}-stacked-downstream`,'saw.txt'),'utf8')).toBe('upstream');
    // 合并顺序：上游先合，越级合并被拒且不改状态
    await expect(cli(root,['task','merge',String(downstream.id)])).rejects.toThrow('is not merged into');
    expect((await client.request('task.inspect',{id:downstream.id})).integration).toBe('pending');
    await cli(root,['task','merge',String(upstream.id)]);
    await cli(root,['task','merge',String(downstream.id)]);
    expect(fs.readFileSync(path.join(root,'file.txt'),'utf8')).toBe('upstream\n');
    expect(fs.readFileSync(path.join(root,'other.txt'),'utf8')).toBe('downstream\n');
    expect((await client.request('task.inspect',{id:downstream.id})).integration).toBe('merged');
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);
