import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, done, workOf } from './harness.js';

test('pi subprocess receives project/task capability, pinned CLI, persistent session path and performs delegation', async () => {
  const root = temp();
  const fake = path.join(root,'fake-pi');
  await repo(root);
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const file = path.join(process.env.LUSH_HOME,'sessions','task-'+process.env.LUSH_TASK_ID+'-input.md');
const context = JSON.parse(fs.readFileSync(file,'utf8'));
const systemFile = args[args.indexOf('--append-system-prompt')+1];
const prompt = fs.readFileSync(systemFile,'utf8');
fs.appendFileSync(path.join(process.env.LUSH_HOME,'seen.jsonl'),JSON.stringify({args, cwd:process.cwd(), project:process.env.LUSH_PROJECT, token:!!process.env.LUSH_AGENT_TOKEN, task:context.task, sharedEnv:process.env.TEST_SHARED, roleEnv:process.env.TEST_ROLE, promptRole:prompt.includes('角色：'+context.task.role), promptHasWorkerInstructions:prompt.includes('角色：worker')})+'\\n');
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
    const agentDir = path.join(root, '.lush', 'agent'); fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.env'), 'TEST_SHARED=common\n');
    fs.writeFileSync(path.join(agentDir, 'planner.env'), 'TEST_ROLE=planner-only\n');
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','run']);
    const client = new UIClient(Config.fromEnv(env(),root));
    const result = await done(client,input.task.id);
    expect(result.status).toBe('completed');
    expect(result.agent).toMatchObject({ id: `planner#${input.task.id}`, role: 'planner', active: false, pid: null });
    expect(result.agent.wakes).toBeGreaterThan(0);
    expect(result.agent.last_seen_at).toBeTruthy();
    // runtime 直接把 Plan 编译成 root research work。
    const research = (await workOf(client, input.task.id)).find(task => task.role === 'research');
    expect(research.goal).toBe('delegated via pinned CLI');
    expect(research.parent_id).toBeNull();
    expect((await done(client, research.id)).status).toBe('completed');
    const seen = fs.readFileSync(path.join(root,'.lush','seen.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(row => row.project === root && row.token && row.sharedEnv === 'common' && row.promptRole)).toBe(true);
    const plannerSeen = seen.find(row => row.task.role === 'planner');
    expect(plannerSeen.roleEnv).toBe('planner-only');
    expect(plannerSeen.promptHasWorkerInstructions).toBe(false);
    expect(seen.filter(row => row.task.role !== 'planner').every(row => row.roleEnv === undefined)).toBe(true);
    const sessions = seen.filter(row => row.task.id === input.task.id).map(row => row.args[row.args.indexOf('--session-id')+1]);
    expect(new Set(sessions).size).toBe(1);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 30000);
