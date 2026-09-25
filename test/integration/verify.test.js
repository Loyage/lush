import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env, repo } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, legacySay, done, workOf } from './harness.js';

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
  const proc = Bun.spawn(['lush','spec','add','add a greeting','--name','add-greeting','--role','worker','--json'],{stdout:'pipe',stderr:'pipe'});
  const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
  if (await proc.exited) throw new Error(err);
} else if (task.role === 'scheduler') {
  for (const spec of context.specs.filter(s => s.status === 'pending')) {
    const proc = Bun.spawn(['lush','task','spawn',spec.goal,'--role',spec.role,'--name',spec.name,'--spec',String(spec.id),'--json'],{stdout:'pipe',stderr:'pipe'});
    const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
    if (await proc.exited) throw new Error(err);
  }
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
    const input = await legacySay(root, 'add a greeting');
    const client = new UIClient(Config.fromEnv(env(),root));
    expect((await done(client,input.task.id)).status).toBe('completed');
    // planner 只写 Plan；runtime 直接编译 worker，不产生 scheduler invocation。
    const worker = (await workOf(client, input.task.id)).find(task => task.role === 'worker');
    expect(worker).toBeTruthy();
    expect((await done(client, worker.id)).status).toBe('completed');
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
    // Auto-integration and this explicit legacy verification may race; the changed worktree must contain the result,
    // while the baseline truthfully records whichever direct-parent commit was pinned for that verifier.
    expect(fs.readFileSync(report,'utf8')).toContain('change=true baseline=');
    const inspected = await client.request('task.inspect',{id:worker.id});
    expect(inspected.verifications[0]).toMatchObject({ id: verification.id, status:'completed', has_report:true });
    expect(inspected.report).toBeNull();
    expect((await client.request('task.tree',{id:worker.id})).children.map(child => child.id)).toEqual([verification.id]);
    // verifier 只读：主工作树与 worker 分支都没有新提交。
    expect(await client.request('task.inspect',{id:worker.id})).toMatchObject({ status:'completed', integration:'merged' });
    expect(fs.existsSync(path.join(root,'greeting.txt'))).toBe(false);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);
