import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, done, schedulerOf } from './harness.js';

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
    const scheduler = await schedulerOf(client, input.task.id);
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
