import { test, expect } from 'bun:test';
import { idle } from './harness.js';

const task = (overrides = {}) => ({ status: 'waiting', calls: 1, agent: { active: false }, ...overrides });

function clientFor(inspect) {
  return { async request(method, params) {
    expect(method).toBe('worker.inspect');
    expect(params).toEqual({ id: 42 });
    return inspect();
  } };
}

test('idle waits beyond the old 100-poll window for a slow invocation', async () => {
  let polls = 0;
  const client = clientFor(() => ++polls <= 101
    ? task({ status: 'running', agent: { active: true } }) : task());
  expect((await idle(client, 42)).status).toBe('waiting');
  expect(polls).toBe(102);
}, 15000);

test('idle accepts settled delivery but still waits for the requested call and actual process exit', async () => {
  const states = [task(), task({ calls: 2, status: 'awaiting_acceptance', agent: { active: true } }),
    task({ calls: 2, status: 'awaiting_acceptance' })];
  const client = clientFor(() => states.shift());
  expect((await idle(client, 42, 2)).status).toBe('awaiting_acceptance');
  expect(states).toHaveLength(0);
});

for (const status of ['failed', 'cancelled', 'completed']) {
  test(`idle reports ${status} without waiting for its timeout`, async () => {
    const client = clientFor(() => task({ status, error: 'fixture stopped' }));
    await expect(idle(client, 42)).rejects.toThrow(`worker 42 stopped with ${status}: fixture stopped`);
  });
}

test('idle timeout includes the last observed worker state', async () => {
  const client = clientFor(() => task({ status: 'running', calls: 2, agent: { active: true } }));
  await expect(idle(client, 42, 2, 1)).rejects.toThrow(
    'worker 42 did not become idle in 1ms (status=running, calls=2, active=true)');
});
