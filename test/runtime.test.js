import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse, ToolCall } from '../src/agent/provider.js';
import { AgentTools, TOOL_DEFINITIONS } from '../src/agent/tools.js';
import { LushError } from '../src/core/types.js';
import { cleanup, contextSid, deferred, expectRejection, permissiveRoot, queue, system, tmpdir } from './helpers.js';

class BlockingProvider {
  constructor() {
    this.name = 'blocking-test';
    this.entered = queue();
    this.release = deferred();
  }

  async call(messages) {
    this.entered.push(contextSid(messages));
    await this.release.promise;
    return new AgentResponse('finished');
  }
}

describe('runtime', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let root;

  beforeEach(() => {
    dir = tmpdir('lush-agent-');
    ({ database: db, manager, runtime } = system(dir));
    root = permissiveRoot(manager);
  });

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  /** A service whose task we are about to run. */
  function worker(template = 'generic-task', name = 'worker') {
    return manager.load(manager.spawn(0, template, name).sid);
  }

  test('a task carries its own identity, conversation and result', async () => {
    const parent = manager.load(manager.spawn(0, 'generic-service', 'project-manager').sid);
    const child = manager.load(manager.spawn(parent.sid, 'generic-task', 'implement-login', '实现登录').sid);
    const first = await manager.call(child.sid, '请介绍一下你当前的身份和任务');
    for (const expected of ['SID = 2', 'task = #1', 'project-manager[1]', 'children：无']) {
      expect(first.result).toContain(expected);
    }
    expect(first.status).toBe('completed');
    // A second call is a second task with its own conversation: the first
    // task's messages are not replayed into it.
    const second = await manager.call(child.sid, '继续介绍');
    expect(second.result).toContain('用户消息数：1');
    expect(second.id).not.toBe(first.id);
    expect(manager.taskHistory(first.id).messages.length).toBe(2);
    expect(manager.taskHistory(second.id).messages.length).toBe(2);
    // The service keeps the aggregate history of the work done on it.
    expect(manager.repository.calls(child.sid).length).toBe(2);
    expect((await manager.call(0, 'who are you?')).result).toContain('SID = 0');
  });

  test('the tools are the task/service split, and deleting stays human-only', async () => {
    const task = manager.repository.createTask(worker().sid, null, 'work');
    const tools = new AgentTools(manager, task.id, task.sid);
    expect((await tools.execute('task_self', '{}')).result).toMatchObject({ id: task.id, sid: task.sid });
    expect((await tools.execute('service_self', '{}')).result.sid).toBe(task.sid);
    expect((await tools.execute('task_children', '{}')).result).toEqual([]);
    for (const [name, args] of [
      ['task_spawn', '{"sid":0,"goal":"x"}'],
      ['service_spawn', '{"template":"no-such-template"}'],
      ['service_update_state', '{}'],
      ['service_update_vars', '{}'],
      ['task_self', '[]'],
      ['task_self', 'bad-json'],
      ['task_wait', '{"task_id":true}'],
      ['shell', '{}'],
    ]) {
      expect((await tools.execute(name, args)).error).toBeDefined();
    }
    // The declaration is the full tool surface.
    const names = TOOL_DEFINITIONS.map((tool) => tool.function.name);
    for (const expected of ['task_self', 'task_spawn', 'task_wait', 'task_complete', 'service_spawn']) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('service_delete');
    expect(names).not.toContain('service_purge');
    expect(names).not.toContain('service_call');
    manager.cancelTask(task.id);
  });

  test('task state is scratch, service state is long-lived, variables stay declarable', async () => {
    const project = manager.load(manager.spawn(0, 'project', 'demo', undefined, { path: dir }).sid);
    const task = manager.repository.createTask(project.sid, null, 'work');
    const tools = new AgentTools(manager, task.id, project.sid);
    expect((await tools.execute('task_update_state', '{"patch":{"progress":"half"}}')).result).toEqual({ progress: 'half' });
    expect((await tools.execute('service_update_state', '{"patch":{"knowledge":"kept"}}')).result)
      .toEqual({ params: { path: dir }, vars: { branch: 'main' }, knowledge: 'kept' });
    expect(manager.repository.getTask(task.id).state).toEqual({ progress: 'half' });
    expect(project.inspect().context.state).toMatchObject({ knowledge: 'kept', params: { path: dir } });
    expect((await tools.execute('service_self', '{}')).result.variables.mutable).toEqual({ branch: 'main' });
    expect((await tools.execute('service_update_vars', '{"patch":{"branch":"dev"}}')).result).toEqual({ branch: 'dev' });
    for (const args of ['{"patch":{"path":"/tmp"}}', '{"patch":{"nope":1}}', '{"patch":{}}']) {
      expect((await tools.execute('service_update_vars', args)).error).toBeDefined();
    }
    manager.cancelTask(task.id);
  });

  test('concurrent tasks on different services; one task per service', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const a = worker();
    const b = worker();
    const first = manager.call(a.sid, 'A');
    const second = manager.call(b.sid, 'B');
    const entered = [await provider.entered.next(), await provider.entered.next()].sort();
    expect(entered).toEqual([a.sid, b.sid].sort());
    await expectRejection(manager.call(a.sid, 'overlap'), /already working on task/);
    expect(a.inspect().agent.status).toBe('busy');
    provider.release.resolve();
    await Promise.all([first, second]);
    expect(a.inspect().agent.status).toBe('idle');
  });

  test('agent ids are per task and the finished log is bounded', async () => {
    const workerService = worker('generic-task', 'worker');
    const other = worker('generic-task', 'other');
    expect(manager.agentsList()).toEqual([]);
    for (let round = 1; round <= 35; round += 1) await manager.call(workerService.sid, `round ${round}`);
    const kept = manager.agentsList(null, null, true);
    // 35 finished agents, only the last 32 are kept in memory.
    expect(kept.length).toBe(32);
    expect(kept[0].id).toBe('4.1');
    expect(kept[kept.length - 1].id).toBe('35.1');
    expect(manager.agentsList(null, null, true).map((agent) => agent.id)).not.toContain('3.1');
    // Every task mints its own sequence; a live agent shows in tree and list.
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const pending = manager.call(workerService.sid, 'blocking');
    const sid = await provider.entered.next();
    expect(sid).toBe(workerService.sid);
    expect(manager.agentsList()).toEqual([
      expect.objectContaining({ id: '36.1', sid: workerService.sid, provider: 'blocking-test', status: 'running', cancellable: true }),
    ]);
    expect(runtime.agentSummary(workerService.sid)).toMatchObject({
      provider: 'blocking-test', running: 1, agents: [{ id: '36.1', interactive: false, os_pid: null }],
    });
    expect(manager.tree().find((row) => row.sid === workerService.sid).agent.running).toBe(1);
    expect(manager.tree(false).find((row) => row.sid === workerService.sid).agent).toBeUndefined();
    provider.release.resolve();
    await pending;
    expect(runtime.agentSummary(workerService.sid).running).toBe(0);
    expect(manager.agentsList(null, null, true).length).toBe(32);
    expect(manager.agentsList(null, other.sid)).toEqual([]);
  });

  test('agent and descriptor validation', async () => {
    const sid = worker().sid;
    expect(() => manager.agentsList(null, null, 'yes')).toThrow(/all must be a boolean/);
    expect(() => manager.agentsList(null, 99)).toThrow(/service not found/);
    expect(() => manager.agentsList(99)).toThrow(/task not found/);
    expect(() => manager.tree('yes')).toThrow(/agents must be a boolean/);
    expect(() => manager.agentShow('2')).toThrow(/agent id must look like/);
    expect(() => manager.agentShow('2.x')).toThrow(/agent id must look like/);
    expect(() => manager.agentsKill('1.1')).toThrow(/agent 1.1 is not running/);
    expect(() => manager.callOsPid(1, 1, 0)).toThrow(/os_pid must be a positive integer/);
    expect(() => manager.callOsPid(1, 0, 5)).toThrow(/call_id must be a positive integer/);
    expect(() => manager.callDescribe(sid, '')).toThrow(/prompt must be a non-empty string/);
    expect(() => manager.callDescribe(99, 'x')).toThrow(/not found/);
  });

  test('a task can only wait on its own downstream work', async () => {
    const parent = worker('generic-service', 'parent');
    const child = worker('generic-task', 'child');
    const other = worker('generic-task', 'other');
    const task = manager.repository.createTask(parent.sid, null, 'parent work');
    const parked = manager.repository.createTask(child.sid, task.id, 'child work', { rootTaskId: task.id });
    const unrelated = manager.repository.createTask(other.sid, null, 'unrelated');

    // A task may not delegate to a non-child service, nor to its own service.
    expect(() => manager.spawnTask(task.id, other.sid, 'off tree')).toThrow(/only delegate downstream/);
    expect(() => manager.spawnTask(task.id, parent.sid, 'itself')).toThrow(/cannot delegate to its own service/);
    // Waiting is symmetric: only the waiter's subtree, never itself.
    expect(() => manager.waitForTask(unrelated.id, task.id)).toThrow(/not part of task/);
    expect(() => manager.waitForTask(task.id, task.id)).toThrow(/cannot wait on itself/);
    manager.completeTask(parked.id, 'done');
    expect((await manager.waitForTask(parked.id, task.id)).status).toBe('completed');
    manager.cancelTask(task.id);
    manager.cancelTask(unrelated.id);
  });

  test('cancelTask cancels its whole subtree', () => {
    const a = worker('generic-service', 'a');
    const b = worker('generic-task', 'b');
    const one = manager.repository.createTask(a.sid, null, 'one');
    const two = manager.repository.createTask(b.sid, one.id, 'two', { rootTaskId: one.id });
    const three = manager.repository.createTask(b.sid, two.id, 'three', { rootTaskId: one.id });
    expect(manager.cancelTask(one.id).status).toBe('cancelled');
    expect(manager.repository.getTask(two.id).status).toBe('cancelled');
    expect(manager.repository.getTask(three.id).status).toBe('cancelled');
  });

  test('cancelling a task interrupts its agent and leaves other services alone', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const first = worker();
    const second = worker();
    const pending = manager.call(first.sid, 'work');
    const other = manager.call(second.sid, 'other');
    pending.catch(() => {});
    other.catch(() => {});
    for (let i = 0; i < 2; i += 1) await provider.entered.next();
    const task = manager.taskList(first.sid)[0];
    manager.cancelTask(task.id);
    expect((await pending).status).toBe('cancelled');
    expect(runtime.isBusy(second.sid)).toBe(true);
    expect(manager.repository.getTask(task.id).status).toBe('cancelled');
    provider.release.resolve();
    await other;
  });

  test('purge interrupts a live task and keeps the agent log readable', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const doomed = worker('generic-task', 'doomed');
    const pending = manager.call(doomed.sid, 'work');
    pending.catch(() => {});
    await provider.entered.next();
    expect(runtime.isBusy(doomed.sid)).toBe(true);

    const result = manager.purge(doomed.sid);
    expect(result).toMatchObject({ status: 'active', terminated: [doomed.sid], deleted: [doomed.sid] });
    // The task row is gone, so the waiting caller is told that instead of a
    // bare "not found".
    expect((await pending).status).toBe('removed');
    expect(runtime.isBusy(doomed.sid)).toBe(false);
    expect(runtime.activeCalls).toBe(0);
    // The finished worker is still in this daemon run's memory; its service is not.
    expect(manager.agentsList()).toEqual([]);
    expect(manager.agentsList(null, null, true)[0])
      .toMatchObject({ id: '1.1', sid: doomed.sid, name: null, status: 'interrupted' });
    provider.release.resolve();
  });

  test('an abandoned waiter keeps the invocation alive', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const service_ = worker();
    const waiter = manager.call(service_.sid, 'work');
    await provider.entered.next();
    // A detached client stops awaiting; the daemon must finish the work anyway.
    provider.release.resolve();
    const task = await waiter;
    expect(task.status).toBe('completed');
    expect(task.result).toBe('finished');
    expect(runtime.isBusy(service_.sid)).toBe(false);
    expect(manager.repository.callsOfTask(task.id)[0].status).toBe('succeeded');
  });

  test('provider error, timeout and round limit fail the task', async () => {
    class Broken {
      constructor() {
        this.name = 'broken';
      }

      async call() {
        throw new LushError('test provider failure', -32020);
      }
    }
    const target = worker();
    runtime.provider = new Broken();
    const broken = await manager.call(target.sid, 'fail');
    expect(broken.status).toBe('failed');
    expect(broken.error).toMatch(/test provider failure/);

    runtime.provider = new BlockingProvider();
    runtime.timeout = 0.03;
    const timedOut = await manager.call(target.sid, 'timeout');
    expect(timedOut.status).toBe('failed');
    expect(timedOut.error).toMatch(/timed out/);

    class Loop {
      constructor() {
        this.name = 'loop';
      }

      async call() {
        return new AgentResponse('', [new ToolCall('loop', 'task_self', '{}')]);
      }
    }
    runtime.provider = new Loop();
    runtime.maxRounds = 2;
    runtime.timeout = 1;
    const looped = await manager.call(target.sid, 'loop');
    const task = manager.taskList(target.sid)[0];
    expect(looped.status).toBe('failed');
    expect(looped.error).toMatch(/exceeded 2 rounds/);
    expect(task.status).toBe('failed');
    expect(manager.repository.callsOfTask(task.id).every((call) => call.status === 'failed')).toBe(true);
  });

  test('shutdown fails the task and interrupts its call', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const service_ = worker();
    const waiter = manager.call(service_.sid, 'work');
    waiter.catch(() => {});
    const sid = await provider.entered.next();
    expect(sid).toBe(service_.sid);
    await runtime.shutdown();
    expect((await waiter).status).toBe('failed');
    expect(runtime.active.size).toBe(0);
    const task = manager.taskList(service_.sid)[0];
    expect(task.status).toBe('failed');
    expect(task.error).toBe('daemon shut down');
    expect(manager.repository.callsOfTask(task.id)[0].status).toBe('interrupted');
  });

  test('the continuation budget bounds how often one task is woken', () => {
    expect(runtime.maxCalls).toBe(12);
    runtime.maxCalls = 3;
    expect(runtime.maxCalls).toBe(3);
  });
});
