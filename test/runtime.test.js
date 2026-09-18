import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse, ToolCall } from '../src/agent/provider.js';
import { AgentTools, TOOL_DEFINITIONS } from '../src/agent/tools.js';
import { LushError } from '../src/core/types.js';
import { cleanup, contextPid, deferred, expectRejection, permissiveRoot, queue, system, tmpdir } from './helpers.js';

class BlockingProvider {
  constructor() {
    this.name = 'blocking-test';
    this.entered = queue();
    this.release = deferred();
  }

  async call(messages) {
    this.entered.push(contextPid(messages));
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

  test('mock identity, context and history', async () => {
    const parent = root.createChild('generic-service', { name: 'project-manager' });
    const task = parent.createChild('generic-task', { name: 'implement-login', goal: '实现登录' });
    const result = await task.call('请介绍一下你当前的身份和任务');
    for (const expected of ['PID = 2', 'type = task', 'project-manager[1]', '实现登录', 'children：无']) {
      expect(result.output).toContain(expected);
    }
    expect(task.inspect().status).toBe('running');
    const again = await task.call('继续介绍');
    expect(again.output).toContain('用户消息数：2');
    expect(manager.history(task.pid).messages.length).toBe(4);
    expect(task.inspect().recent_calls[0].status).toBe('succeeded');
    expect((await root.call('who are you?')).output).toContain('PID = 0');
  });

  test('agent autonomous spawn and explicit complete', async () => {
    const parent = root.createChild('generic-service', { name: 'pm' });
    await parent.call('创建一个子任务，研究 OAuth 登录实现方式');
    const child = parent.getChildren()[0];
    expect(child.inspect().name).toBe('research-oauth');
    await child.call('/tool process.update_state {"patch":{"progress":"done"}}');
    const service = child.createChild('generic-service');
    await child.call('/tool process.complete {"result":"OAuth report"}');
    expect(child.inspect().status).toBe('completed');
    expect(child.inspect().context.state.result).toBe('OAuth report');
    expect(service.getParent().pid).toBe(0);
    expect(parent.inspect().status).toBe('running');
    await expectRejection(child.call('another call'));
    manager.reclaim(child.pid);
    expect(child.inspect().context.message_count).toBeGreaterThan(0);
  });

  test('tools share core rules and bind the current pid', async () => {
    const task = root.createChild('generic-task');
    const tools = new AgentTools(manager, task.pid);
    expect((await tools.execute('process_self', '{}')).result.pid).toBe(task.pid);
    expect((await tools.execute('process_parent', '{}')).result.pid).toBe(0);
    for (const [name, args] of [
      ['process_spawn', '{"parent_pid":0,"template":"generic-task"}'],
      ['process_update_state', '{"pid":0,"patch":{}}'],
      ['process_update_vars', '{"pid":0,"patch":{}}'],
      ['process_self', '[]'],
      ['process_self', 'bad-json'],
      ['process_inspect', '{"pid":true}'],
      ['shell', '{}'],
    ]) {
      expect((await tools.execute(name, args)).error).toBeDefined();
    }
    manager.complete(task.pid);
    expect((await tools.execute('process_spawn', '{"template":"generic-task"}')).error).toBeDefined();
    expect((await tools.execute('process_update_vars', '{"patch":{"branch":"dev"}}')).error).toBeDefined();
    expect((await tools.execute('process_self', '{}')).result).toBeDefined();
    // The declaration is the full tool surface: variables are part of it.
    expect(TOOL_DEFINITIONS.map((tool) => tool.function.name)).toContain('process_update_vars');
    // Deleting records stays a human CLI/RPC decision: no agent gets that tool.
    const names = TOOL_DEFINITIONS.map((tool) => tool.function.name);
    expect(names).not.toContain('process_delete');
    expect(names).not.toContain('process_purge');
  });

  test('process_update_vars tool only changes mutable variables', async () => {
    const project = root.createChild('project', { variables: { path: dir } });
    const tools = new AgentTools(manager, project.pid);
    expect((await tools.execute('process_self', '{}')).result.variables.mutable).toEqual({ branch: 'main' });
    expect((await tools.execute('process_update_vars', '{"patch":{"branch":"dev"}}')).result).toEqual({ branch: 'dev' });
    for (const args of ['{"patch":{"path":"/tmp"}}', '{"patch":{"nope":1}}', '{"patch":{}}']) {
      expect((await tools.execute('process_update_vars', args)).error).toBeDefined();
    }
    expect(project.inspect().variables.mutable).toEqual({ branch: 'dev' });
    // Spawning through the tool takes the same declaration: path is required.
    // Opening a project is the project-manager's job, so the spawn goes through
    // one — the project itself may not create projects.
    const controller = new AgentTools(manager, root.createChild('project-manager').pid);
    const spawnVariables = JSON.stringify({ template: 'project', name: 'child', goal: 'g', variables: { path: dir } });
    expect((await controller.execute('process_spawn', spawnVariables)).result.variables.immutable).toEqual({ path: dir });
    expect((await controller.execute('process_spawn', '{"template":"project"}')).error).toBeDefined();
    expect((await tools.execute('process_spawn', spawnVariables)).error).toBeDefined();
  });

  test('concurrent calls on different pids; same pid is busy', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const a = root.createChild('generic-task');
    const b = root.createChild('generic-task');
    const first = a.call('A');
    const second = b.call('B');
    const entered = [await provider.entered.next(), await provider.entered.next()].sort();
    expect(entered).toEqual([a.pid, b.pid].sort());
    await expectRejection(a.call('overlap'), /busy/);
    expect(a.inspect().agent.status).toBe('busy');
    provider.release.resolve();
    await Promise.all([first, second]);
    expect(a.inspect().agent.status).toBe('idle');
  });

