import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse, ToolCall } from '../src/agent/provider.js';
import { AgentTools } from '../src/agent/tools.js';
import { LushError } from '../src/core/types.js';
import { cleanup, contextPid, deferred, expectRejection, queue, system, tmpdir } from './helpers.js';

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
    root = manager.load(0);
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
      ['process_self', '[]'],
      ['process_self', 'bad-json'],
      ['process_inspect', '{"pid":true}'],
      ['shell', '{}'],
    ]) {
      expect((await tools.execute(name, args)).error).toBeDefined();
    }
    manager.complete(task.pid);
    expect((await tools.execute('process_spawn', '{"template":"generic-task"}')).error).toBeDefined();
    expect((await tools.execute('process_self', '{}')).result).toBeDefined();
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
