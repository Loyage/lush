import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentTools } from '../src/agent/tools.js';
import { MockAgentProvider } from '../src/agent/mock.js';
import { ROOT } from '../src/cli/tree/index.js';
import { formatTaskInbox } from '../src/cli/format/service/tasks.js';
import { RPCClient } from '../src/rpc/client.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { RPCServer } from '../src/rpc/server.js';
import { createSignal } from '../src/signal.js';
import { cleanup, deferred, permissiveRoot, system, tmpdir } from './helpers.js';
import path from 'node:path';

/** Holds the very first invocation open, so a message can arrive mid-flight. */
class FirstCallGate {
  constructor() {
    this.name = 'gate';
    this.contextMode = 'tools';
    this.calls = 0;
    this.entered = deferred();
    this.release = deferred();
    this.inner = new MockAgentProvider();
  }

  async call(messages, tools, signal, invocation) {
    this.calls += 1;
    if (this.calls === 1) {
      this.entered.resolve();
      await this.release.promise;
    }
    return this.inner.call(messages, tools, signal, invocation);
  }
}

describe('task inbox (core)', () => {
  let dir;
  let db;
  let manager;
  let runtime;

  beforeEach(() => {
    dir = tmpdir('lush-inbox-');
    ({ database: db, manager, runtime } = system(dir));
    permissiveRoot(manager);
  });

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  /** parent service + child service + one idle parent task (no agent). */
  function pair() {
    const parentSid = manager.spawn(0, 'generic-service', 'parent').sid;
    const childSid = manager.spawn(parentSid, 'generic-task', 'child').sid;
    const parentTask = manager.spawnTask(null, parentSid, 'parent work', false);
    return { parentSid, childSid, parentTask };
  }

  test('a message is queued, only walks direct parent/child edges, and never wakes a finished task', () => {
    const { parentSid, childSid, parentTask } = pair();
    const childTask = manager.spawnTask(parentTask.id, childSid, 'child work', false);
    const grandSid = manager.spawn(childSid, 'generic-task', 'grand').sid;
    const grandTask = manager.repository.createTask(grandSid, childTask.id, 'grand work', { rootTaskId: parentTask.id });

    const queued = manager.taskMessage(parentTask.id, childTask.id, '把范围收窄到登录接口');
    expect(queued).toMatchObject({
      to_task_id: childTask.id, from_task_id: parentTask.id, kind: 'message',
      body: '把范围收窄到登录接口', delivered_at: null,
    });
    // It sits in the inbox until the task layer hands it over.
    expect(manager.taskInbox(childTask.id)).toHaveLength(1);
    expect(manager.pendingTaskInput(childTask.id)).toBe(1);
    const taken = manager.takeTaskInput(childTask.id);
    expect(taken).toHaveLength(1);
    expect(manager.pendingTaskInput(childTask.id)).toBe(0);
    expect(manager.taskInbox(childTask.id)[0].delivered_at).not.toBeNull();

    // Child → parent is allowed; skipping a level and messaging yourself are not.
    expect(manager.taskMessage(childTask.id, parentTask.id, '进度：一半').kind).toBe('message');
    expect(() => manager.taskMessage(parentTask.id, grandTask.id, 'skip')).toThrow(/not a direct parent or child/);
    expect(() => manager.taskMessage(childTask.id, childTask.id, 'self')).toThrow(/cannot message itself/);
    // The direct parent's *service* is not a task: only task ids are addresses.
    expect(() => manager.taskMessage(parentTask.id, 9999, 'ghost')).toThrow(/task not found/);

    // A terminal receiver is refused, from either direction.
    manager.completeTask(grandTask.id, 'done');
    expect(() => manager.taskMessage(childTask.id, grandTask.id, 'too late')).toThrow(/no longer receive/);
    expect(() => manager.taskMessage(childTask.id, parentTask.id, '')).toThrow(/body must be a non-empty string/);
    expect(manager.inspect(parentSid).sid).toBe(parentSid); // keep parentSid referenced
  });

  test('queueing a message wakes a parked task', async () => {
    const { childSid, parentTask } = pair();
    const childTask = manager.spawnTask(parentTask.id, childSid, 'child work', false);
    const parked = manager.waitForTaskInput(childTask.id);
    manager.taskMessage(parentTask.id, childTask.id, 'wake up');
    await parked; // resolves as soon as anything lands in the inbox
    expect(manager.takeTaskInput(childTask.id)).toHaveLength(1);
  });

  test('a message that arrives mid-invocation is delivered on the next invocation, not interrupting', async () => {
    const gate = new FirstCallGate();
    const gateDir = tmpdir('lush-inbox-gate-');
    const built = system(gateDir, gate);
    permissiveRoot(built.manager);
    try {
      const parentSid = built.manager.spawn(0, 'generic-service', 'parent').sid;
      const childSid = built.manager.spawn(parentSid, 'generic-task', 'child').sid;
      const parentTask = built.manager.spawnTask(null, parentSid, 'parent work', false);

      const childTask = built.manager.spawnTask(parentTask.id, childSid, 'do the thing');
      await gate.entered.promise; // the child's first invocation is in flight
      built.manager.taskMessage(parentTask.id, childTask.id, 'mid-flight note');
      gate.release.resolve();
      await built.manager.waitForTask(childTask.id);

      // The child was invoked twice: the original turn, then the delivered note.
      expect(built.manager.repository.callsOfTask(childTask.id)).toHaveLength(2);
      const bodies = built.manager.taskHistory(childTask.id).messages.map((row) => row.body.content ?? '');
      expect(bodies.some((body) => body.includes('你有新的输入'))).toBe(true);
      expect(bodies.some((body) => body.includes('mid-flight note'))).toBe(true);
    } finally {
      await built.runtime.shutdown();
      built.database.close();
      cleanup(gateDir);
    }
  });

  test("a settling child reports into its parent's inbox", () => {
    const { parentTask } = pair();
    const childSid = manager.spawn(0, 'generic-task', 'child').sid;
    const childTask = manager.repository.createTask(childSid, parentTask.id, 'child work', { rootTaskId: parentTask.id });

    manager.completeTask(childTask.id, { answer: 'shipped' });
    const [row] = manager.taskInbox(parentTask.id);
    expect(row).toMatchObject({
      kind: 'child_settled', from_task_id: childTask.id, to_task_id: parentTask.id,
    });
    expect(row.data).toMatchObject({ task_id: childTask.id, status: 'completed', result: { answer: 'shipped' } });
    // The parent's own event stream records the input.
    expect(manager.repository.taskEvents(parentTask.id)[0]).toMatchObject({ kind: 'child_reported' });
  });

  test('an agent with unread input is refused task_complete until it ends its turn', async () => {
    const { childSid, parentTask } = pair();
    const childTask = manager.repository.createTask(childSid, parentTask.id, 'child work', { rootTaskId: parentTask.id });
    const tools = new AgentTools(manager, childTask.id, childSid);
    manager.taskMessage(parentTask.id, childTask.id, 'read me first');

    const refused = await tools.execute('task_complete', '{}');
    expect(refused.error).toMatchObject({ code: -32010 });
    expect(refused.error.message).toMatch(/unread message/);

    // Once the task layer has delivered it, completing is allowed again.
    manager.takeTaskInput(childTask.id);
    expect((await tools.execute('task_complete', '{"result":"done"}')).result.status).toBe('completed');
  });

  test('deleting a task removes its mailbox in both directions', async () => {
    const { childSid, parentTask } = pair();
    const childTask = manager.repository.createTask(childSid, parentTask.id, 'child work', { rootTaskId: parentTask.id });
    manager.taskMessage(parentTask.id, childTask.id, 'to child');
    manager.taskMessage(childTask.id, parentTask.id, 'to parent');

    manager.cancelTask(childTask.id);
    manager.taskDelete(childTask.id);
    // The deleted task is gone, so its own read model is too; its rows are not.
    expect(manager.repository.listTaskMessages(childTask.id)).toEqual([]);
    expect(manager.taskInbox(parentTask.id)).toEqual([]);
  });

  test('the CLI declares task message / inbox and the inbox renders as text', () => {
    const group = ROOT.children.task;
    expect(Object.keys(group.children)).toContain('message');
    expect(Object.keys(group.children)).toContain('inbox');

    const message = group.children.message;
    const parsed = message.parse(['3']);
    message.options['--body'].apply(parsed, '收窄范围');
    message.options['--from'].apply(parsed, '1');
    message.check(parsed);
    expect(parsed).toMatchObject({ to_task_id: 3, from_task_id: 1, body: '收窄范围' });
    expect(() => message.check(message.parse(['3']))).toThrow(/--body/);

    const { childSid, parentTask } = pair();
    const childTask = manager.repository.createTask(childSid, parentTask.id, 'child work', { rootTaskId: parentTask.id });
    manager.taskMessage(parentTask.id, childTask.id, '把范围收窄');
    expect(formatTaskInbox(manager.taskInbox(childTask.id))).toContain('message task#');
    expect(formatTaskInbox(manager.taskInbox(childTask.id))).toContain('把范围收窄');
  });
});

