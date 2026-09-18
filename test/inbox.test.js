import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentTools } from '../src/agent/tools.js';
import { MockAgentProvider } from '../src/agent/mock.js';
import { ROOT } from '../src/cli/tree/index.js';
import { formatTaskInbox, formatTaskTrace } from '../src/cli/format/service/tasks.js';
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
    const parentSid = manager.construct(0, 'generic-service', 'parent').sid;
    const childSid = manager.construct(parentSid, 'generic-task', 'child').sid;
    const parentTask = manager.constructTask(null, parentSid, 'parent work', false);
    return { parentSid, childSid, parentTask };
  }

  test('a message is queued, only walks direct parent/child edges, and never wakes a finished task', () => {
    const { parentSid, childSid, parentTask } = pair();
    const childTask = manager.constructTask(parentTask.id, childSid, 'child work', false);
    const grandSid = manager.construct(childSid, 'generic-task', 'grand').sid;
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
    const childTask = manager.constructTask(parentTask.id, childSid, 'child work', false);
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
      const parentSid = built.manager.construct(0, 'generic-service', 'parent').sid;
      const childSid = built.manager.construct(parentSid, 'generic-task', 'child').sid;
      const parentTask = built.manager.constructTask(null, parentSid, 'parent work', false);

      const childTask = built.manager.constructTask(parentTask.id, childSid, 'do the thing');
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
    const childSid = manager.construct(0, 'generic-task', 'child').sid;
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
    const parentSid = manager.construct(0, 'generic-service', 'parent').sid;
    const childSid = manager.construct(parentSid, 'generic-task', 'child').sid;
    const parentTask = manager.constructTask(null, parentSid, 'parent work', false);
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

  test('task.trace travels over the wire', async () => {
    const parentSid = manager.construct(0, 'generic-service', 'parent').sid;
    const childSid = manager.construct(parentSid, 'generic-task', 'child').sid;
    const parentTask = manager.constructTask(null, parentSid, 'parent work', false);
    const childTask = manager.repository.createTask(childSid, parentTask.id, 'child work', { rootTaskId: parentTask.id });
    manager.taskMessage(parentTask.id, childTask.id, 'over the wire');

    const trace = await client.request('task.trace', { task_id: parentTask.id });
    expect(trace).toMatchObject({ task_id: parentTask.id, total: 1, truncated: false });
    expect(trace.entries[0]).toMatchObject({ kind: 'message', body: 'over the wire', delivered_at: null });
    await expect(client.request('task.trace', { task_id: parentTask.id, limit: 0 })).rejects.toThrow(/limit/);
  });
});

