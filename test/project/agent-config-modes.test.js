import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { fixture, repo } from '../helpers.js';

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const piProfile = { agent: 'pi', config_mode: 'pi' };
const noSecrets = value => expect(JSON.stringify(value)).not.toMatch(/retry_profile|PRIVATE_|SECRET/);

test('a creation-time profile becomes the new Worker task-local run settings', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const created = await f.project.submitOrder('mode work', null, [], piProfile);
    const stored = JSON.parse(f.store.task(created.task.id).retry_profile);
    expect(stored).toEqual({ agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
      extensions: [], skills: [], config_mode: 'pi' });
    const view = f.project.inspect(created.task.id);
    expect(view.model_selection).toEqual({ agent: 'pi', config_mode: 'pi', connection_id: null, model: '',
      thinking: '', explicit: true });
    noSecrets(view.model_selection);
    const configured = JSON.parse(f.store.get(
      "SELECT data FROM events WHERE task_id=? AND type='task.configured' ORDER BY id DESC LIMIT 1", created.task.id).data);
    expect(configured).toMatchObject({ agent: 'pi', config_mode: 'pi', profile_override: true, via: 'order' });
    // Without an explicit override the existing project/role default still applies unchanged.
    const plain = await f.project.order('plain work');
    expect(f.store.task(plain.task.id).retry_profile).toBeNull();
    expect(f.project.inspect(plain.task.id).model_selection.config_mode).toBe('lush');
  } finally { await f.close(); }
});

test('the order.submit positional profile (7th argument of order) becomes the Worker override', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    // Mirrors the RPC handler: p.order(content, branch, references, null, start !== false, undefined, profile).
    const created = await f.project.order('positional profile', null, [], null, true, undefined,
      { agent: 'pi', model: 'deepseek/deepseek-chat', connection_id: CONNECTION, thinking: 'low' });
    expect(JSON.parse(f.store.task(created.task.id).retry_profile)).toMatchObject({ agent: 'pi',
      connection_id: CONNECTION, model: 'deepseek/deepseek-chat', thinking: 'low' });
    expect(f.project.inspect(created.task.id).model_selection).toMatchObject({ connection_id: CONNECTION, explicit: true });
    const without = await f.project.order('no profile', null, [], null, false, undefined, null);
    expect(f.store.task(without.task.id).retry_profile).toBeNull();
    expect(f.store.task(without.task.id).status).toBe('paused');
  } finally { await f.close(); }
});

test('an invalid creation profile fails before an input, branch or anchor is created', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const inputs = f.store.get('SELECT count(*) AS n FROM inputs').n;
    const branches = f.store.get('SELECT count(*) AS n FROM branches').n;
    await expect(f.project.submitOrder('bad', null, [], { agent: 'codex', config_mode: 'pi' })).rejects.toThrow('Pi backend');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(inputs);
    expect(f.store.get('SELECT count(*) AS n FROM branches').n).toBe(branches);
  } finally { await f.close(); }
});

test('spawned children inherit the parent task-local run settings, not frozen project defaults', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const modeParent = (await f.project.submitOrder('mode parent', null, [], piProfile)).task;
    f.store.update(modeParent.id, { status: 'waiting' });
    const modeChild = await f.project.spawn(modeParent.id, 'inherit mode', undefined, [], 'inherit-mode');
    expect(JSON.parse(f.store.task(modeChild.id).retry_profile)).toMatchObject({ agent: 'pi', config_mode: 'pi' });
    expect(f.project.inspect(modeChild.id).model_selection).toMatchObject({ config_mode: 'pi', explicit: true });
    const inheritedEvent = JSON.parse(f.store.get(
      "SELECT data FROM events WHERE task_id=? AND type='task.configured' ORDER BY id DESC LIMIT 1", modeChild.id).data);
    expect(inheritedEvent).toMatchObject({ config_mode: 'pi', inherited_from: modeParent.id, profile_override: true });

    const localParent = (await f.project.submitOrder('local parent')).task;
    f.store.update(localParent.id, { status: 'paused' });
    f.project.configureTask(localParent.id, { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: 'low',
      connection_id: CONNECTION, append_prompt: 'private instructions' });
    f.store.update(localParent.id, { status: 'waiting' });
    const localChild = await f.project.spawn(localParent.id, 'inherit selection', undefined, [], 'inherit-selection');
    expect(JSON.parse(f.store.task(localChild.id).retry_profile)).toMatchObject({ connection_id: CONNECTION,
      model: 'deepseek/deepseek-chat', thinking: 'low' });
    expect(f.project.inspect(localChild.id).model_selection).toMatchObject({ connection_id: CONNECTION,
      model: 'deepseek/deepseek-chat', explicit: true });
    noSecrets(f.project.inspect(localChild.id).model_selection);

    const defaultParent = (await f.project.order('default parent')).task;
    f.store.update(defaultParent.id, { status: 'waiting' });
    const defaultChild = await f.project.spawn(defaultParent.id, 'keep defaults', undefined, [], 'keep-defaults');
    expect(f.store.task(defaultChild.id).retry_profile).toBeNull();
    expect(f.project.inspect(defaultChild.id).model_selection.explicit).toBe(false);
  } finally { await f.close(); }
});

