import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { AGENT_CAPABILITIES } from '../../src/agent/capabilities.js';
import { cli, idle, emittedTask } from './harness.js';
import { bindMockPiSource } from './pi-runtime-fixture.js';

test('result-notice Skill reaches the real info API without parking', async () => {
  const root = temp(), device = temp(), extra = { LUSH_GLOBAL_CONFIG: device };
  const fake = path.join(root, 'fake-pi');
  const report = AGENT_CAPABILITIES.find(entry => entry.id === 'result-notice');
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), home = process.env.LUSH_HOME;
if (!args.includes(${JSON.stringify(report.skill)})) throw new Error('missing result-notice Skill');
const guide = Bun.spawnSync(['lushw', 'skills', 'show', 'result-notice']);
if (guide.exitCode || !guide.stdout.toString().includes('notify 固定发送 info')) throw new Error('missing guide');
const child = Bun.spawn(['lushw', 'self', 'notice', 'notify', 'Analysis result', '--body', 'Conclusion: inspected; no code changes.', '--json'], {stdout:'pipe',stderr:'pipe'});
const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
if (code) throw new Error(err);
fs.writeFileSync(path.join(home, 'info-receipt.json'), out);
console.log('result provider continued normally');
`, { mode: 0o755 });
  try {
    await repo(root);
    await cli(root, ['daemon', 'start'], { ...extra, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake });
    await bindMockPiSource(root, extra);
    const client = new UIClient(Config.fromEnv(env(extra), root));
    const task = await emittedTask(client, await cli(root, ['order', '只分析代码；做好了告诉我'], extra));
    const result = await idle(client, task.id);
    expect(result.error).toBeNull(); expect(result.status).toBe('waiting');
    expect(result.result).toContain('result provider continued normally');
    const notice = JSON.parse(fs.readFileSync(path.join(root, '.lush', 'info-receipt.json'), 'utf8')).data;
    expect(notice).toMatchObject({ task_id: task.id, kind: 'info', status: 'sent', lifecycle_type: null, read_at: null });
    expect(notice.source_event_id).toBeGreaterThan(0);
    expect((await client.request('notice.page', { status: 'unread' })).notices.some(row => row.id === notice.id)).toBe(true);
    expect((await client.request('notice.read', { id: notice.id })).read_at).toBeTruthy();
  } finally {
    await cli(root, ['daemon', 'stop'], extra).catch(() => {});
    for (const dir of [root, device]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
