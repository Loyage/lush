import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ROOT } from '../src/cli/tree/index.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';
import { cleanup, permissiveRoot, system, tmpdir } from './helpers.js';

/**
 * `lush task spawn` must stay inside the task tree it was called from: a
 * delegation that silently becomes a *root* task is invisible to the parent
 * (`task tree` does not show it) and only turns up later as mysterious orphan
 * work. The parent is therefore taken from `$LUSH_TASK_ID` — the convention
 * `task message --from` and `notice post --task` already use — exactly like the
 * built-in runtime's `task_spawn` tool takes it from the calling task.
 */
describe('lush task spawn: who is the delegating task', () => {
  const spawn = ROOT.children.task.children.spawn;

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
      // Outside an agent there is nobody to delegate for: still a root task.
      expect(spawn.parse(['8'])).toEqual({ sid: 8 });
    });
    withEnv('19', () => {
      // This is the shape an agent's shell produces: `lush task spawn 8 --goal ...`
      expect(spawn.parse(['8'])).toEqual({ sid: 8, parent_task_id: 19 });
      const explicit = spawn.parse(['8']);
      spawn.options['--goal'].apply(explicit, 'work');
      spawn.options['--parent-task-id'].apply(explicit, '20');
      spawn.check(explicit);
      expect(explicit).toMatchObject({ sid: 8, goal: 'work', parent_task_id: 20 });
    });
  });

  test('a malformed $LUSH_TASK_ID fails loudly instead of becoming a root task', () => {
    for (const bad of ['not-a-task', '0', '-3']) {
      withEnv(bad, () => {
        expect(() => spawn.parse(['8'])).toThrow(/\$LUSH_TASK_ID/);
      });
    }
  });
});

describe('task.spawn over the wire', () => {
  let dir;
  let database;
  let manager;
  let runtime;
  let dispatcher;

  beforeEach(() => {
    dir = tmpdir('lush-task-spawn-');
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
    const parentSid = manager.spawn(0, 'generic-service', 'parent').sid;
    const childSid = manager.spawn(parentSid, 'generic-task', 'child').sid;
    // Not started: the parent stays active, like an agent that is still working.
    const parent = manager.spawnTask(null, parentSid, 'parent work', false);

    const child = await dispatcher.dispatch('task.spawn', {
      sid: childSid, goal: 'downstream', parent_task_id: parent.id,
    });
    expect(child).toMatchObject({ sid: childSid, parent_task_id: parent.id, root_task_id: parent.id });
    expect(manager.taskTree(parent.id).children.map((task) => task.id)).toContain(child.id);

    // Without a parent it is a root task, which is why the CLI must supply one.
    const spareSid = manager.spawn(parentSid, 'generic-task', 'spare').sid;
    const standalone = await dispatcher.dispatch('task.spawn', { sid: spareSid, goal: 'standalone' });
    expect(standalone.parent_task_id).toBeNull();
  });
});
