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
