import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

test('messages arriving during an invocation are delivered exactly on the next invocation', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.order('work')).task;
    await until(() => provider.calls.length === 1);
    f.project.message(task.id, 'new requirement');
    expect(provider.calls[0].messages).toEqual([]);
    provider.calls[0].done.resolve('first');
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].messages.map(m => m.body)).toEqual(['new requirement']);
    provider.calls[1].done.resolve('second');
    // A new order Task stays idle between invocations; it is not completed by an ordinary return.
    await until(() => f.store.task(task.id).status === 'waiting');
    expect(f.store.unread(task.id)).toEqual([]);
  } finally { await f.close(); }
});

test('cancel cascades and terminal tasks cannot have active descendants', async () => {
  const provider = controlled(), f = fixture(provider); await repo(f.root);
  try {
    const root = (await f.project.order('root')).task;
    const child = await f.project.spawn(root.id, 'child', undefined, [], 'child');
    const leaf = await f.project.spawn(child.id, 'leaf', undefined, [], 'leaf');
    await until(() => f.project.running.size === 3);
    f.project.notice(leaf.id,'question');
    f.project.cancel(root.id);
    await until(() => f.project.running.size === 0);
    expect(f.store.tasks().filter(t => ['order','child'].includes(t.task_kind)).map(t => t.status))
      .toEqual(['cancelled','cancelled','cancelled']);
    expect(f.store.runsForTask(root.id).at(-1)).toMatchObject({ status: 'cancelled', error: 'cancelled by user' });
    expect(f.store.get('SELECT status FROM notices').status).toBe('dismissed');
    expect(() => f.project.spawn(root.id,'no')).toThrow('terminal');
    expect(() => f.project.message(root.id,'no')).toThrow('ended');
    expect(() => f.project.retry(leaf.id)).toThrow('parent has ended');
  } finally { await f.close(); }
});

test('failure cancels descendants; child failure wakes parent with explicit error', async () => {
  let message;
  const f = fixture({ async run({ task, api, messages }) {
    if (task.task_kind === 'order' && task.calls === 1) { await api.spawn(task.id,'fail', undefined, [], 'fail'); return 'delegated'; }
    if (task.task_kind === 'child') throw new Error('backend failed');
    message = messages[0].body; return 'reported failure';
  } }); await repo(f.root);
  try {
    const root = (await f.project.order('root')).task;
    await until(() => message !== undefined);
    expect(message).toContain('backend failed');
    expect(f.store.children(root.id)[0].status).toBe('failed');
  } finally { await f.close(); }
});

test('retry is explicit, preserves unconsumed messages and prior audit', async () => {
  let fail = true;
  const f = fixture({ async run() { if (fail) throw new Error('bad'); return 'ok'; } }); await repo(f.root);
  try {
    const root = (await f.project.order('root')).task; f.project.message(root.id,'keep');
    await until(() => f.store.task(root.id).status === 'failed');
    expect(f.store.unread(root.id)).toHaveLength(1);
    fail = false; f.project.retry(root.id);
    await until(() => f.store.task(root.id).status === 'waiting');
    expect(f.store.unread(root.id)).toHaveLength(0);
    expect(f.store.history(root.id).some(e => e.type === 'failed')).toBe(true);
  } finally { await f.close(); }
});

test('retry can freeze a complete task-local Agent profile without changing project defaults', async () => {
  let fail = true;
  const seen = [];
  const provider = {
    resolve() { return { agent: 'mock', model: 'project-default', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }; },
    async run({ agent }) { seen.push(agent); if (fail) throw new Error('first attempt failed'); return 'ok'; },
  };
  const f = fixture(provider); await repo(f.root);
  try {
    const task = (await f.project.order('retry with another model')).task;
    await until(() => f.store.task(task.id).status === 'failed');
    fail = false;
    const profile = { agent: 'pi', model: 'openai-codex/gpt-5.4-mini', thinking: 'high',
      default_prompt: 'custom role rules', append_prompt: 'focus on the previous failure',
      extensions: ['/tmp/extension.js'], skills: ['/tmp/skill'], soft_budget: { responses: 8, tokens: 12000 } };
    f.project.retry(task.id, profile);
    expect(JSON.parse(f.store.task(task.id).retry_profile)).toEqual(profile);
    await until(() => f.store.task(task.id).status === 'waiting');
    expect(seen.at(-1)).toEqual(profile);
    // The task-local profile stays pinned on the idle order until it settles or is retried again.
    expect(JSON.parse(f.store.task(task.id).retry_profile)).toEqual(profile);
    expect(f.project.agentSettings.resolve('agent').model).not.toBe(profile.model);
    const event = f.store.history(task.id).find(row => row.type === 'retry');
    expect(event.data).toMatchObject({ profile_override: true, agent: 'pi', model: profile.model,
      default_prompt_overridden: true, extensions: 1, skills: 1 });
  } finally { await f.close(); }
});

test('invalid retry profile does not queue or mutate a stopped task', async () => {
  const f = fixture({ async run() { throw new Error('stop'); } }); await repo(f.root);
  try {
    const task = (await f.project.order('invalid retry')).task;
    await until(() => f.store.task(task.id).status === 'failed');
    expect(() => f.project.retry(task.id, { agent: 'codex', model: '', thinking: '', default_prompt: '', append_prompt: '',
      extensions: [], skills: [], soft_budget: { responses: 1 } })).toThrow('supported only by Pi');
    expect(f.store.task(task.id)).toMatchObject({ status: 'failed', retry_profile: null });
  } finally { await f.close(); }
});
