import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { AGENT_CAPABILITIES } from '../../src/agent/capabilities.js';
import { cli, idle, emittedTask } from './harness.js';
import { bindMockPiSource } from './pi-runtime-fixture.js';

// Controlled Provider, real pinned CLI + invocation token + daemon dispatcher + SQLite.
// No paid model, mocked RPC, or mutation of the developer's project/settings.
test('result-notice Skill reaches the real info API without parking, and next invocation obeys the device switch', async () => {
  const root = temp(), device = temp(), extra = { LUSH_GLOBAL_CONFIG: device };
  const fake = path.join(root, 'fake-pi');
  const report = AGENT_CAPABILITIES.find(entry => entry.id === 'result-notice');
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { Config } from ${JSON.stringify(fileURLToPath(new URL('../../src/config.js', import.meta.url)))};
import { UIClient } from ${JSON.stringify(fileURLToPath(new URL('../../src/ui/client.js', import.meta.url)))};
const args = process.argv.slice(2), home = process.env.LUSH_HOME;
const input = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'task-'+process.env.LUSH_TASK_ID+'-input.md'), 'utf8'));
const prompt = fs.readFileSync(args[args.indexOf('--append-system-prompt')+1], 'utf8');
const enabled = args.includes(${JSON.stringify(report.skill)});
const client = new UIClient(Config.fromEnv(process.env, process.env.LUSH_PROJECT), process.env.LUSH_AGENT_TOKEN);
async function command(args) {
 const proc = Bun.spawn(['lushw', ...args], { stdout: 'pipe', stderr: 'pipe' });
 const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
 if (code) throw new Error(err); return out;
}
async function refused(params, message) {
 try { await client.request('notice.post', params); } catch (error) { if (error.message.includes(message)) return; throw error; }
 throw new Error('invalid post unexpectedly succeeded');
}
if (enabled) {
 const listed = JSON.parse(await command(['skills', 'list', '--json']));
 if (!JSON.stringify(listed).includes('result-notice')) throw new Error('missing guide registration');
 const guide = await command(['skills', 'get', 'result-notice']);
 if (!guide.includes('--kind info') || !prompt.includes('不能只写最终回答')) throw new Error('missing guidance');
 await refused({task: input.parent.id, title: 'Cross-worker', kind: 'info'}, 'only for their own worker');
 await refused({title: 'Bad kind', kind: 'plan'}, 'question or info');
 await refused({title: 'Bad questions', kind: 'info', questions: []}, 'cannot contain a questionnaire');
 const before = await client.request('worker.inspect', {id: input.task.id});
 const notice = JSON.parse(await command(['notice', 'post', 'Analysis result', '--kind', 'info', '--body', 'Conclusion: inspected; no code changes.', '--json']));
 const after = await client.request('worker.inspect', {id: input.task.id});
 if (before.status !== 'running' || after.status !== 'running' || !after.agent.active || notice.kind !== 'info' || notice.status !== 'sent') throw new Error('info parked or changed the invocation');
 fs.writeFileSync(path.join(home, 'info-receipt.json'), JSON.stringify(notice));
} else if (!prompt.includes('已关闭：result-notice') || prompt.includes('lushw skills get result-notice')) throw new Error('disabled guidance still injected');
fs.appendFileSync(path.join(home, 'notice-invocations.jsonl'), JSON.stringify({enabled, calls: input.task.calls, continued: true})+'\\n');
console.log('result provider continued normally');
`, { mode: 0o755 });
  try {
    await repo(root);
    await cli(root, ['start'], { ...extra, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake });
    await bindMockPiSource(root, extra);
    const client = new UIClient(Config.fromEnv(env(extra), root));
    const task = await emittedTask(client, await cli(root, ['order', '只分析代码；做好了告诉我'], extra));
    const first = await idle(client, task.id);
    expect(first.error).toBeNull();
    expect(first.notices.some(notice => notice.status === 'open')).toBe(false);
    const notice = JSON.parse(fs.readFileSync(path.join(root, '.lush', 'info-receipt.json'), 'utf8'));
    expect(notice).toMatchObject({ task_id: task.id, kind: 'info', status: 'sent', lifecycle_type: null, read_at: null });
    expect(notice.source_event_id).toBeGreaterThan(0);
    expect((await client.request('notice.page', { status: 'unread' })).notices.some(row => row.id === notice.id)).toBe(true);
    await expect(client.request('notice.answer', { id: notice.id, answer: 'yes' })).rejects.toThrow();
    await expect(client.request('notice.dismiss', { id: notice.id })).rejects.toThrow();
    expect((await client.request('notice.read', { id: notice.id })).read_at).toBeTruthy();
    await client.request('system.configure', { settings: { result_notice: false } });
    await client.request('worker.message', { id: task.id, body: '追加只读分析' });
    await idle(client, task.id, 2);
    expect(fs.readFileSync(path.join(root, '.lush', 'notice-invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse))
      .toEqual([{ enabled: true, calls: 1, continued: true }, { enabled: false, calls: 2, continued: true }]);
    const notices = await client.request('notice.list');
    expect(notices.filter(row => row.title === 'Analysis result')).toHaveLength(1);
    expect(notices.some(row => ['Cross-worker', 'Bad kind', 'Bad questions'].includes(row.title))).toBe(false);
    // The default remains a question, not an info report.
    const question = await client.request('notice.post', { task: task.id, title: 'Legacy question' });
    expect(question).toMatchObject({ kind: 'question', status: 'open' });
    await client.request('notice.dismiss', { id: question.id });
  } finally {
    await cli(root, ['stop'], extra).catch(() => {});
    for (const dir of [root, device]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
