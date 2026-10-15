import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { normalizeAgentProfile } from '../../src/agent/settings.js';

const baseProfile = { agent: 'mock', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] };

test('order start:false creates a paused「待开始」Task that stays put until task.resume', async () => {
  const runs = [];
  const f = fixture({
    resolve: () => ({ ...baseProfile }),
    async run(options) { runs.push(options); return `ran #${options.task.id}`; },
  });
  await repo(f.root);
  try {
    const response = await f.project.order('先暂存这条', null, [], null, false);
    expect(response.task.status).toBe('paused');
    expect(response.task.agent_wakes).toBe(0);
    expect(runs).toHaveLength(0);
    // 待开始任务仍出现在活动任务窗口里，但不会因为 kick / 消息被唤醒。
    expect(f.project.activity(50, 'work').tasks.map(task => task.id)).toContain(response.task.id);
    f.project.kick();
    await Bun.sleep(20);
    expect(runs).toHaveLength(0);

    const resumed = await f.project.resumeTask(response.task.id);
    expect(resumed.status).toBe('queued');
    await until(() => f.store.task(response.task.id).status === 'waiting');
    expect(runs).toHaveLength(1);
  } finally { await f.close(); }
});
