import { test, expect, spyOn } from 'bun:test';
import { RuntimeCoordinator } from '../src/core/runtime-coordinator.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function microtasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('copies a fixed handler registry, rejects unknown names and exposes read-only counts', async () => {
  let calls = 0;
  const handlers = { check: () => { calls++; } };
  const coordinator = new RuntimeCoordinator(handlers);
  handlers.check = () => { throw new Error('mutated'); };
  handlers.later = () => {};
  for (const name of ['later', 'toString', '__proto__', '', undefined]) {
    expect(() => coordinator.request(name)).toThrow('Unknown runtime handler');
  }
  expect(() => { coordinator.pendingCount = 10; }).toThrow();
  expect(() => { coordinator.runningCount = 10; }).toThrow();
  expect(() => new RuntimeCoordinator({ bad: null })).toThrow('Invalid runtime handler');
  expect(() => new RuntimeCoordinator({}, { canRun: false })).toThrow();
  expect(() => new RuntimeCoordinator({}, { onError: null })).toThrow();
  coordinator.request('check');
  await microtasks();
  expect(calls).toBe(1);
  await coordinator.stop();
  expect(() => coordinator.request('later')).toThrow('Unknown runtime handler');
});

test('coalesces synchronous requests in a microtask and counts keys rather than requests', async () => {
  const calls = [];
  const coordinator = new RuntimeCoordinator({ a: () => calls.push('a'), b: () => calls.push('b') });
  for (let i = 0; i < 100; i++) coordinator.request('a');
  coordinator.request('b');
  expect(calls).toEqual([]);
  expect(coordinator.pendingCount).toBe(2);
  expect(coordinator.runningCount).toBe(0);
  await microtasks();
  expect(calls).toEqual(['a', 'b']);
  expect(coordinator.pendingCount).toBe(0);
  expect(coordinator.runningCount).toBe(0);
  await coordinator.stop();
});

test('keeps one dirty check during execution and restarts only after true settlement', async () => {
  const first = deferred(), second = deferred();
  let calls = 0, active = 0, maxActive = 0;
  const coordinator = new RuntimeCoordinator({ check: async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await (++calls === 1 ? first.promise : second.promise);
    active--;
  } });
  coordinator.request('check');
  await microtasks();
  for (let i = 0; i < 100; i++) coordinator.request('check');
  await turn();
  expect(calls).toBe(1);
  expect(coordinator.pendingCount).toBe(1);
  expect(coordinator.runningCount).toBe(1);
  first.resolve();
  await microtasks();
  expect(calls).toBe(1); // Dirty continuation yields to the event loop.
  await turn();
  expect(calls).toBe(2);
  expect(coordinator.pendingCount).toBe(0);
  second.resolve();
  await microtasks();
  expect(maxActive).toBe(1);
  expect(coordinator.runningCount).toBe(0);
  await turn();
  expect(calls).toBe(2);
  await coordinator.stop();
});

test('marks a handler running before synchronous reentry and coalesces its self requests', async () => {
  let calls = 0;
  const running = [], pending = [];
  const coordinator = new RuntimeCoordinator({ check: () => {
    calls++;
    running.push(coordinator.runningCount);
    if (calls === 1) {
      coordinator.request('check');
      coordinator.request('check');
      pending.push(coordinator.pendingCount);
    }
  } });
  coordinator.request('check');
  await microtasks();
  expect(calls).toBe(1);
  await turn();
  expect(calls).toBe(2);
  expect(running).toEqual([1, 1]);
  expect(pending).toEqual([1]);
  await microtasks();
  await coordinator.stop();
});

test('a long handler does not block another key, including synchronous cross-key reentry', async () => {
  const long = deferred();
  const calls = [];
  const coordinator = new RuntimeCoordinator({
    long: () => { calls.push('long'); coordinator.request('short'); return long.promise; },
    short: () => { calls.push('short'); },
    third: () => { calls.push('third'); },
  });
  coordinator.request('long');
  coordinator.request('third');
  await microtasks();
  expect(calls).toEqual(['long', 'third', 'short']);
  expect(coordinator.runningCount).toBe(1);
  const stopped = coordinator.stop();
  long.resolve();
  await stopped;
});

