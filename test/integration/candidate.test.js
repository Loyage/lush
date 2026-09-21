import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env, repo, git } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, done } from './harness.js';

// End-to-end proof of the new main line: Intent → Plan → compiled Work → auto integration inside the
// private Intent branch → frozen Review Candidate → user acceptance into the target branch.
const CANDIDATE_PI = `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.LUSH_HOME,'sessions','task-'+process.env.LUSH_TASK_ID+'-input.md');
const context = JSON.parse(fs.readFileSync(file,'utf8'));
const task = context.task;
const git = (...args) => { const proc = Bun.spawnSync(['git',...args]); if (proc.exitCode) throw new Error(proc.stderr.toString()); };
if (task.role === 'planner' && task.calls === 1) {
  const proc = Bun.spawn(['lush','spec','add','add greeting','--role','worker','--name','add-greeting','--json'],{stdout:'pipe',stderr:'pipe'});
  const err = await new Response(proc.stderr).text();
  if (await proc.exited) throw new Error(err);
} else if (task.role === 'worker') {
  fs.writeFileSync('greeting.txt','hi\\n');
  git('add','greeting.txt'); git('commit','-qm','add greeting');
} else if (task.role === 'verifier') {
  const v = context.verification;
  const changed = fs.existsSync(path.join(v.workspace,'greeting.txt'));
  const baseline = fs.existsSync(path.join(v.baseline_workspace,'greeting.txt'));
  fs.mkdirSync(path.dirname(v.report_path),{recursive:true});
  fs.writeFileSync(v.report_path, '<!doctype html><title>candidate</title><p>changed='+changed+' baseline='+baseline+'</p>');
}
console.log('candidate pi done ' + task.role);
`;

test('an Intent compiles to work, auto-integrates privately, then a frozen Candidate lands on acceptance', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, CANDIDATE_PI, { mode:0o755 });
  await repo(root);
  try {
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','add greeting']);
    const client = new UIClient(Config.fromEnv(env(),root));
    expect((await done(client,input.task.id)).status).toBe('completed');

    // No scheduler task exists; the Plan is compiled straight into a root worker.
    const tasks = await client.request('task.list');
    expect(tasks.some(task => task.role === 'scheduler')).toBe(false);
    const worker = tasks.find(task => task.role === 'worker');
    expect(worker).toBeTruthy();
    expect(worker.parent_id).toBeNull();
    expect((await done(client, worker.id)).status).toBe('completed');

    // Auto integration moves the work into the private Intent branch, not into main.
    for (let i=0;i<400;i++) {
      const state = await client.request('task.inspect',{id:worker.id});
      if (state.integration === 'merged') break;
      await Bun.sleep(30);
    }
    expect(fs.existsSync(path.join(root,'greeting.txt'))).toBe(false);

    // The runtime freezes the integration commit and produces a reviewable candidate with a report.
    let candidate = null;
    for (let i=0;i<400;i++) {
      candidate = (await client.request('candidate.list',{input:input.id}))[0] ?? null;
      if (candidate && ['ready','failed'].includes(candidate.status)) break;
      await Bun.sleep(30);
    }
    expect(candidate?.status).toBe('ready');
    expect(candidate.report_task_id).toBeGreaterThan(0);
    // Verifier 把自包含报告写到磁盘；Web 路由只把它作为独立文档发出去（路由本身在 web/security.test.js 覆盖）。
    const reportFile = path.join(root,'.lush','verify',String(candidate.report_task_id),'report.html');
    const html = fs.readFileSync(reportFile,'utf8');
    expect(html).toContain('changed=true baseline=false');

    // Acceptance re-checks the pinned commit and only then moves the target branch.
    const accepted = await cli(root,['candidate','accept',String(candidate.id)]);
    expect(accepted.candidate.status).toBe('integrated');
    expect(fs.readFileSync(path.join(root,'greeting.txt'),'utf8')).toBe('hi\n');
    expect(await git(root,'rev-parse','main')).toBe(candidate.commit_hash);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);

test('requesting changes keeps the reviewed version and starts a new planner for the same Intent', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  fs.writeFileSync(fake, CANDIDATE_PI, { mode:0o755 });
  await repo(root);
  try {
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','add greeting']);
    const client = new UIClient(Config.fromEnv(env(),root));
    await done(client,input.task.id);
    const worker = (await client.request('task.list')).find(task => task.role === 'worker');
    await done(client, worker.id);
    let candidate = null;
    for (let i=0;i<400;i++) {
      candidate = (await client.request('candidate.list',{input:input.id}))[0] ?? null;
      if (candidate?.status === 'ready') break;
      await Bun.sleep(30);
    }
    expect(candidate.status).toBe('ready');

    // The user asks for changes: the reviewed version is kept, and a new planner owns the same Intent.
    const revision = await cli(root,['candidate','changes',String(candidate.id),'按钮再明显一点']);
    expect(revision.candidate.status).toBe('changes_requested');
    const intents = await client.request('input.list');
    expect(intents[0].task_id).not.toBe(input.task.id);
    const fresh = await client.request('task.inspect',{id:intents[0].task_id});
    expect(fresh.role).toBe('planner');
    expect(fresh.input_id).toBe(input.id);
    // The old candidate can no longer be accepted.
    await expect(cli(root,['candidate','accept',String(candidate.id)])).rejects.toThrow();
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 40000);
