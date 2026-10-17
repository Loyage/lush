import { expect, test } from 'bun:test';
import { createPerformanceData } from '../../src/ui/web/assets/performance-data.js';

function fixture() {
  const calls = [];
  const read = async route => {
    calls.push(route); const url = new URL(route, 'http://test');
    if (url.pathname.endsWith('/7')) return { id: 7, status: 'waiting', goal: 'not needed' };
    const older = url.searchParams.has('before') || url.searchParams.has('before_event');
    if (url.pathname.endsWith('/reading-page')) return { events: [{ id: older ? 1 : 9, task_id: 7, type: 'invocation.started', created_at: '2026-01-01T00:00:00Z',
      data: { run_id: older ? 1 : 2, call: older ? 1 : 2 }, reading_text: 'discard body' }], event_cursor: older ? 0 : 9, has_more_events: !older };
    if (url.pathname.endsWith('/runs-page')) return { items: [{ id: older ? 1 : 2, task_id: 7, attempt: older ? 1 : 2, result: 'discard' }], cursor: older ? 1 : 2, has_more: !older };
    if (url.pathname.endsWith('/transcript-search')) {
      const after = Number(url.searchParams.get('after'));
      return { steps: [{ seq: after ? 2 : 1, file: 'a', kind: after ? 'result' : 'tool', call_id: 'x', at: '2026-01-01T00:00:00Z', body: 'discard body' }], next: after ? 2 : 1, has_more: !after };
    }
    return { items: [{ id: older ? 1 : 2, progress: { items: [] } }], cursor: older ? 1 : 2, has_more: !older };
  };
  return { calls, read };
}

test('initial performance collection reads one bounded page per scope; full scans are explicit and retain only timing metadata', async () => {
  const f = fixture(), data = createPerformanceData(7, { read: f.read });
  expect(f.calls).toEqual([]);
  const first = await data.load(); expect(f.calls).toHaveLength(5);
  expect(first.coverage).toEqual({ history: false, runs: false, steps: false, progress: false });
  expect(first.events[0].reading_text).toBeUndefined(); expect(first.runs[0].result).toBeUndefined(); expect(first.steps[0].body).toBeUndefined();
  await data.load(); expect(f.calls).toHaveLength(5);
  const all = await data.load({ all: true }); expect(f.calls).toHaveLength(9);
  expect(all.coverage).toEqual({ history: true, runs: true, steps: true, progress: true });
  expect(all.ranges).toEqual([[1, 9]]); expect(all.runs.map(row => row.id)).toEqual([2, 1]);
  expect(f.calls.filter(route => route.includes('reading-page')).every(route => route.includes('before_message=0'))).toBe(true);
  expect(f.calls.every(route => !/children|relations|action/.test(route))).toBe(true);
});

test('cancelled or late collection cannot publish data; continuation reads the same remaining cursor', async () => {
  const f = fixture(); let finish;
  const data = createPerformanceData(7, { read: route => route.endsWith('/7') ? new Promise(resolve => { finish = resolve; }) : f.read(route) });
  const controller = new AbortController(), pending = data.load({ signal: controller.signal });
  controller.abort(); finish({ id: 7 }); await expect(pending).rejects.toThrow('取消'); expect(data.snapshot().task).toBeNull();
  const another = createPerformanceData(7, { read: f.read }); await another.load();
  const abort = new AbortController(); abort.abort(); await expect(another.load({ all: true, signal: abort.signal })).rejects.toThrow('取消');
  expect(another.snapshot().coverage.history).toBe(false);
  await another.load({ all: true }); expect(another.snapshot().coverage.history).toBe(true);
});

test('shell-only collection preserves authoritative bounded command identity and never loads plans, runs or lifecycle', async () => {
  const f = fixture(), shell = { command: 'bun run test', parameters: '{"timeout":20}', identity_complete: true, fingerprint: 'a'.repeat(64) };
  const data = createPerformanceData(7, { commandsOnly: true, read: async route => {
    const result = await f.read(route);
    if (route.includes('transcript-search')) { result.steps[0].shell = shell; result.steps[0].error_known = true; }
    return result;
  } });
  const first = await data.load(); expect(first.steps[0].shell).toEqual(shell); expect(first.steps[0].body).toBeUndefined();
  expect(first.steps[0].error_known).toBe(true); expect(f.calls).toHaveLength(2);
  expect(first.task.progress).toBeUndefined();
  await data.load({ all: true }); expect(data.snapshot().coverage.steps).toBe(true);
  expect(f.calls.some(route => /progress-history|runs-page|reading-page/.test(route))).toBe(false);
});

for (const kind of ['stalled', 'foreign', 'unreadable', 'budget']) test(`performance collection preserves incomplete scope for ${kind} evidence`, async () => {
  const f = fixture(), data = createPerformanceData(7, { maxRecords: kind === 'budget' ? 0 : 5000, read: async route => {
    const result = await f.read(route);
    if (route.includes('reading-page')) {
      if (kind === 'stalled') { result.event_cursor = 0; result.has_more_events = true; }
      if (kind === 'foreign') result.events[0].task_id = 8;
      if (kind === 'unreadable') result.errors = ['bad event'];
    }
    return result;
  } });
  await expect(data.load()).rejects.toThrow(); expect(data.snapshot().coverage.history).toBe(false); expect(data.snapshot().events).toEqual([]);
  if (kind === 'budget') expect(data.snapshot().exhausted).toBe(true);
});
