import { expect, test } from 'bun:test';
import { createUserServices } from '../src/host/user-services.js';

const environment = { LUSH_GLOBAL_CONFIG: '/tmp/lush-unused-user-services' };

test('shutdown during lazy initialization closes the new instance without admitting its operation', async () => {
  const calls = [];
  const services = createUserServices({ hasRoute: () => false }, { env: environment,
    preferencesService: { get() { calls.push('get'); return {}; }, close() { calls.push('close'); } } });
  const reading = services.readPreferences();
  const closing = services.close();
  await expect(reading).rejects.toThrow('设备偏好操作未确认');
  await closing;
  await services.close();
  expect(calls).toEqual(['close']);
});

test('concurrent workspace requests share one lazy dependency initialization', async () => {
  let supplied = 0, calls = 0, closes = 0;
  const model = { version: 1, revision: 'v1', values: {} };
  const dependency = { get() { calls++; return model; }, close() { closes++; } };
  const options = { env: environment, get preferencesService() { supplied++; return dependency; } };
  const services = createUserServices({ hasRoute: () => false }, options);
  try {
    const values = await Promise.all([services.readPreferences(), services.readPreferences(), services.readPreferences()]);
    expect(values).toEqual([model, model, model]);
    // The injection is checked and returned within the one factory; not once per request.
    expect(supplied).toBe(2); expect(calls).toBe(3);
  } finally { await services.close(); }
  expect(closes).toBe(1);
});

test('invalid global mutations never initialize a dependency or mutate any project', async () => {
  let initialized = false;
  const services = createUserServices({ hasRoute: () => false }, { env: environment,
    get inboxService() { initialized = true; throw new Error('PRIVATE'); } });
  try {
    await expect(services.actionInbox({ project_id: 'ffffffffffffffff', id: 1, method: 'notice.read' })).rejects.toThrow('unknown');
    await expect(services.listInbox({ status: 'all', _token: '' })).rejects.toThrow('invalid');
    await expect(services.getNotice({ project_id: 'ffffffffffffffff', id: 1, path: '/tmp' })).rejects.toThrow('invalid');
    expect(initialized).toBe(false);
  } finally { await services.close(); }
});
