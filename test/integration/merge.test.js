import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env, repo, git } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, done, schedulerOf } from './harness.js';

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
    const queued = await run('lush','spec','add','改同一个文件','--role','worker','--name','conflict-worker','--json');
    if (queued.code) throw new Error(queued.err);
  }
} else if (task.role === 'scheduler') {
  for (const spec of context.specs.filter(s => s.status === 'pending')) {
    const spawned = await run('lush','task','spawn',spec.goal,'--role',spec.role,'--name',spec.name,'--spec',String(spec.id),'--json');
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
    // planner 只写 spec；等 scheduler 把整批 spec 编成任务并收尾，这一刻 worker 才是终态。
    await done(client,input.task.id);
    const scheduler = await schedulerOf(client, input.task.id);
    expect(scheduler).toBeTruthy();
    expect((await done(client, scheduler.id)).status).toBe('completed');
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
    // planner 写 spec，scheduler 串行把它们编成任务并在子任务全部终态后收尾（同一轮拆解是同一批）
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
      const row = (await client.request('input.list')).find(intent => intent.task_id === batch.task.id);
      schedulers = row?.scheduler_id ? [await client.request('task.inspect',{id:row.scheduler_id})] : [];
      if (schedulers.length && schedulers.every(task => ['completed','failed'].includes(task.status))) break;
      await Bun.sleep(30);
    }
    expect(schedulers.length).toBeGreaterThanOrEqual(1);
    expect(schedulers.every(task => task.status === 'completed')).toBe(true);
    const [fullUpstream, fullDownstream] = [await client.request('task.inspect',{id:upstream.id}), await client.request('task.inspect',{id:downstream.id})];
    expect(fullDownstream.deps.map(dep => ({ id: dep.id, kind: dep.kind, status: dep.status }))).toEqual([{ id: upstream.id, kind:'code', status:'completed' }]);
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
    // CLI：草稿可改，也能按 id 只提交选中的几条，未选中的留在缓存
    const keep = await cli(root,['draft','add','这条留着']);
    const pick = await cli(root,['draft','add','只提交这条']);
    const edited = await cli(root,['draft','edit',String(pick.id),'只提交这条（改过）']);
    expect(edited).toMatchObject({ id: pick.id, content: '只提交这条（改过）' });
    const partial = await cli(root,['draft','commit',String(pick.id)]);
    expect(partial.content).toBe('只提交这条（改过）');
    expect(partial.drafts).toEqual([pick.id]);
    expect((await cli(root,['draft','list'])).map(draft => draft.id)).toEqual([keep.id]);
    await settle(partial.task.id);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);
