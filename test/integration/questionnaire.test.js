import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env, repo, until } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, idle } from './harness.js';

// A real process that intentionally never exits after posting: runtime, not model compliance, must stop it.
test('pi CLI questionnaire stops process group, survives daemon restart, and resumes via answers-file', async () => {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.LUSH_HOME;
const context = JSON.parse(fs.readFileSync(path.join(home,'sessions','task-'+process.env.LUSH_TASK_ID+'-input.md'),'utf8'));
fs.appendFileSync(path.join(home,'seen.jsonl'), JSON.stringify({pid:process.pid,task:context.task.id,messages:context.messages})+'\\n');
if (context.task.calls === 1) {
 const file = path.join(home,'sessions','questions.json');
 fs.writeFileSync(file,JSON.stringify({questions:[{header:'Layout',question:'Which layout?',options:[{label:'Sidebar',description:'Categories'},{label:'Tabs',description:'Wider content'}]}]}));
 const child = Bun.spawn(['lush','notice','post','Layout decision','--questions-file',file],{stdout:'pipe',stderr:'pipe'});
 await child.exited;
 setInterval(() => {},1000);
 await new Promise(() => {});
} else console.log('resumed with '+JSON.stringify(context.messages));
`, { mode: 0o755 });
  try {
    await repo(root);
    await cli(root, ['start'], { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake });
    const { task } = await cli(root, ['say', 'choose a layout']);
    let client = new UIClient(Config.fromEnv(env(), root));
    let waiting;
    for (let i = 0; i < 400; i++) {
      waiting = await client.request('task.inspect', { id: task.id });
      if (waiting.status === 'awaiting' && !waiting.agent.active) break;
      await Bun.sleep(10);
    }
    expect(waiting.status).toBe('awaiting'); expect(waiting.agent.active).toBe(false);
    const seenFile = path.join(root, '.lush', 'seen.jsonl');
    const first = JSON.parse(fs.readFileSync(seenFile, 'utf8').trim());
    await until(() => { try { process.kill(first.pid, 0); return false; } catch { return true; } });
    const notice = waiting.notices[0]; expect(notice.kind).toBe('questionnaire');
    await cli(root, ['stop']);
    await cli(root, ['start'], { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake });
    client = new UIClient(Config.fromEnv(env(), root));
    expect((await client.request('task.inspect', { id: task.id })).status).toBe('awaiting');
    const answers = path.join(root, 'answers.json');
    fs.writeFileSync(answers, JSON.stringify({ answers: [{ selected: [1] }] }));
    await cli(root, ['answer', String(notice.id), '--answers-file', answers]);
    const result = await idle(client, task.id, 2);
    expect(result.status).toBe('waiting'); expect(result.calls).toBe(2);
    const seen = fs.readFileSync(seenFile, 'utf8').trim().split('\n').map(JSON.parse);
    expect(seen.length).toBe(2);
    expect(JSON.parse(seen[1].messages[0].body).answer.answers[0].labels).toEqual(['Tabs']);
  } finally { await cli(root, ['stop']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
