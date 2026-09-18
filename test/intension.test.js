import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AgentResponse, ToolCall } from '../src/agent/provider.js';
import { MockAgentProvider } from '../src/agent/mock.js';
import { parseArgs } from '../src/cli/parse.js';
import { MAX_ATTEMPTS } from '../src/core/intensions.js';
import { LushError } from '../src/core/types.js';
import { cleanup, deferred, expectRejection, permissiveRoot, system, tmpdir } from './helpers.js';

/**
 * The stock mock, with an optional per-attempt script.
 *
 * A parse task's goal is the user's words verbatim, so the mock already reads
 * the right prompt. The shim exists for the two-attempt tests: the n-th *first*
 * prompt of an invocation runs `actions[n]` instead. It is a test fixture, not
 * part of the runtime.
 */

class ParseMock {
  constructor(actions = []) {
    this.name = 'mock';
    this.contextMode = 'tools';
    this.actions = actions;
    this.attempts = 0;
    this.inner = new MockAgentProvider();
  }

  async call(messages, tools, signal, invocation) {
    const opening = messages.filter((message) => message.role === 'user').length === 1
      && messages.every((message) => message.role !== 'assistant');
    if (!opening || this.actions.length === 0) return this.inner.call(messages, tools, signal, invocation);
    const action = this.actions[this.attempts];
    this.attempts += 1;
    if (action === undefined) return this.inner.call(messages, tools, signal, invocation);
    const rewritten = messages.map((message) => (
      message.role === 'user' ? { ...message, content: action } : message
    ));
    return this.inner.call(rewritten, tools, signal, invocation);
  }
}

/** A provider that always explodes: how a parse task fails without any model. */
class BrokenProvider {
  constructor() {
    this.name = 'mock';
    this.contextMode = 'tools';
  }

  async call() {
    throw new Error('the model is on fire');
  }
}

/**
 * The provider the handoff tests run on: the worker service answers nothing
 * until the test releases the gate (so "the child is still running" is a fact
 * rather than a race), while the parsing node either runs a script of tool calls
 * the test handed it or falls back to the stock mock like every other task.
 */
class GateProvider {
  constructor() {
    this.name = 'mock';
    this.contextMode = 'tools';
    this.workerSid = null;
    this.script = null;
    this.gate = deferred();
    this.inner = new MockAgentProvider();
  }

  /** What the parsing node answers with, as `[tool, args]` pairs, exactly once. */
  answer(calls) {
    this.script = calls;
  }

  async call(messages, tools, signal, invocation) {
    if (invocation.sid === this.workerSid) return this.worker(messages, tools, signal, invocation);
    if (this.script !== null) {
      const calls = this.script;
      this.script = null;
      return new AgentResponse('已安排。', calls.map(([name, args], index) => (
        new ToolCall(`gate_${index}`, name, JSON.stringify(args))
      )));
    }
    return this.inner.call(messages, tools, signal, invocation);
  }

  async worker(messages, tools, signal, invocation) {
    await this.gate.promise;
    return this.inner.call(messages, tools, signal, invocation);
  }
}

/**
 * A home built for the handoff tests: a permissive SID 0, one gated worker
 * service, and the provider wired to both. `gate.resolve()` lets the worker run.
 */
function handoffSystem(dir) {
  const provider = new GateProvider();
  const built = system(dir, provider);
  permissiveRoot(built.manager);
  provider.workerSid = built.manager.construct(0, 'generic-task', 'worker').sid;
  return { ...built, provider };
}

/**
 * The rows still in the queue. `intensionList` mirrors the wire signature, so
 * the third positional is `open` — a helper keeps the assertions readable.
 */
function openRows(manager) {
  return manager.intensionList(null, undefined, true);
}