  test('agent ids are per process and the finished log is bounded', async () => {
    const parent = root.createChild('generic-task', { name: 'worker' });
    const other = root.createChild('generic-task', { name: 'other' });
    expect(manager.agentsList()).toEqual([]);
    for (let round = 1; round <= 35; round += 1) await parent.call(`round ${round}`);
    const kept = manager.agentsList(null, true);
    // 35 finished agents, only the last 32 are kept in memory.
    expect(kept.length).toBe(32);
    expect(kept[0].id).toBe(`${parent.pid}.4`);
    expect(kept[kept.length - 1].id).toBe(`${parent.pid}.35`);
    expect(manager.agentsList(parent.pid, true).map((agent) => agent.id)).not.toContain(`${parent.pid}.3`);
    // Every process mints its own sequence, and new work pushes out the oldest kept entry.
    await other.call('one');
    expect(manager.agentsList(other.pid, true).map((agent) => agent.id)).toEqual([`${other.pid}.1`]);
    expect(manager.agentsList(null, true).map((agent) => agent.id)).not.toContain(`${parent.pid}.4`);
    // A live agent shows up in the tree and in `agents list`; history stays out of both.
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const pending = parent.call('blocking');
    await provider.entered.next();
    expect(manager.agentsList()).toEqual([
      expect.objectContaining({ id: `${parent.pid}.36`, pid: parent.pid, provider: 'blocking-test', status: 'running', cancellable: true }),
    ]);
    expect(runtime.agentSummary(parent.pid)).toMatchObject({
      provider: 'blocking-test', running: 1, agents: [{ id: `${parent.pid}.36`, interactive: false, os_pid: null }],
    });
    expect(manager.tree().find((row) => row.pid === parent.pid).agent.running).toBe(1);
    expect(manager.tree(false).find((row) => row.pid === parent.pid).agent).toBeUndefined();
    provider.release.resolve();
    await pending;
    expect(runtime.agentSummary(parent.pid).running).toBe(0);
    expect(manager.agentsList(null, true).length).toBe(32);
  });

  test('agent validation keeps the two spaces apart', () => {
    expect(() => manager.agentsList(null, 'yes')).toThrow(/all must be a boolean/);
    expect(() => manager.agentsList(99)).toThrow(/process not found/);
    expect(() => manager.tree('yes')).toThrow(/agents must be a boolean/);
    expect(() => manager.agentShow('2')).toThrow(/agent id must look like/);
    expect(() => manager.agentShow('2.x')).toThrow(/agent id must look like/);
    expect(() => manager.agentsKill('1.1')).toThrow(/agent 1.1 is not running/);
    expect(() => manager.callOsPid(0, 1, 0)).toThrow(/os_pid must be a positive integer/);
    expect(() => manager.callOsPid(0, 0, 5)).toThrow(/call_id must be a positive integer/);
  });

  test('recursive and cross calls do not deadlock', async () => {
    class CrossProvider {
      constructor() {
        this.name = 'cross';
      }

      async call(messages) {
        const last = messages[messages.length - 1];
        if (last.role === 'tool') return new AgentResponse(last.content);
        const pid = contextPid(messages);
        return new AgentResponse('', [new ToolCall('cross', 'process_call',
          JSON.stringify({ pid: pid === 1 ? 2 : 1, prompt: 'cross' }))]);
      }
    }
    runtime.provider = new CrossProvider();
    const a = root.createChild('generic-task');
    root.createChild('generic-task');
    const guard = Bun.sleep(3000).then(() => {
      throw new Error('deadlock');
    });
    const result = await Promise.race([a.call('start'), guard]);
    expect(result.output).toContain('recursive');
    expect(runtime.active.size).toBe(0);
  });

