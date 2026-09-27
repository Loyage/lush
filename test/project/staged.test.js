import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { assertAllowed } from '../../src/rpc/registry.js';
import { normalizeAgentProfile } from '../../src/agent/settings.js';

const baseProfile = { agent: 'mock', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] };

test('say start:false creates a paused「待开始」Task that stays put until task.resume', async () => {
  const runs = [];
  const f = fixture({
    resolve: () => ({ ...baseProfile }),
    async run(options) { runs.push(options); return `ran #${options.task.id}`; },
  });
  await repo(f.root);
  try {
    const response = await f.project.say('先暂存这条', null, [], null, false);
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

test('resume profile freezes per-task env and rejects unsafe names', async () => {
  const seen = [];
  const f = fixture({
    resolve: () => ({ ...baseProfile }),
    async run(options) { seen.push(options.agent); return 'ok'; },
  });
  f.project.stopping = true; await repo(f.root);
  try {
    const response = await f.project.say('带环境变量', null, [], null, false);
    expect(() => f.project.resumeTask(response.task.id, { ...baseProfile, agent: 'pi', env: { 'BAD-NAME': 'x' } }))
      .toThrow('invalid environment variable name');
    expect(f.store.task(response.task.id).status).toBe('paused');
    f.project.stopping = false;
    f.project.resumeTask(response.task.id, { ...baseProfile, agent: 'pi', env: { API_BASE: 'https://example.invalid' } });
    await until(() => seen.length === 1);
    expect(seen[0].env).toEqual({ API_BASE: 'https://example.invalid' });
  } finally { await f.close(); }
});

test('resume / configure / say.submit start are user-only and env is validated on the profile', () => {
  expect(assertAllowed('task.resume', { id: 1, profile: {} }, null)).toBeNull();
  expect(() => assertAllowed('task.resume', { id: 1 }, 42)).toThrow('requires user approval');
  expect(assertAllowed('task.configure', { id: 1 }, null)).toBeNull();
  expect(assertAllowed('say.submit', { content: 'x', start: false }, null)).toBeNull();
  expect(() => assertAllowed('say.submit', { content: 'x', bogus: 1 }, null)).toThrow('unknown parameter');
  expect(normalizeAgentProfile({ agent: 'pi', env: { OK: '1' } }).env).toEqual({ OK: '1' });
  expect(() => normalizeAgentProfile({ agent: 'pi', env: { LUSH_SECRET: 'x' } })).toThrow('reserved by Lush');
  expect(normalizeAgentProfile({ agent: 'pi' }).env).toBeUndefined();
});
