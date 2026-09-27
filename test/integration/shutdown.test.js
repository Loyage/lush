import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, until } from '../helpers.js';
import { cli } from './harness.js';

test('shutdown kills pi process group, preserves task as failed, and restart does not replay it', async () => {
  const root = temp(), fake = path.join(root,'fake-pi');
  await repo(root);
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
