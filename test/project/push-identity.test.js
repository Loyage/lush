import { test, expect } from 'bun:test';
import { fixture, repo } from '../helpers.js';

const facts = f => ['tasks','meta','events','notices'].map(table => f.store.all(`SELECT * FROM ${table} ORDER BY rowid`));
const setRecord = (f, record) => f.store.run("INSERT INTO meta(key,value) VALUES ('command_hook_example',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  typeof record === 'string' ? record : JSON.stringify(record));
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root);
  // Real main must not be inferred from ID=1, branch labels or goal text.
  f.store.create({ role: 'agent', task_kind: 'order', goal: 'main 合并后 git push' });
  const main = await f.project.bootstrapMain();
  const worker = (await f.project.order('other Worker', 'main', [], null, false)).task;
  const example = f.project.commandHookExample();
  return { ...f, main, worker, example };
}

test('no main means null push identity even with misleading names or stale metadata; reads never initialize', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const task = f.store.create({ role: 'agent', task_kind: 'owner', goal: 'main 合并后 git push' });
    f.store.update(task.id, { branch: 'main' });
    setRecord(f, { version: 2, worker_id: task.id, hook_id: 'misleading-hook', template_id: 'misleading-template' });
    const before = facts(f);
    expect(f.project.commandHookExampleIdentity()).toBeNull();
    expect(f.project.commandHookExample()).toBeNull();
    expect(f.project.taskHooks(task.id).push).toBeNull();
    expect(f.project.hooksList().command_example).toBeNull();
    expect(facts(f)).toEqual(before);
  } finally { await f.close(); }
});

test('real main and every Worker share only persisted push identity without recursive hooks reads', async () => {
  const f = await setup();
  try {
    expect(f.main.id).not.toBe(1);
    const expected = { worker_id: f.main.id, hook_id: f.example.hook_id }, before = facts(f);
    const originalExample = f.project.commandHookExample;
    f.project.commandHookExample = () => { throw new Error('taskHooks must never call commandHookExample'); };
    expect(f.project.commandHookExampleIdentity()).toEqual({ ...expected, template_id: f.example.template_id });
    for (const task of [f.main, f.worker]) {
      const hooks = f.project.taskHooks(task.id);
      expect(hooks.push).toEqual(expected);
      expect(Object.keys(hooks.push).sort()).toEqual(['hook_id','worker_id']);
    }
    f.project.commandHookExample = originalExample;
    const taskHooks = f.project.taskHooks; let depth = 0, maxDepth = 0;
    f.project.taskHooks = function (...args) {
      depth++; maxDepth = Math.max(maxDepth, depth);
      try { expect(depth).toBe(1); return taskHooks.apply(this, args); } finally { depth--; }
    };
    expect(f.project.hooksList().command_example.hooks.push).toEqual(expected);
    expect(maxDepth).toBe(1);
    expect(f.project.inspect(f.worker.id).hooks.push).toEqual(expected);
    expect(facts(f)).toEqual(before);
  } finally { await f.close(); }
});

test('missing or mismatched installation metadata cannot identify a different Worker mount', async () => {
  const f = await setup();
  try {
    for (const record of [null, { version: 2, worker_id: f.worker.id, hook_id: f.example.hook_id, template_id: f.example.template_id },
      { version: 2, worker_id: String(f.main.id), hook_id: f.example.hook_id },
      { version: 9, worker_id: f.main.id, hook_id: f.example.hook_id }, '{malformed secret', [],
      { version: 2, worker_id: f.main.id, hook_id: { private: 'secret' }, template_id: 42 }]) {
      setRecord(f, record); const before = facts(f);
      expect(f.project.commandHookExampleIdentity()).toEqual({ worker_id: f.main.id, hook_id: null, template_id: null });
      expect(f.project.taskHooks(f.main.id).push).toEqual({ worker_id: f.main.id, hook_id: null });
      expect(f.project.taskHooks(f.worker.id).push).toEqual({ worker_id: f.main.id, hook_id: null });
      expect(f.project.commandHookExample()).toMatchObject({ worker_id: f.main.id, hook_id: null, template_id: null });
      expect(facts(f)).toEqual(before);
    }
    f.store.run("DELETE FROM meta WHERE key='command_hook_example'");
    const before = facts(f);
    expect(f.project.taskHooks(f.worker.id).push).toEqual({ worker_id: f.main.id, hook_id: null });
    expect(facts(f)).toEqual(before);
  } finally { await f.close(); }
});

test('deleted example keeps tombstone identity without reinstall or guessing a same-title replacement', async () => {
  const f = await setup();
  try {
    const { hook_id, template_id } = f.example;
    const command = f.project.shortcutCommands().items[0];
    f.project.removeTaskHook(f.main.id, hook_id, f.project.taskHooks(f.main.id).revision);
    f.project.removeHookTemplate(template_id, f.project.hooksList().revision);
    const copied = f.project.attachTaskHook(f.main.id, { name: 'main 合并后 git push', trigger: 'worker.merge_received', mode: 'persistent', enabled: false,
      actions: [{ type: 'command', command_id: command.id }] }, f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    expect(copied.id).not.toBe(hook_id);
    const before = facts(f);
    for (const task of [f.main, f.worker]) expect(f.project.taskHooks(task.id).push).toEqual({ worker_id: f.main.id, hook_id });
    const example = f.project.commandHookExample();
    expect(example).toMatchObject({ worker_id: f.main.id, hook_id, template_id });
    expect(example.hooks.mounts.some(mount => mount.id === hook_id)).toBe(false);
    expect(example.hooks.mounts.find(mount => mount.id === copied.id).enabled).toBe(false);
    expect(facts(f)).toEqual(before);
    await f.project.bootstrapMain();
    expect(f.project.taskHooks(f.main.id).mounts.some(mount => mount.id === hook_id)).toBe(false);
    expect(f.project.commandHookExampleIdentity().hook_id).toBe(hook_id);
  } finally { await f.close(); }
});

test('version 1 installed identity is projected without migration or exposing extra private metadata', async () => {
  const f = await setup();
  try {
    setRecord(f, { version: 1, worker_id: f.main.id, hook_id: f.example.hook_id, template_id: f.example.template_id,
      secret: 'PRIVATE_IDENTITY_METADATA', profile: { token: 'PRIVATE_IDENTITY_TOKEN' } });
    const before = facts(f);
    const identity = f.project.commandHookExampleIdentity();
    expect(identity).toEqual({ worker_id: f.main.id, hook_id: f.example.hook_id, template_id: f.example.template_id });
    expect(JSON.stringify(f.project.taskHooks(f.worker.id))).not.toContain('PRIVATE_IDENTITY');
    expect(JSON.stringify(f.project.hooksList())).not.toContain('PRIVATE_IDENTITY');
    expect(facts(f)).toEqual(before);
  } finally { await f.close(); }
});
