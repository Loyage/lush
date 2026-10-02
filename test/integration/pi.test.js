import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, idle } from './harness.js';

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
fs.appendFileSync(path.join(process.env.LUSH_HOME,'seen.jsonl'),JSON.stringify({args, cwd:process.cwd(), project:process.env.LUSH_PROJECT, token:!!process.env.LUSH_AGENT_TOKEN, task:context.task, sharedEnv:process.env.TEST_SHARED, promptRole:prompt.includes('角色：'+context.task.role), promptHasWorkerInstructions:prompt.includes('角色：worker')})+'\\n');
if(context.task.task_kind === 'say') {
 const proc = Bun.spawn(['lush','worker','spawn','delegated via pinned CLI','--name','delegated-work','--json'],{stdout:'pipe',stderr:'pipe'});
 const out = await new Response(proc.stdout).text(), err = await new Response(proc.stderr).text();
 if(await proc.exited) throw new Error(err); console.log(out);
}
console.log('fake pi completed');
`, { mode:0o755 });
  try {
    const agentDir = path.join(root, '.lush', 'agent'); fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.env'), 'TEST_SHARED=common\n');
    await cli(root,['start'], { LUSH_PROVIDER:'pi', LUSH_PI_COMMAND:fake });
    const input = await cli(root,['say','run']);
    const client = new UIClient(Config.fromEnv(env(),root));
    const say = await idle(client,input.task.id);
    // A say Task stays idle after an ordinary return; it is not completed by it.
    expect(say.status).toBe('waiting');
    expect(say.agent).toMatchObject({ id: `agent#${input.task.id}`, role: 'agent', active: false, pid: null });
    expect(say.agent.wakes).toBeGreaterThan(0);
    expect(say.agent.last_seen_at).toBeTruthy();
    const children = (await client.request('worker.list')).filter(task => task.parent_id === input.task.id && task.task_kind === 'child');
    expect(children).toHaveLength(1);
    expect(children[0].goal).toBe('delegated via pinned CLI');
    await idle(client, children[0].id);
    const seen = fs.readFileSync(path.join(root,'.lush','seen.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(row => row.project === root && row.token && row.sharedEnv === 'common' && row.promptRole)).toBe(true);
    const saySeen = seen.find(row => row.task.id === input.task.id);
    expect(saySeen.promptHasWorkerInstructions).toBe(false);
    const sessions = seen.filter(row => row.task.id === input.task.id).map(row => row.args[row.args.indexOf('--session-id')+1]);
    expect(new Set(sessions).size).toBe(1);
  } finally { await cli(root,['stop']).catch(() => {}); fs.rmSync(root,{recursive:true,force:true}); }
}, 30000);
