import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ContextBuilder } from '../src/context/builder.js';
import { DEFAULT_ORPHAN_POLICY, normalizeOrphanPolicy } from '../src/core/orphans.js';
import { LushError } from '../src/core/types.js';
import { TemplateLoader } from '../src/template_loader.js';
import { cleanup, system, tmpdir } from './helpers.js';

describe('core', () => {
  let dir;
  let db;
  let manager;
  let runtime;
  let root;

  beforeEach(() => {
    dir = tmpdir('lush-core-');
    ({ database: db, manager, runtime } = system(dir));
    root = manager.load(0);
  });

  afterEach(() => {
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
    expect(root.inspect().type).toBe('service');
    expect(root.getParent()).toBeNull();
    manager.ensureRoot();
    expect(manager.list().length).toBe(1);

    const a = root.createChild('generic-service', { name: 'pm' });
    const b = a.createChild('generic-task', { goal: 'implement login' });
    expect([a.pid, b.pid]).toEqual([1, 2]);
    expect(b.getParent().pid).toBe(1);
    expect(a.getChildren()[0].pid).toBe(2);
    expect(b.inspect().goal).toBe('implement login');
  });

  test('all four parent/child type combinations', () => {
    for (const parentTemplate of ['generic-task', 'generic-service']) {
      const parent = root.createChild(parentTemplate);
      for (const template of ['generic-task', 'generic-service']) {
        const child = parent.createChild(template);
        expect(child.getParent().pid).toBe(parent.pid);
      }
    }
  });

  test('task completion adopts active children only', () => {
    const parent = root.createChild('generic-task');
    const live = parent.createChild('generic-service');
    const grandchild = live.createChild('generic-task');
    const ended = parent.createChild('generic-task');
    manager.complete(ended.pid, 'old');
    manager.complete(parent.pid, { answer: 'done' });

    expect(live.getParent().pid).toBe(0);
    expect(live.inspect().original_parent_pid).toBe(parent.pid);
    expect(grandchild.getParent().pid).toBe(live.pid);
    expect(ended.getParent().pid).toBe(parent.pid);
    expect(live.inspect().status).toBe('running');
    const event = live.inspect().recent_events[0];
    expect(event.kind).toBe('reparented');
    expect(event.data).toEqual({ from: parent.pid, to: 0, reason: 'completed' });
    expect(parent.inspect().context.state.result).toEqual({ answer: 'done' });
  });

  test('service stop/restart does not take back orphans', () => {
    const parent = root.createChild('generic-service');
    const child = parent.createChild('generic-task');
    manager.stop(parent.pid);
    manager.stop(parent.pid);
    manager.start(parent.pid);
    expect(parent.inspect().status).toBe('running');
    expect(child.getParent().pid).toBe(0);
    manager.start(parent.pid);
  });

  test('kill, fail and reclaim keep metadata', () => {
    for (const name of ['kill', 'fail']) {
      const parent = root.createChild('generic-task');
      const child = parent.createChild('generic-service');
      manager[name](parent.pid);
      expect(child.getParent().pid).toBe(0);
      manager.reclaim(parent.pid);
      manager.reclaim(parent.pid);
      expect(parent.inspect().status).toBe('reclaimed');
      expect(parent.inspect().children).toEqual([]);
      expect(parent.inspect().recent_events.length).toBeGreaterThan(0);
      expect(manager.kill(parent.pid).status).toBe('reclaimed');
      expect(() => manager.start(parent.pid)).toThrow(LushError);
    }
  });

  test('delete removes a finished process and every row it owned', () => {
    const parent = root.createChild('generic-service');
    const child = parent.createChild('generic-service');
    const grandchild = child.createChild('generic-task');
    manager.updateState(child.pid, { progress: 'half' });
    manager.complete(grandchild.pid, 'done');
    manager.stop(child.pid);

    expect(code(() => manager.delete(child.pid, 'yes'))).toBe(-32602);
    const result = manager.delete(child.pid, true);
    const expected = [child.pid, grandchild.pid].sort((left, right) => left - right);
    expect(result.pid).toBe(child.pid);
    expect(result.status).toBe('stopped');
    expect(result.deleted).toEqual(expected);
    expect(result.terminated).toEqual([]);
    expect(result.rows.processes).toBe(2);
    expect(result.rows.contexts).toBe(2);
    expect(result.rows.process_events).toBeGreaterThan(2);
    expect(() => manager.inspect(child.pid)).toThrow(/not found/);
    expect(() => manager.history(grandchild.pid)).toThrow(/not found/);
    expect(parent.getChildren()).toEqual([]);
    // The parent keeps the only trace: what disappeared, and what it looked like.
    const event = manager.repository.events(parent.pid, 1)[0];
    expect(event.kind).toBe('child_deleted');
    expect(event.data).toMatchObject({ pid: child.pid, template: 'generic-service', status: 'stopped' });
    expect(event.data.deleted).toEqual(expected);
  });

  test('delete refuses unfinished work, children and PID 0', () => {
    const running = root.createChild('generic-task');
    expect(code(() => manager.delete(running.pid))).toBe(-32010);
    expect(() => manager.delete(running.pid)).toThrow(/stop or kill it first/);
    expect(code(() => manager.delete(0))).toBe(-32010);
    expect(() => manager.purge(0)).toThrow(/PID 0 is managed by the daemon/);
    expect(() => manager.delete(running.pid + 99)).toThrow(/not found/);

    const parent = root.createChild('generic-service');
    parent.createChild('generic-task');
    expect(() => manager.delete(parent.pid)).toThrow(/has children/);
    expect(() => manager.purge(parent.pid)).toThrow(/has children/);
  });

  test('purge terminates the whole subtree before removing it, without adopting', () => {
    const parent = root.createChild('generic-service');
    const child = parent.createChild('generic-task');
    const grandchild = child.createChild('generic-task');
    const pids = [parent.pid, child.pid, grandchild.pid];
    const result = manager.purge(parent.pid, true);
    expect(result.deleted).toEqual(pids);
    expect(result.terminated).toEqual(pids);
    expect(result.status).toBe('running');
    expect(manager.list().map((item) => item.pid)).toEqual([0]);
    // Nothing was reparented to PID 0 on the way out: those rows would only be deleted again.
    expect(manager.repository.events(0, 20).map((event) => event.kind)).not.toContain('reparented');
    expect(manager.repository.events(0, 1)[0]).toMatchObject({ kind: 'child_deleted', data: { pid: parent.pid } });
    // A finished process purges like a delete, and reports no termination.
    const done = root.createChild('generic-task');
    manager.complete(done.pid);
    expect(manager.purge(done.pid).terminated).toEqual([]);
  });

  test('delete repairs surviving links to the pid it removes', () => {
    const creator = root.createChild('generic-service', { name: 'creator' });
    const adopted = creator.createChild('generic-service');
    manager.stop(creator.pid);
    expect(adopted.inspect().parent_pid).toBe(0);
    expect(adopted.inspect().original_parent_pid).toBe(creator.pid);

    // `original_parent_pid` is a NOT NULL foreign key: the row may not outlive the pid it names.
    manager.delete(creator.pid);
    const survivor = adopted.inspect();
    expect(survivor.parent_pid).toBe(0);
    expect(survivor.original_parent_pid).toBe(0);
    expect(survivor.recent_events[0]).toMatchObject({
      kind: 'parent_deleted',
      data: { pid: creator.pid, name: 'creator', template: 'generic-service', status: 'stopped' },
    });
  });

  test('invalid lifecycle transitions and root protection', () => {
    expect(() => root.createChild('lush-root')).toThrow(/reserved/);
    const task = root.createChild('generic-task');
    const service = root.createChild('generic-service');
    for (const method of ['start', 'stop', 'kill', 'fail', 'complete', 'reclaim']) {
      expect(() => manager[method](0)).toThrow(LushError);
    }
    for (const [method, pid] of [['complete', service.pid], ['stop', task.pid],
      ['reclaim', task.pid], ['reclaim', service.pid]]) {
      expect(() => manager[method](pid)).toThrow(LushError);
    }
    manager.complete(task.pid);
    expect(() => task.createChild('generic-task')).toThrow(LushError);
    expect(() => manager.updateState(task.pid, {})).toThrow(LushError);
  });

  test('template restrictions and creation-time snapshot', () => {
    const template = manager.templates.get('generic-task');
    manager.templates.register({ ...template, name: 'restricted-task', child_templates: ['research-task'] });
    const parent = root.createChild('restricted-task');
    parent.createChild('research-task');
    expect(code(() => parent.createChild('generic-service'))).toBe(-32010);
    manager.templates.templates['restricted-task'].child_templates = ['*'];
    expect(() => parent.createChild('generic-service')).toThrow(LushError);
    expect(() => root.createChild('no-such-template')).toThrow(LushError);
  });

  test('singleton templates allow one active instance per parent', () => {
    const template = manager.templates.get('generic-service');
    manager.templates.register({ ...template, name: 'one-per-parent', singleton: true });
    const parent = root.createChild('generic-service');
    const first = parent.createChild('one-per-parent');
    expect(code(() => parent.createChild('one-per-parent'))).toBe(-32010);
    // Singleton is per parent PID, not system-wide.
    expect(root.createChild('one-per-parent').getParent().pid).toBe(0);

    // Only active instances occupy the slot: stopping one releases it.
    manager.stop(first.pid);
    const second = parent.createChild('one-per-parent');
    expect(second.pid).not.toBe(first.pid);
    expect(code(() => parent.createChild('one-per-parent'))).toBe(-32010);
    manager.kill(second.pid);
    expect(parent.createChild('one-per-parent').pid).not.toBe(second.pid);

    // Non-singleton templates stay unrestricted.
    const plain = parent.createChild('generic-task');
    expect(parent.createChild('generic-task').pid).not.toBe(plain.pid);
  });

  test('dev-task is a variable-less leaf that a project can create', () => {
    const template = manager.templates.get('dev-task');
    expect(template).toMatchObject({ type: 'task', singleton: false, child_templates: [], variables: {} });
    expect(template.spawn_prompt).toContain('dev-task');
    // Its own guide says work parameters come from the parent, not from variables.
    for (const expected of ['variables', 'parent', 'path']) expect(template.system_prompt).toContain(expected);

    const project = root.createChild('project', { variables: { path: dir } });
    expect(manager.templates.get('project').child_templates).toContain('dev-task');
    const task = project.createChild('dev-task', { name: 'implement-x', goal: '实现 X' });
    expect(task.inspect().context.state).toEqual({});
    expect(task.inspect().variables).toEqual({ immutable: {}, mutable: {}, declarations: { immutable: {}, mutable: {} } });
    // Declaring nothing means accepting nothing: the creator must not pass variables.
    expect(code(() => project.createChild('dev-task', { variables: { path: dir } }))).toBe(-32602);
    // A leaf even though other tasks can spawn: the whitelist is empty.
    expect(code(() => task.createChild('generic-task'))).toBe(-32010);
    // The parent's variables are readable through the normal read model.
    expect(task.getParent().inspect().variables.immutable).toEqual({ path: dir });
  });

  test('context advertises child templates with their spawn prompts', () => {
    const parent = root.createChild('generic-task');
    const callId = manager.repository.beginCall(parent.pid, 'who can you create?');
    const built = new ContextBuilder(manager.repository, manager.templates).build(manager.load(parent.pid), callId);
    const data = JSON.parse(built.messages[1].content.slice('LUSH_CONTEXT\n'.length));
    expect(data.child_templates).toEqual(['*']);
    const generic = data.available_child_templates.find((item) => item.name === 'generic-task');
    expect(generic.type).toBe('task');
    expect(generic.singleton).toBe(false);
    expect(generic.spawn_prompt).toContain('process_spawn');
    expect(data.available_child_templates.some((item) => item.name === 'lush-root')).toBe(false);
  });

  test('available child templates hide a singleton that is already taken', () => {
    const names = (pid) => new ContextBuilder(manager.repository, manager.templates)
      .build(manager.load(pid), null).data.available_child_templates.map((item) => item.name);
    expect(names(0)).toContain('project-manager');
    const taken = manager.spawn(0, 'project-manager', 'pm');
    expect(names(0)).not.toContain('project-manager');
    // Non-singleton templates stay advertised next to it.
    expect(names(0)).toContain('generic-task');
    manager.kill(taken.pid);
    expect(names(0)).toContain('project-manager');
    // A child is scoped by its own whitelist: it never inherits project-manager.
    const child = root.createChild('project-manager');
    expect(names(child.pid)).toContain('generic-task');
    expect(names(child.pid)).not.toContain('project-manager');
  });

  test('view has no command section and ignores legacy snapshot fields', () => {
    const child = root.createChild('generic-task');
    const view = manager.view(child.pid, ['parent', 'children', 'prompt']);
    expect(view.parent.pid).toBe(0);
    expect(view.children).toEqual([]);
    expect(view.call_prompt).toBe(manager.templates.get('generic-task').system_prompt);
    expect(() => manager.view(child.pid, ['command'])).toThrow(LushError);
  });

  test('startup backfills child_templates for snapshots written earlier', () => {
    const child = root.createChild('generic-task');
    const snapshot = manager.repository.get(child.pid).template_snapshot;
    delete snapshot.child_templates;
    delete snapshot.variables;
    manager.repository.db.run('UPDATE processes SET template_snapshot=? WHERE pid=?',
      [JSON.stringify(snapshot), child.pid]);
    expect(manager.backfillTemplateSnapshots().filled).toEqual([child.pid]);
    const filled = manager.repository.get(child.pid).template_snapshot;
    expect(filled.child_templates).toEqual(['*']);
    expect(filled.variables).toEqual(manager.templates.get(manager.repository.get(child.pid).template).variables);
    expect(manager.backfillTemplateSnapshots().filled).toEqual([]);
  });

  test('template loader rejects duplicates and unknown references', () => {
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
    // The eight template fields are exact: dropping or adding one is an error.
    for (const mutate of [
      (value) => delete value.spawn_prompt,
      (value) => delete value.variables,
      (value) => { value.singleton = 'yes'; },
      (value) => { value.type = 'daemon'; },
      (value) => { value.extra = 1; },
    ]) {
      const broken = { ...template, name: 'custom' };
      mutate(broken);
      fs.writeFileSync(file, JSON.stringify(broken));
      expect(() => new TemplateLoader(directory)).toThrow(LushError);
    }
  });

  test('spawn variables: required path, defaults, mutability regions and validation', () => {
    expect(code(() => root.createChild('project'))).toBe(-32602);
    try {
      root.createChild('project');
    } catch (err) {
      expect(err.message).toContain('variables.path');
    }
    expect(code(() => root.createChild('project', { variables: { path: 'relative/dir' } }))).toBe(-32602);
    expect(code(() => root.createChild('project', { variables: { path: path.join(dir, 'missing') } }))).toBe(-32602);
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(code(() => root.createChild('project', { variables: { path: file } }))).toBe(-32602);
    expect(code(() => root.createChild('project', { variables: [] }))).toBe(-32602);
    // Only declared names are accepted; a template without variables takes none.
    expect(code(() => root.createChild('project', { variables: { path: dir, nope: 1 } }))).toBe(-32602);
    expect(code(() => root.createChild('generic-task', { variables: { path: dir } }))).toBe(-32602);

    // Immutable values land in state.params, mutable ones in state.vars.
    const project = root.createChild('project', { name: 'p1', goal: 'ship', variables: { path: dir } });
    expect(project.inspect().context.state).toEqual({ params: { path: dir }, vars: { branch: 'main' } });
    const second = root.createChild('project', { variables: { path: dir, branch: 'dev' } });
    expect(second.pid).not.toBe(project.pid);
    expect(second.inspect().variables).toMatchObject({
      immutable: { path: dir },
      mutable: { branch: 'dev' },
      declarations: { immutable: { path: { required: true } }, mutable: { branch: { default: 'main' } } },
    });

    // The read model carries values and declarations on every row (inspect, tree, children).
    expect(root.inspect().variables).toEqual({ immutable: {}, mutable: {}, declarations: { immutable: {}, mutable: {} } });
    expect(manager.tree().find((row) => row.pid === project.pid).variables.mutable).toEqual({ branch: 'main' });
    manager.updateState(project.pid, { progress: 'started' });
    expect(project.inspect().context.state)
      .toEqual({ params: { path: dir }, vars: { branch: 'main' }, progress: 'started' });
  });

  test('update_vars changes mutable variables only, and update_state cannot write them', () => {
    const project = root.createChild('project', { variables: { path: dir } });
    expect(manager.updateVars(project.pid, { branch: 'dev' })).toEqual({ branch: 'dev' });
    expect(manager.updateVars(project.pid, { branch: 'release' })).toEqual({ branch: 'release' });
    expect(project.inspect().variables.mutable).toEqual({ branch: 'release' });
    expect(project.inspect().context.state.params).toEqual({ path: dir });

    // Immutable and undeclared names are refused; the process's own snapshot decides.
    for (const patch of [{ path: '/tmp' }, { nope: 1 }, {}, [], { branch: Number.NaN }]) {
      expect(code(() => manager.updateVars(project.pid, patch))).toBe(-32602);
    }
    expect((() => { try { manager.updateVars(project.pid, { path: '/tmp' }); } catch (err) { return err.message; } })())
      .toContain('immutable');
    expect(project.inspect().context.state.params).toEqual({ path: dir });

    // Generic state merging must not be a back door into the variable regions.
    for (const patch of [{ params: { path: '/tmp' } }, { vars: { branch: 'x' } }]) {
      expect(code(() => manager.updateState(project.pid, patch))).toBe(-32602);
    }
    expect(project.inspect().context.state.params).toEqual({ path: dir });

    // A template with no variables accepts no variable updates either.
    const plain = root.createChild('generic-task');
    expect(code(() => manager.updateVars(plain.pid, { branch: 'dev' }))).toBe(-32602);
    // Only running processes: the same rule as update-state.
    manager.kill(plain.pid);
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
    // Omitting a group means no variables in it.
    expect(write({ immutable: { path: { description: 'repo' } } }).variables).toEqual({ immutable: { path: { description: 'repo' } } });
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
    ]) {
      expect(code(() => write(broken))).toBe(-32602);
    }
  });

  test('project-manager advertises project as a child, project path stays per process', () => {
    const template = manager.templates.get('project-manager');
    expect(template.child_templates).toContain('project');
    expect(template.singleton).toBe(true);
    const spawnPrompt = manager.templates.get('project').spawn_prompt;
    for (const expected of ['path', '绝对路径', 'singleton=false', 'update-vars', 'variables']) {
      expect(spawnPrompt).toContain(expected);
    }
  });

  test('state, context isolation and validation', () => {
    const a = root.createChild('generic-task');
    const b = root.createChild('generic-task');
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
    expect(a.inspect().context.state.x).toBe(1);
  });

  test('restart recovers tree, context and interrupted history', () => {
    const parent = root.createChild('generic-service');
    const task = parent.createChild('generic-task');
    manager.updateState(task.pid, { progress: 'half' });
    let repo = manager.repository;
    const callId = repo.beginCall(task.pid, 'work');
    repo.addMessage(task.pid, callId, {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'pending', type: 'function', function: { name: 'process_self', arguments: '{}' } }],
    });
    db.close();
    ({ database: db, manager, runtime } = system(dir));

    const info = manager.inspect(task.pid);
    expect(info.parent_pid).toBe(parent.pid);
    expect(info.status).toBe('running');
    expect(info.context.state).toEqual({ progress: 'half' });
    expect(info.recent_calls[0].status).toBe('interrupted');
    expect(manager.history(task.pid).messages.length).toBe(2);

    repo = manager.repository;
    const nextCall = repo.beginCall(task.pid, 'continue');
    const built = new ContextBuilder(repo).build(manager.load(task.pid), nextCall);
    expect(built.messages.some((message) => 'tool_calls' in message)).toBe(false);
    expect(JSON.stringify(built.messages)).toContain('interrupted');
    expect(built.messages.filter((message) => message.content === 'continue').length).toBe(1);
  });

  test('transition transaction rolls back on an invalid result', () => {
    const parent = root.createChild('generic-task');
    const child = parent.createChild('generic-service');
    expect(() => manager.repository.transition(parent.pid, 'completed', { adopt: true, result: Number.NaN }))
      .toThrow(LushError);
    expect(parent.inspect().status).toBe('running');
    expect(child.getParent().pid).toBe(parent.pid);
  });

  test('pagination validation', () => {
    for (const [after, limit] of [[-1, 1], [0, 0], [0, 1001], [true, 1]]) {
      expect(() => manager.history(0, after, limit)).toThrow(LushError);
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
    root = manager.load(0);
  });

  afterEach(() => {
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

  /** A second system built with an explicit orphan policy; closed by afterEach. */
  function policySystem(policy) {
    const directory = tmpdir('lush-core-orphan-');
    const built = system(directory, null, {}, policy);
    extras.push({ directory, database: built.database });
    return built;
  }

  function code(fn) {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  }

  /** Adopt `count` active services into PID 0 without the policy running immediately. */
  function adoptServices(systemManager, count, { suppressPass = false } = {}) {
    const parent = systemManager.load(0).createChild('generic-task');
    const children = [];
    for (let i = 0; i < count; i += 1) children.push(parent.createChild('generic-service', { name: `orphan-${i}` }));
    // A pass triggered by adoption would hide the one the test wants to inspect;
    // the reentrancy flag is exactly what suppresses it (returns `skipped`).
    if (suppressPass) systemManager.orphanSupervisor.running = true;
    systemManager.complete(parent.pid, 'done');
    systemManager.orphanSupervisor.running = false;
    return { parent, children };
  }

  function eventOfKind(process, kind) {
    return process.inspect().recent_events.find((event) => event.kind === kind) ?? null;
  }

  test('default policy adopts active children and reports the pool', () => {
    const parent = root.createChild('generic-task');
    const live = parent.createChild('generic-service');
    manager.complete(parent.pid);

    const pool = manager.orphans();
    expect(pool.policy).toEqual({ adopt: 'adopt', limit: 0, ttl_seconds: 0, sweep_seconds: 30 });
    expect(pool.active_count).toBe(1);
    expect(pool.busy_count).toBe(0);
    expect(pool.over_limit).toBe(0);
    expect(pool.orphans.map((orphan) => orphan.pid)).toEqual([live.pid]);
    expect(pool.orphans[0]).toMatchObject({
      name: 'generic-service',
      type: 'service',
      status: 'running',
      original_parent_pid: parent.pid,
      busy: false,
    });
    // The policy keeps its two shapes: camelCase internally, snake_case on the wire.
    expect(manager.orphanPolicy).toEqual(DEFAULT_ORPHAN_POLICY);
    expect(manager.orphanPolicyReport()).toEqual(pool.policy);
    expect(manager.superviseOrphans().evicted).toEqual([]);
  });

  test("adopt mode 'none' leaves children under their terminal parent", () => {
    const { manager: strict } = policySystem({ adopt: 'none' });
    const parent = strict.load(0).createChild('generic-task');
    const live = parent.createChild('generic-service');
    strict.complete(parent.pid);

    expect(live.inspect().status).toBe('running');
    expect(live.inspect().parent_pid).toBe(parent.pid);
    expect(live.inspect().original_parent_pid).toBe(parent.pid);
    expect(live.inspect().recent_events.map((event) => event.kind)).not.toContain('reparented');
    // Not an orphan: PID 0 does not supervise what it never adopted.
    expect(strict.orphans().active_count).toBe(0);
    expect(strict.orphans().orphans).toEqual([]);
    expect(strict.superviseOrphans()).toMatchObject({ checked: 0, active_before: 0, active_after: 0 });
  });

  test("adopt mode 'terminate' freezes direct children and walks the active chain", () => {
    const { manager: strict } = policySystem({ adopt: 'terminate' });
    const parent = strict.load(0).createChild('generic-task');
    const service = parent.createChild('generic-service');
    const task = parent.createChild('generic-task');
    const grandchild = service.createChild('generic-task');
    strict.complete(parent.pid, 'done');

    expect(service.inspect().status).toBe('stopped');
    expect(task.inspect().status).toBe('cancelled');
    expect(service.inspect().parent_pid).toBe(parent.pid);
    expect(task.inspect().parent_pid).toBe(parent.pid);
    expect(eventOfKind(service, 'transition').data)
      .toEqual({ from: 'running', to: 'stopped', cause: 'parent_terminated' });
    expect(eventOfKind(task, 'transition').data)
      .toEqual({ from: 'running', to: 'cancelled', cause: 'parent_terminated' });
    // Each frozen child applies the same policy to its own children.
    expect(grandchild.inspect().status).toBe('cancelled');
    expect(strict.orphans().active_count).toBe(0);
  });

  test('a terminal PID 0 never adopts or terminates its own children', () => {
    const { manager: strict } = policySystem({ adopt: 'terminate' });
    const child = strict.load(0).createChild('generic-service');
    expect(child.inspect().original_parent_pid).toBe(0);

    // The daemon shutdown path: PID 0 alone changes, even with adoption asked for.
    strict.repository.transition(0, 'stopped', { adopt: true, terminate: true });
    expect(strict.repository.get(0).status).toBe('stopped');
    expect(child.inspect().status).toBe('running');
    expect(child.inspect().parent_pid).toBe(0);
    // A child PID 0 created itself is not an orphan and is never supervised.
    expect(strict.orphans().orphans).toEqual([]);
  });

  test('the limit freezes the oldest orphans, immediately on adoption and on demand', () => {
    const { manager: strict } = policySystem({ limit: 1 });

    // Adoption itself exceeds the limit, so the pass runs inside `complete`.
    const { children } = adoptServices(strict, 3);
    expect(strict.orphans().active_count).toBe(1);
    expect(strict.orphans().over_limit).toBe(0);
    const stopped = children.filter((child) => child.inspect().status === 'stopped');
    expect(stopped.length).toBe(2);
    for (const child of stopped) {
      expect(eventOfKind(child, 'transition').data)
        .toEqual({ from: 'running', to: 'stopped', cause: 'orphan_limit' });
    }

    // A manual pass reports what it did, oldest first. The activity stamps are
    // written explicitly so "oldest" does not depend on the wall clock.
    const { manager: strict2 } = policySystem({ limit: 1 });
    const { children: kids } = adoptServices(strict2, 3, { suppressPass: true });
    const backdate = (child, iso) => {
      strict2.repository.db.run('UPDATE processes SET updated_at=? WHERE pid=?', [iso, child.pid]);
    };
    backdate(kids[0], '2020-01-01T00:00:00.000Z');
    backdate(kids[1], '2021-01-01T00:00:00.000Z');
    backdate(kids[2], '2022-01-01T00:00:00.000Z');
    const before = strict2.orphans();
    expect(before.active_count).toBe(3);
    expect(before.orphans.map((orphan) => orphan.pid))
      .toEqual([kids[0].pid, kids[1].pid, kids[2].pid]);

    const report = strict2.superviseOrphans('manual');
    expect(report).toMatchObject({
      trigger: 'manual',
      skipped: false,
      checked: before.orphans.length,
      active_before: 3,
      active_after: 1,
      limit: 1,
      ttl_seconds: 0,
      deferred: [],
    });
    expect(report.evicted.map((entry) => entry.pid)).toEqual([kids[0].pid, kids[1].pid]);
    expect(report.evicted.map((entry) => entry.reason)).toEqual(['orphan_limit', 'orphan_limit']);
    expect(report.evicted.map((entry) => entry.to)).toEqual(['stopped', 'stopped']);
    expect(report.evicted[0].idle_seconds).toBeGreaterThan(report.evicted[1].idle_seconds);
    expect(kids[2].inspect().status).toBe('running');
    expect(strict2.orphans().active_count).toBe(1);
    expect(strict2.superviseOrphans().evicted).toEqual([]);
  });

  test('the limit never freezes a busy orphan and defers to it', () => {
    const { manager: strict, runtime: strictRuntime } = policySystem({ limit: 1 });
    const { children } = adoptServices(strict, 3, { suppressPass: true });
    // The two oldest orphans are the busy ones; the newest one is the only
    // candidate, and freezing it still leaves too many.
    const backdate = (child, iso) => {
      strict.repository.db.run('UPDATE processes SET updated_at=? WHERE pid=?', [iso, child.pid]);
    };
    backdate(children[0], '2020-01-01T00:00:00.000Z');
    backdate(children[1], '2021-01-01T00:00:00.000Z');
    backdate(children[2], '2022-01-01T00:00:00.000Z');
    const busy = [children[0].pid, children[1].pid];
    const frozenCalls = [];
    strict.runtime = {
      provider: strictRuntime.provider,
      isBusy: (pid) => busy.includes(pid),
      cancel: (pid) => frozenCalls.push(pid),
    };

    const report = strict.superviseOrphans();
    expect(children[0].inspect().status).toBe('running');
    expect(children[1].inspect().status).toBe('running');
    expect(children[2].inspect().status).toBe('stopped');
    expect(report.deferred).toEqual([{ pid: children[0].pid, reason: 'busy' }]);
    expect(report.evicted.map((entry) => entry.pid)).toEqual([children[2].pid]);
    expect(report.active_after).toBe(2);
    expect(strict.orphans().busy_count).toBe(2);
    expect(frozenCalls).toEqual([children[2].pid]);
  });

  test('the ttl freezes idle orphans and cancels their running calls', () => {
    const { manager: strict, runtime: strictRuntime } = policySystem({ ttlSeconds: 3600 });
    const { children } = adoptServices(strict, 2);

    // Freshly adopted orphans are idle for ~0s: nothing to do yet.
    expect(strict.superviseOrphans().evicted).toEqual([]);

    const cancelled = [];
    const realCancel = strictRuntime.cancel.bind(strictRuntime);
    strictRuntime.cancel = (pid) => {
      cancelled.push(pid);
      realCancel(pid);
    };
    strict.orphanSupervisor.clock = () => Date.now() + 2 * 3600 * 1000;
    expect(strict.orphans().orphans[0].idle_seconds).toBeGreaterThanOrEqual(7200);

    const report = strict.superviseOrphans('timer');
    expect(report.trigger).toBe('timer');
    expect(report.evicted.map((entry) => entry.pid)).toEqual(children.map((child) => child.pid));
    for (const entry of report.evicted) {
      expect(entry.reason).toBe('orphan_ttl');
      expect(entry.to).toBe('stopped');
      expect(entry.idle_seconds).toBeGreaterThanOrEqual(7200);
    }
    for (const child of children) {
      expect(child.inspect().status).toBe('stopped');
      expect(eventOfKind(child, 'transition').data)
        .toEqual({ from: 'running', to: 'stopped', cause: 'orphan_ttl' });
    }
    expect(cancelled.sort((a, b) => a - b)).toEqual(children.map((child) => child.pid).sort((a, b) => a - b));
    expect(strict.orphans().active_count).toBe(0);
    expect(strict.superviseOrphans().evicted).toEqual([]);
  });

  test('the ttl never touches children PID 0 created itself', () => {
    const { manager: strict } = policySystem({ ttlSeconds: 3600 });
    const own = strict.load(0).createChild('generic-service');
    expect(own.inspect().original_parent_pid).toBe(0);
    strict.orphanSupervisor.clock = () => Date.now() + 10 * 3600 * 1000;

    const report = strict.superviseOrphans();
    expect(report.checked).toBe(0);
    expect(report.evicted).toEqual([]);
    expect(own.inspect().status).toBe('running');
    expect(strict.orphans().orphans).toEqual([]);
  });

  test('orphans() is a read model with busy, idle and limit arithmetic', () => {
    const parent = root.createChild('generic-task');
    const running = parent.createChild('generic-service', { name: 'cache' });
    const stopped = parent.createChild('generic-service', { name: 'old' });
    manager.complete(parent.pid);
    manager.stop(stopped.pid);

    const pool = manager.orphans();
    expect(pool.orphans.map((orphan) => orphan.pid)).toEqual([running.pid, stopped.pid]);
    expect(pool.active_count).toBe(1);
    expect(pool.busy_count).toBe(0);
    expect(pool.over_limit).toBe(0);
    const [first] = pool.orphans;
    expect(first).toMatchObject({ name: 'cache', template: 'generic-service', original_parent_pid: parent.pid });
    expect(Number.isInteger(first.idle_seconds)).toBe(true);
    expect(first.idle_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(first.last_activity_at))).toBe(false);
    expect(Number.isNaN(Date.parse(first.created_at))).toBe(false);
    expect(first.last_activity_at >= first.created_at).toBe(true);
    // Note: `created_at` is second-precision free, `last_activity_at` is the newest stamp.
    expect(pool.orphans[1].status).toBe('stopped');

    // over_limit counts the active orphans a limit would leave behind.
    const { manager: strict } = policySystem({ limit: 1, ttlSeconds: 2.5 });
    adoptServices(strict, 2, { suppressPass: true });
    const limited = strict.orphans();
    expect(limited.policy).toEqual({ adopt: 'adopt', limit: 1, ttl_seconds: 2.5, sweep_seconds: 30 });
    expect(limited.active_count).toBe(2);
    expect(limited.over_limit).toBe(1);
  });

  test('normalizeOrphanPolicy fills defaults and rejects invalid values', () => {
    expect(normalizeOrphanPolicy()).toEqual(DEFAULT_ORPHAN_POLICY);
    expect(normalizeOrphanPolicy({ limit: 2 })).toEqual({ adopt: 'adopt', limit: 2, ttlSeconds: 0, sweepSeconds: 30 });
    expect(normalizeOrphanPolicy({ adopt: 'none', ttlSeconds: 0.5, sweepSeconds: 0 }))
      .toEqual({ adopt: 'none', limit: 0, ttlSeconds: 0.5, sweepSeconds: 0 });

    const invalid = [
      [{ adopt: 'maybe' }, 'adopt mode'],
      [{ limit: -1 }, 'limit'],
      [{ limit: 1.5 }, 'limit'],
      [{ limit: Number.NaN }, 'limit'],
      [{ ttlSeconds: -0.1 }, 'ttl'],
      [{ ttlSeconds: 'soon' }, 'ttl'],
      [{ sweepSeconds: -1 }, 'sweep'],
      [{ sweepSeconds: 2.5 }, 'sweep'],
    ];
    for (const [policy, field] of invalid) {
      const failure = (() => {
        try {
          normalizeOrphanPolicy(policy);
        } catch (err) {
          return err;
        }
        return null;
      })();
      expect(failure).toBeInstanceOf(LushError);
      expect(failure.code).toBe(-32602);
      expect(failure.message).toContain(field);
    }

    // The trigger names are validated too, before any work happens.
    expect(code(() => manager.superviseOrphans('bogus'))).toBe(-32602);
    expect(code(() => manager.superviseOrphans('timer'))).toBe(null);
  });
});
