import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/identity.js';
import { temp, env, until, repo, git } from './helpers.js';
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
 const proc = Bun.spawn(['lush','task','spawn','delegated via pinned CLI','--role','research','--json'],{stdout:'pipe',stderr:'pipe'});
 const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
 if(await proc.exited) throw new Error(err); console.log(out);
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
    const seen = fs.readFileSync(path.join(root,'.lush','seen.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every(row => row.project === root && row.token)).toBe(true);
    const sessions = seen.filter(row => row.task.id === input.task.id).map(row => row.args[row.args.indexOf('--session-id')+1]);
    expect(new Set(sessions).size).toBe(1);
    expect((await client.request('task.tree'))[0].children[0].goal).toBe('delegated via pinned CLI');
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 30000);

test('task verify runs a read-only verifier that demonstrates the worktree against the target branch', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.LUSH_HOME,'sessions','task-'+process.env.LUSH_TASK_ID+'-input.md');
const context = JSON.parse(fs.readFileSync(file,'utf8'));
const task = context.task;
const git = (...args) => { const proc = Bun.spawnSync(['git',...args]); if (proc.exitCode) throw new Error(proc.stderr.toString()); };
if (task.role === 'planner' && task.calls === 1) {
  const proc = Bun.spawn(['lush','task','spawn','add a greeting','--name','add-greeting','--role','worker','--json'],{stdout:'pipe',stderr:'pipe'});
  const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
  if (await proc.exited) throw new Error(err);
} else if (task.role === 'worker') {
  fs.writeFileSync('greeting.txt','hi\\n');
  git('add','greeting.txt'); git('commit','-qm','add greeting');
} else if (task.role === 'verifier') {
  const v = context.verification;
  const inChange = fs.existsSync(path.join(v.workspace,'greeting.txt'));
  const inBaseline = fs.existsSync(path.join(v.baseline_workspace,'greeting.txt'));
  fs.mkdirSync(path.dirname(v.report_path),{recursive:true});
  fs.writeFileSync(v.report_path, '<!doctype html><title>verify</title><p>change='+inChange+' baseline='+inBaseline+'</p>');
}
console.log('fake pi completed');
`, { mode:0o755 });
  await repo(root);
  try {
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','add a greeting']);
    const client = new UIClient(Config.fromEnv(env(),root));
    expect((await done(client,input.task.id)).status).toBe('completed');
    const worker = (await client.request('task.list',{})).find(task => task.role === 'worker');
    // 开发完成但还没合并：主工作树里没有这次改动。
    expect(fs.existsSync(path.join(root,'greeting.txt'))).toBe(false);
    const verification = await cli(root,['task','verify',String(worker.id)]);
    expect(verification).toMatchObject({ role:'verifier', verifies_task_id: worker.id, parent_id: null });
    expect((await done(client, verification.id)).status).toBe('completed');
    for (let i=0;i<100 && (await client.request('task.inspect',{id:verification.id})).baseline_workspace !== null;i++) await Bun.sleep(30);
    const settled = await client.request('task.inspect',{id:verification.id});
    expect(settled.baseline_workspace).toBeNull();
    expect(settled.baseline_commit).toBeTruthy();
    const report = path.join(root,'.lush','verify',String(verification.id),'report.html');
    expect(fs.readFileSync(report,'utf8')).toContain('change=true baseline=false');
    const inspected = await client.request('task.inspect',{id:worker.id});
    expect(inspected.verifications[0]).toMatchObject({ id: verification.id, status:'completed', has_report:true });
    expect(inspected.report).toBeNull();
    expect((await client.request('task.tree',{id:worker.id})).children.map(child => child.id)).toEqual([verification.id]);
    // verifier 只读：主工作树与 worker 分支都没有新提交。
    expect(await client.request('task.inspect',{id:worker.id})).toMatchObject({ status:'completed', integration:'pending' });
    expect(fs.existsSync(path.join(root,'greeting.txt'))).toBe(false);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);

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
const task = JSON.parse(fs.readFileSync(file,'utf8')).task;
const git = (...args) => { const proc = Bun.spawnSync(['git',...args]); if (proc.exitCode) throw new Error(proc.stderr.toString()); };
if (task.role === 'planner') {
  if (task.calls === 1) {
    const spawn = async (goal, ...flags) => {
      const proc = Bun.spawn(['lush','task','spawn',goal,'--name',flags.length ? 'stacked-downstream' : 'stacked-upstream','--role','worker',...flags,'--json'],{stdout:'pipe',stderr:'pipe'});
      const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
      if (await proc.exited) throw new Error(err);
      return JSON.parse(out);
    };
    const upstream = await spawn('upstream change');
    await spawn('downstream change','--depends-on',String(upstream.id));
  }
} else if (task.goal === 'upstream change') {
  fs.writeFileSync('file.txt','upstream\\n');
  git('add','file.txt'); git('commit','-qm','upstream work');
} else {
  fs.writeFileSync('saw.txt', fs.readFileSync('file.txt','utf8').trim());
  fs.writeFileSync('other.txt','downstream\\n');
  git('add','saw.txt','other.txt'); git('commit','-qm','downstream work');
}
console.log('fake pi completed');
`;

const MERGE_PI = `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.LUSH_HOME,'sessions','task-'+process.env.LUSH_TASK_ID+'-input.md');
const context = JSON.parse(fs.readFileSync(file,'utf8'));
const task = context.task;
async function run(...args) {
  const proc = Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});
  const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
  return { code: await proc.exited, out, err };
}
const git = (...args) => run('git','-C',process.cwd(),...args);
if (task.role === 'planner') {
  if (task.calls === 1) {
    const spawned = await run('lush','task','spawn','改同一个文件','--role','worker','--name','conflict-worker','--json');
    if (spawned.code) throw new Error(spawned.err);
  }
} else if (task.role === 'worker') {
  fs.writeFileSync(path.join(process.cwd(),'file.txt'),'worker\\n');
  await git('add','-A'); await git('commit','-m','worker change');
} else if (task.role === 'merger') {
  // 真的并进来、解冲突、提交这次 merge：git 返回冲突是预期的。
  await git('merge',context.merge_conflict.commit);
  fs.writeFileSync(path.join(process.cwd(),'file.txt'),'resolved\\n');
  await git('add','-A'); await git('commit','-m','resolve conflict');
}
console.log('fake pi done ' + task.role);
`;

test('a real conflict becomes a notice plus a merger task, and lands with --ff-only', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, MERGE_PI, { mode:0o755 });
  try {
    await repo(root);
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','改同一个文件']);
    const client = new UIClient(Config.fromEnv(env(),root));
    // planner 只在子任务全部结算后才会完成，所以这一刻 worker 已经是终态。
    await done(client,input.task.id);
    const worker = (await client.request('task.list',{})).find(task => task.role === 'worker');
    expect(worker.status).toBe('completed');
    // 主树在同名文件上继续前进：合并必然内容冲突。
    fs.writeFileSync(path.join(root,'file.txt'),'main\n');
    await git(root,'add','-A'); await git(root,'commit','-m','main moves on');
    const mainHead = await git(root,'rev-parse','HEAD');

    // 批准合并：冲突不走错误通道，而是带着冲突文件与解冲突任务回来。
    const merged = await cli(root,['task','merge',String(worker.id)]);
    expect(merged.integration).toBe('conflict');
    expect(merged.merge).toMatchObject({ status:'conflict', files:['file.txt'] });
    expect(await git(root,'rev-parse','HEAD')).toBe(mainHead);
    expect(await git(root,'status','--porcelain')).toBe('');
    // 请示真的存在，且挂在那个人还没答应的解冲突任务上。
    const notice = (await cli(root,['notices'])).find(row => row.status === 'open');
    expect(notice.task_id).toBe(merged.merge.resolution_task_id);
    expect(notice.body).toContain('file.txt');
    expect((await cli(root,['status'])).merge_freeze)
      .toEqual([{ task_id: worker.id, target_branch:'main', resolves_task_id: merged.merge.resolution_task_id }]);

    // 答复 → 解冲突任务开工 → 完成后用 --ff-only 落地，两个任务一起变成已合并。
    await cli(root,['answer',String(notice.id),'批准，开始解冲突']);
    const resolution = await done(client, merged.merge.resolution_task_id);
    expect(resolution.integration).toBe('pending');
    const landed = await cli(root,['task','merge',String(resolution.id)]);
    expect(landed.merge).toEqual({ status:'resolved', resolved_task_id: worker.id });
    expect((await client.request('task.inspect',{id:worker.id})).integration).toBe('merged');
    expect(await git(root,'rev-parse','HEAD')).toBe(resolution.head_commit);
    expect(fs.readFileSync(path.join(root,'file.txt'),'utf8')).toBe('resolved\n');
    expect((await cli(root,['status'])).merge_freeze).toEqual([]);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);

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
    const children = (await client.request('task.list',{})).filter(task => task.parent_id === batch.task.id).sort((a,b) => a.id - b.id);
    const [upstream, downstream] = children;
    expect(downstream.deps).toEqual([{ id: upstream.id, kind:'code', status:'completed' }]);
    expect(upstream.blocked).toBe(false);
    const [fullUpstream, fullDownstream] = [await client.request('task.inspect',{id:upstream.id}), await client.request('task.inspect',{id:downstream.id})];
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
