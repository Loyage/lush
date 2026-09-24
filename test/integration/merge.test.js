import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env, repo, git } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, done, workOf } from './harness.js';

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
} else if (context.task.role === 'verifier') {
  const v = context.verification;
  fs.mkdirSync(path.dirname(v.report_path),{recursive:true});
  fs.writeFileSync(v.report_path,'<!doctype html><title>candidate</title><p>ok</p>');
  fs.writeFileSync(v.evidence_path,JSON.stringify({schema_version:1,status:'pass',summary:'candidate verified',
    commands:[{command:'git diff --check',exit_code:0,baseline_exit_code:0,summary:'both trees are clean'}],
    failures:[],unverified:[],baseline_failures:[],residual_risks:[]}));
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
  // 父分支先进入子侧；git 返回冲突是预期的。
  await git('merge',context.branch_sync?.parent_commit || context.merge_conflict.commit);
  fs.writeFileSync(path.join(process.cwd(),'file.txt'),'resolved\\n');
  await git('add','-A'); await git('commit','-m','resolve conflict');
}
console.log('fake pi done ' + task.role);
`;

test('a diverged input branch resolves on the child side, then lands through two fast-forwards', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, MERGE_PI, { mode:0o755 });
  try {
    await repo(root);
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','改同一个文件']);
    const client = new UIClient(Config.fromEnv(env(),root));
    // planner 只写 Plan；runtime 直接编译 worker。
    await done(client,input.task.id);
    const worker = (await workOf(client, input.task.id)).find(task => task.role === 'worker');
    expect(worker).toBeTruthy();
    expect((await done(client, worker.id)).status).toBe('completed');
    for (let i=0;i<200 && (await client.request('task.inspect',{id:worker.id})).integration !== 'merged';i++) await Bun.sleep(30);
    // 自动中间集成只冻结 pending 候选，不会擅自启动 verifier。
    for (let i=0;i<400;i++) {
      const candidate = (await client.request('candidate.list',{input:input.id}))[0];
      if (candidate?.status === 'pending') break;
      await Bun.sleep(30);
    }
    expect((await client.request('task.list')).filter(task => task.role === 'verifier')).toHaveLength(0);
    // 主树在同名文件上继续前进：最终 Candidate 与目标分支必然内容冲突。
    fs.writeFileSync(path.join(root,'file.txt'),'main\n');
    await git(root,'add','-A'); await git(root,'commit','-m','main moves on');
    const mainHead = await git(root,'rev-parse','HEAD');

    // runtime 已自动把 worker 聚合进私有 Intent 分支；用户目标分支仍完全不动。
    expect((await client.request('task.inspect',{id:worker.id})).integration).toBe('merged');
    expect(await git(root,'rev-parse','HEAD')).toBe(mainHead);

    // 输入分支与 main 已分歧：直接 merge 只报告，不在 main 上 no-ff；sync 在子侧解决冲突。
    const diverged = await cli(root,['branch','merge',input.anchor.branch]);
    expect(diverged).toMatchObject({ status:'diverged', needs_sync:true, parent:'main' });
    const queued = await cli(root,['branch','sync',input.anchor.branch]);
    const resolution = await done(client, queued.task.id);
    expect(resolution.integration).toBe('pending');
    await cli(root,['branch','merge',resolution.branch]);
    const landed = await cli(root,['branch','merge',input.anchor.branch]);
    expect(landed).toMatchObject({ status:'integrated', merged:true, parent:'main' });
    expect(await git(root,'rev-parse','HEAD')).toBe(resolution.head_commit);
    expect(fs.readFileSync(path.join(root,'file.txt'),'utf8')).toBe('resolved\n');
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);

test('a draft becomes a planner, and a code dependency stacks worktrees with an ordered merge', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, STACKED_PI, { mode:0o755 });
  await repo(root);
  const settle = async id => { for (let i=0;i<200;i++) { const task = await (new UIClient(Config.fromEnv(env(),root))).request('task.inspect',{id}); if (['completed','failed'].includes(task.status)) return task; await Bun.sleep(50); } throw new Error('task timeout'); };
  try {
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    await cli(root,['draft','add','实现搜索键盘导航与筛选器组件']);
    const committed = await cli(root,['draft','commit']);
    expect(committed.inputs).toHaveLength(1);
    expect(committed.inputs[0].content).toBe('实现搜索键盘导航与筛选器组件');
    const inputId = committed.inputs[0].id;
    const client = new UIClient(Config.fromEnv(env(),root));
    expect((await settle(committed.inputs[0].task.id)).status).toBe('completed');
    // planner 写 Plan，runtime 直接编译两个带 code 依赖的 WorkItem。
    let workers = [];
    for (let i=0;i<200 && workers.length<2;i++) {
      workers = (await client.request('task.list',{})).filter(task => task.role === 'worker').sort((a,b) => a.id - b.id);
      if (workers.length < 2) await Bun.sleep(30);
    }
    expect(workers).toHaveLength(2);
    const [upstream, downstream] = workers;
    expect((await settle(upstream.id)).status).toBe('completed');
    expect((await settle(downstream.id)).status).toBe('completed');
    expect((await client.request('task.list')).some(task => task.role === 'scheduler')).toBe(false);
    const [fullUpstream, fullDownstream] = [await client.request('task.inspect',{id:upstream.id}), await client.request('task.inspect',{id:downstream.id})];
    expect(fullDownstream.deps.map(dep => ({ id: dep.id, kind: dep.kind, status: dep.status }))).toEqual([{ id: upstream.id, kind:'code', status:'completed' }]);
    expect(upstream.blocked).toBe(false);
    expect(fullDownstream.base_commit).toBe(fullUpstream.head_commit);
    // 主工作树没有上游的改动，但下游的 worktree 是从上游分支拉出来的
    expect(fs.readFileSync(path.join(root,'file.txt'),'utf8')).toBe('base\n');
    expect(fs.readFileSync(path.join(root,'.lush','worktrees',`${downstream.id}-stacked-downstream`,'saw.txt'),'utf8')).toBe('upstream');
    // Integration Service 叶子优先自动聚合下游 → 上游 → Intent branch；最终仍由用户接受 Candidate。
    expect(fullDownstream.target_branch).toBe(fullUpstream.branch);
    for (let i=0;i<200;i++) {
      const states = await Promise.all([upstream.id,downstream.id].map(id => client.request('task.inspect',{id})));
      if (states.every(task => task.integration === 'merged')) break;
      await Bun.sleep(30);
    }
    expect(fs.existsSync(path.join(root,'other.txt'))).toBe(false);
    let candidate = null;
    for (let i=0;i<200;i++) {
      candidate = (await client.request('candidate.list',{input:inputId}))[0] ?? null;
      if (candidate?.status === 'pending') break;
      await Bun.sleep(30);
    }
    expect(candidate?.status).toBe('pending');
    await cli(root,['candidate','verify',String(candidate.id)]);
    for (let i=0;i<200;i++) {
      candidate = (await client.request('candidate.list',{input:inputId}))[0] ?? null;
      if (candidate?.status === 'ready') break;
      await Bun.sleep(30);
    }
    expect(candidate?.status).toBe('ready');
    await cli(root,['candidate','accept',String(candidate.id)]);
    expect(fs.readFileSync(path.join(root,'file.txt'),'utf8')).toBe('upstream\n');
    expect(fs.readFileSync(path.join(root,'other.txt'),'utf8')).toBe('downstream\n');
    expect((await client.request('task.inspect',{id:downstream.id})).integration).toBe('merged');
    // CLI：草稿可改，也能按 id 只提交选中的几条，未选中的留在缓存
    const keep = await cli(root,['draft','add','这条留着']);
    const pick = await cli(root,['draft','add','只提交这条']);
    const edited = await cli(root,['draft','edit',String(pick.id),'只提交这条（改过）']);
    expect(edited).toMatchObject({ id: pick.id, content: '只提交这条（改过）' });
    const partial = await cli(root,['draft','commit',String(pick.id)]);
    expect(partial.inputs[0].content).toBe('只提交这条（改过）');
    expect(partial.drafts).toEqual([pick.id]);
    expect((await cli(root,['draft','list'])).map(draft => draft.id)).toEqual([keep.id]);
    await settle(partial.inputs[0].task.id);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);
