import { expect, test } from 'bun:test';
import { createUserServices } from '../src/host/user-services.js';

const environment = { LUSH_GLOBAL_CONFIG: '/tmp/lush-unused-user-services' };

test('dashboard validates before lazy construction and shutdown rejects late requests without escaping its lifecycle', async () => {
  let initialized = 0, calls = 0, closed = 0;
  const services = createUserServices({}, { env: environment,
    get dashboardService() { initialized++; return { get() { calls++; return {}; }, close() { closed++; } }; } });
  await expect(services.saveDashboard({ cards: [], expected_revision: 'v1', _token: 'private' })).rejects.toThrow('invalid');
  await expect(services.saveDashboard({ cards: [{ type: 'account', connection_id: 'invalid' }], expected_revision: 'v1' })).rejects.toThrow('UUID');
  expect(initialized).toBe(0);
  const reading = services.readDashboard();
  const closing = services.close();
  await expect(reading).rejects.toThrow('总览卡片操作未确认');
  await closing; await services.close();
  expect(initialized).toBe(2); expect(calls).toBe(0); expect(closed).toBe(1);
  await expect(services.readDashboard()).rejects.toThrow('总览卡片操作未确认');
});

test('concurrent dashboard reads share one lazy instance and invalid cards never reach an injected writer', async () => {
  let supplied = 0, closes = 0;
  const calls = [], selected = { type: 'account', connection_id: '12345678-1234-1234-1234-123456789abc' };
  const model = { version: 1, revision: 'v1', cards: [selected] };
  const dependency = { get() { calls.push('get'); return model; },
    save(cards, revision) { calls.push([cards, revision]); return model; }, close() { closes++; } };
  const services = createUserServices({}, { env: environment, get dashboardService() { supplied++; return dependency; } });
  try {
    expect(await Promise.all([services.readDashboard(), services.readDashboard()])).toEqual([model, model]);
    expect(supplied).toBe(2);
    expect(await services.saveDashboard({ cards: [selected, selected], expected_revision: 'v1' })).toEqual(model);
    expect(calls).toEqual(['get', 'get', [[selected], 'v1']]);
    await expect(services.saveDashboard({ cards: [{ ...selected, credential: 'private' }], expected_revision: 'v1' })).rejects.toThrow('invalid');
    expect(calls).toHaveLength(3);
  } finally { await services.close(); }
  expect(closes).toBe(1);
});

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