test('isolates synchronous throws, async rejects and thenable failures without automatic retries', async () => {
  const syncError = new Error('sync'), asyncError = new Error('async'), thenError = new Error('then');
  const reports = [], calls = [];
  const coordinator = new RuntimeCoordinator({
    sync: () => { calls.push('sync'); throw syncError; },
    async: async () => { calls.push('async'); throw asyncError; },
    then: () => { calls.push('then'); return { get then() { throw thenError; } }; },
    good: () => { calls.push('good'); },
  }, { onError: (name, error) => { reports.push([name, error]); } });
  for (const name of ['sync', 'async', 'then', 'good']) coordinator.request(name);
  await microtasks();
  await turn();
  await turn();
  expect(calls).toEqual(['sync', 'async', 'then', 'good']);
  expect(new Map(reports)).toEqual(new Map([['sync', syncError], ['async', asyncError], ['then', thenError]]));
  expect(coordinator.pendingCount).toBe(0);
  expect(coordinator.runningCount).toBe(0);
  // A fresh explicit request is allowed, unlike an automatic retry.
  coordinator.request('sync');
  await microtasks();
  expect(calls.filter(name => name === 'sync')).toHaveLength(2);
  await coordinator.stop();
});

test('a failed handler still honors an explicit dirty wakeup, not an implicit retry', async () => {
  const first = deferred();
  let calls = 0;
  const reports = [];
  const coordinator = new RuntimeCoordinator({ check: () => {
    calls++;
    if (calls === 1) return first.promise;
  } }, { onError: (name, error) => reports.push([name, error]) });
  coordinator.request('check');
  await microtasks();
  coordinator.request('check');
  const failure = new Error('first failed');
  first.reject(failure);
  await microtasks();
  await turn();
  expect(calls).toBe(2);
  expect(reports).toEqual([['check', failure]]);
  await turn();
  expect(calls).toBe(2);
  await coordinator.stop();
});

test('throwing or rejecting error reporters cannot strand running work or other keys', async () => {
  for (const onError of [() => { throw new Error('report'); }, async () => { throw new Error('report'); }]) {
    let good = 0;
    const coordinator = new RuntimeCoordinator({
      sync: () => { throw new Error('sync'); },
      async: async () => { throw new Error('async'); },
      good: () => { good++; },
    }, { onError });
    coordinator.request('sync');
    coordinator.request('async');
    coordinator.request('good');
    await microtasks();
    expect(good).toBe(1);
    expect(coordinator.runningCount).toBe(0);
    await coordinator.stop();
  }
});

test('canRun gates both admission and late starts; reopening requires a fresh request', async () => {
  let allowed = false, calls = 0;
  const coordinator = new RuntimeCoordinator({ check: () => { calls++; } }, { canRun: () => allowed });
  coordinator.request('check');
  expect(coordinator.pendingCount).toBe(0);
  allowed = true;
  coordinator.request('check');
  allowed = false;
  await microtasks();
  expect(calls).toBe(0);
  expect(coordinator.pendingCount).toBe(0);
  allowed = true;
  await turn();
  expect(calls).toBe(0);
  coordinator.request('check');
  await microtasks();
  expect(calls).toBe(1);
  await coordinator.stop();
});

test('checks canRun between handlers and drops a dirty check when execution exits behind the gate', async () => {
  let allowed = true, calls = 0, other = 0;
  const held = deferred();
  const coordinator = new RuntimeCoordinator({
    first: () => { calls++; allowed = false; return held.promise; },
    other: () => { other++; },
  }, { canRun: () => allowed });
  coordinator.request('first');
  coordinator.request('other');
  await microtasks();
  expect(calls).toBe(1);
  expect(other).toBe(0);
  expect(coordinator.pendingCount).toBe(0);
  allowed = true;
  coordinator.request('first');
  allowed = false;
  held.resolve();
  await microtasks();
  expect(coordinator.pendingCount).toBe(0);
  allowed = true;
  await turn();
  expect(calls).toBe(1);
  await coordinator.stop();
});

test('stop synchronously clears admission and invalidates an already queued microtask', async () => {
  let calls = 0;
  const coordinator = new RuntimeCoordinator({ check: () => { calls++; } });
  coordinator.request('check');
  const stopped = coordinator.stop();
  expect(coordinator.stop()).toBe(stopped);
  coordinator.request('check');
  expect(coordinator.pendingCount).toBe(0);
  expect(coordinator.runningCount).toBe(0);
  await stopped;
  await microtasks();
  await turn();
  expect(calls).toBe(0);
});

