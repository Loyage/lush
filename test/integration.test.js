import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/identity.js';
import { temp, env, until } from './helpers.js';
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
    const seen = fs.readFileSync(path.join(root,'.lush','seen.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every(row => row.project === root && row.token)).toBe(true);
    const sessions = seen.filter(row => row.task.id === input.task.id).map(row => row.args[row.args.indexOf('--session-id')+1]);
    expect(new Set(sessions).size).toBe(1);
    expect((await client.request('task.tree'))[0].children[0].goal).toBe('delegated via pinned CLI');
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