/** Poll until `predicate` holds; tests use it for "wait until the queue moved". */
async function until(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('the intension queue', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let parseMock;

  beforeEach(() => {
    dir = tmpdir('lush-intension-');
    parseMock = new ParseMock();
    ({ database: db, manager, runtime } = system(dir, parseMock));
  });

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
    cleanup(dir);
  });

  test('an intension becomes one parse task on the parsing node, words verbatim', async () => {
    const row = await manager.submitIntension('把登录功能加上', null, 'test');
    expect(row).toMatchObject({ sid: null, content: '把登录功能加上', source: 'test', status: 'parsing', attempts: 1 });
    expect(row.parse_task_id).not.toBeNull();

    const parse = manager.repository.getTask(row.parse_task_id);
    expect(parse.sid).toBe(0); // the parsing node, the only node that is allowed
    expect(parse.parent_task_id).toBeNull();
    // The goal *is* the user's sentence: verbatim, with nothing wrapped around it.
    expect(parse.goal).toBe('把登录功能加上');

    const settled = await manager.intensionWait(row.id);
    expect(settled.status).toBe('settled');
    expect(settled.response).toContain('SID = 0');
    expect(settled.resolution).toEqual({ kind: 'arranged', task_ids: [] });
    expect(settled.settled_at).not.toBeNull();
    expect(manager.taskInspect(row.parse_task_id).status).toBe('completed');
  });

  test('the queue is serial: while the node is parked, the next row waits', async () => {
    const first = await manager.submitIntension('/tool notice {"title":"冲突"}', null, 'test');
    await until(() => manager.intensionInspect(first.id).status === 'awaiting', 'the row to park');

    const second = await manager.submitIntension('第二件事', null, 'test');
    expect(second.status).toBe('queued');
    expect(second.parse_task_id).toBeNull();
    expect(openRows(manager).map((row) => row.id)).toEqual([second.id, first.id]);

    // The conflict question is linked to the input it is about, both ways.
    const shown = manager.intensionInspect(first.id);
    expect(shown.notices).toHaveLength(1);
    expect(shown.notices[0]).toMatchObject({ kind: 'report', intension_id: first.id, wait: true });
    expect(manager.intensionContext(first.id).parser.busy_task.id).toBe(first.parse_task_id);

    // Answering it wakes the parser, which finishes and hands the node over.
    manager.noticeAnswer(shown.notices[0].id, { text: 'ok' });
    expect((await manager.intensionWait(first.id)).status).toBe('settled');
    const carried = await manager.intensionWait(second.id);
    expect(carried.status).toBe('settled');
    expect(carried.attempts).toBe(1);
  });

  test('a parser that concludes hands its subtree off and frees the node', async () => {
    const home = tmpdir('lush-handoff-');
    const built = handoffSystem(home);
    try {
      const { manager: m, provider } = built;
      const worker = provider.workerSid;
      // The script is in place before the submission: parsing starts at once.
      provider.answer([
        ['task_construct', { sid: worker, goal: '干活' }],
        ['intent_settle', { status: 'settled', response: '已派活' }],
      ]);
      const row = await m.submitIntension('把仓库里的活安排一下', null, 'test');
      await until(() => m.intensionInspect(row.id).status === 'settled', 'the row to settle');

      const settled = m.intensionInspect(row.id);
      expect(settled.response).toBe('已派活');
      expect(settled.resolution.task_ids).toHaveLength(1);
      const childId = settled.resolution.task_ids[0];
      await until(() => m.repository.findTask(childId).status === 'running', 'the child to run');

      // Handed off: the promoted task is a root of its own, and the parser — which
      // did the arranging — is already finished while the work keeps running.
      const child = m.taskInspect(childId);
      expect(child).toMatchObject({ parent_task_id: null, root_task_id: childId, status: 'running' });
      expect(m.taskInspect(row.parse_task_id).status).toBe('completed');
      expect(m.repository.activeTaskOfService(0)).toBeNull();
      expect(m.intensionContext(row.id).parser.busy_task).toBeNull();
      // The chain still opens with the delegation that created it, read from the
      // promoted task's own `detached` event now that there is no parent left.
      expect(m.taskTrace(childId).entries[0]).toMatchObject({
        kind: 'delegated', from_task_id: row.parse_task_id, to_task_id: childId, goal: '干活',
      });
      expect(m.taskInspect(childId).recent_events.some((event) => event.kind === 'detached')).toBe(true);

      // The point of it all: the next input is parsed while that work runs.
      const second = await m.submitIntension('第二件事', null, 'test');
      expect(second.status).toBe('parsing');
      expect((await m.intensionWait(second.id)).status).toBe('settled');
      expect(m.repository.findTask(childId).status).toBe('running');
      expect(m.repository.activeTaskOfService(0)).toBeNull();
    } finally {
      built.provider.gate.resolve();
      await built.runtime.shutdown();
      built.database.close();
      cleanup(home);
    }
  });

  test('settling a parked parser also hands its work over and wakes it', async () => {
    const home = tmpdir('lush-handoff-parked-');
    const built = handoffSystem(home);
    try {
      const { manager: m, provider } = built;
      const row = await m.submitIntension('派活：让它慢慢干', null, 'test');
      await until(() => m.taskInspect(row.parse_task_id).status === 'waiting', 'the parser to park');
      const childId = m.repository.childTasks(row.parse_task_id)[0].id;

      // Someone else closes the row the parser is holding while it waits on the
      // very children it delegated: those are no longer its business.
      m.intensionSettle('settled', '外部下的结论', null, row.id);
      await until(() => m.taskInspect(row.parse_task_id).status === 'completed', 'the parser to finish');
      expect(m.taskInspect(childId)).toMatchObject({ parent_task_id: null, status: 'running' });
      expect(m.intensionInspect(row.id)).toMatchObject({ status: 'settled', response: '外部下的结论' });
      expect(m.repository.activeTaskOfService(0)).toBeNull();
    } finally {
      built.provider.gate.resolve();
      await built.runtime.shutdown();
      built.database.close();
      cleanup(home);
    }
  });

  test('what the parser arranged is derived from its own child tasks', async () => {
    permissiveRoot(manager);
    const worker = manager.construct(0, 'generic-task', 'worker').sid;
    const row = await manager.submitIntension('派活：检查一下这个仓库', null, 'test');

    const settled = await manager.intensionWait(row.id);
    expect(settled.status).toBe('settled');
    expect(settled.resolution.task_ids).toHaveLength(1);
    const child = manager.taskInspect(settled.resolution.task_ids[0]);
    expect(child.sid).toBe(worker);
    expect(child.parent_task_id).toBe(settled.parse_task_id);
    expect(child.status).toBe('completed');
  });

  test('the parser can refuse an input, and a closed row is final', async () => {
    const row = await manager.submitIntension('/tool intent_settle {"status":"rejected","reason":"这不是 Lush 的活"}', null, 'test');
    const settled = await manager.intensionWait(row.id);
    expect(settled.status).toBe('rejected');
    expect(settled.resolution).toMatchObject({ kind: 'rejected', reason: '这不是 Lush 的活' });
    expect(settled.response).toBeNull();

    expect(() => manager.intensionSettle('settled', 'too late', null, row.id))
      .toThrow(/already settled/);
  });

  test('a conflict answered with "wait behind that task" leaves the node free', async () => {
    permissiveRoot(manager);
    const worker = manager.construct(0, 'generic-task', 'worker').sid;
    const blocker = manager.constructRootTask(worker, 'busy work', false);
    // The first parse defers; the second (after the blocker is gone) just answers.
    // The script has to be in place *before* the submission: parsing starts at once.
    parseMock.actions = [`/tool intent_defer {"task_id":${blocker.id},"reason":"那个还在跑"}`, '不着急，回一句就行'];
    const row = await manager.submitIntension('随便什么', null, 'test');

    await until(() => manager.intensionInspect(row.id).status === 'queued', 'the row to be deferred');
    const deferred = manager.intensionInspect(row.id);
    expect(deferred).toMatchObject({ status: 'queued', blocked_by_task_id: blocker.id, parse_task_id: null });
    expect(deferred.resolution).toMatchObject({ kind: 'defer', blocked_by_task_id: blocker.id });
    // Waiting behind a task must not hold the parsing node hostage.
    await until(() => manager.repository.activeTaskOfService(0) === null, 'the node to be free');

    // Nothing starts while the blocker lives...
    expect(openRows(manager)).toHaveLength(1);
    // ...and its settlement puts the row back in line, for a second attempt.
    manager.cancelTask(blocker.id);
    const settled = await manager.intensionWait(row.id);
    expect(settled.status).toBe('settled');
    expect(settled.attempts).toBe(2);
  });

  test('a row the parser never finished goes back to the queue, then is refused', async () => {
    const broken = tmpdir('lush-intension-broken-');
    const failing = system(broken, new BrokenProvider());
    try {
      const row = await failing.manager.submitIntension('谁也解析不了', null, 'test');
      const settled = await failing.manager.intensionWait(row.id);
      expect(settled.status).toBe('rejected');
      expect(settled.attempts).toBe(MAX_ATTEMPTS);
      expect(settled.resolution).toMatchObject({ kind: 'exhausted', attempts: MAX_ATTEMPTS });
    } finally {
      await failing.runtime.shutdown();
      failing.database.close();
      cleanup(broken);
    }
  });

  test('a queued row can be withdrawn, a started one cannot', async () => {
    const first = await manager.submitIntension('/tool notice {"title":"先别动"}', null, 'test');
    await until(() => manager.intensionInspect(first.id).status === 'awaiting', 'the row to park');
    const second = await manager.submitIntension('还没排到', null, 'test');

    const withdrawn = manager.intensionWithdraw(second.id, '改主意了');
    expect(withdrawn.status).toBe('rejected');
    expect(withdrawn.resolution).toEqual({ kind: 'withdrawn', reason: '改主意了' });
    expect(() => manager.intensionWithdraw(first.id)).toThrow(/only a queued intension/);
  });

  test('intent.context carries the architecture and the mechanical precheck', async () => {
    permissiveRoot(manager);
    const worker = manager.construct(0, 'generic-task', 'worker').sid;
    const busy = manager.constructRootTask(worker, 'busy work', false);

    const row = await manager.submitIntension('/tool notice {"title":"再查一下"}', worker, 'test');
    await until(() => manager.intensionInspect(row.id).status === 'awaiting', 'the row to park');
    const snapshot = manager.intensionContext(row.id);

    expect(snapshot.intension).toMatchObject({ id: row.id, sid: worker, content: '/tool notice {"title":"再查一下"}' });
    expect(snapshot.precheck.target).toMatchObject({
      sid: worker, exists: true, status: 'active', is_parser: false,
      active_task: { id: busy.id, goal: 'busy work' },
    });
    expect(snapshot.architecture.templates.map((template) => template.name)).toContain('lush-root');
    const root = snapshot.architecture.services.find((service) => service.sid === 0);
    expect(root.active_task.id).toBe(row.parse_task_id);
    expect(snapshot.parser.sid).toBe(0);
  });

  test('submitting names a service the user has to be right about', async () => {
    await expectRejection(manager.submitIntension('hi', 999, 'test'), /not found/);
    const row = await manager.submitIntension('hi', 0, 'test');
    expect(row.sid).toBe(0);
    // A duplicate is a fact for the parser, not a refusal at submission.
    const again = await manager.submitIntension('hi', 0, 'test');
    expect(again.status).toBe('queued');
    expect(manager.intensionContext(again.id).precheck.duplicates).toEqual([{ id: row.id, status: 'parsing' }]);
  });

  test('root tasks cannot be created outside the dispatcher', () => {
    permissiveRoot(manager);
    const worker = manager.construct(0, 'generic-task', 'worker').sid;
    expect(() => manager.constructTask(null, worker, 'sneak in'))
      .toThrow(/root tasks are created only by the intension dispatcher/);
    expect(() => manager.constructTask(null, 0, 'sneak in'))
      .toThrow(/root tasks are created only by the intension dispatcher/);
    // The internal entry (tests, embedding) still works, and only it does.
    const task = manager.constructRootTask(worker, 'internal', false);
    expect(task).toMatchObject({ sid: worker, parent_task_id: null });
  });

  test('an early settle with nothing to say is filled in by the closing answer', async () => {
    // The parser ends the row before it has anything to report: the response is
    // "nothing said", and the answer it gives when its task finishes fills it in.
    const silent = await manager.submitIntension('/tool intent_settle {"status":"settled"}', null, 'test');
    expect((await manager.intensionWait(silent.id)).response).toBeNull();
    await manager.waitForTask(silent.parse_task_id);
    expect(manager.intensionInspect(silent.id).response).toContain('已执行工具');

    // A response the parser *did* give is never overwritten by the closing answer.
    const said = await manager.submitIntension(
      '/tool intent_settle {"status":"settled","response":"已经安排好了"}', null, 'test',
    );
    expect((await manager.intensionWait(said.id)).response).toBe('已经安排好了');
    await manager.waitForTask(said.parse_task_id);
    expect(manager.intensionInspect(said.id).response).toBe('已经安排好了');
  });

  test('a parse task may only be settled by the task holding it', async () => {
    const row = await manager.submitIntension('/tool notice {"title":"谁来都行"}', null, 'test');
    await until(() => manager.intensionInspect(row.id).status === 'awaiting', 'the row to park');
    expect(() => manager.intensionSettleFromTask(9999, 'settled')).toThrow(/not parsing an intension/);
    expect(() => manager.intensionContextOfTask(9999)).toThrow(/not parsing an intension/);
    expect(() => manager.intensionSettle('settled', null, null, null, null)).toThrow(LushError);
  });
});

