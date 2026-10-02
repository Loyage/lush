import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { AgentPreempted } from '../../src/agent/provider.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../../src/rpc/registry.js';
import { Dispatcher } from '../../src/rpc/protocol.js';

/** 不返回、只在 abort 时 reject 的 provider，用来模拟「正在调用」的 Task（mock 没有可验证安全边界）。 */
function abortingProvider(starts) {
  return {
    resolve: () => ({ agent: 'mock', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }),
    run: ({ signal }) => new Promise((_, reject) => {
      starts.push(true);
      const stop = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
    }),
  };
}

/** 有 pi 安全边界语义的 provider：让 invoke 以 AgentPreempted 收尾，验证「暂停」不会被自动恢复。 */
function preemptProvider() {
  return {
    resolve: () => ({ agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }),
    run: async () => { await Bun.sleep(10); throw new AgentPreempted({ safe_point: 'turn_end', reason: 'test interrupt' }); },
  };
}

test('interrupt pauses a running say without cascading, keeps context, and resume re-queues it', async () => {
  const starts = [];
  const f = fixture(abortingProvider(starts));
  f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.say('pause this work');
    f.project.stopping = false; f.project.kick();
    await until(() => starts.length === 1);
    expect(f.store.task(task.id).status).toBe('running');
    expect(starts).toHaveLength(1);

    const paused = f.project.interrupt(task.id, 'user pause');
    expect(paused.status).toBe('paused');
    await until(() => !f.project.running.has(task.id));
    const after = f.store.task(task.id);
    expect(after.status).toBe('paused');
    expect(after.error).toBeNull();
    expect(after.branch).toBe(task.branch);
    expect(after.workspace).toBe(task.workspace);
    expect(after.calls).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.interrupted'", task.id).n).toBe(1);

    // 追加说明不会自动唤醒：消息入收件箱，任务保持 paused。
    f.project.message(task.id, '补充说明：先只改后端');
    expect(f.store.task(task.id).status).toBe('paused');
    expect(f.store.unread(task.id).some(row => row.body.includes('先只改后端'))).toBe(true);

    const resumed = f.project.resumeTask(task.id);
    expect(resumed.status).toBe('queued');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.resumed'", task.id).n).toBe(1);
    await until(() => starts.length === 2);
    expect(starts).toHaveLength(2);
    // calls 保留、继续累加；上下文没有被重置。
    expect(f.store.task(task.id).calls).toBe(2);
  } finally { await f.close(); }
});

test('interrupt of a queued say skips the abort path and configureTask keeps settings until settlement', async () => {
  const f = fixture();
  f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.say('queue then pause');
    expect(['queued', 'waiting']).toContain(f.store.task(task.id).status);
    const paused = f.project.interrupt(task.id);
    expect(paused.status).toBe('paused');

    const profile = { agent: 'pi', model: 'gpt-5.4', thinking: 'high', default_prompt: '',
      append_prompt: '先写测试', extensions: [], skills: [], soft_budget: {} };
    const configured = f.project.configureTask(task.id, profile);
    expect(JSON.parse(configured.retry_profile)).toMatchObject({ agent: 'pi', model: 'gpt-5.4', thinking: 'high', append_prompt: '先写测试' });
    const configuredEvent = f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.configured' ORDER BY id DESC LIMIT 1", task.id);
    expect(JSON.parse(configuredEvent.data)).toMatchObject({ agent: 'pi', model: 'gpt-5.4', thinking: 'high', append_prompt: true });

    // 继续不带 profile：沿用暂停时保存的设置。
    const resumed = f.project.resumeTask(task.id);
    expect(resumed.status).toBe('queued');
    expect(JSON.parse(f.store.task(task.id).retry_profile)).toMatchObject({ model: 'gpt-5.4' });
    const resumedEvent = f.store.get("SELECT data FROM events WHERE task_id=? AND type='task.resumed' ORDER BY id DESC LIMIT 1", task.id);
    expect(JSON.parse(resumedEvent.data)).toMatchObject({ profile_override: false });
  } finally { await f.close(); }
});

test('a paused pi Task stays paused even when the preempted invocation unwinds', async () => {
  const f = fixture(preemptProvider());
  f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.say('pi pause');
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.running.has(task.id));
    f.project.interrupt(task.id, 'safe pause');
    expect(f.store.task(task.id).status).toBe('paused');
    await until(() => !f.project.running.has(task.id));
    await Bun.sleep(10);
    // AgentPreempted 的收尾不会把 paused 改回 queued/waiting。
    expect(f.store.task(task.id).status).toBe('paused');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='invocation.preempted'", task.id).n).toBe(1);
  } finally { await f.close(); }
});

test('interrupt / resume / configure reject the wrong targets and are user-only RPCs', async () => {
  const f = fixture();
  f.project.stopping = true; await repo(f.root);
  try {
    const root = await f.project.ensureMainTask();
    expect(() => f.project.interrupt(root.id)).toThrow('permanent root');
    const { task } = await f.project.say('guards');
    expect(() => f.project.resumeTask(task.id)).toThrow('only paused workers');
    expect(() => f.project.configureTask(task.id, { agent: 'pi' })).toThrow('only paused');
    f.project.interrupt(task.id);
    expect(() => f.project.interrupt(task.id)).toThrow('already paused');
    // 终态任务不能暂停：直接写终态避开 delivery 收尾。
    f.store.update(task.id, { status: 'cancelled' });
    expect(() => f.project.interrupt(task.id)).toThrow('has ended');

    expect(PARAMS['worker.interrupt']).toEqual(['id']);
    expect(PARAMS['worker.resume']).toEqual(['id', 'profile']);
    expect(PARAMS['worker.configure']).toEqual(['id', 'profile']);
    for (const method of ['worker.interrupt', 'worker.resume', 'worker.configure']) {
      expect(USER_ONLY.has(method)).toBe(true);
      const params = method === 'worker.interrupt' ? { id: 5 } : { id: 5, profile: {} };
      expect(() => assertAllowed(method, params, 5)).toThrow('requires user approval');
    }
    // 用户路径经 RPC 正常：interrupt 后 inspect 看到 paused。
    f.store.update(task.id, { status: 'queued' });
    await new Dispatcher(f.project).dispatch('worker.interrupt', { id: task.id });
    expect((await new Dispatcher(f.project).dispatch('worker.inspect', { id: task.id })).status).toBe('paused');
  } finally { await f.close(); }
});

/** 声称有 pi 安全边界、但从不进入边界的 provider：验证宽限期到点后强制结束本轮 invocation。 */
function hangingPiProvider() {
  return {
    resolve: () => ({ agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] }),
    run: ({ signal }) => new Promise((_, reject) => {
      const stop = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
    }),
  };
}

test('interrupt force-stops a pi invocation that never reaches a safe boundary, keeping it paused', async () => {
  const f = fixture(hangingPiProvider());
  f.config.interruptGraceMs = 30;
  f.project.stopping = true; await repo(f.root);
  try {
    const { task } = await f.project.say('hang forever');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(task.id).status === 'running');
    f.project.interrupt(task.id, 'force after grace');
    expect(f.store.task(task.id).status).toBe('paused');
    await until(() => !f.project.running.has(task.id));
    expect(f.store.task(task.id).status).toBe('paused');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.interrupt_timeout'", task.id).n).toBe(1);
  } finally { await f.close(); }
});
