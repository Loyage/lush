import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp, repo, env } from '../helpers.js';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { cli, idle, emittedTask } from './harness.js';

test('real daemon starts once, admits input and retains Worker state across restart', async () => {
  const root = temp(); await repo(root);
  try {
    const started = await cli(root, ['daemon', 'start']);
    const client = new UIClient(Config.fromEnv(env(), root));
    expect((await cli(root, ['daemon', 'start'])).already_running).toBe(true);
    expect((await cli(root, ['doctor'])).daemon_code_match).toBe(true);
    const main = (await client.request('worker.list')).find(task => task.task_kind === 'main');
    expect(main).toMatchObject({ task_kind: 'main', status: 'waiting', input_id: null });
    const receipt = await cli(root, ['order', 'original input']);
    expect(receipt).toMatchObject({ emitted: true });
    const task = await emittedTask(client, receipt);
    expect((await idle(client, task.id)).status).toBe('waiting');
    const before = await client.request('worker.inspect', { id: task.id });
    const restarted = await cli(root, ['daemon', 'restart']);
    expect(restarted.pid).not.toBe(started.pid);
    expect(await client.request('worker.inspect', { id: task.id })).toMatchObject({
      id: before.id, goal: before.goal, status: before.status, result: before.result, calls: before.calls,
    });
  } finally { await cli(root, ['daemon', 'stop']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