  test('kill cancels only the target invocation', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const parent = root.createChild('generic-task');
    const child = parent.createChild('generic-service');
    const pending = parent.call('work');
    const independent = child.call('serve');
    pending.catch(() => {});
    await provider.entered.next();
    await provider.entered.next();
    manager.kill(parent.pid);
    const error = await expectRejection(pending, /interrupted/);
    expect(error.code).toBe(-32021);
    expect(runtime.isBusy(child.pid)).toBe(true);
    expect(child.getParent().pid).toBe(0);
    expect(parent.inspect().recent_calls[0].status).toBe('interrupted');
    provider.release.resolve();
    await independent;
  });

  test('purge interrupts a live call and keeps the agent log readable', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const task = root.createChild('generic-task', { name: 'doomed' });
    const pending = task.call('work');
    pending.catch(() => {});
    await provider.entered.next();
    expect(runtime.isBusy(task.pid)).toBe(true);

    const result = manager.purge(task.pid);
    expect(result).toMatchObject({ status: 'running', terminated: [task.pid], deleted: [task.pid] });
    const error = await expectRejection(pending, /interrupted/);
    expect(error.code).toBe(-32021);
    expect(runtime.isBusy(task.pid)).toBe(false);
    expect(runtime.activeCalls).toBe(0);
    // The finished worker is still in this daemon run's memory; its process is not.
    expect(manager.agentsList()).toEqual([]);
    expect(manager.agentsList(null, true)[0])
      .toMatchObject({ id: `${task.pid}.1`, pid: task.pid, name: null, status: 'interrupted' });
    provider.release.resolve();
  });

  test('cancelling a parent wait does not cancel a nested child', async () => {
    const entered = deferred();
    const release = deferred();
    class NestedProvider {
      constructor() {
        this.name = 'nested';
      }

      async call(messages) {
        const pid = contextPid(messages);
        if (pid === 1) {
          return new AgentResponse('', [new ToolCall('child', 'process_call', '{"pid":2,"prompt":"work"}')]);
        }
        entered.resolve();
        await release.promise;
        return new AgentResponse('child done');
      }
    }
    runtime.provider = new NestedProvider();
    const parent = root.createChild('generic-task');
    const child = parent.createChild('generic-task');
    const waiter = parent.call('delegate');
    waiter.catch(() => {});
    await entered.promise;
    manager.kill(parent.pid);
    await expectRejection(waiter, /interrupted/);
    expect(runtime.isBusy(child.pid)).toBe(true);
    expect(child.getParent().pid).toBe(0);
    const execution = runtime.active.get(child.pid).promise;
    release.resolve();
    await execution;
    expect(child.inspect().recent_calls[0].status).toBe('succeeded');
  });

  test('an abandoned waiter keeps the invocation alive', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const task = root.createChild('generic-task');
    const waiter = task.call('work');
    await provider.entered.next();
    // A detached client stops awaiting; the daemon must finish the invocation anyway.
    provider.release.resolve();
    const result = await waiter;
    expect(result.output).toBe('finished');
    expect(runtime.isBusy(task.pid)).toBe(false);
    expect(task.inspect().recent_calls[0].status).toBe('succeeded');
  });

  test('provider error, timeout and round limit are call failures', async () => {
    class Broken {
      constructor() {
        this.name = 'broken';
      }

      async call() {
        throw new LushError('test provider failure', -32020);
      }
    }
    const task = root.createChild('generic-task');
    runtime.provider = new Broken();
    await expectRejection(task.call('fail'), /test provider failure/);
    expect(task.inspect().status).toBe('running');

    runtime.provider = new BlockingProvider();
    runtime.timeout = 0.03;
    await expectRejection(task.call('timeout'), /timed out/);

    class Loop {
      constructor() {
        this.name = 'loop';
      }

      async call() {
        return new AgentResponse('', [new ToolCall('loop', 'process_self', '{}')]);
      }
    }
    runtime.provider = new Loop();
    runtime.maxRounds = 2;
    runtime.timeout = 1;
    await expectRejection(task.call('loop'), /exceeded 2 rounds/);
    expect(task.inspect().recent_calls.every((call) => call.status === 'failed')).toBe(true);
  });

  test('shutdown persists the interruption', async () => {
    const provider = new BlockingProvider();
    runtime.provider = provider;
    const task = root.createChild('generic-task');
    const waiter = task.call('work');
    waiter.catch(() => {});
    await provider.entered.next();
    await runtime.shutdown();
    await expectRejection(waiter);
    expect(runtime.active.size).toBe(0);
    expect(task.inspect().recent_calls[0].status).toBe('interrupted');
  });
});
