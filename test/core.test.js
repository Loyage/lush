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
    expect([a.sid, b.sid]).toEqual([1, 2]);
    expect(b.getParent().sid).toBe(1);
    expect(a.getChildren()[0].sid).toBe(2);
    expect(b.inspect().goal).toBe('implement login');
    // A service is passive: creating it starts no agent and creates no task.
    expect(manager.repository.activeTasks()).toEqual([]);
  });

  /** Spawn a service and keep the SID handle (the tests read it like the old ones did). */
  function construct(parent, template, name, goal, variables) {
    return manager.load(manager.construct(parent, template, name, goal, variables).sid);
  }

  /** A child service of SID 0 that is ready to be given work. */
  function worker(template = 'generic-task', name = 'worker') {
    return construct(0, template, name).sid;
  }

  test('call creates a root task, runs it and returns its result', async () => {
    const sid = worker();
    const task = await manager.call(sid, 'do the thing');
    expect(task).toMatchObject({ sid, status: 'completed', parent_task_id: null });
    expect(task.root_task_id).toBe(task.id);
    expect(String(task.result)).toContain('[Mock]');
    // The conversation belongs to the task, and the call row carries both ids.
    expect(manager.taskHistory(task.id).messages.length).toBeGreaterThan(0);
    const calls = manager.repository.callsOfTask(task.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sid, task_id: task.id, status: 'succeeded' });
    expect(manager.taskList(sid).map((row) => row.id)).toEqual([task.id]);
    expect(manager.taskResult(task.id)).toMatchObject({ finished: true, status: 'completed' });
  });

  test('detached call returns the task while it still runs', async () => {
    const sid = worker();
    const task = await manager.call(sid, 'do the thing', true);
    expect(task.status === 'running' || task.status === 'created' || task.status === 'completed').toBe(true);
    const settled = await manager.taskWait(task.id);
    expect(settled.status).toBe('completed');
  });

  test('one service runs at most one task at a time', async () => {
    const sid = worker();
    const first = manager.repository.createTask(sid, null, 'first');
    expect(() => manager.constructTask(null, sid, 'second')).toThrow(/already working on task/);
    manager.cancelTask(first.id);
    // Once the first one is finished the service is free again.
    const second = await manager.call(sid, 'second');
    expect(second.id).not.toBe(first.id);
  });

  test('a task may only delegate to a direct child service', () => {
    const parent = construct(0, 'generic-service', 'parent');
    const child = construct(parent.sid, 'generic-task', 'child');
    const grandchild = construct(child.sid, 'generic-task', 'grandchild');
    const task = manager.repository.createTask(parent.sid, null, 'delegate');

    // A direct child service is the only legal target, and the child task
    // inherits the root of the tree it belongs to.
    const sub = manager.constructTask(task.id, child.sid, 'downstream');
    expect(sub).toMatchObject({ sid: child.sid, parent_task_id: task.id, root_task_id: task.id });
    expect(() => manager.constructTask(task.id, grandchild.sid, 'skip a level')).toThrow(/only delegate downstream/);
    expect(() => manager.constructTask(task.id, parent.sid, 'its own service')).toThrow(/cannot delegate to its own service/);
    manager.cancelTask(task.id);
  });

  test('delegating downstream runs the child task and wakes the parent', async () => {
    // A slow provider makes the delegation observable: the parent answers
    // before its child is done, is parked in `waiting`, and is then woken.
    const slowDir = tmpdir('lush-core-slow-');
    // The child is the slow one: the parent is guaranteed to answer while its
    // child task is still running, which is the path being tested.
    const built = system(slowDir, new SlowProvider(
      (invocation) => (invocation?.context?.service?.name === 'kid' ? 300 : 5),
    ));
    permissiveRoot(built.manager);
    try {
      const parent = built.manager.construct(0, 'generic-service', 'pm');
      const child = built.manager.construct(parent.sid, 'generic-task', 'kid');
      const task = await built.manager.call(parent.sid, '把这活派给下游');
      expect(task.status).toBe('completed');
      const children = built.manager.taskList(null, null, 'children');
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ sid: child.sid, parent_task_id: task.id, status: 'completed' });
      // The parent's own run was invoked twice: delegate, then finish after the wake.
      expect(built.manager.repository.callsOfTask(task.id)).toHaveLength(2);
      // The wake prompt is part of the task's own conversation, not another task's.
      const messages = built.manager.taskHistory(task.id).messages.map((row) => row.body.content ?? '');
      expect(messages.some((body) => body.includes('你有新的输入'))).toBe(true);
      expect(messages.some((body) => body.includes('你的子 task #') && body.includes('已结束'))).toBe(true);
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
    const parent = construct(0, 'generic-service', 'parent');
    const child = construct(parent.sid, 'generic-task', 'child');
    const task = manager.constructTask(null, parent.sid, 'parent work');
    // Parked on purpose: a child task that is still active, without an agent.
    const sub = manager.repository.createTask(child.sid, task.id, 'child work', { rootTaskId: task.id });

    // Not while the child task is active.
    expect(() => manager.completeTask(task.id, 'done')).toThrow(/active child tasks/);
    manager.cancelTask(sub.id);
    const done = manager.completeTask(task.id, { answer: 'shipped' });
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({ answer: 'shipped' });
    expect(manager.repository.childTasks(task.id)[0].status).toBe('cancelled');

    // Cancelling a task cancels its whole subtree.
    const one = manager.repository.createTask(parent.sid, null, 'one');
    const two = manager.repository.createTask(child.sid, one.id, 'two', { rootTaskId: one.id });
    const cancelled = manager.cancelTask(one.id);
    expect(cancelled.status).toBe('cancelled');
    expect(manager.repository.getTask(two.id).status).toBe('cancelled');
    expect(manager.taskResult(one.id)).toMatchObject({ finished: true, status: 'cancelled' });
  });

  test('a task may only wait on its own subtree, and never on itself', async () => {
    const parent = construct(0, 'generic-service', 'parent');
    const child = construct(parent.sid, 'generic-task', 'child');
    const other = construct(0, 'generic-task', 'other');
    const task = manager.repository.createTask(parent.sid, null, 'parent work');
    const mine = manager.repository.createTask(child.sid, task.id, 'child work', { rootTaskId: task.id });
    const theirs = manager.repository.createTask(other.sid, null, 'unrelated');
    expect(() => manager.waitForTask(theirs.id, task.id)).toThrow(/not part of task/);
    expect(() => manager.waitForTask(task.id, task.id)).toThrow(/cannot wait on itself/);
    manager.completeTask(mine.id, 'done');
    await manager.waitForTask(mine.id, task.id);
    manager.cancelTask(theirs.id);
    manager.completeTask(task.id, 'done');
  });

  test('tasks can be listed, inspected and deleted', async () => {
    const sid = worker();
    const task = await manager.call(sid, 'do the thing');
    expect(manager.taskList(null, 'completed').map((row) => row.id)).toContain(task.id);
    expect(manager.taskList(null, null, 'roots').map((row) => row.id)).toContain(task.id);
    expect(code(() => manager.taskList(null, 'nope'))).toBe(-32602);
    expect(code(() => manager.taskHistory(task.id, -1, 10))).toBe(-32602);

    const info = manager.taskInspect(task.id);
    expect(info.service).toMatchObject({ sid, status: 'active' });
    expect(info.recent_calls).toHaveLength(1);
    expect(info.messages).toBeGreaterThan(0);

    const deleted = manager.taskDelete(task.id);
    expect(deleted.deleted).toEqual([task.id]);
    expect(manager.repository.findTask(task.id)).toBeNull();
    expect(code(() => manager.taskInspect(task.id))).toBe(-32004);
    // The call rows stay: they are the service's durable history.
    expect(manager.repository.callsOfTask(task.id)).toEqual([]);
    expect(manager.repository.calls(sid).length).toBe(1);
  });

  test('update-state writes the task scratch and the service keeps its own state', async () => {
    const sid = worker();
    const task = manager.repository.createTask(sid, null, 'work');
    expect(manager.updateTaskState(task.id, { progress: 'half' })).toEqual({ progress: 'half' });
    expect(manager.taskInspect(task.id).state).toEqual({ progress: 'half' });
    expect(code(() => manager.updateTaskState(task.id, []))).toBe(-32602);
    manager.updateState(sid, { knowledge: 'shared' });
    expect(manager.inspect(sid).context.state).toEqual({ knowledge: 'shared' });
    manager.cancelTask(task.id);
  });

  test('service lifecycle: created → active → stopped, and stop refuses live work', async () => {
    const sid = worker();
    manager.stop(sid);
    expect(manager.inspect(sid).status).toBe('stopped');
    manager.stop(sid); // idempotent
    expect(code(() => manager.constructTask(null, sid, 'work'))).toBe(-32009);
    expect(code(() => manager.start(sid))).toBeNull();
    expect(manager.inspect(sid).status).toBe('active');

    const task = manager.constructTask(null, sid, 'work');
    expect(() => manager.stop(sid)).toThrow(/working on task/);
    manager.cancelTask(task.id);
    manager.stop(sid);
    expect(manager.inspect(sid).status).toBe('stopped');

    // The service state machine is small and closed.
    for (const method of ['start', 'stop', 'delete', 'purge']) {
      expect(() => manager[method](0)).toThrow(LushError);
    }
  });

  test('stop adopts active children; restart does not take them back', () => {
    const parent = construct(0, 'generic-service', 'parent');
    const child = parent.createChild('generic-task', { name: 'kid' });
    manager.stop(parent.sid);
    expect(child.getParent().sid).toBe(0);
    expect(child.inspect().original_parent_sid).toBe(parent.sid);
    manager.start(parent.sid);
    expect(child.getParent().sid).toBe(0);
    const event = child.inspect().recent_events[0];
    expect(event.kind).toBe('reparented');
    expect(event.data).toEqual({ from: parent.sid, to: 0, reason: 'stopped' });
  });

  test('delete removes a stopped service, its tasks and every row they owned', async () => {
    const parent = construct(0, 'generic-service', 'parent');
    const child = construct(parent.sid, 'generic-service', 'child');
    const grandchild = construct(child.sid, 'generic-task', 'grandchild');
    const task = await manager.call(grandchild.sid, 'work');
    manager.updateState(child.sid, { progress: 'half' });
    // Stop the leaf first: stopping `child` would hand its *active* children to
    // SID 0, and then they would not be part of the deleted subtree.
    manager.stop(grandchild.sid);
    manager.stop(child.sid);

    expect(code(() => manager.delete(child.sid, 'yes'))).toBe(-32602);
    const result = manager.delete(child.sid, true);
    expect(result.status).toBe('stopped');
    expect(result.deleted).toEqual([child.sid, grandchild.sid].sort((left, right) => left - right));
    expect(result.rows.tasks).toBe(1);
    expect(manager.repository.findTask(task.id)).toBeNull();
    expect(() => manager.inspect(child.sid)).toThrow(/not found/);
    expect(() => manager.taskInspect(task.id)).toThrow(/not found/);
    expect(parent.getChildren()).toEqual([]);
    const event = manager.repository.events(parent.sid, 1)[0];
    expect(event.kind).toBe('child_deleted');
    expect(event.data).toMatchObject({ sid: child.sid, template: 'generic-service', status: 'stopped' });
  });

  test('delete refuses live work, children and SID 0', () => {
    const running = construct(0, 'generic-task', 'busy');
    expect(code(() => manager.delete(running.sid))).toBe(-32010);
    expect(() => manager.delete(running.sid)).toThrow(/stop it first/);
    expect(code(() => manager.delete(0))).toBe(-32010);
    expect(() => manager.purge(0)).toThrow(/SID 0 is managed by the daemon/);
    expect(() => manager.delete(running.sid + 99)).toThrow(/not found/);

    const parent = construct(0, 'generic-service', 'parent');
    parent.createChild('generic-task', { name: 'kid' });
    expect(() => manager.delete(parent.sid)).toThrow(/has children/);
    expect(() => manager.purge(parent.sid)).toThrow(/has children/);

    // A task still running on the service is refused too, and purge cancels it.
    const task = manager.constructTask(null, running.sid, 'work');
    expect(() => manager.delete(running.sid)).toThrow(/task .* is (created|running|waiting)/);
    const purged = manager.purge(running.sid);
    expect(purged.cancelled).toEqual([task.id]);
    expect(manager.list().map((item) => item.sid)).toEqual([0, parent.sid, parent.getChildren()[0].sid]);
  });

  test('purge cancels the whole subtree before removing it, without adopting', () => {
    const parent = construct(0, 'generic-service', 'parent');
    const child = construct(parent.sid, 'generic-task', 'child');
    const grandchild = construct(child.sid, 'generic-task', 'grandchild');
    const sids = [parent.sid, child.sid, grandchild.sid];
    const result = manager.purge(parent.sid, true);
    expect(result.deleted).toEqual(sids);
    expect(result.terminated).toEqual(sids);
    expect(result.status).toBe('active');
    expect(manager.list().map((item) => item.sid)).toEqual([0]);
    expect(manager.repository.events(0, 20).map((event) => event.kind)).not.toContain('reparented');
    expect(manager.repository.events(0, 1)[0]).toMatchObject({ kind: 'child_deleted', data: { sid: parent.sid } });
  });

  test('delete repairs surviving links to the sid it removes', () => {
    const creator = construct(0, 'generic-service', 'creator');
    const adopted = construct(creator.sid, 'generic-service', 'adopted');
    manager.stop(creator.sid);
    expect(adopted.inspect().parent_sid).toBe(0);
    expect(adopted.inspect().original_parent_sid).toBe(creator.sid);

    manager.delete(creator.sid);
    const survivor = adopted.inspect();
    expect(survivor.parent_sid).toBe(0);
    expect(survivor.original_parent_sid).toBe(0);
    expect(survivor.recent_events[0]).toMatchObject({
      kind: 'parent_deleted',
      data: { sid: creator.sid, name: 'creator', template: 'generic-service', status: 'stopped' },
    });
  });

  test('template restrictions and creation-time snapshot', () => {
    const template = manager.templates.get('generic-task');
    manager.templates.register({ ...template, name: 'restricted-task', child_templates: ['research-task'] });
    const parent = construct(0, 'restricted-task', 'restricted');
    construct(parent.sid, 'research-task', 'researcher');
    expect(code(() => construct(parent.sid, 'generic-service', 'nope'))).toBe(-32010);
    manager.templates.templates['restricted-task'].child_templates = ['*'];
    expect(() => construct(parent.sid, 'generic-service', 'nope')).toThrow(LushError);
    expect(() => construct(0, 'no-such-template', 'x')).toThrow(LushError);
    expect(() => construct(0, 'lush-root', 'x')).toThrow(/reserved/);
  });

  test('singleton templates allow one active instance per parent', () => {
    const template = manager.templates.get('generic-service');
    manager.templates.register({ ...template, name: 'one-per-parent', singleton: true });
    const parent = construct(0, 'generic-service', 'parent');
    const first = construct(parent.sid, 'one-per-parent', 'first');
    expect(code(() => construct(parent.sid, 'one-per-parent', 'second'))).toBe(-32010);
    // Singleton is per parent SID, not system-wide.
    expect(construct(0, 'one-per-parent', 'other').inspect().parent_sid).toBe(0);
    // Only active instances occupy the slot.
    manager.stop(first.sid);
    expect(construct(parent.sid, 'one-per-parent', 'third').sid).not.toBe(first.sid);
    // Non-singleton templates stay unrestricted.
    const plain = construct(parent.sid, 'generic-task', 'plain');
    expect(construct(parent.sid, 'generic-task', 'plain-2').sid).not.toBe(plain.sid);
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
      expect(template.construct_prompt).toContain(expected);
    }
    for (const expected of ['variables', 'detail', 'parent', 'task_construct']) {
      expect(template.system_prompt).toContain(expected);
    }

    const project = construct(0, 'project', 'demo', undefined, { path: dir });
    expect(manager.templates.get('project').child_templates).toContain('dev-task');
    const task = construct(project.sid, 'dev-task', 'fix-login', '修好登录',
      { title: '修复登录流程', detail: '第一行\n第二行' });
    expect(task.inspect().name).toBe('fix-login');
    expect(task.inspect().context.state).toEqual({
      params: { name: 'fix-login', title: '修复登录流程', detail: '第一行\n第二行' },
    });
    expect(task.inspect().variables.declarations.immutable.name.max_length).toBe(64);
    // One child and one only: the worktree node.
    expect(code(() => construct(task.sid, 'generic-task', 'nope'))).toBe(-32010);
    expect(code(() => construct(task.sid, 'project', 'nope'))).toBe(-32010);
    expect(task.getParent().inspect().variables.immutable).toEqual({ path: dir });
    expect(code(() => construct(project.sid, 'dev-task', 'ok-name', undefined, { title: 'x', path: dir }))).toBe(-32602);

    const minimal = construct(project.sid, 'dev-task', 'small-fix', undefined, { title: '小修' });
    expect(minimal.inspect().name).toBe('small-fix');
    expect(minimal.inspect().goal).toBe('small-fix');
    const empty = construct(project.sid, 'dev-task', 'no-body', undefined, { title: '没正文', detail: '' });
    expect(empty.inspect().context.state.params.detail).toBe('');
  });

  test('worktree-service is bound to one worktree through the immutable path variable', () => {
    const template = manager.templates.get('worktree-service');
    expect(template).toMatchObject({ singleton: false, child_templates: [] });
    expect(template.variables.immutable.path).toMatchObject({ required: true });
    expect(template.variables.mutable).toBeUndefined();
    for (const expected of ['path', 'worktree add', 'service_construct']) expect(template.construct_prompt).toContain(expected);
    for (const expected of ['worktree', 'state', 'task_complete']) expect(template.system_prompt).toContain(expected);

    const project = construct(0, 'project', 'demo', undefined, { path: dir });
    expect(code(() => construct(project.sid, 'worktree-service', 'nope', undefined, { path: dir }))).toBe(-32010);
    const task = construct(project.sid, 'dev-task', 'fix-login', undefined, { title: '修登录' });
    expect(code(() => construct(task.sid, 'worktree-service', 'wt'))).toBe(-32602);
    expect(code(() => construct(task.sid, 'worktree-service', 'wt', undefined, { path: 'relative/dir' }))).toBe(-32602);
    expect(code(() => construct(task.sid, 'worktree-service', 'wt', undefined, { path: `${dir}/nope` }))).toBe(-32602);
    expect(code(() => construct(task.sid, 'worktree-service', 'wt', undefined, { path: dir, branch: 'dev' }))).toBe(-32602);

    const service = construct(task.sid, 'worktree-service', 'fix-login', '修登录', { path: dir });
    expect(service.inspect().template).toBe('worktree-service');
    expect(service.inspect().context.state).toEqual({ params: { path: dir } });
    expect(code(() => manager.updateVars(service.sid, { path: '/tmp' }))).toBe(-32602);
    expect(code(() => construct(service.sid, 'generic-task', 'nope'))).toBe(-32010);
  });

  test('project runs development and merge as two phases, and builds the worktrees itself', () => {
    const project = manager.templates.get('project');
    // Phase 1 is machine-paced and must not park the node on a human.
    for (const expected of ['阶段 1', '阶段 2', 'worktree add', '合并：', 'wait: false']) {
      expect(project.system_prompt).toContain(expected);
    }
    // The worktree comes from the parent, so parallel dev-tasks never race on
    // `git worktree add` / branch names.
    const devTask = manager.templates.get('dev-task');
    for (const expected of ['worktree=', '串行', '不要再 `git worktree add`', 'merge: null']) {
      expect(devTask.system_prompt).toContain(expected);
    }
    // The leaf reports and never blocks on a merge decision of its own.
    const worktree = manager.templates.get('worktree-service');
    expect(worktree.system_prompt).toContain('merge: null');
    expect(worktree.system_prompt).not.toContain('--kind decision');
  });

  test('dev-task refuses an unusable name / title / detail with an actionable error', () => {
    const project = construct(0, 'project', 'demo', undefined, { path: dir });
    const attempt = (overrides) => {
      // An explicit `undefined` must reach construct as "no name", so no
      // destructuring default may swallow it.
      const name = Object.hasOwn(overrides, 'name') ? overrides.name : 'ok-name';
      const variables = Object.hasOwn(overrides, 'variables') ? overrides.variables : { title: '标题' };
      try {
        return construct(project.sid, 'dev-task', name, undefined, variables);
      } catch (err) {
        return err;
      }
    };
    const rejects = (overrides, expected) => {
      const err = attempt(overrides);
      expect(err?.code).toBe(-32602);
      for (const part of expected) expect(err.message).toContain(part);
    };

    rejects({ name: undefined }, ['service name', '--name']);
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
    const checked = construct(0, 'checked-mutable', 'checked');
    expect(checked.inspect().context.state.vars).toEqual({ branch: 'main' });
    expect(manager.updateVars(checked.sid, { branch: 'dev' })).toEqual({ branch: 'dev' });
    for (const patch of [{ branch: 'DEV 1' }, { branch: 'toolongbranch' }, { branch: 7 }]) {
      expect(code(() => manager.updateVars(checked.sid, patch))).toBe(-32602);
    }
    expect(checked.inspect().context.state.vars).toEqual({ branch: 'dev' });
    manager.templates.register({
      ...manager.templates.get('generic-task'),
      name: 'anchored-pattern',
      variables: { immutable: { tag: { pattern: '[a-z]+', description: '标签' } } },
    });
    expect(construct(0, 'anchored-pattern', 'ok', undefined, { tag: 'abc' }).inspect().context.state.params.tag).toBe('abc');
    expect(code(() => construct(0, 'anchored-pattern', 'bad', undefined, { tag: 'a1c' }))).toBe(-32602);
  });

  test('context advertises child templates, the task, and no type', async () => {
    const parent = construct(0, 'generic-task', 'parent');
    const task = manager.constructTask(null, parent.sid, 'who can you create?');
    const built = new ContextBuilder(manager.repository, manager.templates).build(manager.repository.getTask(task.id), null);
    const data = built.data;
    expect(data.child_templates).toEqual(['*']);
    expect(data.task).toMatchObject({ id: task.id, goal: 'who can you create?', parent_task_id: null });
    const generic = data.available_child_templates.find((item) => item.name === 'generic-task');
    expect(generic.type).toBeUndefined();
    expect(generic.singleton).toBe(false);
    expect(generic.construct_prompt).toContain('service_construct');
    expect(data.available_child_templates.some((item) => item.name === 'lush-root')).toBe(false);
    manager.cancelTask(task.id);

    // A project is told what a dev-task needs.
    const project = construct(0, 'project', 'demo', undefined, { path: dir });
    const projectTask = manager.constructTask(null, project.sid, 'split me');
    const devTask = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(projectTask.id), null).data.available_child_templates
      .find((item) => item.name === 'dev-task');
    for (const expected of ['name', 'title', 'detail', 'worktree', 'service_construct']) {
      expect(devTask.construct_prompt).toContain(expected);
    }
    manager.cancelTask(projectTask.id);
  });

  test('templates load in hierarchy order, and agents see that order', () => {
    const loader = new TemplateLoader();
    const order = Object.keys(loader.templates);
    expect(order).toEqual([
      'lush-root', 'project-manager', 'project',
      'dev-task', 'worktree-service',
    ]);
    const origin = (name) => loader.origins.get(name).split(path.sep).join('/');
    expect(origin('dev-task').endsWith('/templates/lush-root/project-manager/project/dev-task.json')).toBe(true);
    for (const template of Object.values(loader.templates)) {
      for (const child of template.child_templates) {
        if (child === '*' || child === template.name) continue;
        expect(order.indexOf(template.name)).toBeLessThan(order.indexOf(child));
      }
    }
    const project = construct(0, 'project', 'demo', undefined, { path: dir });
    const projectTask = manager.constructTask(null, project.sid, 'order');
    const names = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(projectTask.id), null).data.available_child_templates.map((item) => item.name);
    expect(names).toEqual(['dev-task']);
    manager.cancelTask(projectTask.id);
  });

  test('available child templates hide a singleton that is already taken', () => {
    const names = (sid) => {
      const task = manager.constructTask(null, sid, 'names');
      const list = new ContextBuilder(manager.repository, manager.templates)
        .build(manager.repository.getTask(task.id), null).data.available_child_templates.map((item) => item.name);
      manager.cancelTask(task.id);
      return list;
    };
    expect(names(0)).toContain('project-manager');
    const taken = construct(0, 'project-manager', 'pm');
    expect(names(0)).not.toContain('project-manager');
    expect(names(0)).toContain('generic-task');
    manager.stop(taken.sid);
    expect(names(0)).toContain('project-manager');
    const child = construct(0, 'project-manager', 'pm2');
    expect(names(child.sid)).toContain('project');
    expect(names(child.sid)).not.toContain('generic-task');
    expect(names(child.sid)).not.toContain('project-manager');
  });

  test('view has no command section and ignores legacy snapshot fields', () => {
    const child = construct(0, 'generic-task', 'child');
    const view = manager.view(child.sid, ['parent', 'children', 'prompt']);
    expect(view.parent.sid).toBe(0);
    expect(view.children).toEqual([]);
    expect(view.call_prompt).toBe(manager.templates.get('generic-task').system_prompt);
    expect(() => manager.view(child.sid, ['command'])).toThrow(LushError);
  });

  test('view answers what the node is, what it may create and how its tasks read', () => {
    const child = construct(0, 'generic-task', 'child');
    const view = manager.view(child.sid, ['description', 'parent', 'children', 'prompt', 'templates']);
    expect(view.description).toBe(manager.templates.get('generic-task').description);
    expect(view.parent.sid).toBe(0);
    expect(view.children).toEqual([]);
    expect(view.call_prompt).toBe(manager.templates.get('generic-task').system_prompt);
    // `templates` is the very list the node's own agent sees in Context, so the
    // two read paths cannot drift.
    const task = manager.constructTask(null, child.sid, 'view');
    const context = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(task.id), null).data.available_child_templates;
    manager.cancelTask(task.id);
    expect(view.available_child_templates).toEqual(context);
    expect(view.available_child_templates.map((item) => item.name)).not.toContain('lush-root');
    expect(view.available_child_templates.length).toBeGreaterThan(0);
    // A singleton whose slot under this parent is taken is not advertised.
    const names = () => manager.view(0, ['templates']).available_child_templates.map((item) => item.name);
    expect(names()).toContain('project-manager');
    const taken = manager.construct(0, 'project-manager', 'pm');
    expect(names()).not.toContain('project-manager');
    manager.stop(taken.sid);
    expect(names()).toContain('project-manager');
  });

  test('startup backfills child_templates for snapshots written earlier', () => {
    const child = construct(0, 'generic-task', 'child');
    const snapshot = manager.repository.get(child.sid).template_snapshot;
    delete snapshot.child_templates;
    delete snapshot.variables;
    manager.repository.db.run('UPDATE services SET template_snapshot=? WHERE sid=?',
      [JSON.stringify(snapshot), child.sid]);
    expect(manager.backfillTemplateSnapshots().filled).toEqual([child.sid]);
    const filled = manager.repository.get(child.sid).template_snapshot;
    expect(filled.child_templates).toEqual(['*']);
    expect(manager.backfillTemplateSnapshots().filled).toEqual([]);
  });

  test('template loader rejects duplicates, unknown references and the old type field', () => {
    const directory = path.join(dir, 'templates');
    fs.mkdirSync(directory);
    const template = new TemplateLoader().get('dev-task');
    const file = path.join(directory, 'custom.json');
    fs.writeFileSync(file, JSON.stringify(template));
    expect(() => new TemplateLoader(directory)).toThrow(LushError);
    fs.writeFileSync(file, JSON.stringify({ ...template, name: 'custom', child_templates: ['missing'] }));
    expect(() => new TemplateLoader(directory)).toThrow(LushError);
    fs.writeFileSync(file, JSON.stringify({ ...template, name: 'custom', child_templates: [] }));
    expect(new TemplateLoader(directory).get('custom').child_templates).toEqual([]);
    // The seven template fields are exact: dropping or adding one is an error.
    for (const mutate of [
      (value) => delete value.construct_prompt,
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

  test('prose fields may be read from a referenced file next to the template', () => {
    const directory = path.join(dir, 'templates');
    const base = manager.templates.get('generic-task');
    const write = (relative, value) => {
      fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      fs.writeFileSync(path.join(directory, relative), typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('sub/prose-tpl.json', {
      ...base,
      name: 'prose-tpl',
      description: '@prose-tpl/description.md',
      construct_prompt: '@prose-tpl/construct_prompt.md',
      system_prompt: '字面量：以 @ 之外的字符开头就不是引用',
      child_templates: [],
    });
    write('sub/prose-tpl/description.md', '一句话。\n');
    // CRLF 归一成 LF，编辑器补的末尾换行去掉，段落之间的空行原样保留。
    write('sub/prose-tpl/construct_prompt.md', '第一段。\n\n第二段。\r\n');

    const template = new TemplateLoader(directory).get('prose-tpl');
    expect(template.description).toBe('一句话。');
    expect(template.construct_prompt).toBe('第一段。\n\n第二段。');
    expect(template.system_prompt).toBe('字面量：以 @ 之外的字符开头就不是引用');

    // A reference is never a literal: nothing readable behind it is an error.
    for (const [description, message] of [
      ['@missing.md', /no readable file at .*missing\.md/],
      ['@', /empty reference/],
    ]) {
      write('sub/prose-tpl.json', { ...base, name: 'prose-tpl', description });
      expect(() => new TemplateLoader(directory)).toThrow(message);
    }
    // Programmatic register has no file to resolve against, so it refuses one.
    expect(() => manager.templates.register({ ...base, name: 'prose-no-file', description: '@/tmp/x.md' }))
      .toThrow(/registered without a file/);
    expect(manager.templates.find('prose-no-file')).toBeNull();
  });

  test('construct variables: required path, defaults, mutability regions and validation', () => {
    expect(code(() => construct(0, 'project', 'p'))).toBe(-32602);
    try {
      construct(0, 'project', 'p');
    } catch (err) {
      expect(err.message).toContain('variables.path');
    }
    expect(code(() => construct(0, 'project', 'p', undefined, { path: 'relative/dir' }))).toBe(-32602);
    expect(code(() => construct(0, 'project', 'p', undefined, { path: path.join(dir, 'missing') }))).toBe(-32602);
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(code(() => construct(0, 'project', 'p', undefined, { path: file }))).toBe(-32602);
    expect(code(() => construct(0, 'project', 'p', undefined, []))).toBe(-32602);
    expect(code(() => construct(0, 'project', 'p', undefined, { path: dir, nope: 1 }))).toBe(-32602);
    expect(code(() => construct(0, 'generic-task', 'p', undefined, { path: dir }))).toBe(-32602);

    const project = construct(0, 'project', 'p1', 'ship', { path: dir });
    expect(project.inspect().context.state).toEqual({ params: { path: dir }, vars: { branch: 'main' } });
    const second = construct(0, 'project', 'p2', undefined, { path: dir, branch: 'dev' });
    expect(second.inspect().variables).toMatchObject({
      immutable: { path: dir },
      mutable: { branch: 'dev' },
      declarations: { immutable: { path: { required: true } }, mutable: { branch: { default: 'main' } } },
    });
    expect(manager.tree().find((row) => row.sid === project.sid).variables.mutable).toEqual({ branch: 'main' });
    manager.updateState(project.sid, { progress: 'started' });
    expect(project.inspect().context.state)
      .toEqual({ params: { path: dir }, vars: { branch: 'main' }, progress: 'started' });
  });

  test('update_vars changes mutable variables only, and update_state cannot write them', () => {
    const project = construct(0, 'project', 'p1', undefined, { path: dir });
    expect(manager.updateVars(project.sid, { branch: 'dev' })).toEqual({ branch: 'dev' });
    expect(project.inspect().variables.mutable).toEqual({ branch: 'dev' });
    for (const patch of [{ path: '/tmp' }, { nope: 1 }, {}, [], { branch: Number.NaN }]) {
      expect(code(() => manager.updateVars(project.sid, patch))).toBe(-32602);
    }
    for (const patch of [{ params: { path: '/tmp' } }, { vars: { branch: 'x' } }]) {
      expect(code(() => manager.updateState(project.sid, patch))).toBe(-32602);
    }
    const plain = construct(0, 'generic-task', 'plain');
    expect(code(() => manager.updateVars(plain.sid, { branch: 'dev' }))).toBe(-32602);
    manager.stop(plain.sid);
    expect(code(() => manager.updateVars(plain.sid, { branch: 'dev' }))).toBe(-32009);
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
    for (const expected of ['task_construct', 'project', 'research-task', 'generic-task', 'generic-service', 'children']) {
      expect(managerTemplate.system_prompt).toContain(expected);
    }
    const projectTemplate = manager.templates.get('project');
    for (const expected of ['dev-task', 'task construct', 'task message', 'path', 'state']) {
      expect(projectTemplate.system_prompt).toContain(expected);
    }
    expect(manager.templates.get('project').construct_prompt).toContain('path');
    expect(manager.templates.get('project').construct_prompt).toContain('singleton=false');
  });

  test('SID 0 routes work to project-manager instead of doing it itself', () => {
    const template = manager.templates.get('lush-root');
    expect(template.child_templates).toEqual(['project-manager']);
    for (const expected of [
      '入口', 'project-manager', 'children', 'task_construct', '被唤醒', '不要自己动手', '孤儿', '不要声称',
    ]) {
      expect(template.system_prompt).toContain(expected);
    }
    expect(template.system_prompt).toContain('lush service orphans');
  });

  test('the shared guide teaches the service/task split on both backends', () => {
    for (const mode of ['tools', 'cli']) {
      const guide = agentGuide(mode);
      for (const expected of [
        'Service', 'Task', 'task_construct', 'task_message', 'task_complete', 'task tree', '下游', '被动的节点',
      ]) {
        expect(guide).toContain(expected);
      }
    }
    expect(agentGuide('tools').split('通用规则：')[1]).toBe(agentGuide('cli').split('通用规则：')[1]);
  });

  test('only project-manager opens projects: a project cannot nest another one', async () => {
    const project = construct(0, 'project', 'demo', undefined, { path: dir });
    const failure = (() => {
      try {
        construct(project.sid, 'project', 'nested', undefined, { path: dir });
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(failure?.code).toBe(-32010);
    expect(failure?.message).toContain('cannot create template project');
    expect(manager.templates.get('project').child_templates).toEqual(['dev-task']);
    const controller = construct(0, 'project-manager', 'controller');
    expect(construct(controller.sid, 'project', 'opened', undefined, { path: dir }).inspect().template).toBe('project');

    const task = manager.constructTask(null, controller.sid, 'open the project');
    const names = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(task.id), null).data.available_child_templates.map((item) => item.name);
    expect(names).toContain('project');
    manager.cancelTask(task.id);
  });

  test('state, context isolation and validation', () => {
    const a = construct(0, 'generic-task', 'a');
    const b = construct(0, 'generic-task', 'b');
    manager.updateState(a.sid, { x: 1, nested: { a: 1 } });
    manager.updateState(a.sid, { nested: { b: 2 } });
    expect(a.inspect().context.state).toEqual({ x: 1, nested: { b: 2 } });
    expect(b.inspect().context.state).toEqual({});
    const symbolPatch = { [Symbol('k')]: 'x' };
    for (const bad of [[], { x: Number.NaN }, symbolPatch]) {
      expect(() => manager.updateState(a.sid, bad)).toThrow(LushError);
    }
    for (const sid of [true, -1, '1', 2 ** 64, null]) {
      expect(() => manager.inspect(sid)).toThrow(LushError);
    }
  });

  test('restart recovers the tree and fails unfinished tasks', async () => {
    const parent = construct(0, 'generic-service', 'parent');
    const child = construct(parent.sid, 'generic-task', 'child');
    const task = manager.repository.createTask(child.sid, null, 'work');
    manager.updateTaskState(task.id, { progress: 'half' });
    let repo = manager.repository;
    const callId = repo.beginCall(child.sid, task.id, 'work');
    repo.addMessage(child.sid, task.id, callId, { role: 'user', content: 'work' });
    await runtime.shutdown();
    db.close();
    ({ database: db, manager, runtime } = system(dir));

    const info = manager.inspect(child.sid);
    expect(info.parent_sid).toBe(parent.sid);
    expect(info.status).toBe('active');
    expect(info.context.state).toEqual({});
    expect(manager.repository.getTask(task.id)).toMatchObject({
      status: 'failed', error: 'daemon restarted', state: { progress: 'half' },
    });
    expect(manager.repository.calls(child.sid)[0].status).toBe('interrupted');
    repo = manager.repository;
    const next = repo.beginCall(child.sid, task.id, 'continue');
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

  test('a v1 database migrates through v2 to the service/task schema', async () => {
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
      expect(migrated.database.connection.query('PRAGMA user_version').get().user_version).toBe(8);
      expect(migrated.database.connection.query('PRAGMA foreign_key_check').all()).toEqual([]);
      // v1 `running` / `completed` become `active`; v1 `cancelled` collapsed
      // into `stopped` on the way through v2, like v1 `stopped` does.
      expect(migrated.manager.list().map((row) => [row.sid, row.status])).toEqual([
        [0, 'active'], [1, 'active'], [2, 'stopped'], [3, 'stopped'],
      ]);
      // The historical call became a root task with its output as the result.
      const adopted = migrated.manager.taskList(1);
      expect(adopted).toHaveLength(1);
      expect(adopted[0]).toMatchObject({ status: 'completed', goal: 'old work', result: 'old output', sid: 1 });
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
    // Spawn a service and keep the SID handle, like the main describe does.
    const construct = (parent, template, name) => built.manager.load(built.manager.construct(parent, template, name).sid);
    return { ...built, construct };
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
    const parent = manager.construct(0, 'generic-task', 'parent');
    const live = manager.construct(parent.sid, 'generic-service', 'live');
    manager.stop(parent.sid);

    const pool = manager.orphans();
    expect(pool.policy).toEqual({ adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 });
    expect(pool.active_count).toBe(1);
    expect(pool.orphans.map((orphan) => orphan.sid)).toEqual([live.sid]);
    expect(pool.orphans[0]).toMatchObject({
      name: 'live',
      status: 'active',
      original_parent_sid: parent.sid,
      busy: false,
    });
    expect(manager.orphanPolicy).toEqual(DEFAULT_ORPHAN_POLICY);
    expect(manager.orphanPolicyReport()).toEqual(pool.policy);
    expect(manager.superviseOrphans().evicted).toEqual([]);
  });

  test("adopt mode 'none' leaves children under their stopped parent", () => {
    const { manager: strict, construct } = policySystem({ adopt: 'none' });
    const parent = construct(0, 'generic-task', 'parent');
    const live = construct(parent.sid, 'generic-service', 'live');
    strict.stop(parent.sid);

    expect(live.inspect().status).toBe('active');
    expect(live.inspect().parent_sid).toBe(parent.sid);
    expect(live.inspect().recent_events.map((event) => event.kind)).not.toContain('reparented');
    expect(strict.orphans().active_count).toBe(0);
  });

  test("adopt mode 'terminate' freezes direct children and walks the chain", () => {
    const { manager: strict, construct } = policySystem({ adopt: 'terminate' });
    const parent = construct(0, 'generic-task', 'parent');
    const service = construct(parent.sid, 'generic-service', 'service');
    const task = construct(parent.sid, 'generic-task', 'task');
    const grandchild = construct(service.sid, 'generic-task', 'grandchild');
    strict.stop(parent.sid);

    expect(service.inspect().status).toBe('stopped');
    expect(task.inspect().status).toBe('stopped');
    expect(grandchild.inspect().status).toBe('stopped');
    expect(service.inspect().recent_events.find((event) => event.kind === 'transition').data)
      .toEqual({ from: 'active', to: 'stopped', cause: 'parent_terminated' });
    expect(strict.orphans().active_count).toBe(0);
  });

  test('a stopped SID 0 never adopts or terminates its own children', () => {
    const { manager: strict, construct } = policySystem({ adopt: 'terminate' });
    const child = construct(0, 'generic-service', 'child');
    expect(child.inspect().original_parent_sid).toBe(0);

    strict.repository.transition(0, 'stopped', { adopt: true, terminate: true });
    expect(strict.repository.get(0).status).toBe('stopped');
    expect(child.inspect().status).toBe('active');
    expect(strict.orphans().orphans).toEqual([]);
  });

  test('the limit freezes the oldest orphans, on adoption and on demand', () => {
    const { manager: strict, construct } = policySystem({ limit: 1 });
    const parent = construct(0, 'generic-task', 'parent');
    const children = [1, 2, 3].map((index) => construct(parent.sid, 'generic-service', `orphan-${index}`));
    strict.stop(parent.sid);

    expect(strict.orphans().active_count).toBe(1);
    const stopped = children.filter((child) => child.inspect().status === 'stopped');
    expect(stopped.length).toBe(2);
    for (const child of stopped) {
      expect(child.inspect().recent_events.find((event) => event.kind === 'transition').data)
        .toEqual({ from: 'active', to: 'stopped', cause: 'orphan_limit' });
    }
  });

  test('eviction cancels the task an orphan was working on', () => {
    const { manager: strict, construct } = policySystem({ ttlSeconds: 1 });
    const parent = construct(0, 'generic-task', 'parent');
    const busy = construct(parent.sid, 'generic-task', 'busy');
    // A task with no agent of its own: created directly, so it stays active.
    const task = strict.repository.createTask(busy.sid, null, 'long work');
    strict.stop(parent.sid);
    const evicted = strict.orphanEvict(busy.sid, 'orphan_ttl');
    expect(strict.repository.getTask(task.id).status).toBe('cancelled');
    expect(evicted.status).toBe('stopped');
    expect(busy.inspect().status).toBe('stopped');
    expect(strict.orphans().active_count).toBe(0);
  });

  test('a busy orphan is never frozen and is deferred', async () => {
    // A slow agent keeps both orphans busy; the limit is 1 and nothing may be
    // frozen, so the pass reports them as deferred instead of forcing it.
    const slow = policySystem({ limit: 1 }, new SlowProvider(400));
    const parent = slow.construct(0, 'generic-task', 'parent');
    const first = slow.construct(parent.sid, 'generic-service', 'first');
    const second = slow.construct(parent.sid, 'generic-service', 'second');
    slow.manager.constructTask(null, first.sid, 'long work');
    slow.manager.constructTask(null, second.sid, 'long work');
    expect(slow.manager.runtime.isBusy(first.sid)).toBe(true);
    slow.manager.stop(parent.sid);
    expect(slow.manager.orphans().active_count).toBe(2);
    expect(first.inspect().status).toBe('active');
    expect(second.inspect().status).toBe('active');
    const report = slow.manager.superviseOrphans('manual');
    expect(report.evicted).toEqual([]);
    expect(report.deferred).toHaveLength(1);
  });

  test('orphans() is a read model with busy, idle and limit arithmetic', () => {
    const { manager: strict, construct } = policySystem({ limit: 0, ttlSeconds: 60 });
    const parent = construct(0, 'generic-task', 'parent');
    const live = construct(parent.sid, 'generic-service', 'live');
    strict.stop(parent.sid);
    strict.repository.db.run('UPDATE services SET updated_at=? WHERE sid=?',
      ['2020-01-01T00:00:00.000Z', live.sid]);
    const pool = strict.orphans();
    expect(pool.orphans[0].idle_seconds).toBeGreaterThan(1000);
    expect(pool.over_limit).toBe(0);
    expect(pool.busy_count).toBe(0);
    const report = strict.superviseOrphans('manual');
    expect(report.ttl_seconds).toBe(60);
    expect(report.evicted.map((item) => item.sid)).toEqual([live.sid]);
    expect(code(() => strict.superviseOrphans('never'))).toBe(-32602);
    expect(code(() => strict.orphanEvict(live.sid, ''))).toBe(-32602);
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

describe('SID 0 creation lockdown', () => {
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

  test('SID 0 may only create project-manager', () => {
    expect(manager.templates.get('lush-root').child_templates).toEqual(['project-manager']);
    expect(manager.construct(0, 'project-manager', 'pm').template).toBe('project-manager');
    expect(() => manager.construct(0, 'generic-task', 'nope')).toThrow(/cannot create template generic-task/);
  });

  test('SID 0 advertises exactly project-manager, and user templates are no exception', () => {
    const task = manager.constructTask(null, 0, 'what can you create?');
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
    const scoped = built.build(manager.repository.getTask(manager.constructTask(null, 0, 'x').id), null);
    expect(scoped.data.available_child_templates.map((item) => item.name)).toEqual(['project-manager']);
  });

  test('refreshRootTemplate restores drift, is idempotent and only touches SID 0', () => {
    const task = manager.constructTask(null, 0, 'drift');
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

  test('refreshRootTemplate makes an edited lush-root prompt reach the agent, SID 0 only', async () => {
    const edited = `${manager.templates.get('lush-root').system_prompt}\nEDITED-MARKER`;
    manager.templates.templates['lush-root'] = { ...manager.templates.get('lush-root'), system_prompt: edited };
    manager.refreshRootTemplate();
    expect(manager.repository.context(0).system_prompt).toContain('EDITED-MARKER');
    const task = manager.constructTask(null, 0, 'hello');
    const built = new ContextBuilder(manager.repository, manager.templates)
      .build(manager.repository.getTask(task.id), null);
    expect(built.messages[0].content).toContain('EDITED-MARKER');
    manager.cancelTask(task.id);
  });
});