test('stop waits for all actually started handlers, including delayed failure, but not dirty checks', async () => {
  const first = deferred(), second = deferred(), cleanup = deferred();
  let calls = 0, stopped = false;
  const reports = [];
  const coordinator = new RuntimeCoordinator({
    first: async () => { calls++; await first.promise; await cleanup.promise; },
    second: () => { calls++; return second.promise; },
  }, { onError: (name, error) => reports.push([name, error]) });
  coordinator.request('first');
  coordinator.request('second');
  await microtasks();
  coordinator.request('first');
  coordinator.request('second');
  const stopping = coordinator.stop().then(() => { stopped = true; });
  expect(coordinator.pendingCount).toBe(0);
  expect(coordinator.runningCount).toBe(2);
  first.resolve();
  await microtasks();
  expect(stopped).toBe(false);
  expect(coordinator.runningCount).toBe(2);
  const failure = new Error('second failed');
  second.reject(failure);
  await microtasks();
  expect(stopped).toBe(false);
  expect(coordinator.runningCount).toBe(1);
  cleanup.resolve();
  await stopping;
  expect(calls).toBe(2);
  expect(reports).toEqual([['second', failure]]);
  expect(coordinator.runningCount).toBe(0);
});

test('synchronous stop from a handler cannot start another queued handler', async () => {
  let stopping, calls = 0;
  const coordinator = new RuntimeCoordinator({
    first: () => { calls++; stopping = coordinator.stop(); },
    second: () => { calls++; },
  });
  coordinator.request('first');
  coordinator.request('second');
  await microtasks();
  await stopping;
  expect(calls).toBe(1);
  expect(coordinator.pendingCount).toBe(0);
  expect(coordinator.runningCount).toBe(0);
});

test('bounds batches and cancels the pending setImmediate continuation on stop', async () => {
  let calls = 0;
  const handlers = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`key${i}`, () => { calls++; }]));
  const coordinator = new RuntimeCoordinator(handlers);
  const marker = turn();
  for (const name of Object.keys(handlers)) coordinator.request(name);
  await marker;
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(256);
  expect(coordinator.pendingCount).toBe(256 - calls);
  const atStop = calls;
  const cancelSpy = spyOn(globalThis, 'clearImmediate');
  try {
    await coordinator.stop();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  } finally {
    cancelSpy.mockRestore();
  }
  await turn();
  expect(calls).toBe(atStop);
  expect(coordinator.pendingCount).toBe(0);
});

test('eventually drains all bounded batches without awaiting long handlers', async () => {
  const allStarted = deferred(), held = deferred();
  let calls = 0;
  const handlers = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key${i}`, () => {
    if (++calls === 129) allStarted.resolve();
    return held.promise;
  }]));
  const coordinator = new RuntimeCoordinator(handlers);
  for (const name of Object.keys(handlers)) coordinator.request(name);
  await allStarted.promise;
  expect(coordinator.pendingCount).toBe(0);
  expect(coordinator.runningCount).toBe(129);
  const stopping = coordinator.stop();
  held.resolve();
  await stopping;
});

test('continuous immediately settled self-wakes yield to the event loop', async () => {
  let calls = 0;
  const coordinator = new RuntimeCoordinator({ check: () => { calls++; coordinator.request('check'); } });
  const marker = turn();
  coordinator.request('check');
  await marker;
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(100);
  await coordinator.stop();
});

test('synchronously failing self-wakes also yield rather than monopolize the loop', async () => {
  let calls = 0, reports = 0;
  const coordinator = new RuntimeCoordinator({ check: () => {
    calls++;
    coordinator.request('check');
    throw new Error('explicitly dirtied');
  } }, { onError: () => { reports++; } });
  const marker = turn();
  coordinator.request('check');
  await marker;
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(100);
  expect(reports).toBe(calls);
  await coordinator.stop();
});

test('a running dirty key does not schedule busy microtasks or empty immediate continuations', async () => {
  const held = deferred();
  let calls = 0;
  const coordinator = new RuntimeCoordinator({ check: () => { calls++; return held.promise; } });
  coordinator.request('check');
  await microtasks();
  const queueSpy = spyOn(globalThis, 'queueMicrotask');
  const immediateSpy = spyOn(globalThis, 'setImmediate');
  try {
    for (let i = 0; i < 1000; i++) coordinator.request('check');
    await microtasks();
    expect(queueSpy).not.toHaveBeenCalled();
    expect(immediateSpy).not.toHaveBeenCalled();
    expect(calls).toBe(1);
    expect(coordinator.pendingCount).toBe(1);
  } finally {
    queueSpy.mockRestore();
    immediateSpy.mockRestore();
    const stopping = coordinator.stop();
    held.resolve();
    await stopping;
  }
});