describe('task inbox over RPC', () => {
  let dir;
  let database;
  let manager;
  let runtime;
  let rpcServer;
  let client;

  beforeEach(async () => {
    dir = tmpdir('lush-inbox-rpc-');
    ({ database, manager, runtime } = system(dir));
    permissiveRoot(manager);
    const socket = path.join(dir, 'lush.sock');
    rpcServer = new RPCServer(socket, new Dispatcher(manager, createSignal()));
    await rpcServer.start();
    client = new RPCClient(socket, 2);
  });

  afterEach(async () => {
    await rpcServer.close();
    await runtime.shutdown();
    database.close();
    cleanup(dir);
  });

  test('task.message and task.inbox travel over the wire', async () => {
    const parentSid = manager.spawn(0, 'generic-service', 'parent').sid;
    const childSid = manager.spawn(parentSid, 'generic-task', 'child').sid;
    const parentTask = manager.spawnTask(null, parentSid, 'parent work', false);
    const childTask = manager.repository.createTask(childSid, parentTask.id, 'child work', { rootTaskId: parentTask.id });

    const sent = await client.request('task.message', {
      from_task_id: parentTask.id, to_task_id: childTask.id, body: 'over the wire',
    });
    expect(sent).toMatchObject({ kind: 'message', body: 'over the wire' });

    const inbox = await client.request('task.inbox', { task_id: childTask.id });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from_task_id: parentTask.id, body: 'over the wire', kind: 'message' });

    const err = await (async () => {
      try {
        await client.request('task.message', { from_task_id: parentTask.id, to_task_id: parentTask.id, body: 'x' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err.code).toBe(-32010);
  });
});
