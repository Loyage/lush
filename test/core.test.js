import fs from 'node:fs';
import path from 'node:path';
import { Database as SQLite } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ContextBuilder } from '../src/context/builder.js';
import { agentGuide } from '../src/agent/guide.js';
import { DEFAULT_ORPHAN_POLICY, normalizeOrphanPolicy } from '../src/core/orphans.js';
import { LushError } from '../src/core/types.js';
import { TemplateLoader } from '../src/template_loader.js';
import { cleanup, permissiveRoot, SlowProvider, system, tmpdir } from './helpers.js';

describe('core', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let root;

  beforeEach(() => {
    dir = tmpdir('lush-core-');
    ({ database: db, manager, runtime } = system(dir));
    root = permissiveRoot(manager);
  });

  afterEach(async () => {
    try {
      await runtime.shutdown();
    } catch {
      /* already shut down */
    }
    try {
      db.close();
    } catch {
      /* already closed by a restart test */
    }
    cleanup(dir);
  });

  function code(fn) {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  }

  test('root and persistent handles', () => {
    expect(root.inspect().name).toBe('lush');
    expect(root.inspect().status).toBe('active');
    expect(root.getParent()).toBeNull();
    expect(root.inspect().type).toBeUndefined();
    manager.ensureRoot();
    expect(manager.list().length).toBe(1);

    const a = root.createChild('generic-service', { name: 'pm' });
    const b = a.createChild('generic-task', { goal: 'implement login' });
    expect([a.pid, b.pid]).toEqual([1, 2]);
    expect(b.getParent().pid).toBe(1);
    expect(a.getChildren()[0].pid).toBe(2);
    expect(b.inspect().goal).toBe('implement login');
    // A process is passive: creating it starts no agent and creates no task.
    expect(manager.repository.activeTasks()).toEqual([]);
  });

  /** Spawn a process and keep the PID handle (the tests read it like the old ones did). */
  function spawn(parent, template, name, goal, variables) {
    return manager.load(manager.spawn(parent, template, name, goal, variables).pid);
  }

  /** A child process of PID 0 that is ready to be given work. */
  function worker(template = 'generic-task', name = 'worker') {
    return spawn(0, template, name).pid;
  }

  test('call creates a root task, runs it and returns its result', async () => {
    const pid = worker();
    const task = await manager.call(pid, 'do the thing');
    expect(task).toMatchObject({ pid, status: 'completed', parent_task_id: null });
    expect(task.root_task_id).toBe(task.id);
    expect(String(task.result)).toContain('[Mock]');
    // The conversation belongs to the task, and the call row carries both ids.
    expect(manager.taskHistory(task.id).messages.length).toBeGreaterThan(0);
    const calls = manager.repository.callsOfTask(task.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pid, task_id: task.id, status: 'succeeded' });
    expect(manager.taskList(pid).map((row) => row.id)).toEqual([task.id]);
    expect(manager.taskResult(task.id)).toMatchObject({ finished: true, status: 'completed' });
  });

  test('detached call returns the task while it still runs', async () => {
    const pid = worker();
    const task = await manager.call(pid, 'do the thing', true);
    expect(task.status === 'running' || task.status === 'created' || task.status === 'completed').toBe(true);
    const settled = await manager.taskWait(task.id);
    expect(settled.status).toBe('completed');
  });

  test('one process runs at most one task at a time', async () => {
    const pid = worker();
    const first = manager.repository.createTask(pid, null, 'first');
    expect(() => manager.spawnTask(null, pid, 'second')).toThrow(/already working on task/);
    manager.cancelTask(first.id);
    // Once the first one is finished the process is free again.
    const second = await manager.call(pid, 'second');
    expect(second.id).not.toBe(first.id);
  });

  test('a task may only delegate to a direct child process', () => {
    const parent = spawn(0, 'generic-service', 'parent');
    const child = spawn(parent.pid, 'generic-task', 'child');
    const grandchild = spawn(child.pid, 'generic-task', 'grandchild');
    const task = manager.repository.createTask(parent.pid, null, 'delegate');

    // A direct child process is the only legal target, and the child task
    // inherits the root of the tree it belongs to.
    const sub = manager.spawnTask(task.id, child.pid, 'downstream');
    expect(sub).toMatchObject({ pid: child.pid, parent_task_id: task.id, root_task_id: task.id });
    expect(() => manager.spawnTask(task.id, grandchild.pid, 'skip a level')).toThrow(/only delegate downstream/);
    expect(() => manager.spawnTask(task.id, parent.pid, 'its own process')).toThrow(/cannot delegate to its own process/);
    manager.cancelTask(task.id);
  });

  test('delegating downstream runs the child task and wakes the parent', async () => {
    // A slow provider makes the delegation observable: the parent answers
    // before its child is done, is parked in `waiting`, and is then woken.
    const slowDir = tmpdir('lush-core-slow-');
    // The child is the slow one: the parent is guaranteed to answer while its
    // child task is still running, which is the path being tested.
    const built = system(slowDir, new SlowProvider(
      (invocation) => (invocation?.context?.process?.name === 'kid' ? 300 : 5),
    ));
    permissiveRoot(built.manager);
    try {
      const parent = built.manager.spawn(0, 'generic-service', 'pm');
      const child = built.manager.spawn(parent.pid, 'generic-task', 'kid');
      const task = await built.manager.call(parent.pid, '把这活派给下游');
      expect(task.status).toBe('completed');
      const children = built.manager.taskList(null, null, 'children');
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ pid: child.pid, parent_task_id: task.id, status: 'completed' });
      // The parent's own run was invoked twice: delegate, then finish after the wake.
      expect(built.manager.repository.callsOfTask(task.id)).toHaveLength(2);
      // The wake prompt is part of the task's own conversation, not another task's.
      const messages = built.manager.taskHistory(task.id).messages.map((row) => row.body.content ?? '');
      expect(messages.some((body) => body.includes('你的子 task 已经结束'))).toBe(true);
      // And the tree shows the collaboration.
      const tree = built.manager.taskTree(task.id);
      expect(tree.children.map((node) => node.id)).toEqual([children[0].id]);
    } finally {
      await built.runtime.shutdown();
      built.database.close();
      cleanup(slowDir);
    }
  });

  test('task completion waits for the children, and terminating cascades', async () => {
    const parent = spawn(0, 'generic-service', 'parent');
    const child = spawn(parent.pid, 'generic-task', 'child');
    const task = manager.spawnTask(null, parent.pid, 'parent work');
    // Parked on purpose: a child task that is still active, without an agent.
    const sub = manager.repository.createTask(child.pid, task.id, 'child work', { rootTaskId: task.id });

    // Not while the child task is active.
    expect(() => manager.completeTask(task.id, 'done')).toThrow(/active child tasks/);
    manager.cancelTask(sub.id);
    const done = manager.completeTask(task.id, { answer: 'shipped' });
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({ answer: 'shipped' });
    expect(manager.repository.childTasks(task.id)[0].status).toBe('cancelled');

    // Cancelling a task cancels its whole subtree.
    const one = manager.repository.createTask(parent.pid, null, 'one');
    const two = manager.repository.createTask(child.pid, one.id, 'two', { rootTaskId: one.id });
    const cancelled = manager.cancelTask(one.id);
    expect(cancelled.status).toBe('cancelled');
    expect(manager.repository.getTask(two.id).status).toBe('cancelled');
    expect(manager.taskResult(one.id)).toMatchObject({ finished: true, status: 'cancelled' });
  });

  test('a task may only wait on its own subtree, and never on itself', async () => {
    const parent = spawn(0, 'generic-service', 'parent');
    const child = spawn(parent.pid, 'generic-task', 'child');
    const other = spawn(0, 'generic-task', 'other');
    const task = manager.repository.createTask(parent.pid, null, 'parent work');
    const mine = manager.repository.createTask(child.pid, task.id, 'child work', { rootTaskId: task.id });
    const theirs = manager.repository.createTask(other.pid, null, 'unrelated');
    expect(() => manager.waitForTask(theirs.id, task.id)).toThrow(/not part of task/);
    expect(() => manager.waitForTask(task.id, task.id)).toThrow(/cannot wait on itself/);
    manager.completeTask(mine.id, 'done');
    await manager.waitForTask(mine.id, task.id);
    manager.cancelTask(theirs.id);
    manager.completeTask(task.id, 'done');
  });

  test('tasks can be listed, inspected and deleted', async () => {
    const pid = worker();
    const task = await manager.call(pid, 'do the thing');
    expect(manager.taskList(null, 'completed').map((row) => row.id)).toContain(task.id);
    expect(manager.taskList(null, null, 'roots').map((row) => row.id)).toContain(task.id);
    expect(code(() => manager.taskList(null, 'nope'))).toBe(-32602);
    expect(code(() => manager.taskHistory(task.id, -1, 10))).toBe(-32602);

    const info = manager.taskInspect(task.id);
    expect(info.process).toMatchObject({ pid, status: 'active' });
    expect(info.recent_calls).toHaveLength(1);
    expect(info.messages).toBeGreaterThan(0);

    const deleted = manager.taskDelete(task.id);
    expect(deleted.deleted).toEqual([task.id]);
    expect(manager.repository.findTask(task.id)).toBeNull();
    expect(code(() => manager.taskInspect(task.id))).toBe(-32004);
    // The call rows stay: they are the process's durable history.
    expect(manager.repository.callsOfTask(task.id)).toEqual([]);
    expect(manager.repository.calls(pid).length).toBe(1);
  });

  test('update-state writes the task scratch and the process keeps its own state', async () => {
    const pid = worker();
    const task = manager.repository.createTask(pid, null, 'work');
    expect(manager.updateTaskState(task.id, { progress: 'half' })).toEqual({ progress: 'half' });
    expect(manager.taskInspect(task.id).state).toEqual({ progress: 'half' });
    expect(code(() => manager.updateTaskState(task.id, []))).toBe(-32602);
    manager.updateState(pid, { knowledge: 'shared' });
    expect(manager.inspect(pid).context.state).toEqual({ knowledge: 'shared' });
    manager.cancelTask(task.id);
  });

  test('process lifecycle: created → active → stopped, and stop refuses live work', async () => {
    const pid = worker();
    manager.stop(pid);
    expect(manager.inspect(pid).status).toBe('stopped');
    manager.stop(pid); // idempotent
    expect(code(() => manager.spawnTask(null, pid, 'work'))).toBe(-32009);
    expect(code(() => manager.start(pid))).toBeNull();
    expect(manager.inspect(pid).status).toBe('active');

    const task = manager.spawnTask(null, pid, 'work');
    expect(() => manager.stop(pid)).toThrow(/working on task/);
    manager.cancelTask(task.id);
    manager.stop(pid);
    expect(manager.inspect(pid).status).toBe('stopped');

    // The process state machine is small and closed.
    for (const method of ['start', 'stop', 'delete', 'purge']) {
      expect(() => manager[method](0)).toThrow(LushError);
    }
  });

  test('stop adopts active children; restart does not take them back', () => {
    const parent = spawn(0, 'generic-service', 'parent');
    const child = parent.createChild('generic-task', { name: 'kid' });
    manager.stop(parent.pid);
    expect(child.getParent().pid).toBe(0);
    expect(child.inspect().original_parent_pid).toBe(parent.pid);
    manager.start(parent.pid);
    expect(child.getParent().pid).toBe(0);
    const event = child.inspect().recent_events[0];
    expect(event.kind).toBe('reparented');
    expect(event.data).toEqual({ from: parent.pid, to: 0, reason: 'stopped' });
  });

  test('delete removes a stopped process, its tasks and every row they owned', async () => {
    const parent = spawn(0, 'generic-service', 'parent');
    const child = spawn(parent.pid, 'generic-service', 'child');
    const grandchild = spawn(child.pid, 'generic-task', 'grandchild');
    const task = await manager.call(grandchild.pid, 'work');
    manager.updateState(child.pid, { progress: 'half' });
    // Stop the leaf first: stopping `child` would hand its *active* children to
    // PID 0, and then they would not be part of the deleted subtree.
    manager.stop(grandchild.pid);
    manager.stop(child.pid);

    expect(code(() => manager.delete(child.pid, 'yes'))).toBe(-32602);
    const result = manager.delete(child.pid, true);
    expect(result.status).toBe('stopped');
    expect(result.deleted).toEqual([child.pid, grandchild.pid].sort((left, right) => left - right));
    expect(result.rows.tasks).toBe(1);
    expect(manager.repository.findTask(task.id)).toBeNull();
    expect(() => manager.inspect(child.pid)).toThrow(/not found/);
    expect(() => manager.taskInspect(task.id)).toThrow(/not found/);
    expect(parent.getChildren()).toEqual([]);
    const event = manager.repository.events(parent.pid, 1)[0];
    expect(event.kind).toBe('child_deleted');
    expect(event.data).toMatchObject({ pid: child.pid, template: 'generic-service', status: 'stopped' });
  });

  test('delete refuses live work, children and PID 0', () => {
    const running = spawn(0, 'generic-task', 'busy');
    expect(code(() => manager.delete(running.pid))).toBe(-32010);
    expect(() => manager.delete(running.pid)).toThrow(/stop it first/);
    expect(code(() => manager.delete(0))).toBe(-32010);
    expect(() => manager.purge(0)).toThrow(/PID 0 is managed by the daemon/);
    expect(() => manager.delete(running.pid + 99)).toThrow(/not found/);

    const parent = spawn(0, 'generic-service', 'parent');
    parent.createChild('generic-task', { name: 'kid' });
    expect(() => manager.delete(parent.pid)).toThrow(/has children/);
    expect(() => manager.purge(parent.pid)).toThrow(/has children/);

    // A task still running on the process is refused too, and purge cancels it.
    const task = manager.spawnTask(null, running.pid, 'work');
    expect(() => manager.delete(running.pid)).toThrow(/task .* is (created|running|waiting)/);
    const purged = manager.purge(running.pid);
    expect(purged.cancelled).toEqual([task.id]);
    expect(manager.list().map((item) => item.pid)).toEqual([0, parent.pid, parent.getChildren()[0].pid]);
  });

  test('purge cancels the whole subtree before removing it, without adopting', () => {
    const parent = spawn(0, 'generic-service', 'parent');
    const child = spawn(parent.pid, 'generic-task', 'child');
    const grandchild = spawn(child.pid, 'generic-task', 'grandchild');
    const pids = [parent.pid, child.pid, grandchild.pid];
    const result = manager.purge(parent.pid, true);
    expect(result.deleted).toEqual(pids);
    expect(result.terminated).toEqual(pids);
    expect(result.status).toBe('active');
    expect(manager.list().map((item) => item.pid)).toEqual([0]);
    expect(manager.repository.events(0, 20).map((event) => event.kind)).not.toContain('reparented');
    expect(manager.repository.events(0, 1)[0]).toMatchObject({ kind: 'child_deleted', data: { pid: parent.pid } });
  });

  test('delete repairs surviving links to the pid it removes', () => {
    const creator = spawn(0, 'generic-service', 'creator');
    const adopted = spawn(creator.pid, 'generic-service', 'adopted');
    manager.stop(creator.pid);
    expect(adopted.inspect().parent_pid).toBe(0);
    expect(adopted.inspect().original_parent_pid).toBe(creator.pid);

    manager.delete(creator.pid);
    const survivor = adopted.inspect();
    expect(survivor.parent_pid).toBe(0);
    expect(survivor.original_parent_pid).toBe(0);
    expect(survivor.recent_events[0]).toMatchObject({
      kind: 'parent_deleted',
      data: { pid: creator.pid, name: 'creator', template: 'generic-service', status: 'stopped' },
    });
  });

  test('template restrictions and creation-time snapshot', () => {
    const template = manager.templates.get('generic-task');
    manager.templates.register({ ...template, name: 'restricted-task', child_templates: ['research-task'] });
    const parent = spawn(0, 'restricted-task', 'restricted');
    spawn(parent.pid, 'research-task', 'researcher');
    expect(code(() => spawn(parent.pid, 'generic-service', 'nope'))).toBe(-32010);
    manager.templates.templates['restricted-task'].child_templates = ['*'];
    expect(() => spawn(parent.pid, 'generic-service', 'nope')).toThrow(LushError);
    expect(() => spawn(0, 'no-such-template', 'x')).toThrow(LushError);
    expect(() => spawn(0, 'lush-root', 'x')).toThrow(/reserved/);
  });

  test('singleton templates allow one active instance per parent', () => {
    const template = manager.templates.get('generic-service');
    manager.templates.register({ ...template, name: 'one-per-parent', singleton: true });
    const parent = spawn(0, 'generic-service', 'parent');
    const first = spawn(parent.pid, 'one-per-parent', 'first');
    expect(code(() => spawn(parent.pid, 'one-per-parent', 'second'))).toBe(-32010);
    // Singleton is per parent PID, not system-wide.
    expect(spawn(0, 'one-per-parent', 'other').inspect().parent_pid).toBe(0);
    // Only active instances occupy the slot.
    manager.stop(first.pid);
    expect(spawn(parent.pid, 'one-per-parent', 'third').pid).not.toBe(first.pid);
    // Non-singleton templates stay unrestricted.
    const plain = spawn(parent.pid, 'generic-task', 'plain');
    expect(spawn(parent.pid, 'generic-task', 'plain-2').pid).not.toBe(plain.pid);
  });

  test('dev-task declares name / title / detail as checked fields', () => {
    const template = manager.templates.get('dev-task');
    expect(template).toMatchObject({ singleton: false, child_templates: ['worktree-service'] });
    expect(template.type).toBeUndefined();
    expect(template.variables.immutable.name)
      .toMatchObject({ required: true, pattern: '^[A-Za-z][A-Za-z0-9_-]*$', max_length: 64 });
    expect(template.variables.immutable.title).toMatchObject({ required: true, max_length: 200, single_line: true });
    expect(template.variables.immutable.detail).toMatchObject({ max_length: 20000 });
    expect(Object.hasOwn(template.variables.immutable.detail, 'required')).toBe(false);
    // Creating agents are told all three fields, and how the work is delegated.
    for (const expected of ['name', 'title', 'detail', 'worktree', 'task']) {
      expect(template.spawn_prompt).toContain(expected);
    }
    for (const expected of ['variables', 'detail', 'parent', 'task_spawn']) {
      expect(template.system_prompt).toContain(expected);
    }

    const project = spawn(0, 'project', 'demo', undefined, { path: dir });
    expect(manager.templates.get('project').child_templates).toContain('dev-task');
    const task = spawn(project.pid, 'dev-task', 'fix-login', '修好登录',
      { title: '修复登录流程', detail: '第一行\n第二行' });
    expect(task.inspect().name).toBe('fix-login');
    expect(task.inspect().context.state).toEqual({
      params: { name: 'fix-login', title: '修复登录流程', detail: '第一行\n第二行' },
    });
    expect(task.inspect().variables.declarations.immutable.name.max_length).toBe(64);
    // One child and one only: the worktree node.
    expect(code(() => spawn(task.pid, 'generic-task', 'nope'))).toBe(-32010);
    expect(code(() => spawn(task.pid, 'project', 'nope'))).toBe(-32010);
    expect(task.getParent().inspect().variables.immutable).toEqual({ path: dir });
    expect(code(() => spawn(project.pid, 'dev-task', 'ok-name', undefined, { title: 'x', path: dir }))).toBe(-32602);

    const minimal = spawn(project.pid, 'dev-task', 'small-fix', undefined, { title: '小修' });
    expect(minimal.inspect().name).toBe('small-fix');
    expect(minimal.inspect().goal).toBe('small-fix');
    const empty = spawn(project.pid, 'dev-task', 'no-body', undefined, { title: '没正文', detail: '' });
    expect(empty.inspect().context.state.params.detail).toBe('');
  });

  test('worktree-service is bound to one worktree through the immutable path variable', () => {
    const template = manager.templates.get('worktree-service');
    expect(template).toMatchObject({ singleton: false, child_templates: [] });
    expect(template.variables.immutable.path).toMatchObject({ required: true });
    expect(template.variables.mutable).toBeUndefined();
    for (const expected of ['path', 'worktree add', 'process_spawn']) expect(template.spawn_prompt).toContain(expected);
    for (const expected of ['worktree', 'state', 'task_complete']) expect(template.system_prompt).toContain(expected);

    const project = spawn(0, 'project', 'demo', undefined, { path: dir });
    expect(code(() => spawn(project.pid, 'worktree-service', 'nope', undefined, { path: dir }))).toBe(-32010);
    const task = spawn(project.pid, 'dev-task', 'fix-login', undefined, { title: '修登录' });
    expect(code(() => spawn(task.pid, 'worktree-service', 'wt'))).toBe(-32602);
    expect(code(() => spawn(task.pid, 'worktree-service', 'wt', undefined, { path: 'relative/dir' }))).toBe(-32602);
    expect(code(() => spawn(task.pid, 'worktree-service', 'wt', undefined, { path: `${dir}/nope` }))).toBe(-32602);
    expect(code(() => spawn(task.pid, 'worktree-service', 'wt', undefined, { path: dir, branch: 'dev' }))).toBe(-32602);

    const service = spawn(task.pid, 'worktree-service', 'fix-login', '修登录', { path: dir });
    expect(service.inspect().template).toBe('worktree-service');
    expect(service.inspect().context.state).toEqual({ params: { path: dir } });
    expect(code(() => manager.updateVars(service.pid, { path: '/tmp' }))).toBe(-32602);
    expect(code(() => spawn(service.pid, 'generic-task', 'nope'))).toBe(-32010);
  });

  test('dev-task refuses an unusable name / title / detail with an actionable error', () => {
    const project = spawn(0, 'project', 'demo', undefined, { path: dir });
    const attempt = (overrides) => {
      // An explicit `undefined` must reach spawn as "no name", so no
      // destructuring default may swallow it.
      const name = Object.hasOwn(overrides, 'name') ? overrides.name : 'ok-name';
      const variables = Object.hasOwn(overrides, 'variables') ? overrides.variables : { title: '标题' };
      try {
        return spawn(project.pid, 'dev-task', name, undefined, variables);
      } catch (err) {
        return err;
      }
    };
    const rejects = (overrides, expected) => {
      const err = attempt(overrides);
      expect(err?.code).toBe(-32602);
      for (const part of expected) expect(err.message).toContain(part);
    };

    rejects({ name: undefined }, ['process name', '--name']);
    rejects({ name: '' }, ['variable name', 'A-Za-z', 'worktree']);
    rejects({ name: 'fix login' }, ['does not match', 'worktree']);
    rejects({ name: 'fix-login!' }, ['does not match']);
    rejects({ name: '1fix' }, ['does not match']);
    rejects({ name: 'a'.repeat(65) }, ['max_length 64']);
    rejects({ variables: { name: 'other-name', title: '标题' } }, ['disagree']);
    rejects({ variables: { name: 'ok-name' } }, ['variables.title', '一句话摘要']);
    rejects({ variables: { name: 'ok-name', title: 'a\nb' } }, ['single_line']);
    rejects({ variables: { name: 'ok-name', title: 'x'.repeat(201) } }, ['max_length 200']);
    rejects({ variables: { name: 'ok-name', title: 42 } }, ['must be a string']);
    rejects({ variables: { name: 'ok-name', title: 'ok', detail: 42 } }, ['must be a string']);
    rejects({ variables: { name: 'ok-name', title: 'ok', detail: 'x'.repeat(20001) } }, ['max_length 20000']);
  });

  test('declared format constraints are enforced on values and on updates', () => {
    manager.templates.register({
      ...manager.templates.get('generic-task'),
      name: 'checked-mutable',
      variables: { mutable: { branch: { default: 'main', pattern: '[a-z]+', max_length: 8, description: '分支名' } } },
    });
    const checked = spawn(0, 'checked-mutable', 'checked');
    expect(checked.inspect().context.state.vars).toEqual({ branch: 'main' });
    expect(manager.updateVars(checked.pid, { branch: 'dev' })).toEqual({ branch: 'dev' });
    for (const patch of [{ branch: 'DEV 1' }, { branch: 'toolongbranch' }, { branch: 7 }]) {
      expect(code(() => manager.updateVars(checked.pid, patch))).toBe(-32602);
    }
    expect(checked.inspect().context.state.vars).toEqual({ branch: 'dev' });
    manager.templates.register({
      ...manager.templates.get('generic-task'),
      name: 'anchored-pattern',
      variables: { immutable: { tag: { pattern: '[a-z]+', description: '标签' } } },
    });
    expect(spawn(0, 'anchored-pattern', 'ok', undefined, { tag: 'abc' }).inspect().context.state.params.tag).toBe('abc');
    expect(code(() => spawn(0, 'anchored-pattern', 'bad', undefined, { tag: 'a1c' }))).toBe(-32602);
  });

  test('context advertises child templates, the task, and no type', async () => {
    const parent = spawn(0, 'generic-task', 'parent');
    const task = manager.spawnTask(null, parent.pid, 'who can you create?');
    const built = new ContextBuilder(manager.repository, manager.templates).build(manager.repository.getTask(task.id), null);
    const data = built.data;
    expect(data.child_templates).toEqual(['*']);
    expect(data.task).toMatchObject({ id: task.id, goal: 'who can you create?', parent_task_id: null });
    const generic = data.available_child_templates.find((item) => item.name === 'generic-task');
    expect(generic.type).toBeUndefined();
    expect(generic.singleton).toBe(false);
    expect(generic.spawn_prompt).toContain('process_spawn');
    expect(data.available_child_templates.some((item) => item.name === 'lush-root')).toBe(false);
    manager.cancelTask(task.id);

    // A project is told what a dev-task needs.
    const project = spawn(0, 'project', 'demo', undefined, { path: dir });
    const projectTask = manager.spawnTask(null, project.pid, 'split me');
    const devTask = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(projectTask.id), null).data.available_child_templates
      .find((item) => item.name === 'dev-task');
    for (const expected of ['name', 'title', 'detail', 'worktree', 'process_spawn']) {
      expect(devTask.spawn_prompt).toContain(expected);
    }
    manager.cancelTask(projectTask.id);
  });

  test('templates load in hierarchy order, and agents see that order', () => {
    const loader = new TemplateLoader();
    const order = Object.keys(loader.templates);
    expect(order).toEqual([
      'lush-root', 'project-manager', 'project',
      'dev-task', 'research-task', 'generic-service', 'generic-task', 'worktree-service',
    ]);
    const origin = (name) => loader.origins.get(name).split(path.sep).join('/');
    expect(origin('dev-task').endsWith('/templates/lush-root/project-manager/project/dev-task.json')).toBe(true);
    for (const template of Object.values(loader.templates)) {
      for (const child of template.child_templates) {
        if (child === '*' || child === template.name) continue;
        expect(order.indexOf(template.name)).toBeLessThan(order.indexOf(child));
      }
    }
    const project = spawn(0, 'project', 'demo', undefined, { path: dir });
    const projectTask = manager.spawnTask(null, project.pid, 'order');
    const names = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(projectTask.id), null).data.available_child_templates.map((item) => item.name);
    expect(names).toEqual(['dev-task', 'research-task', 'generic-service', 'generic-task']);
    manager.cancelTask(projectTask.id);
  });

  test('available child templates hide a singleton that is already taken', () => {
    const names = (pid) => {
      const task = manager.spawnTask(null, pid, 'names');
      const list = new ContextBuilder(manager.repository, manager.templates)
        .build(manager.repository.getTask(task.id), null).data.available_child_templates.map((item) => item.name);
      manager.cancelTask(task.id);
      return list;
    };
    expect(names(0)).toContain('project-manager');
    const taken = spawn(0, 'project-manager', 'pm');
    expect(names(0)).not.toContain('project-manager');
    expect(names(0)).toContain('generic-task');
    manager.stop(taken.pid);
    expect(names(0)).toContain('project-manager');
    const child = spawn(0, 'project-manager', 'pm2');
    expect(names(child.pid)).toContain('generic-task');
    expect(names(child.pid)).not.toContain('project-manager');
  });

  test('view has no command section and ignores legacy snapshot fields', () => {
    const child = spawn(0, 'generic-task', 'child');
    const view = manager.view(child.pid, ['parent', 'children', 'prompt']);
    expect(view.parent.pid).toBe(0);
    expect(view.children).toEqual([]);
    expect(view.call_prompt).toBe(manager.templates.get('generic-task').system_prompt);
    expect(() => manager.view(child.pid, ['command'])).toThrow(LushError);
  });

  test('startup backfills child_templates for snapshots written earlier', () => {
    const child = spawn(0, 'generic-task', 'child');
    const snapshot = manager.repository.get(child.pid).template_snapshot;
    delete snapshot.child_templates;
    delete snapshot.variables;
    manager.repository.db.run('UPDATE processes SET template_snapshot=? WHERE pid=?',
      [JSON.stringify(snapshot), child.pid]);
    expect(manager.backfillTemplateSnapshots().filled).toEqual([child.pid]);
    const filled = manager.repository.get(child.pid).template_snapshot;
    expect(filled.child_templates).toEqual(['*']);
    expect(manager.backfillTemplateSnapshots().filled).toEqual([]);
  });

  test('template loader rejects duplicates, unknown references and the old type field', () => {
    const directory = path.join(dir, 'templates');
    fs.mkdirSync(directory);
    const template = manager.templates.get('generic-task');
    const file = path.join(directory, 'custom.json');
    fs.writeFileSync(file, JSON.stringify(template));
    expect(() => new TemplateLoader(directory)).toThrow(LushError);
    fs.writeFileSync(file, JSON.stringify({ ...template, name: 'custom', child_templates: ['missing'] }));
    expect(() => new TemplateLoader(directory)).toThrow(LushError);
    fs.writeFileSync(file, JSON.stringify({ ...template, name: 'custom', child_templates: [] }));
    expect(new TemplateLoader(directory).get('custom').child_templates).toEqual([]);
    // The seven template fields are exact: dropping or adding one is an error.
    for (const mutate of [
      (value) => delete value.spawn_prompt,
      (value) => delete value.variables,
      (value) => { value.singleton = 'yes'; },
      (value) => { value.extra = 1; },
    ]) {
      const broken = { ...template, name: 'custom' };
      mutate(broken);
      fs.writeFileSync(file, JSON.stringify(broken));
      expect(() => new TemplateLoader(directory)).toThrow(LushError);
    }
  });

  test('child_templates paths resolve against the declaring template file', () => {
    const directory = path.join(dir, 'templates');
    fs.mkdirSync(path.join(directory, 'sub'), { recursive: true });
    const base = manager.templates.get('generic-task');
    const write = (relative, value) => fs.writeFileSync(path.join(directory, relative), JSON.stringify(value));
    write('root-tpl.json', { ...base, name: 'root-tpl', child_templates: ['sub/mid-tpl.json'] });
    write('sub/mid-tpl.json', { ...base, name: 'mid-tpl', child_templates: ['leaf-tpl.json', '../shared-tpl.json'] });
    write('sub/leaf-tpl.json', { ...base, name: 'leaf-tpl', child_templates: [] });
    write('shared-tpl.json', { ...base, name: 'shared-tpl', child_templates: ['*'] });

    const loader = new TemplateLoader(directory);
    expect(loader.get('root-tpl').child_templates).toEqual(['mid-tpl']);
    expect(loader.get('mid-tpl').child_templates).toEqual(['leaf-tpl', 'shared-tpl']);

    write('sub/leaf-tpl.json', { ...base, name: 'leaf-tpl', child_templates: ['nope.json'] });
    expect(() => new TemplateLoader(directory)).toThrow(/no template file at .*nope\.json/);
    expect(() => manager.templates.register({ ...base, name: 'path-task', child_templates: ['other.json'] }))
      .toThrow(/registered without a file/);
    expect(manager.templates.find('path-task')).toBeNull();

    write('sub/leaf-tpl.json', { ...base, name: 'leaf-tpl', child_templates: ['leaf-tpl'] });
    expect(new TemplateLoader(directory).get('leaf-tpl').child_templates).toEqual(['leaf-tpl']);
  });

  test('spawn variables: required path, defaults, mutability regions and validation', () => {
    expect(code(() => spawn(0, 'project', 'p'))).toBe(-32602);
    try {
      spawn(0, 'project', 'p');
    } catch (err) {
      expect(err.message).toContain('variables.path');
    }
    expect(code(() => spawn(0, 'project', 'p', undefined, { path: 'relative/dir' }))).toBe(-32602);
    expect(code(() => spawn(0, 'project', 'p', undefined, { path: path.join(dir, 'missing') }))).toBe(-32602);
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(code(() => spawn(0, 'project', 'p', undefined, { path: file }))).toBe(-32602);
    expect(code(() => spawn(0, 'project', 'p', undefined, []))).toBe(-32602);
    expect(code(() => spawn(0, 'project', 'p', undefined, { path: dir, nope: 1 }))).toBe(-32602);
    expect(code(() => spawn(0, 'generic-task', 'p', undefined, { path: dir }))).toBe(-32602);

    const project = spawn(0, 'project', 'p1', 'ship', { path: dir });
    expect(project.inspect().context.state).toEqual({ params: { path: dir }, vars: { branch: 'main' } });
    const second = spawn(0, 'project', 'p2', undefined, { path: dir, branch: 'dev' });
    expect(second.inspect().variables).toMatchObject({
      immutable: { path: dir },
      mutable: { branch: 'dev' },
      declarations: { immutable: { path: { required: true } }, mutable: { branch: { default: 'main' } } },
    });
    expect(manager.tree().find((row) => row.pid === project.pid).variables.mutable).toEqual({ branch: 'main' });
    manager.updateState(project.pid, { progress: 'started' });
    expect(project.inspect().context.state)
      .toEqual({ params: { path: dir }, vars: { branch: 'main' }, progress: 'started' });
  });

  test('update_vars changes mutable variables only, and update_state cannot write them', () => {
    const project = spawn(0, 'project', 'p1', undefined, { path: dir });
    expect(manager.updateVars(project.pid, { branch: 'dev' })).toEqual({ branch: 'dev' });
    expect(project.inspect().variables.mutable).toEqual({ branch: 'dev' });
    for (const patch of [{ path: '/tmp' }, { nope: 1 }, {}, [], { branch: Number.NaN }]) {
      expect(code(() => manager.updateVars(project.pid, patch))).toBe(-32602);
    }
    for (const patch of [{ params: { path: '/tmp' } }, { vars: { branch: 'x' } }]) {
      expect(code(() => manager.updateState(project.pid, patch))).toBe(-32602);
    }
    const plain = spawn(0, 'generic-task', 'plain');
    expect(code(() => manager.updateVars(plain.pid, { branch: 'dev' }))).toBe(-32602);
    manager.stop(plain.pid);
    expect(code(() => manager.updateVars(plain.pid, { branch: 'dev' }))).toBe(-32009);
  });

  test('template variables declaration is validated', () => {
    const directory = path.join(dir, 'templates');
    fs.mkdirSync(directory, { recursive: true });
    const template = manager.templates.get('project');
    const file = path.join(directory, 'custom.json');
    const write = (variables) => {
      fs.writeFileSync(file, JSON.stringify({ ...template, name: 'custom', variables }));
      return new TemplateLoader(directory).get('custom');
    };
    const groups = (immutable, mutable = {}) => ({ immutable, mutable });
    expect(write(groups({}, {})).variables).toEqual({ immutable: {}, mutable: {} });
    for (const broken of [
      [],
      { immutable: {}, mutable: {}, extra: {} },
      groups({ path: { required: true, default: '/tmp', description: 'x' } }),
      groups({ path: { required: 'yes', description: 'x' } }),
      groups({ path: { description: '' } }),
      groups({ path: {} }),
      groups({ path: { description: 'x', typo: 1 } }),
      groups({}, { path: { description: 'x' } }),
      { immutable: { a: { description: 'x' } }, mutable: { a: { description: 'y' } } },
      groups({}, { name: { description: 'x' } }),
      groups({ title: { description: 'x', pattern: '[' } }),
      groups({ title: { description: 'x', max_length: 0 } }),
      groups({ title: { description: 'x', single_line: 'yes' } }),
      groups({ title: { description: 'x', max_length: 3, default: 'abcd' } }),
    ]) {
      expect(code(() => write(broken))).toBe(-32602);
    }
    expect(write(groups({
      title: { description: 'x', pattern: '^[a-z]+$', max_length: 5, single_line: true, default: 'abc' },
    })).variables.immutable.title.max_length).toBe(5);
  });

  test('project-manager and project describe the delegation protocol', () => {
    const managerTemplate = manager.templates.get('project-manager');
    expect(managerTemplate.child_templates).toContain('project');
    expect(managerTemplate.singleton).toBe(true);
    for (const expected of ['task_spawn', 'project', 'research-task', 'generic-task', 'generic-service', 'children']) {
      expect(managerTemplate.system_prompt).toContain(expected);
    }
    const projectTemplate = manager.templates.get('project');
    for (const expected of ['dev-task', 'task spawn', 'task wait', 'path', 'state']) {
      expect(projectTemplate.system_prompt).toContain(expected);
    }
    expect(manager.templates.get('project').spawn_prompt).toContain('path');
    expect(manager.templates.get('project').spawn_prompt).toContain('singleton=false');
  });

  test('PID 0 routes work to project-manager instead of doing it itself', () => {
    const template = manager.templates.get('lush-root');
    expect(template.child_templates).toEqual(['project-manager']);
    for (const expected of [
      '入口', 'project-manager', 'children', 'task_spawn', 'task_wait', '不要自己动手', '孤儿', '不要声称',
    ]) {
      expect(template.system_prompt).toContain(expected);
    }
    expect(template.system_prompt).toContain('lush process orphans');
  });

  test('the shared guide teaches the process/task split on both backends', () => {
    for (const mode of ['tools', 'cli']) {
      const guide = agentGuide(mode);
      for (const expected of [
        'Process', 'Task', 'task_spawn', 'task_wait', 'task_complete', 'task tree', '下游', '被动的节点',
      ]) {
        expect(guide).toContain(expected);
      }
    }
    expect(agentGuide('tools').split('通用规则：')[1]).toBe(agentGuide('cli').split('通用规则：')[1]);
  });

  test('only project-manager opens projects: a project cannot nest another one', async () => {
    const project = spawn(0, 'project', 'demo', undefined, { path: dir });
    const failure = (() => {
      try {
        spawn(project.pid, 'project', 'nested', undefined, { path: dir });
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(failure?.code).toBe(-32010);
    expect(failure?.message).toContain('cannot create template project');
    expect(manager.templates.get('project').child_templates).toEqual([
      'dev-task', 'generic-task', 'research-task', 'generic-service',
    ]);
    const controller = spawn(0, 'project-manager', 'controller');
    expect(spawn(controller.pid, 'project', 'opened', undefined, { path: dir }).inspect().template).toBe('project');

    const task = manager.spawnTask(null, controller.pid, 'open the project');
    const names = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(task.id), null).data.available_child_templates.map((item) => item.name);
    expect(names).toContain('project');
    manager.cancelTask(task.id);
  });

  test('state, context isolation and validation', () => {
    const a = spawn(0, 'generic-task', 'a');
    const b = spawn(0, 'generic-task', 'b');
    manager.updateState(a.pid, { x: 1, nested: { a: 1 } });
    manager.updateState(a.pid, { nested: { b: 2 } });
    expect(a.inspect().context.state).toEqual({ x: 1, nested: { b: 2 } });
    expect(b.inspect().context.state).toEqual({});
    const symbolPatch = { [Symbol('k')]: 'x' };
    for (const bad of [[], { x: Number.NaN }, symbolPatch]) {
      expect(() => manager.updateState(a.pid, bad)).toThrow(LushError);
    }
    for (const pid of [true, -1, '1', 2 ** 64, null]) {
      expect(() => manager.inspect(pid)).toThrow(LushError);
    }
  });

  test('restart recovers the tree and fails unfinished tasks', async () => {
    const parent = spawn(0, 'generic-service', 'parent');
    const child = spawn(parent.pid, 'generic-task', 'child');
    const task = manager.repository.createTask(child.pid, null, 'work');
    manager.updateTaskState(task.id, { progress: 'half' });
    let repo = manager.repository;
    const callId = repo.beginCall(child.pid, task.id, 'work');
    repo.addMessage(child.pid, task.id, callId, { role: 'user', content: 'work' });
    await runtime.shutdown();
    db.close();
    ({ database: db, manager, runtime } = system(dir));

    const info = manager.inspect(child.pid);
    expect(info.parent_pid).toBe(parent.pid);
    expect(info.status).toBe('active');
    expect(info.context.state).toEqual({});
    expect(manager.repository.getTask(task.id)).toMatchObject({
      status: 'failed', error: 'daemon restarted', state: { progress: 'half' },
    });
    expect(manager.repository.calls(child.pid)[0].status).toBe('interrupted');
    repo = manager.repository;
    const next = repo.beginCall(child.pid, task.id, 'continue');
    expect(repo.conversation(task.id, next).length).toBeGreaterThan(0);
  });

  test('transition transactions roll back on an invalid result', () => {
    const task = manager.repository.createTask(worker(), null, 'work');
    expect(() => manager.completeTask(task.id, Number.NaN)).toThrow(LushError);
    expect(manager.repository.getTask(task.id).status).toMatch(/created|running/);
    manager.cancelTask(task.id);
  });

  test('pagination validation', () => {
    for (const [after, limit] of [[-1, 1], [0, 0], [0, 1001], [true, 1]]) {
      expect(() => manager.taskHistory(1, after, limit)).toThrow(LushError);
    }
  });

  test('a v1 database migrates through v2 to the process/task schema', async () => {
    const legacyDir = tmpdir('lush-migrate-');
    const legacy = new SQLite(path.join(legacyDir, 'lush.db'), { create: true });
    legacy.exec(`
      CREATE TABLE processes (
        pid INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_pid INTEGER REFERENCES processes(pid),
        original_parent_pid INTEGER REFERENCES processes(pid),
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('service','task')),
        status TEXT NOT NULL CHECK(
          (type='service' AND status IN ('created','running','stopped','failed')) OR
          (type='task' AND status IN ('created','running','completed','failed','cancelled','reclaimed'))
        ),
        template TEXT NOT NULL,
        template_snapshot TEXT NOT NULL,
        goal TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((pid=0 AND parent_pid IS NULL AND original_parent_pid IS NULL AND type='service')
           OR (pid>0 AND parent_pid IS NOT NULL AND original_parent_pid IS NOT NULL)),
        CHECK(parent_pid IS NULL OR parent_pid != pid)
      );
      CREATE TABLE contexts (
        pid INTEGER PRIMARY KEY REFERENCES processes(pid),
        system_prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        refs TEXT NOT NULL
      );
      CREATE TABLE agent_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid INTEGER NOT NULL REFERENCES processes(pid),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
        output TEXT, error TEXT,
        started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid INTEGER NOT NULL REFERENCES processes(pid),
        call_id INTEGER NOT NULL REFERENCES agent_calls(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE process_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid INTEGER NOT NULL REFERENCES processes(pid),
        kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const insert = legacy.query('INSERT INTO processes VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(0, null, null, 'lush', 'service', 'running', 'lush-root', '{}', 'g', 't', 't');
    insert.run(1, 0, 0, 'done', 'task', 'completed', 'generic-task', '{}', 'g', 't', 't');
    insert.run(2, 0, 0, 'stopme', 'task', 'cancelled', 'generic-task', '{}', 'g', 't', 't');
    insert.run(3, 0, 0, 'idle', 'service', 'stopped', 'generic-service', '{}', 'g', 't', 't');
    for (const pid of [0, 1, 2, 3]) {
      legacy.run(`INSERT INTO contexts VALUES(${pid},'sys',?, '[]','[]')`,
        [pid === 1 ? '{"progress":"half"}' : '{}']);
    }
    legacy.run("INSERT INTO agent_calls(pid,prompt,status,output,started_at,finished_at) VALUES(1,'old work','succeeded','old output','2020-01-01T00:00:00.000Z','2020-01-01T00:00:10.000Z')");
    legacy.run("INSERT INTO messages(pid,call_id,body,created_at) VALUES(1,1,'{\"role\":\"user\",\"content\":\"old work\"}','2020-01-01T00:00:00.000Z')");
    legacy.close();

    const migrated = system(legacyDir);
    try {
      expect(migrated.database.connection.query('PRAGMA user_version').get().user_version).toBe(3);
      expect(migrated.database.connection.query('PRAGMA foreign_key_check').all()).toEqual([]);
      // v1 `running` / `completed` become `active`; v1 `cancelled` collapsed
      // into `stopped` on the way through v2, like v1 `stopped` does.
      expect(migrated.manager.list().map((row) => [row.pid, row.status])).toEqual([
        [0, 'active'], [1, 'active'], [2, 'stopped'], [3, 'stopped'],
      ]);
      // The historical call became a root task with its output as the result.
      const adopted = migrated.manager.taskList(1);
      expect(adopted).toHaveLength(1);
      expect(adopted[0]).toMatchObject({ status: 'completed', goal: 'old work', result: 'old output', pid: 1 });
      expect(migrated.manager.taskHistory(adopted[0].id).messages).toHaveLength(1);
      expect(migrated.manager.inspect(1).context.state).toEqual({ progress: 'half' });
      // The new schema allows work on any node, once it is started again.
      migrated.manager.start(3);
      const task = await migrated.manager.call(3, 'back to work');
      expect(task.status).toBe('completed');
    } finally {
      await migrated.runtime.shutdown();
      migrated.database.close();
      cleanup(legacyDir);
    }
  });
});

describe('orphan supervision', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let root;
  const extras = [];

  beforeEach(() => {
    dir = tmpdir('lush-core-orphan-');
    ({ database: db, manager, runtime } = system(dir));
    root = permissiveRoot(manager);
  });

  afterEach(async () => {
    try {
      await runtime.shutdown();
    } catch {
      /* already shut down */
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
    cleanup(dir);
    for (const extra of extras.splice(0)) {
      try {
        extra.database.close();
      } catch {
        /* already closed */
      }
      cleanup(extra.directory);
    }
  });

  function policySystem(policy, provider = null) {
    const directory = tmpdir('lush-core-orphan-');
    const built = system(directory, provider, {}, policy);
    permissiveRoot(built.manager);
    extras.push({ directory, database: built.database, runtime: built.runtime });
    // Spawn a process and keep the PID handle, like the main describe does.
    const spawn = (parent, template, name) => built.manager.load(built.manager.spawn(parent, template, name).pid);
    return { ...built, spawn };
  }

  function code(fn) {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  }

  test('default policy adopts active children and reports the pool', () => {
    const parent = manager.spawn(0, 'generic-task', 'parent');
    const live = manager.spawn(parent.pid, 'generic-service', 'live');
    manager.stop(parent.pid);

    const pool = manager.orphans();
    expect(pool.policy).toEqual({ adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 });
    expect(pool.active_count).toBe(1);
    expect(pool.orphans.map((orphan) => orphan.pid)).toEqual([live.pid]);
    expect(pool.orphans[0]).toMatchObject({
      name: 'live',
      status: 'active',
      original_parent_pid: parent.pid,
      busy: false,
    });
    expect(manager.orphanPolicy).toEqual(DEFAULT_ORPHAN_POLICY);
    expect(manager.orphanPolicyReport()).toEqual(pool.policy);
    expect(manager.superviseOrphans().evicted).toEqual([]);
  });

  test("adopt mode 'none' leaves children under their stopped parent", () => {
    const { manager: strict, spawn } = policySystem({ adopt: 'none' });
    const parent = spawn(0, 'generic-task', 'parent');
    const live = spawn(parent.pid, 'generic-service', 'live');
    strict.stop(parent.pid);

    expect(live.inspect().status).toBe('active');
    expect(live.inspect().parent_pid).toBe(parent.pid);
    expect(live.inspect().recent_events.map((event) => event.kind)).not.toContain('reparented');
    expect(strict.orphans().active_count).toBe(0);
  });

  test("adopt mode 'terminate' freezes direct children and walks the chain", () => {
    const { manager: strict, spawn } = policySystem({ adopt: 'terminate' });
    const parent = spawn(0, 'generic-task', 'parent');
    const service = spawn(parent.pid, 'generic-service', 'service');
    const task = spawn(parent.pid, 'generic-task', 'task');
    const grandchild = spawn(service.pid, 'generic-task', 'grandchild');
    strict.stop(parent.pid);

    expect(service.inspect().status).toBe('stopped');
    expect(task.inspect().status).toBe('stopped');
    expect(grandchild.inspect().status).toBe('stopped');
    expect(service.inspect().recent_events.find((event) => event.kind === 'transition').data)
      .toEqual({ from: 'active', to: 'stopped', cause: 'parent_terminated' });
    expect(strict.orphans().active_count).toBe(0);
  });

  test('a stopped PID 0 never adopts or terminates its own children', () => {
    const { manager: strict, spawn } = policySystem({ adopt: 'terminate' });
    const child = spawn(0, 'generic-service', 'child');
    expect(child.inspect().original_parent_pid).toBe(0);

    strict.repository.transition(0, 'stopped', { adopt: true, terminate: true });
    expect(strict.repository.get(0).status).toBe('stopped');
    expect(child.inspect().status).toBe('active');
    expect(strict.orphans().orphans).toEqual([]);
  });

  test('the limit freezes the oldest orphans, on adoption and on demand', () => {
    const { manager: strict, spawn } = policySystem({ limit: 1 });
    const parent = spawn(0, 'generic-task', 'parent');
    const children = [1, 2, 3].map((index) => spawn(parent.pid, 'generic-service', `orphan-${index}`));
    strict.stop(parent.pid);

    expect(strict.orphans().active_count).toBe(1);
    const stopped = children.filter((child) => child.inspect().status === 'stopped');
    expect(stopped.length).toBe(2);
    for (const child of stopped) {
      expect(child.inspect().recent_events.find((event) => event.kind === 'transition').data)
        .toEqual({ from: 'active', to: 'stopped', cause: 'orphan_limit' });
    }
  });

  test('eviction cancels the task an orphan was working on', () => {
    const { manager: strict, spawn } = policySystem({ ttlSeconds: 1 });
    const parent = spawn(0, 'generic-task', 'parent');
    const busy = spawn(parent.pid, 'generic-task', 'busy');
    // A task with no agent of its own: created directly, so it stays active.
    const task = strict.repository.createTask(busy.pid, null, 'long work');
    strict.stop(parent.pid);
    const evicted = strict.orphanEvict(busy.pid, 'orphan_ttl');
    expect(strict.repository.getTask(task.id).status).toBe('cancelled');
    expect(evicted.status).toBe('stopped');
    expect(busy.inspect().status).toBe('stopped');
    expect(strict.orphans().active_count).toBe(0);
  });

  test('a busy orphan is never frozen and is deferred', async () => {
    // A slow agent keeps both orphans busy; the limit is 1 and nothing may be
    // frozen, so the pass reports them as deferred instead of forcing it.
    const slow = policySystem({ limit: 1 }, new SlowProvider(400));
    const parent = slow.spawn(0, 'generic-task', 'parent');
    const first = slow.spawn(parent.pid, 'generic-service', 'first');
    const second = slow.spawn(parent.pid, 'generic-service', 'second');
    slow.manager.spawnTask(null, first.pid, 'long work');
    slow.manager.spawnTask(null, second.pid, 'long work');
    expect(slow.manager.runtime.isBusy(first.pid)).toBe(true);
    slow.manager.stop(parent.pid);
    expect(slow.manager.orphans().active_count).toBe(2);
    expect(first.inspect().status).toBe('active');
    expect(second.inspect().status).toBe('active');
    const report = slow.manager.superviseOrphans('manual');
    expect(report.evicted).toEqual([]);
    expect(report.deferred).toHaveLength(1);
  });

  test('orphans() is a read model with busy, idle and limit arithmetic', () => {
    const { manager: strict, spawn } = policySystem({ limit: 0, ttlSeconds: 60 });
    const parent = spawn(0, 'generic-task', 'parent');
    const live = spawn(parent.pid, 'generic-service', 'live');
    strict.stop(parent.pid);
    strict.repository.db.run('UPDATE processes SET updated_at=? WHERE pid=?',
      ['2020-01-01T00:00:00.000Z', live.pid]);
    const pool = strict.orphans();
    expect(pool.orphans[0].idle_seconds).toBeGreaterThan(1000);
    expect(pool.over_limit).toBe(0);
    expect(pool.busy_count).toBe(0);
    const report = strict.superviseOrphans('manual');
    expect(report.ttl_seconds).toBe(60);
    expect(report.evicted.map((item) => item.pid)).toEqual([live.pid]);
    expect(code(() => strict.superviseOrphans('never'))).toBe(-32602);
    expect(code(() => strict.orphanEvict(live.pid, ''))).toBe(-32602);
  });

  test('normalizeOrphanPolicy fills defaults and rejects invalid values', () => {
    expect(normalizeOrphanPolicy()).toEqual(DEFAULT_ORPHAN_POLICY);
    expect(normalizeOrphanPolicy({ adopt: 'none', limit: 2, ttlSeconds: 1.5, sweepSeconds: 0 }))
      .toEqual({ adopt: 'none', limit: 2, ttlSeconds: 1.5, sweepSeconds: 0 });
    for (const broken of [
      { adopt: 'maybe' }, { limit: -1 }, { limit: 1.5 }, { ttlSeconds: -1 }, { sweepSeconds: 1.5 }, [],
    ]) {
      expect(code(() => normalizeOrphanPolicy(broken))).toBe(-32602);
    }
  });
});

describe('PID 0 creation lockdown', () => {
  let dir;
  let db;
  let manager;
  let runtime;

  beforeEach(() => {
    dir = tmpdir('lush-root-');
    ({ database: db, manager, runtime } = system(dir));
  });

  afterEach(async () => {
    try {
      await runtime.shutdown();
    } catch {
      /* already shut down */
    }
    db.close();
    cleanup(dir);
  });

  test('PID 0 may only create project-manager', () => {
    expect(manager.templates.get('lush-root').child_templates).toEqual(['project-manager']);
    expect(manager.spawn(0, 'project-manager', 'pm').template).toBe('project-manager');
    expect(() => manager.spawn(0, 'generic-task', 'nope')).toThrow(/cannot create template generic-task/);
  });

  test('PID 0 advertises exactly project-manager, and user templates are no exception', () => {
    const task = manager.spawnTask(null, 0, 'what can you create?');
    const names = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(task.id), null).data.available_child_templates.map((item) => item.name);
    expect(names).toEqual(['project-manager']);
    manager.cancelTask(task.id);

    const directory = path.join(dir, 'templates');
    fs.mkdirSync(directory);
    const base = manager.templates.get('generic-task');
    fs.writeFileSync(path.join(directory, 'user.json'), JSON.stringify({ ...base, name: 'user-template' }));
    const loader = new TemplateLoader(directory);
    const built = new ContextBuilder(manager.repository, loader);
    const scoped = built.build(manager.repository.getTask(manager.spawnTask(null, 0, 'x').id), null);
    expect(scoped.data.available_child_templates.map((item) => item.name)).toEqual(['project-manager']);
  });

  test('refreshRootTemplate restores drift, is idempotent and only touches PID 0', () => {
    const task = manager.spawnTask(null, 0, 'drift');
    manager.repository.replaceSnapshot(0, { ...manager.templates.get('generic-task'), name: 'drifted' });
    manager.cancelTask(task.id);
    const refreshed = manager.refreshRootTemplate();
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.changed).toContain('name');
    expect(manager.repository.get(0).template).toBe('lush-root');
    expect(manager.refreshRootTemplate().refreshed).toBe(false);
  });

  test('a missing lush-root template is reported instead of thrown', () => {
    const loader = new TemplateLoader();
    delete loader.templates['lush-root'];
    const bare = system(dir, null, { templates: loader });
    try {
      expect(bare.manager.refreshRootTemplate()).toMatchObject({ refreshed: false, missing: true });
    } finally {
      bare.runtime.shutdown();
      bare.database.close();
    }
  });

  test('refreshRootTemplate makes an edited lush-root prompt reach the agent, PID 0 only', async () => {
    const edited = `${manager.templates.get('lush-root').system_prompt}\nEDITED-MARKER`;
    manager.templates.templates['lush-root'] = { ...manager.templates.get('lush-root'), system_prompt: edited };
    manager.refreshRootTemplate();
    expect(manager.repository.context(0).system_prompt).toContain('EDITED-MARKER');
    const task = manager.spawnTask(null, 0, 'hello');
    const built = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(task.id), null);
    expect(built.messages[0].content).toContain('EDITED-MARKER');
    manager.cancelTask(task.id);
  });
});
