import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ROOT } from '../src/cli/tree/index.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';
import { cleanup, permissiveRoot, system, tmpdir } from './helpers.js';

/**
 * `lush task construct` must stay inside the task tree it was called from: a
 * delegation that silently becomes a *root* task is invisible to the parent
 * (`task tree` does not show it) and only turns up later as mysterious orphan
 * work. The parent is therefore taken from `$LUSH_TASK_ID` — the convention
 * `task message --from` and `notice post --task` already use — exactly like the
 * built-in runtime's `task_construct` tool takes it from the calling task.
 */
describe('lush task construct: who is the delegating task', () => {
  const construct = ROOT.children.task.children.construct;

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

  test('the parent defaults to $LUSH_TASK_ID and --parent-task-id overrides it', () => {
    withEnv(undefined, () => {
      // Outside an agent there is nobody to delegate for, and a delegation must
      // never silently become a root task (that is what `lush intent` is for).
      const parsed = construct.parse(['8']);
      construct.options['--goal'].apply(parsed, 'work');
      expect(() => construct.check(parsed)).toThrow(/parent task is required/);
    });
    withEnv('19', () => {
      // This is the shape an agent's shell produces: `lush task construct 8 --goal ...`
      expect(construct.parse(['8'])).toEqual({ sid: 8, parent_task_id: 19 });
      const explicit = construct.parse(['8']);
      construct.options['--goal'].apply(explicit, 'work');
      construct.options['--parent-task-id'].apply(explicit, '20');
      construct.check(explicit);
      expect(explicit).toMatchObject({ sid: 8, goal: 'work', parent_task_id: 20 });
    });
  });

  test('a malformed $LUSH_TASK_ID fails loudly instead of becoming a root task', () => {
    for (const bad of ['not-a-task', '0', '-3']) {
      withEnv(bad, () => {
        expect(() => construct.parse(['8'])).toThrow(/\$LUSH_TASK_ID/);
      });
    }
  });
});

describe('task.construct over the wire', () => {
  let dir;
  let database;
  let manager;
  let runtime;
  let dispatcher;

  beforeEach(() => {
    dir = tmpdir('lush-task-construct-');
    ({ database, manager, runtime } = system(dir));
    permissiveRoot(manager);
    dispatcher = new Dispatcher(manager, createSignal());
  });

  afterEach(async () => {
    await runtime.shutdown();
    database.close();
    cleanup(dir);
  });

  test('a delegated task lands inside the tree of the task that delegated it', async () => {
    const parentSid = manager.construct(0, 'generic-service', 'parent').sid;
    const childSid = manager.construct(parentSid, 'generic-task', 'child').sid;
    // Not started: the parent stays active, like an agent that is still working.
    const parent = manager.constructRootTask(parentSid, 'parent work', false);

    const child = await dispatcher.dispatch('task.construct', {
      sid: childSid, goal: 'downstream', parent_task_id: parent.id,
    });
    expect(child).toMatchObject({ sid: childSid, parent_task_id: parent.id, root_task_id: parent.id });
    expect(manager.taskTree(parent.id).children.map((task) => task.id)).toContain(child.id);

    // Without a parent there is no delegation to make: the wire refuses it, so
    // a stray call cannot become a root task outside the intension queue.
    const spareSid = manager.construct(parentSid, 'generic-task', 'spare').sid;
    await expect(
      dispatcher.dispatch('task.construct', { sid: spareSid, goal: 'standalone' }),
    ).rejects.toThrow(/root tasks are created only by the intension dispatcher/);
  });
});
