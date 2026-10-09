import { test, expect } from 'bun:test';
import { createPollBackoff, liveTick } from '../../src/ui/web/assets/live.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const cache = () => ({ steps: [{ seq: 1 }], next: 1, order: 'desc' });

test('slow usage does not delay log publication or the detached DOM tick', async () => {
  const usage = deferred(), transcript = cache(), seen = [];
  const updated = await liveTick({ task: { id: 7 }, transcript, detachUsage: true,
    fetchUsage: () => usage.promise, fetchTranscript: async () => ({ steps: [{ seq: 2 }], next: 2 }),
    publish: { steps: (_id, steps) => seen.push(steps[0].seq), usage: () => seen.push('usage') } });
  expect(seen).toEqual([2]); expect(transcript.next).toBe(2); expect(updated.tailRead).toBe(true);
  usage.resolve({ last: {} }); await usage.promise; await Promise.resolve();
  expect(seen).toEqual([2, 'usage']);
});

test('statistics failure cannot discard a successful final tail', async () => {
  const transcript = cache();
  const updated = await liveTick({ task: { id: 7 }, transcript,
    fetchUsage: async () => { throw new Error('usage offline'); },
    fetchTranscript: async () => ({ steps: [{ seq: 2 }], next: 2 }) });
  expect(updated.steps).toEqual([{ seq: 2 }]); expect(updated.tailRead).toBe(true);
});

test('invalidated Worker/page/cache publishes neither late usage nor steps', async () => {
  const usage = deferred(), page = deferred(), transcript = cache(), seen = [];
  let current = true;
  const tick = liveTick({ task: { id: 7 }, transcript, current: () => current,
    fetchUsage: () => usage.promise, fetchTranscript: () => page.promise,
    publish: { usage: () => seen.push('usage'), steps: () => seen.push('steps') } });
  current = false; usage.resolve({ last: {} }); page.resolve({ steps: [{ seq: 2 }], next: 2 });
  const updated = await tick;
  expect(seen).toEqual([]); expect(transcript.next).toBe(1); expect(updated.tailRead).toBeUndefined();
});

test('overlapping ticks, duplicate server rows and manual winning cursors never append twice', async () => {
  const page = deferred(), transcript = cache();
  const options = { task: { id: 7 }, transcript, fetchUsage: async () => null, fetchTranscript: () => page.promise };
  const a = liveTick(options), b = liveTick(options);
  page.resolve({ steps: [{ seq: 1 }, { seq: 2 }, { seq: 2 }], next: 2 });
  const results = await Promise.all([a, b]);
  expect(transcript.steps.map(step => step.seq)).toEqual([1, 2]);
  expect(results.filter(result => result.tailRead).length).toBe(1);
  expect(transcript.next).toBe(2);
});

test('tail settlement requires success and exhaustion; desc older boundary remains intact', async () => {
  const transcript = { ...cache(), has_older: true, oldest: 1 };
  const options = { task: { id: 7 }, transcript, fetchUsage: async () => null };
  const partial = await liveTick({ ...options, fetchTranscript: async () => ({ steps: [{ seq: 2 }], next: 2, has_more: true }) });
  expect(partial.tailRead).toBe(false); expect(transcript.has_older).toBe(true); expect(transcript.oldest).toBe(1);
  await expect(liveTick({ ...options, fetchTranscript: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  const final = await liveTick({ ...options, fetchTranscript: async () => ({ steps: [] }) });
  expect(final.tailRead).toBe(true);
});

test('failure-only retry backoff is deterministic, capped, and resettable without slowing healthy ticks', () => {
  let now = 0;
  const retry = createPollBackoff({ now: () => now, base: 100, max: 400 });
  for (const delay of [100, 200, 400, 400, 400]) {
    expect(retry.ready()).toBe(true); retry.failed();
    now += delay - 1; expect(retry.ready()).toBe(false); now++; expect(retry.ready()).toBe(true);
  }
  retry.failed(); retry.reset(); expect(retry.ready()).toBe(true);
  retry.failed(); now += 100; expect(retry.ready()).toBe(true);
});
