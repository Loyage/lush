import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ContextBuilder } from '../src/context/builder.js';
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
    manager.repository.db.run('UPDATE processes SET template_snapshot=? WHERE pid=?',
      [JSON.stringify(snapshot), child.pid]);
    expect(manager.backfillTemplateSnapshots().filled).toEqual([child.pid]);
    expect(manager.repository.get(child.pid).template_snapshot.child_templates).toEqual(['*']);
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
    // The seven template fields are exact: dropping or adding one is an error.
    for (const mutate of [
      (value) => delete value.spawn_prompt,
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

  test('spawn args, project path requirement and args.path validation', () => {
    expect(code(() => root.createChild('project'))).toBe(-32602);
    expect(code(() => root.createChild('project', { args: { path: 'relative/dir' } }))).toBe(-32602);
    expect(code(() => root.createChild('project', { args: { path: path.join(dir, 'missing') } }))).toBe(-32602);
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(code(() => root.createChild('project', { args: { path: file } }))).toBe(-32602);
    expect(code(() => root.createChild('project', { args: [] }))).toBe(-32602);

    const project = root.createChild('project', { name: 'p1', goal: 'ship', args: { path: dir, branch: 'main' } });
    expect(project.inspect().context.state.params).toEqual({ path: dir, branch: 'main' });
    // project is not a singleton, and args are namespaced so the agent keeps its own state.
    const second = root.createChild('project', { args: { path: dir } });
    expect(second.pid).not.toBe(project.pid);
    manager.updateState(project.pid, { progress: 'started' });
    expect(project.inspect().context.state).toEqual({ params: { path: dir, branch: 'main' }, progress: 'started' });
    // Templates without required args stay optional, but a given path is still validated.
    expect(root.createChild('generic-task').inspect().context.state).toEqual({});
    expect(code(() => root.createChild('generic-task', { args: { path: '/definitely/missing' } }))).toBe(-32602);
  });

  test('project-manager advertises project as a child, project path stays per process', () => {
    const template = manager.templates.get('project-manager');
    expect(template.child_templates).toContain('project');
    expect(template.singleton).toBe(true);
    const spawnPrompt = manager.templates.get('project').spawn_prompt;
    for (const expected of ['args.path', '绝对路径', 'singleton=false']) expect(spawnPrompt).toContain(expected);
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