describe('task trace (调用链)', () => {
  let dir;
  let db;
  let manager;
  let runtime;

  beforeEach(() => {
    dir = tmpdir('lush-trace-');
    ({ database: db, manager, runtime } = system(dir));
    permissiveRoot(manager);
  });

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  /**
   * root task → child task → grandchild task, plus a second unrelated root task
   * in its own service subtree: a trace must never mix the two.
   */
  function collaboration() {
    const parentSid = manager.construct(0, 'generic-service', 'parent').sid;
    const childSid = manager.construct(parentSid, 'generic-task', 'child').sid;
    const grandSid = manager.construct(childSid, 'generic-task', 'grand').sid;
    const otherSid = manager.construct(0, 'generic-service', 'other').sid;

    const root = manager.constructTask(null, parentSid, 'root work', false);
    const child = manager.constructTask(root.id, childSid, 'child work', false);
    const grand = manager.constructTask(child.id, grandSid, 'grand work', false);

    const otherRoot = manager.constructTask(null, otherSid, 'other root', false);
    const otherChildSid = manager.construct(otherSid, 'generic-task', 'other child').sid;
    const otherChild = manager.constructTask(otherRoot.id, otherChildSid, 'other work', false);
    manager.taskMessage(otherRoot.id, otherChild.id, '另一棵树');
    return { root, child, grand, otherRoot, otherChild };
  }

  test('is the subtree timeline: delegations, both message directions and settlements', () => {
    const { root, child, grand } = collaboration();
    manager.taskMessage(root.id, child.id, '把范围收窄');
    manager.taskMessage(child.id, root.id, '进度：一半');
    manager.completeTask(grand.id, 'grand done');
    manager.completeTask(child.id, 'child done');

    const trace = manager.taskTrace(root.id);
    expect(trace).toMatchObject({ task_id: root.id, total: 6, truncated: false });
    expect(trace.entries.map((entry) => `${entry.kind} ${entry.from_task_id}->${entry.to_task_id}`)).toEqual([
      `delegated ${root.id}->${child.id}`,
      `delegated ${child.id}->${grand.id}`,
      `message ${root.id}->${child.id}`,
      `message ${child.id}->${root.id}`,
      `child_settled ${grand.id}->${child.id}`,
      `child_settled ${child.id}->${root.id}`,
    ]);
    // The delegation carries the goal it was given; the settlement its outcome.
    expect(trace.entries[0]).toMatchObject({
      from_service: 'parent', to_service: 'child', goal: 'child work', delivered_at: null,
    });
    expect(trace.entries[2]).toMatchObject({ from_service: 'parent', to_service: 'child', body: '把范围收窄' });
    expect(trace.entries[4]).toMatchObject({ status: 'completed', result: 'grand done' });
    // The unrelated root task's traffic stays out of this subtree.
    expect(trace.entries.some((entry) => entry.from_service === 'other' || entry.to_service === 'other')).toBe(false);
    // A message to the parent is an outbound edge of the subtree, so it is here.
    expect(trace.entries.some((entry) => entry.to_task_id === root.id)).toBe(true);

    // “Either end in the subtree” holds for delegations too: the child's own
    // chain opens with the delegation that created it, though that event is
    // stored on its parent (outside the child's subtree).
    const childTrace = manager.taskTrace(child.id);
    expect(childTrace.total).toBe(6);
    expect(childTrace.entries[0]).toMatchObject({
      kind: 'delegated', from_task_id: root.id, to_task_id: child.id, goal: 'child work',
    });
  });

  test('keeps only the newest steps, and says how many it left out', () => {
    const { root, child, grand } = collaboration();
    manager.taskMessage(root.id, child.id, '一');
    manager.taskMessage(child.id, root.id, '二');
    manager.completeTask(grand.id, 'done');

    const tail = manager.taskTrace(root.id, 2);
    expect(tail.total).toBe(5);
    expect(tail.truncated).toBe(true);
    expect(tail.entries.map((entry) => entry.kind)).toEqual(['message', 'child_settled']);
    expect(tail.entries.at(-1)).toMatchObject({ from_task_id: grand.id, to_task_id: child.id, status: 'completed' });

    const all = manager.taskTrace(root.id, 1000);
    expect(all.entries).toHaveLength(5);
    expect(all.truncated).toBe(false);

    expect(() => manager.taskTrace(root.id, 0)).toThrow(/limit/);
    expect(() => manager.taskTrace(root.id, 1001)).toThrow(/limit/);
    expect(() => manager.taskTrace(9999)).toThrow(/task not found/);
  });

  test('is derived: deleting a task takes its inbox rows, and the read model follows', () => {
    const { root, grand } = collaboration();
    manager.completeTask(grand.id, 'grand done');
    expect(manager.taskTrace(root.id).entries).toHaveLength(3);

    manager.taskDelete(grand.id);
    const after = manager.taskTrace(root.id);
    // The delegation step survives — it is the *parent's* own event — and still
    // names the child's service (the event carries the sid). The settlement the
    // deleted task sent is gone with its inbox rows.
    expect(after.entries.map((entry) => entry.kind)).toEqual(['delegated', 'delegated']);
    expect(after.entries[1]).toMatchObject({ to_task_id: grand.id, to_service: 'grand', goal: 'grand work' });
  });

  test('a settled notice is one more step on the chain (and the CLI renders it)', () => {
    const { root } = collaboration();
    const notice = manager.postNotice({
      taskId: root.id, kind: 'decision', title: '选一个', fields: [{ name: 'plan', type: 'choice', options: ['A', 'B'] }],
    });
    manager.noticeAnswer(notice.id, { plan: 'A' });

    const trace = manager.taskTrace(root.id);
    const step = trace.entries.find((entry) => entry.kind === 'notice_settled');
    expect(step).toMatchObject({
      from_task_id: null,
      to_task_id: root.id,
      notice_id: notice.id,
      status: 'answered',
      result: { plan: 'A' },
      body: '选一个',
      delivered_at: null,
    });
    const text = formatTaskTrace(trace);
    expect(text).toContain('notice_settled');
    expect(text).toContain(`notice#${notice.id} answered`);
  });

  test('the CLI declares task trace and the chain renders as text', () => {
    const group = ROOT.children.task;
    expect(Object.keys(group.children)).toContain('trace');
    const command = group.children.trace;
    expect(command.method).toBe('task.trace');
    expect(command.parse(['1'])).toEqual({ task_id: 1, limit: 200 });
    const parsed = command.parse(['1']);
    command.options['--limit'].apply(parsed, '5');
    expect(parsed).toEqual({ task_id: 1, limit: 5 });

    const { root, child, grand } = collaboration();
    manager.taskMessage(root.id, child.id, '把范围收窄');
    manager.completeTask(grand.id, 'grand done');

    const text = formatTaskTrace(manager.taskTrace(root.id));
    expect(text.split('\n')[0]).toBe(`task #${root.id} · 调用链 4 步`);
    expect(text).toContain('delegated');
    expect(text).toContain(`#${root.id} parent[`);
    expect(text).toContain('→');
    expect(text).toContain('把范围收窄');
    expect(text).toContain('grand done');

    const truncated = formatTaskTrace(manager.taskTrace(root.id, 2));
    expect(truncated.split('\n')[0]).toBe(`task #${root.id} · 调用链 2 步（共 4 步，只显示最近的 2 步）`);
    expect(formatTaskTrace({ task_id: 9, entries: [], total: 0, truncated: false }))
      .toContain('还没有与其他 task 的往来');
  });
});