test('spawn freezes the parent current invocation first, then its override, then the effective default', async () => {
  const f = fixture(undefined, { LUSH_PROVIDER: 'pi', LUSH_PI_MODEL: 'deepseek/deepseek-chat' });
  await repo(f.root); f.project.stopping = true;
  try {
    // No running profile and no override: freeze the effective default so later default drift cannot follow.
    const plain = (await f.project.order('freeze default')).task;
    f.store.update(plain.id, { status: 'waiting' });
    const frozen = await f.project.spawn(plain.id, 'freeze', undefined, [], 'freeze-default');
    expect(JSON.parse(f.store.task(frozen.id).retry_profile)).toMatchObject({ agent: 'pi', model: 'deepseek/deepseek-chat' });

    // The profile of the parent's current invocation wins over its task-local override.
    const running = (await f.project.submitOrder('running wins', null, [],
      { agent: 'pi', model: 'deepseek/override', connection_id: CONNECTION })).task;
    f.store.update(running.id, { status: 'waiting' });
    f.project.running.set(running.id, { agent: { agent: 'pi', model: 'deepseek/current', thinking: 'max',
      default_prompt: '', append_prompt: '', extensions: [], skills: [] } });
    const child = await f.project.spawn(running.id, 'current', undefined, [], 'current-wins');
    expect(JSON.parse(f.store.task(child.id).retry_profile)).toMatchObject({ agent: 'pi',
      model: 'deepseek/current', thinking: 'max' });
  } finally { f.project.running.clear(); await f.close(); }
});

test('a buffered draft cannot silently carry run settings', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const draft = await f.project.addBufferedDraft('buffered work', []);
    await expect(f.project.order(undefined, null, [], draft.id, true, draft.revision, { agent: 'pi', config_mode: 'pi' }))
      .rejects.toThrow('buffered draft cannot carry run settings');
    // The draft is untouched and still submittable without a profile.
    const sent = await f.project.order(undefined, null, [], draft.id, true, draft.revision, null);
    expect(sent.task.retry_profile).toBeNull();
  } finally { await f.close(); }
});

test('the narrow model-selection update refuses a Pi-default Worker instead of mixing sources', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const task = (await f.project.submitOrder('pi select', null, [], piProfile)).task;
    f.store.update(task.id, { status: 'paused' });
    expect(() => f.project.configureTaskModelSelection(task.id,
      { connection_id: CONNECTION, model: 'deepseek/chat' })).toThrow('Lush configuration');
    expect(JSON.parse(f.store.task(task.id).retry_profile).config_mode).toBe('pi');
  } finally { await f.close(); }
});

test('the effective profile never carries managed source, model, prompt, resources, budget or env into Pi-default mode', async () => {
  const f = fixture(); await repo(f.root); f.project.stopping = true;
  try {
    const created = await f.project.submitOrder('sanitize', null, [], { agent: 'pi', config_mode: 'pi',
      model: 'deepseek/private-model', thinking: 'high', default_prompt: 'PRIVATE-SYSTEM', append_prompt: 'PRIVATE-APPEND',
      extensions: ['/private/ext.ts'], skills: ['/private/SKILL.md'], soft_budget: { tokens: 9 },
      env: { PRIVATE_ENV: 'v' }, connection_id: CONNECTION });
    const stored = JSON.parse(f.store.task(created.task.id).retry_profile);
    expect(stored).toEqual({ agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
      extensions: [], skills: [], config_mode: 'pi' });
    const inspected = f.project.inspect(created.task.id);
    noSecrets(inspected.model_selection);
    expect(inspected.model_selection.connection_id).toBeNull();
    expect(JSON.stringify(inspected)).not.toMatch(/private-model|PRIVATE-SYSTEM|PRIVATE-APPEND|private\/|PRIVATE_ENV/);
  } finally { await f.close(); }
});