/**
 * The CLI contract the parser itself depends on: `lush intent settle --status …`
 * with no id at all. `parse` sees the whole token list, so an optional leading
 * positional must not swallow the first flag — the row is addressed through
 * `$LUSH_TASK_ID`, which is the only handle an agent has.
 */
describe('the intent command line', () => {
  function withEnv(value, body) {
    const before = process.env.LUSH_TASK_ID;
    if (value === undefined) delete process.env.LUSH_TASK_ID;
    else process.env.LUSH_TASK_ID = value;
    try {
      return body();
    } finally {
      if (before === undefined) delete process.env.LUSH_TASK_ID;
      else process.env.LUSH_TASK_ID = before;
    }
  }

  test('the parser settles its own row with flags only', () => {
    withEnv('19', () => {
      expect(parseArgs(['intent', 'settle', '--status', 'settled', '--response', 'done']))
        .toMatchObject({ command: 'intent_settle', from_task_id: 19, status: 'settled', response: 'done' });
      expect(parseArgs(['intent', 'context'])).toMatchObject({ command: 'intent_context', from_task_id: 19 });
      expect(parseArgs(['intent', 'defer', '--blocked-by', '7']))
        .toMatchObject({ command: 'intent_defer', from_task_id: 19, blocked_by_task_id: 7 });
    });
  });

  test('a named row wins over the environment, and both work outside a task', () => {
    withEnv('19', () => {
      expect(parseArgs(['intent', 'settle', '12', '--status', 'rejected', '--reason', 'no']))
        .toMatchObject({ intension_id: 12, from_task_id: 19, status: 'rejected', reason: 'no' });
    });
    withEnv(undefined, () => {
      expect(parseArgs(['intent', 'show', '3'])).toMatchObject({ command: 'intent_show', intension_id: 3 });
      expect(() => parseArgs(['intent', 'context'])).toThrow(/name the intension/);
    });
  });

  test('a task may not submit user input, and submit is words first', () => {
    withEnv('19', () => {
      expect(() => parseArgs(['intent', 'submit', '你好'])).toThrow(/not yours to submit/);
    });
    // Inside a task `submit` is refused, so the words-first shape is checked
    // without one: the ambient environment must not decide what this asserts.
    withEnv(undefined, () => {
      expect(parseArgs(['intent', 'submit', '你好', '--sid', '2']))
        .toMatchObject({ command: 'intent_submit', content: '你好', sid: 2, source: 'cli' });
      expect(() => parseArgs(['intent', 'submit', '你好', '--wait', '--interactive'])).toThrow(/--wait/);
    });
  });
});
