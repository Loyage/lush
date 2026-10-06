import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { HOOK_ACTIONS, HOOK_LIMITS, normalizeHook } from '../../src/core/hooks.js';
setDefaultTimeout(20000);
const notification = (name = 'notify') => ({ name, trigger: 'agent.returned', mode: 'once', enabled: true,
  actions: [{ type: 'notify', title: name, body: '' }] });
const creation = profile => ({ name: 'create', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
  actions: [{ type: 'create_worker', content: 'job', start: false, ...(profile ? { profile } : {}) }] });

test('action catalogue modes match strict validators and message/create remain one-shot', () => {
  expect(HOOK_ACTIONS.find(action => action.type === 'message').modes).toEqual(['once']);
  expect(HOOK_ACTIONS.find(action => action.type === 'create_worker').modes).toEqual(['once']);
  for (const type of ['request_merge', 'notify']) expect(HOOK_ACTIONS.find(action => action.type === type).modes).toEqual(['once','persistent']);
  expect(() => normalizeHook({ ...creation(), mode: 'persistent' })).toThrow('must be once');
  expect(() => normalizeHook({ ...notification(), mode: 'persistent', actions: [{ type: 'message', target_id: 1, body: 'loop' }] })).toThrow('must be once');
});

test('template metadata edits retain private creation profiles, explicit replacements apply, and instances remain copies', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const parent = await f.project.ensureMainTask();
    const profile = { agent: 'pi', config_mode: 'lush', model: 'saved/model', thinking: 'high', append_prompt: 'PRIVATE_PROMPT', env: { KEY: 'PRIVATE_VALUE' } };
    let saved = f.project.saveHookTemplate(creation(profile), f.project.hooksList().revision);
    const templateId = saved.templates[0].id;
    const raw = { ...saved.templates[0], name: 'renamed', conditions: { statuses: ['waiting'] },
      actions: saved.templates[0].actions.map(({ model_selection, ...action }) => action) };
    saved = f.project.saveHookTemplate(raw, saved.revision);
    expect(saved.templates[0].actions[0].model_selection.model).toBe('saved/model');
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_PROMPT'); expect(JSON.stringify(saved)).not.toContain('PRIVATE_VALUE');
    const first = f.project.attachTaskHook(parent.id, { template_id: templateId }, f.project.taskHooks(parent.id).revision).mounts.at(-1);
    saved = f.project.saveHookTemplate({ ...creation({ agent: 'pi', config_mode: 'pi' }), id: templateId }, saved.revision);
    const second = f.project.attachTaskHook(parent.id, { template_id: templateId }, f.project.taskHooks(parent.id).revision).mounts.at(-1);
    expect(first.model_selection.model).toBe('saved/model'); expect(second.model_selection.config_mode).toBe('pi');
    const stored = JSON.parse(f.store.task(parent.id).hooks).mounts.find(mount => mount.id === first.id);
    expect(stored.actions[0].profile.env.KEY).toBe('PRIVATE_VALUE');
    expect(() => f.project.saveHookTemplate({ ...notification(), id: templateId, actions: null }, saved.revision)).toThrow('1-4 actions');
  } finally { await f.close(); }
});

test('failed/unknown draft mounts stay visible and protected, explicit disable/remove release ownership', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const source = await f.project.order('freeze', 'main', [], null, false);
    f.store.update(source.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.task.base_commit }) });
    const draft = await f.project.addBufferedDraft('draft', [], 'main');
    const queued = await f.project.submitBufferedDraft(draft.id, draft.revision, false, true);
    let data = JSON.parse(f.store.task(source.task.parent_id).hooks);
    data.mounts[0].state = 'failed'; data.mounts[0].reason = 'checked failure';
    f.store.update(source.task.parent_id, { hooks: JSON.stringify(data) });
    expect(f.project.inputHistory({ q: 'draft' }).items[0].hook_mount).toMatchObject({ hook_id: queued.hook_id, state: 'failed' });
    await expect(f.project.updateBufferedDraft(draft.id, 'changed', undefined, undefined, draft.revision)).rejects.toThrow('mounted');
    await f.project.updateTaskHook(source.task.parent_id, queued.hook_id, false, f.project.taskHooks(source.task.parent_id).revision);
    expect(f.project.inputGet('draft', draft.id).hook_mount).toBeNull();
    const edited = await f.project.updateBufferedDraft(draft.id, 'edited', undefined, undefined, draft.revision);
    data = JSON.parse(f.store.task(source.task.parent_id).hooks);
    data.mounts[0].state = 'unknown'; data.mounts[0].draft_revision = edited.revision;
    f.store.update(source.task.parent_id, { hooks: JSON.stringify(data) });
    expect(f.project.inputGet('draft', draft.id).hook_mount.state).toBe('unknown');
    expect(() => f.project.removeBufferedDraft(draft.id, edited.revision)).toThrow('mounted');
    f.project.removeTaskHook(source.task.parent_id, queued.hook_id, f.project.taskHooks(source.task.parent_id).revision);
    expect(f.project.inputGet('draft', draft.id).hook_mount).toBeNull();
    expect(f.store.task(source.task.parent_id).hooks).toBeNull(); // Last removal releases the bounded subscription slot.
    f.store.update(source.task.id, { reservation: null });
  } finally { await f.close(); }
});

test('bounded mounts dispatch in finite batches and yield before exhausting a burst', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const order = await f.project.order('burst', 'main', [], null, false);
    for (let index = 0; index < HOOK_LIMITS.mounts; index += 1)
      f.project.attachTaskHook(order.task.id, notification(`burst-${index}`), f.project.taskHooks(order.task.id).revision);
    expect(() => f.project.attachTaskHook(order.task.id, notification('overflow'), f.project.taskHooks(order.task.id).revision)).toThrow('too many mounted');
    let beforeYield = null;
    const marker = new Promise(resolve => setImmediate(() => {
      beforeYield = f.store.get("SELECT count(*) AS n FROM notices WHERE title LIKE 'burst-%'").n; resolve();
    }));
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue; await marker;
    expect(beforeYield).toBeGreaterThan(0); expect(beforeYield).toBeLessThan(HOOK_LIMITS.mounts);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title LIKE 'burst-%'").n).toBe(HOOK_LIMITS.mounts);
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title LIKE 'burst-%'").n).toBe(HOOK_LIMITS.mounts);
  } finally { await f.close(); }
});

test('template library byte budget fails atomically rather than generating an oversized read response', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const large = { ...notification('large'), actions: Array.from({ length: 4 }, () => ({ type: 'notify', title: 'large', body: 'x'.repeat(32000) })) };
    let saved = f.project.hooksList();
    for (let index = 0; index < 4; index += 1) saved = f.project.saveHookTemplate(large, saved.revision);
    expect(() => f.project.saveHookTemplate(large, saved.revision)).toThrow('512 KiB');
    expect(f.project.hooksList().templates).toHaveLength(4);
  } finally { await f.close(); }
});
